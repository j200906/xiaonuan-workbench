/**
 * 云端自迭代
 *
 * 跑在 Cloudflare 上，不在浏览器里。给它一个 GitHub 仓库和一次性 token，
 * 它会：读反馈 → 想办法 → 校验 → 改文件 → 提交通。浏览器关掉也不影响它跑完。
 *
 * 安全边界：
 *   - 必须带管理员密码（服务端的 XN_ADMIN_PASSWORD）
 *   - token 由调用方每次传入，不落库、不打日志
 *   - 只允许改白名单文件，find 必须唯一，禁止 eval / 外链脚本
 */

const EDITABLE = ['index.html', 'assets/app.css', 'assets/app.core.js', 'assets/app.views.js'];
const VERSION_FILE = 'assets/version.js';
const CHANGELOG_FILE = 'assets/changelog.js';
const MAX_PATCHES = 4;

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function jsonBody(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function ghFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xiaonuan-cloud-iterate',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function readFile(owner, repo, path, token) {
  const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=main`, token);
  if (r.status !== 200) throw new Error(`读不到 ${path}（HTTP ${r.status}）`);
  return { content: b64decode(r.data.content), sha: r.data.sha };
}

async function writeFile(owner, repo, path, content, sha, message, token) {
  const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64encode(content), sha, branch: 'main' })
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`提交 ${path} 失败（HTTP ${r.status}）${JSON.stringify(r.data).slice(0, 160)}`);
  }
  return r.data.commit.sha.slice(0, 7);
}

/* ---------- 问模型 ---------- */

async function ask(env, apiKey, system, user, maxTokens = 2000) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  const key = apiKey || env.XN_API_KEY;
  if (key) {
    const base = (env.XN_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: env.XN_MODEL || 'deepseek-chat', messages, temperature: 0.4, max_tokens: maxTokens })
    });
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  const out = await env.AI.run(env.XN_ITER_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct', { messages, max_tokens: maxTokens });
  if (typeof out === 'string') return out;
  if (typeof out === 'string') return out;
  if (out && typeof out.response === 'string' && out.response) return out.response;
  if (out && out.choices && out.choices[0] && out.choices[0].message) {
    const m = out.choices[0].message;
    return m.content || m.reasoning || '';
  }
  return '';
}

function pickJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/* ---------- README 与发版 ---------- */

const README_FILE = 'README.md';

function patchReadme(text, entry) {
  // 仓库里的换行可能是 CRLF，先归一，改完再还原，免整份文件进 diff
  const crlf = /\r\n/.test(String(text));
  let c = String(text).replace(/\r\n/g, '\n');

  // 版本块
  c = c.replace(
    /<!-- XN:VERSION -->[\s\S]*?<!-- \/XN:VERSION -->/,
    `<!-- XN:VERSION -->\n当前版本 **v${entry.version}**\n<!-- /XN:VERSION -->`
  );

  // 最近更新：新条目插到最前，最多留 5 条
  const bullet = `- **v${entry.version}** ${entry.title}`;
  const m = c.match(/<!-- XN:RECENT -->\n([\s\S]*?)<!-- \/XN:RECENT -->/);
  if (m) {
    const lines = m[1].split('\n').map((x) => x.trim()).filter(Boolean);
    const keep = [bullet, ...lines.filter((x) => x.indexOf('**v' + entry.version + '**') < 0)].slice(0, 5);
    c = c.replace(
      /<!-- XN:RECENT -->\n[\s\S]*?<!-- \/XN:RECENT -->/,
      `<!-- XN:RECENT -->\n${keep.join('\n')}\n<!-- /XN:RECENT -->`
    );
  }
  return crlf ? c.replace(/\n/g, '\r\n') : c;
}

async function makeRelease(owner, repo, token, entry) {
  const fixes = (entry.fixes || []).map((x) => '- ' + x).join('\n');
  const feats = (entry.features || []).map((x) => '- ' + x).join('\n');
  const body = [
    `**v${entry.version}** ${entry.title}`,
    feats ? '\n### 新增\n' + feats : '',
    fixes ? '\n### 修掉\n' + fixes : '',
    '\n\n---\n程序由 GitHub Actions 在 Windows 上现打，稍等一两分钟后刷新本页即可下载 `XiaoNuan.exe`。'
  ].join('\n');

  const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: 'v' + entry.version,
      name: `小暖 v${entry.version} · ${entry.title}`,
      body,
      target_commitish: 'main',
      draft: false,
      prerelease: false
    })
  });
  if (r.status === 201 || r.status === 200) {
    return { ok: true, url: r.data.html_url, tag: r.data.tag_name };
  }
  // 422 = 这个 tag 已经有 release 了，不算失败
  if (r.status === 422) return { ok: true, reused: true, tag: 'v' + entry.version };
  return { ok: false, status: r.status, error: JSON.stringify(r.data).slice(0, 200) };
}

/* ---------- 主流程 ---------- */

export async function runIteration(env, opts) {
  const { owner, repo, token, password, dryRun, apiKey } = opts;
  if (!env.XN_ADMIN_PASSWORD) return jsonBody({ ok: false, error: '服务器没设管理密码（XN_ADMIN_PASSWORD）' }, 501);
  if (String(password || '') !== String(env.XN_ADMIN_PASSWORD)) return jsonBody({ ok: false, error: '密码不对' }, 401);
  if (!owner || !repo) return jsonBody({ ok: false, error: '缺 owner / repo' }, 400);
  if (!token && !dryRun) return jsonBody({ ok: false, error: '缺 GitHub token（要能写这个仓库）' }, 400);

  const log = [];
  const say = (t) => log.push(t);

  /* 1. 反馈 */
  let feedback = [];
  if (env.XN_KV) {
    try {
      const listed = await env.XN_KV.list({ prefix: 'fb:', limit: 50 });
      for (const k of listed.keys) {
        const raw = await env.XN_KV.get(k.name);
        if (raw) { try { feedback.push(JSON.parse(raw)); } catch (e) {} }
      }
      feedback.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    } catch (e) { say('读反馈失败：' + e.message); }
  }
  say(`云端反馈 ${feedback.length} 条`);

  /* 2. 版本与文件 */
  const vFile = await readFile(owner, repo, VERSION_FILE, token);
  const cur = (vFile.content.match(/XN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '1.0.0';
  const parts = cur.split('.').map(Number);
  const next = `${parts[0]}.${parts[1]}.${(parts[2] || 0) + 1}`;
  say(`当前版本 ${cur} → 计划 ${next}`);

  const files = {};
  for (const p of EDITABLE) {
    const f = await readFile(owner, repo, p, token);
    files[p] = f.content;
  }

  /* 3. 让模型出方案 */
  const digest = Object.keys(files)
    .map((p) => `### ${p}\n${files[p].split('\n').slice(0, 70).join('\n')}`)
    .join('\n\n');

  const fbText = feedback.slice(0, 25)
    .map((f, i) => `${i + 1}. [${f.type}] ${String(f.body || '').slice(0, 160)}`)
    .join('\n') || '（没有新反馈）';

  if (apiKey) say('用你填的那个 API Key 跑');
  const rawText = await ask(
    env,
    apiKey,
    '你是代码修改计划器。只输出一个 JSON 对象，不要解释、不要 markdown 代码块。改动必须小、可验证。',
    `仓库：${owner}/${repo}，当前版本 ${cur}。\n\n用户反馈：\n${fbText}\n\n` +
    `文件内容（节选）：\n${digest}\n\n` +
    `请挑 1 个最值得做的问题，给出补丁。输出：\n` +
    `{"version":"${next}","title":"不超过18字","fixes":["改了什么"],"features":[],` +
    `"patches":[{"file":"白名单文件","find":"原文里逐字存在且只出现一次的片段","replace":"替换成"}]}\n` +
    `规则：file 只能是 ${EDITABLE.join(' / ')}；find 至少 12 个字符；最多 ${MAX_PATCHES} 处；` +
    `不许 eval、外链脚本、改 localStorage 键名。`,
    1600
  );
  const plan = pickJson(rawText);

  if (!plan || !Array.isArray(plan.patches) || !plan.patches.length) {
    return jsonBody({
      ok: false,
      error: '模型没给出可用补丁',
      raw: String(rawText || '').slice(0, 800),
      log
    }, 502);
  }

  /* 4. 校验并应用 */
  const applied = [];
  for (const p of plan.patches.slice(0, MAX_PATCHES)) {
    const file = String(p.file || '');
    if (!EDITABLE.includes(file)) throw new Error('不允许改 ' + file);
    const find = String(p.find || '');
    const replace = String(p.replace || '');
    if (find.length < 12) throw new Error('find 太短，容易改错地方');
    const hits = files[file].split(find).length - 1;
    if (hits !== 1) throw new Error(`${file} 里命中 ${hits} 次（必须正好 1 次）`);
    if (/(eval\s*\(|document\.write|<script[^>]+src="https?:)/.test(replace)) throw new Error('替换内容含被禁止的写法');

    // 这些是踩过的坑：模型容易把原片段又抄一遍，造成重复定义 / 缺逗号
    if (replace.indexOf(find) >= 0) throw new Error('替换内容里原样带着被替换的片段，等于重复插入');
    const defs = (replace.match(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\(\)\s*\{/g) || [])
      .map((x) => (x.match(/([A-Za-z_$][\w$]*)\s*\(\)/) || [])[1])
      .filter(Boolean);
    for (const name of defs) {
      const re = new RegExp('(^|[\\s,{])' + name + '\\s*\\(\\)\\s*\\{');
      if (re.test(files[file])) throw new Error(`${file} 里已经有 ${name}()，再插一遍会重复定义`);
    }

    // 括号平衡：插入后整体必须配平，否则语法一定坏
    const bal = (t, a, b) => (t.split(a).length - t.split(b).length);
    const before = files[file];
    const after = before.replace(find, replace);
    if (bal(after, '{', '}') !== bal(before, '{', '}') ||
        bal(after, '(', ')') !== bal(before, '(', ')')) {
      throw new Error(`${file} 括号不配平，这一版会语法错误`);
    }
    files[file] = files[file].replace(find, replace);
    applied.push(file);
  }
  say(`补丁 ${applied.length} 处：${[...new Set(applied)].join(', ')}`);

  /* 5. 版本号与更新日志 */
  files[VERSION_FILE] = `/* 当前版本。自动迭代发布时会改写这个文件。 */\nwindow.XN_VERSION = "${plan.version || next}";\n`;
  const clFile = await readFile(owner, repo, CHANGELOG_FILE, token);
  const entry = {
    version: plan.version || next,
    date: new Date().toISOString().slice(0, 10),
    title: String(plan.title || '云端自迭代').slice(0, 30),
    fixes: Array.isArray(plan.fixes) ? plan.fixes.slice(0, 6) : [],
    features: Array.isArray(plan.features) ? plan.features.slice(0, 6) : [],
    source: 'cloud',
    feedbackCount: feedback.length
  };
  files[CHANGELOG_FILE] = clFile.content.replace(
    'window.XN_CHANGELOG = [',
    'window.XN_CHANGELOG = [\n' + JSON.stringify(entry, null, 2) + ','
  );

  if (dryRun) {
    return jsonBody({
      ok: true, dryRun: true,
      version: plan.version || next, title: entry.title,
      patches: applied, log,
      preview: files[EDITABLE[0]] === undefined ? '' : ''
    });
  }

  /* 6. 提交 */
  const message = `feat: ${entry.title} (v${entry.version})\n\n` +
    `云端自迭代 · 反馈 ${feedback.length} 条\n` +
    `改动：${[...new Set(applied)].join(', ')}\n` +
    `验证：补丁逐处唯一命中；未跑真机回归`;
  // README：版本号 + 最近更新
  const readme = await readFile(owner, repo, README_FILE, token);
  files[README_FILE] = patchReadme(readme.content, entry);
  say('README 已更新（版本块 + 最近更新）');

  const commits = {};
  for (const file of [...new Set([...applied, VERSION_FILE, CHANGELOG_FILE, README_FILE])]) {
    const cur2 = await readFile(owner, repo, file, token);
    commits[file] = await writeFile(owner, repo, file, files[file], cur2.sha, message, token);
    say(`提交 ${file} → ${commits[file]}`);
  }

  // 发版：创建 tag + release，GitHub Actions 会自动打 exe 挂上去
  const rel = await makeRelease(owner, repo, token, entry);
  if (rel.ok) say(rel.reused ? `tag v${entry.version} 已有 release，复用` : `已发版：${rel.url}（Actions 正在打 exe）`);
  else say(`发版失败（HTTP ${rel.status}）：${rel.error}`);

  return jsonBody({
    ok: true,
    version: entry.version,
    title: entry.title,
    patches: applied,
    commits,
    release: rel,
    url: `https://github.com/${owner}/${repo}/commits/main`,
    log
  });
}

export { patchReadme };
