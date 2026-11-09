/**
 * 小暖 · 云端自迭代
 *
 * 一次运行做这些事：
 *   读反馈 → 出方案 → 补丁校验 → 一次性提交（Git Data API）→ 打 tag
 * 发版交给 GitHub Actions（tag 触发），不再先建一个空 release。
 *
 * 安全边界由 worker.js 统一做：同源 + 管理员令牌 + 限流 + 体积上限。
 * 这里只处理业务，不接收明文密码。
 */

import {
  safeBase, b64encode, b64decode, bumpVersion
} from './shared.js';
import { validatePlan, balance } from './rules.js';

const EDITABLE = [
  'index.html',
  'assets/app.css',
  'assets/theme.css',
  'assets/app.core.js',
  'assets/views.study.js',
  'assets/views.feedback.js',
  'assets/views.settings.js',
  'assets/views.changelog.js',
  'assets/iterate.js',
  'assets/persona.js',
  'assets/emotion.js',
  'assets/memory.js',
  'assets/tools.js',
  'assets/lib/util.js',
  'assets/lib/store.js',
  'assets/lib/i18n.js',
  'assets/lib/md.js',
  'assets/lib/models.js',
  'assets/lib/api.js',
  'assets/lib/patch.js'
];

const VERSION_FILE = 'assets/version.js';
const CHANGELOG_FILE = 'assets/changelog.js';
const ARCHIVE_FILE = 'assets/changelog.archive.js';
const README_FILE = 'README.md';
const MAX_PATCHES = 8;
const TOTAL_BUDGET = 100000;
const FILE_BUDGET = 18000;

function jsonBody(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function ghFetch(url, token, init = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xiaonuan-cloud-iterate/1.5',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {})
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data, headers: res.headers };
}

async function readFile(owner, repo, path, branch, token, optional) {
  const r = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    token
  );
  if (r.status === 404 && optional) return { content: '', sha: '', missing: true };
  if (r.status !== 200) {
    const msg = (r.data && r.data.message) || ('HTTP ' + r.status);
    throw new Error(`读不到 ${path}（${msg}）`);
  }
  return { content: b64decode(r.data.content), sha: r.data.sha };
}

function parseArrayFile(text, name) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error(name + ' 格式不对，找不到数组');
  return JSON.parse(s.slice(a, b + 1));
}

function writeArrayFile(name, list, note) {
  return '/* ' + note + ' */\nwindow.' + name + ' = ' + JSON.stringify(list, null, 2) + ';\n';
}

function outline(code) {
  const lines = String(code || '').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s{0,4}(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|class\s+([A-Za-z_$][\w$]*))/);
    if (m && hits.length < 60) hits.push((i + 1) + ':' + (m[1] || m[2] || m[3]));
  });
  return hits.join(', ');
}

function digest(files) {
  const entries = Object.keys(files);
  const per = Math.max(6000, Math.min(FILE_BUDGET, Math.floor(TOTAL_BUDGET / Math.max(1, entries.length))));
  let used = 0;
  return entries.map((p) => {
    const text = String(files[p] || '');
    const room = Math.max(2000, Math.min(per, TOTAL_BUDGET - used));
    const body = text.length > room ? text.slice(0, room) + '\n/* …（本文件后面省略；如需改这里，find 要带足够上下文）*/' : text;
    used += Math.min(text.length, room);
    return `### ${p}（${text.split('\n').length} 行）\n结构：${outline(text)}\n\`\`\`\n${body}\n\`\`\``;
  }).join('\n\n');
}

async function askModel(env, opts, system, user, maxTokens) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  if (opts.apiKey) {
    const fallback = (env.XN_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const base = safeBase(opts.providerBase, fallback, env);
    const model = opts.model || env.XN_MODEL || 'deepseek-chat';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.apiKey },
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens || 3000 }),
        signal: ctrl.signal,
        redirect: 'error'
      });
      const text = await res.text();
      if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + text.slice(0, 180));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('模型返回的不是 JSON'); }
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } finally {
      clearTimeout(timer);
    }
  }

  if (!env.AI) throw new Error('服务器没有 AI 绑定，也没有提供模型 Key');
  const name = env.XN_ITER_MODEL || '@cf/zai-org/glm-4.7-flash';
  const params = { messages, max_tokens: maxTokens || 3000 };
  if (name.indexOf('glm') >= 0) params.chat_template_kwargs = { enable_thinking: false };
  const out = await env.AI.run(name, params);
  if (typeof out === 'string') return out;
  if (out && typeof out.response === 'string') return out.response;
  if (out && out.choices && out.choices[0] && out.choices[0].message) return out.choices[0].message.content || '';
  return '';
}

function pickJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  if (a < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(a, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function patchReadme(text, entry) {
  const crlf = /\r\n/.test(String(text));
  let c = String(text).replace(/\r\n/g, '\n');
  c = c.replace(
    /<!-- XN:VERSION -->[\s\S]*?<!-- \/XN:VERSION -->/,
    `<!-- XN:VERSION -->\n当前版本 **v${entry.version}**\n<!-- /XN:VERSION -->`
  );
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

function verifyFiles(files, touched) {
  for (const p of touched) {
    if (!/\.js$/.test(p)) continue;
    const bal = balance(files[p]);
    if (!bal.ok) return { ok: false, detail: p + ' 括号不配平：' + bal.reason };
  }
  const html = String(files['index.html'] || '');
  const refs = [...html.matchAll(/(?:src|href)="(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const missing = refs.filter((p) => !files[p] && !/^assets\/(theme|app)\.css$/.test(p));
  if (missing.length) return { ok: false, detail: 'index.html 引用了不存在的文件：' + missing.slice(0, 3).join('、') };
  return { ok: true, detail: '括号扫描通过；index.html 引用完整；未跑真机回归' };
}

async function loadFeedback(env) {
  if (!env.XN_KV) return [];
  const listed = await env.XN_KV.list({ prefix: 'fb:', limit: 50 });
  const rows = await Promise.all(listed.keys.map(async (k) => {
    const raw = await env.XN_KV.get(k.name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }));
  return rows.filter(Boolean).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

function feedbackText(feedback) {
  return feedback.slice(0, 30).map((f, i) =>
    `${i + 1}. [${f.type || '其他'}] ${String(f.body || '').slice(0, 200)}`
  ).join('\n') || '（没有新反馈；请基于代码结构做一次自检）';
}

export async function runIteration(env, opts) {
  opts = opts || {};
  if (opts.authorized !== true) return jsonBody({ ok: false, error: '未授权' }, 401);

  const owner = String(env.XN_REPO_OWNER || '').trim();
  const repo = String(env.XN_REPO_NAME || '').trim();
  const token = String(opts.token || env.XN_GH_TOKEN || '').trim();
  const dryRun = !!opts.dryRun;
  const triageOnly = !!opts.triageOnly;

  if (!owner || !repo) {
    return jsonBody({ ok: false, error: '服务器没有锁定发布仓库（XN_REPO_OWNER / XN_REPO_NAME）' }, 501);
  }
  if (!token && !dryRun) {
    return jsonBody({ ok: false, error: '服务器没有 GitHub Token（XN_GH_TOKEN），也没有临时提供' }, 400);
  }

  const log = [];
  const started = Date.now();
  const say = (t) => log.push(t);

  say('仓库锁定：' + owner + '/' + repo);
  say('模式：' + (triageOnly ? '只整理反馈' : dryRun ? '试运行' : '真跑'));

  /* 1. 反馈 */
  let feedback = [];
  try {
    feedback = await loadFeedback(env);
    say(`云端反馈 ${feedback.length} 条`);
  } catch (e) {
    say('读反馈失败：' + e.message);
  }

  if (triageOnly) {
    if (!feedback.length) {
      say('没有反馈，工单为空');
      return jsonBody({ ok: true, triageOnly: true, tickets: [], log });
    }
    const raw = await askModel(
      env, opts,
      '你是工单拆解器。把用户反馈拆成可执行工单，合并重复项，不发明用户没说过的问题。只输出 JSON。',
      `反馈：\n${feedbackText(feedback)}\n\n输出：{"tickets":[{"title":"不超过16字","kind":"bug|feature|content","severity":1-3,"why":"依据","scope":"页面或文件"}]}\n最多 5 条。没有可做的就返回 {"tickets":[]}。`,
      1200
    );
    const data = pickJson(raw);
    const tickets = Array.isArray(data && data.tickets) ? data.tickets.slice(0, 5) : [];
    say('拆出 ' + tickets.length + ' 条工单');
    return jsonBody({ ok: true, triageOnly: true, tickets, log });
  }

  /* 2. 仓库信息与文件（并行） */
  const info = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
  if (info.status !== 200) {
    return jsonBody({ ok: false, error: '读仓库失败：' + ((info.data && info.data.message) || info.status), log }, 502);
  }
  const branch = info.data.default_branch || 'main';
  say('默认分支：' + branch);

  const optional = new Set([ARCHIVE_FILE]);
  const reads = await Promise.all(EDITABLE.concat([README_FILE, CHANGELOG_FILE, ARCHIVE_FILE]).map(async (p) => {
    try {
      const f = await readFile(owner, repo, p, branch, token, optional.has(p));
      return [p, f];
    } catch (e) {
      return [p, { error: e.message }];
    }
  }));

  const files = {};
  const missing = [];
  reads.forEach(([p, f]) => {
    if (f.error) missing.push(p + '：' + f.error);
    else files[p] = f.content;
  });
  if (missing.length) {
    return jsonBody({ ok: false, error: '读文件失败：' + missing.slice(0, 3).join('；'), log }, 502);
  }

  const recent = parseArrayFile(files[CHANGELOG_FILE], 'changelog.js');
  const cur = (recent[0] && recent[0].version) ||
    (String(files[VERSION_FILE] || '').match(/XN_VERSION\s*=\s*["']([^"']+)["']/) || [])[1] ||
    '1.5.0';
  say(`当前版本 ${cur}，最近版本 ${(recent[0] && recent[0].version) || '?'}`);

  /* 3. 模型出方案 */
  const cacheKey = 'iterate:plan:' + owner + '/' + repo;
  if (dryRun && env.XN_KV && opts.useCache !== false) {
    try {
      const cached = await env.XN_KV.get(cacheKey, 'json');
      if (cached && cached.at && Date.now() - cached.at < 600000) {
        say('命中 10 分钟内的试运行方案，没有重复调用模型');
        return jsonBody(Object.assign({}, cached.result, { log, cacheHit: true }), 200);
      }
    } catch (e) { /* 缓存坏了继续 */ }
  }

  const planPrompt = `仓库：${owner}/${repo}，当前版本 ${cur}。\n\n` +
    `用户反馈：\n${feedbackText(feedback)}\n\n` +
    `代码（节选，按文件给结构 + 正文）：\n${digest(files)}\n\n` +
    `请挑 1 个最值得做的问题，给出可验证的改动。允许大改，但一次最多重写 3 个文件或新建 2 个。\n` +
    `输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n` +
    `{"mode":"patch|rewrite","bump":"patch|minor|major","title":"不超过18字","fixes":["改了什么"],"features":[],"verify":"你打算怎么验证","notTried":"你没法验证什么",` +
    `"patches":[{"file":"白名单文件","find":"原文里逐字存在且只出现一次的片段","replace":"替换成"}],` +
    `"rewrites":[{"file":"","content":"完整文件"}],"creates":[{"file":"assets/新文件.js","content":"..."}]}\n` +
    `规则：file 只能是 ${EDITABLE.join(' / ')}；find 至少 8 字；最多 ${MAX_PATCHES} 处；` +
    `不许 eval / new Function / document.write / 外链脚本 / javascript:；不许改 server、cloudflare、.github、tests；` +
    `patch 模式不要同时给 rewrites。`;

  say('把 ' + Object.keys(files).length + ' 个文件交给模型…');
  const rawText = await askModel(
    env, opts,
    '你是代码修改计划器。只输出一个 JSON 对象。改动必须小、可验证、能通过括号扫描。',
    planPrompt,
    4200
  );
  const plan = pickJson(rawText);
  if (!plan) {
    return jsonBody({ ok: false, error: '模型没给出可解析的 JSON', raw: String(rawText || '').slice(0, 600), log }, 502);
  }

  const bump = ['patch', 'minor', 'major'].indexOf(plan.bump) >= 0 ? plan.bump : 'patch';
  const next = bumpVersion(cur, bump);
  plan.version = next;

  /* 4. 校验并应用 */
  let applied;
  try {
    applied = validatePlan(files, plan, EDITABLE, { maxPatches: MAX_PATCHES, maxRewrites: 3, maxCreates: 2 });
  } catch (e) {
    const attempt = {
      title: String(plan.title || '').slice(0, 40),
      mode: plan.mode,
      patches: (plan.patches || []).slice(0, MAX_PATCHES).map((p) => ({
        file: p.file,
        find: String(p.find || '').slice(0, 120)
      })),
      rewrites: (plan.rewrites || []).map((r) => r.file),
      reason: e.message
    };
    return jsonBody({ ok: false, error: '这一版没通过校验：' + e.message, attempt, log }, 422);
  }
  say(`方案：${plan.title || '未命名'}（${applied.mode}，动 ${applied.touched.length} 个文件）`);

  const entry = {
    version: next,
    date: new Date().toISOString().slice(0, 10),
    title: String(plan.title || '云端自迭代').slice(0, 30),
    fixes: Array.isArray(plan.fixes) ? plan.fixes.map((x) => String(x).slice(0, 120)).slice(0, 8) : [],
    features: Array.isArray(plan.features) ? plan.features.map((x) => String(x).slice(0, 120)).slice(0, 8) : [],
    source: 'cloud',
    feedbackCount: feedback.length,
    notes: String(plan.notTried || '').slice(0, 200)
  };
  if (!entry.fixes.length && !entry.features.length) entry.fixes.push(entry.title);

  /* 5. 版本、更新日志、README */
  const out = applied.files;
  out[VERSION_FILE] = '/* 当前版本。从更新日志首条推导，避免两处不一致。 */\n' +
    'window.XN_VERSION = (window.XN_CHANGELOG && window.XN_CHANGELOG[0] && window.XN_CHANGELOG[0].version) || ' +
    JSON.stringify(next) + ';\n';

  const recentList = [entry].concat(recent.filter((x) => x.version !== next));
  const archiveText = files[ARCHIVE_FILE] || 'window.XN_CHANGELOG_ARCHIVE = [];\n';
  let archive = [];
  try { archive = parseArrayFile(archiveText, 'changelog.archive.js'); } catch (e) { archive = []; }
  const overflow = recentList.slice(12);
  out[CHANGELOG_FILE] = writeArrayFile('XN_CHANGELOG', recentList.slice(0, 12), '版本记录（最近 12 条）。');
  if (overflow.length) {
    out[ARCHIVE_FILE] = writeArrayFile('XN_CHANGELOG_ARCHIVE', overflow.concat(archive).slice(0, 300), '旧版本记录（只读归档）。');
  }

  out[README_FILE] = patchReadme(files[README_FILE] || '', entry);
  say('版本：' + cur + ' → ' + next + '（' + bump + '）');
  say('README 已更新（版本块 + 最近更新）');

  const check = verifyFiles(out, Object.keys(out));
  say(check.detail);
  if (!check.ok) {
    return jsonBody({
      ok: false,
      error: '自检没通过：' + check.detail,
      attempt: { title: entry.title, patches: (plan.patches || []).map((p) => ({ file: p.file })) },
      log
    }, 422);
  }

  const changedFiles = [...new Set(applied.touched.concat([VERSION_FILE, CHANGELOG_FILE, ARCHIVE_FILE, README_FILE]))]
    .filter((p) => typeof out[p] === 'string');

  const result = {
    ok: true,
    dryRun,
    version: next,
    title: entry.title,
    fixes: entry.fixes,
    features: entry.features,
    verify: check.detail,
    notTried: entry.notes,
    files: changedFiles,
    patches: applied.touched,
    log
  };

  if (dryRun) {
    if (env.XN_KV) {
      try {
        await env.XN_KV.put(cacheKey, JSON.stringify({ at: Date.now(), result }), { expirationTtl: 900 });
      } catch (e) { /* 缓存写不进不影响结果 */ }
    }
    say('试运行结束，没有写入仓库。');
    return jsonBody(result, 200);
  }

  /* 6. 一次性提交 */
  const ref = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
  if (ref.status !== 200) return jsonBody({ ok: false, error: '读分支失败：' + ((ref.data && ref.data.message) || ref.status), log }, 502);
  const headSha = ref.data.object.sha;
  const head = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${headSha}`, token);
  if (head.status !== 200) return jsonBody({ ok: false, error: '读提交失败', log }, 502);

  say('上传 ' + changedFiles.length + ' 个 blob…');
  const blobs = await Promise.all(changedFiles.map(async (p) => {
    const b = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, token, {
      method: 'POST',
      body: JSON.stringify({ content: b64encode(out[p]), encoding: 'base64' })
    });
    if (b.status !== 201) throw new Error('创建 blob 失败：' + p + '（' + b.status + '）');
    return { path: p, mode: '100644', type: 'blob', sha: b.data.sha };
  }));

  const tree = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: head.data.tree.sha, tree: blobs })
  });
  if (tree.status !== 201) return jsonBody({ ok: false, error: '建 tree 失败：' + ((tree.data && tree.data.message) || tree.status), log }, 502);

  const message = [
    `feat: ${entry.title} (v${next})`,
    '',
    `云端自迭代 · 反馈 ${feedback.length} 条`,
    `改到：${changedFiles.join('、')}`,
    `验证：${check.detail}`,
    `没验证：${entry.notes || '真机、多浏览器、真实服务商'}`
  ].join('\n');

  const commit = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.data.sha, parents: [headSha] })
  });
  if (commit.status !== 201) return jsonBody({ ok: false, error: '建提交失败：' + ((commit.data && commit.data.message) || commit.status), log }, 502);

  const upd = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.data.sha, force: false })
  });
  if (upd.status !== 200) {
    return jsonBody({ ok: false, error: '更新分支失败（可能有并发提交），提交已生成但没进分支：' + commit.data.sha.slice(0, 7), log }, 409);
  }
  say('已提交 ' + commit.data.sha.slice(0, 7) + ' 到 ' + branch);

  /* 7. 打 tag：由 release.yml 在 tag 上打 exe 并创建 release */
  const tag = 'v' + next;
  let tagState = 'created';
  const tagRes = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/tags/' + tag, sha: commit.data.sha })
  });
  if (tagRes.status === 422) tagState = 'exists';
  else if (tagRes.status !== 201) {
    tagState = 'failed';
    say('打 tag 失败：' + ((tagRes.data && tagRes.data.message) || tagRes.status));
  } else {
    say('已打 tag ' + tag + '，Actions 会开始打 exe');
  }

  say('完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒');
  return jsonBody(Object.assign({}, result, {
    tag: tagState === 'created' ? tag : '',
    tagState,
    commit: commit.data.sha.slice(0, 7),
    branch,
    url: `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
    releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${tag}`
  }), 200);
}

export { patchReadme, pickJson, verifyFiles };
