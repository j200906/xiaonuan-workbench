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
  safeBase, b64encode, b64decode, bumpVersion, cmpVersion, parseVersion
} from './shared.js';
import { validatePlan, balance, warnings as changeWarnings } from './rules.js';
import {
  loadLessons, recordFailure, renderLessons, lessonsForPrompt, LESSONS_FILE, HARD_THRESHOLD
} from './lessons.js';

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
  'assets/lib/patch.js',
  'assets/lib/plugin.js',
  'assets/lib/services.js',
  'assets/lib/session.js',
  'assets/plugins/view-chat.js',
  'assets/plugins/manifest.js',
  'assets/plugins/export-session.js'
];

const VERSION_FILE = 'assets/version.js';
const CHANGELOG_FILE = 'assets/changelog.js';
const ARCHIVE_FILE = 'assets/changelog.archive.js';
const README_FILE = 'README.md';
const PKG_FILE = 'package.json';
const MAX_PATCHES = 8;
const TOTAL_BUDGET = 60000;
const FILE_BUDGET = 18000;
/* 试运行方案缓存寿命：读和写必须用同一个数字（Q68：之前读判 600000ms、写 TTL 900s）。 */
const PLAN_CACHE_TTL_SECONDS = 900;

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
  /* 没有超时的请求会把整轮迭代挂死（实测一次卡 15 分钟、CPU 几乎为 0）。 */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { ...init, headers, signal: init.signal || ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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

/* 把原数组拆成「每一项的原始文本」（只在顶层逗号处切，字符串里的逗号不算）。
   复用原始文本是为了 Q74：重排版本列表时不要用 JSON.stringify 把整份文件重写一遍，
   那样头部注释、缩进、键顺序全丢，diff 会大得没法 review。 */
function splitEntries(raw) {
  const s = String(raw || '');
  const out = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (s.slice(start).trim()) out.push(s.slice(start));
  return out.filter((x) => x.trim());
}

function stableText(value) {
  if (Array.isArray(value)) return '[' + value.map(stableText).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableText(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function indentJson(text, pad, eol) {
  return String(text).split('\n').map((line, i) => (i ? pad + line : line)).join(eol || '\n');
}

/* 版本数组文件：头部注释和没变的条目原样保留，只插新条目、删超出上限的旧条目（Q74）。 */
export function writeArrayFile(name, list, note, original) {
  const prev = String(original || '');
  const eol = /\r\n/.test(prev) ? '\r\n' : '\n';
  const open = prev.indexOf('[');
  const close = prev.lastIndexOf(']');
  const fallback = '/* ' + note + ' */' + eol + 'window.' + name + ' = ' + JSON.stringify(list, null, 2) + ';' + eol;
  if (open < 0 || close <= open) return fallback;

  const head = prev.slice(0, open);
  const tail = prev.slice(close + 1);
  const raw = prev.slice(open + 1, close);
  const keep = {};
  let pad = '  ';
  splitEntries(raw).forEach((chunk) => {
    let parsed = null;
    try { parsed = JSON.parse(chunk); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || !parsed.version) return;
    const m = chunk.match(/\r?\n([ \t]+)\S/);
    if (m && pad === '  ') pad = m[1];
    if (!keep[parsed.version]) keep[parsed.version] = { text: chunk.replace(/\s+$/, ''), value: parsed };
  });

  const parts = list.map((item) => {
    const hit = item && item.version && keep[item.version];
    if (hit && stableText(hit.value) === stableText(item)) return hit.text;
    return eol + pad + indentJson(JSON.stringify(item, null, 2), pad, eol);
  });
  if (!parts.length) return head + '[]' + tail;
  return head + '[' + parts.join(',') + eol + ']' + tail;
}

/* 结构列表：抓 function / 箭头函数 / 类 / 对象方法 / 对象属性。
   以前只认 `const x = (`，箭头函数（`const x = a =>`）、对象方法（`foo(a) {`）、
   对象属性（`foo: (a) =>`）全漏，模型以为「不存在」就会重复定义（Q64）。 */
const OUTLINE_RULES = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  /[{,]\s*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /[{,]\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/
];

const OUTLINE_SKIP = ['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'constructor', 'else', 'do', 'try', 'finally', 'with', 'await', 'new'];

export function outline(code) {
  const lines = String(code || '').split('\n');
  const hits = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && hits.length < 60; i++) {
    const line = lines[i];
    for (const re of OUTLINE_RULES) {
      const m = line.match(re);
      const name = m && m[1];
      if (!name || OUTLINE_SKIP.indexOf(name) >= 0 || seen.has(name)) continue;
      seen.add(name);
      hits.push((i + 1) + ':' + name);
      break;
    }
  }
  return hits.join(', ');
}

function lineSpan(text, from, to) {
  const start = text.slice(0, from).split('\n').length;
  const len = Math.max(1, text.slice(from, to).split('\n').length - 1);
  return start + '–' + (start + len);
}

/* 给模型的代码节选：每个文件只给头尾两段，中间只留一行标注。
   同时返回 windows（可见字符区间）：调用方用它执行「看不到的段落不许改」（Q62/Q63），
   而不是加大预算去赌模型能记住中段。 */
export function digest(files) {
  const entries = Object.keys(files);
  /* 每份额度 = min(单文件上限, 均分总预算)。以前有个 6000 的地板，文件一多
     实际总量会远超 TOTAL_BUDGET（23 个文件实测 87k 字符，Q63 复核 M2）。 */
  const per = Math.max(1200, Math.min(FILE_BUDGET, Math.floor(TOTAL_BUDGET / Math.max(1, entries.length))));
  const windows = {};
  let used = 0;
  const text = entries.map((p) => {
    const src = String(files[p] || '');
    const room = Math.min(per, TOTAL_BUDGET - used);
    let body = src;
    if (room < 400) {
      /* 预算用完：只给结构，并且 windows 为空 —— 这个文件本轮任何 patch 都会被拒。 */
      body = `/* 预算已用完（${TOTAL_BUDGET} 字符），这里只给结构；不要对这个文件下 patch */`;
      windows[p] = [];
    } else if (src.length > room) {
      /* 头和尾都要给。只给开头时，模型看不到文件后半段的函数，
         就会照着「结构」列表凭空编出 find（实测就是这么失败的）。 */
      const head = Math.floor(room * 0.55);
      const tail = room - head;
      const cutEnd = src.length - tail;
      body = src.slice(0, head) +
        `\n/* …（中间省略 ${cutEnd - head} 字，第 ${lineSpan(src, head, cutEnd)} 行，这段看不到，不要对它下 patch）… */\n` +
        src.slice(cutEnd);
      windows[p] = [[0, head], [cutEnd, src.length]];
      used += Math.min(src.length, room);
    } else {
      windows[p] = [[0, src.length]];
      used += src.length;
    }
    return `### ${p}（${src.split('\n').length} 行）\n结构：${outline(src)}\n\`\`\`\n${body}\n\`\`\``;
  }).join('\n\n');
  return { text, windows };
}

/* 「看不到就不许改」的执行点：find 只命中省略区间，说明模型是在照结构猜，直接拒绝。
   找不到原文的不在这里管（交给 rules.js 报「找不到原文」，措辞更准）。 */
export function screenPatches(files, patches, windows) {
  const keep = [];
  const dropped = [];
  (patches || []).forEach((p, idx) => {
    const file = String((p && p.file) || '');
    const find = String((p && p.find) || '');
    const spans = windows && windows[file];
    const src = String(files[file] || '');
    const at = find ? src.indexOf(find) : -1;
    if (!spans || at < 0) { keep.push(p); return; }
    const visible = spans.some(([a, b]) => at >= a && at + find.length <= b);
    if (visible) { keep.push(p); return; }
    dropped.push({ index: idx + 1, file, reason: 'find 落在省略区间（看不到的中段），不许改' });
  });
  return { patches: keep, dropped };
}

/* 本机网关的地址：云端必须 https + 白名单主机（防 SSRF），
   而本机后端用同一个文件跑，127.0.0.1 得放行——只有显式开 XN_ALLOW_LOCAL_GATEWAY 才认。 */
function gatewayBase(env) {
  const raw = String((env && env.XN_GATEWAY_BASE) || '').trim();
  if (!raw) return '';
  const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(raw);
  if (local) return String(env.XN_ALLOW_LOCAL_GATEWAY) === '1' ? raw.replace(/\/+$/, '') : '';
  return safeBase(raw, '', env);
}

async function askUpstream(base, key, model, messages, maxTokens, effort) {
  const once = async () => {
    const ctrl = new AbortController();
    /* 大提示词 + 会思考的模型，180 秒经常不够，放宽到 5 分钟 */
    const timer = setTimeout(() => ctrl.abort(), 300000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = 'Bearer ' + key;
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(Object.assign(
          { model, messages, temperature: 0.2, max_tokens: maxTokens || 3000 },
          /* 自迭代要的是「想清楚再改」，思考强度由界面传，默认拉满。 */
          /^(marvis\/|.*deepseek-v4)/i.test(model) ? { reasoning_effort: effort || 'max' } : {}
        )),
        signal: ctrl.signal,
        redirect: 'manual'
      });
      const text = await res.text();
      if (res.status >= 300 && res.status < 400) throw new Error('模型网关返回了重定向，已拒绝跟随');
      if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + text.slice(0, 180));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('模型返回的不是 JSON'); }
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      return {
        text: msg.content || '',
        reasoning: String(msg.reasoning_content || '')
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /* 网关偶发 connection reset，重试一次再判死；但超时（AbortError）重试只会更慢，直接抛。 */
  try {
    return await once();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('模型调用超时（5 分钟没返回）');
    await new Promise((r) => setTimeout(r, 1500));
    return await once();
  }
}

async function askModel(env, opts, system, user, maxTokens) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  /* Workers AI 兜底：用户自带的 Key 或本机网关挂了时，只要有 AI 绑定就继续跑，
     别让整轮迭代陪葬。 */
  const askAI = async () => {
    const name = env.XN_ITER_MODEL || '@cf/zai-org/glm-4.7-flash';
    const params = { messages, max_tokens: maxTokens || 3000 };
    if (name.indexOf('glm') >= 0) params.chat_template_kwargs = { enable_thinking: false };
    const out = await env.AI.run(name, params);
    let text = '';
    if (typeof out === 'string') text = out;
    else if (out && typeof out.response === 'string') text = out.response;
    else if (out && out.choices && out.choices[0] && out.choices[0].message) text = out.choices[0].message.content || '';
    return { text, reasoning: '', fallback: 'workers-ai' };
  };

  if (opts.apiKey) {
    const fallback = (env.XN_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const base = safeBase(opts.providerBase, fallback, env);
    const model = opts.model || env.XN_MODEL || 'deepseek-chat';
    try {
      return await askUpstream(base, opts.apiKey, model, messages, maxTokens, opts.reasoningEffort);
    } catch (e) {
      /* 用户的 Key 也可能失效／超额／上游抖动：有 AI 绑定就退回 Workers AI，
         没有绑定才照原样报错。 */
      if (!env.AI) throw e;
      try {
        return await askAI();
      } catch (e2) {
        throw new Error('自带 Key 的模型不可用（' + e.message + '），退回 Workers AI 也失败（' + e2.message + '）');
      }
    }
  }

  /* 本机网关优先：它挂的是能写代码的模型，比 Workers AI 自带那个 flash 强得多。
     但网关可能挂掉（隧道过期之类），挂了就退回 AI 绑定，别让整轮迭代陪葬。 */
  const gw = gatewayBase(env);
  if (gw) {
    const model = opts.model || env.XN_GATEWAY_MODEL || '';
    if (model) {
      try {
        return await askUpstream(gw, env.XN_GATEWAY_KEY || '', model, messages, maxTokens, opts.reasoningEffort);
      } catch (e) {
        if (!env.AI) throw new Error('本机网关不可用（' + e.message + '），也没有 AI 绑定可以退回');
      }
    }
  }

  if (!env.AI) throw new Error('服务器没有 AI 绑定，也没有提供模型 Key');
  return askAI();
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

/* README 的版本块/最近更新块。标记写成更宽松的形式（标记里多个空格也认），
   并且把「有没有命中」返回出去——以前找不到标记就静默返回原文，README 结构一改
   版本块就永远停在旧值，谁也不知道（Q75）。 */
const README_VERSION_BLOCK = /<!--\s*XN:VERSION\s*-->[\s\S]*?<!--\s*\/\s*XN:VERSION\s*-->/;
const README_RECENT_BLOCK = /<!--\s*XN:RECENT\s*-->\s*([\s\S]*?)<!--\s*\/\s*XN:RECENT\s*-->/;

export function patchReadmeChecked(text, entry) {
  const src = String(text || '');
  if (!README_VERSION_BLOCK.test(src)) {
    return { text: src, ok: false, reason: 'README 里找不到 <!-- XN:VERSION --> 标记' };
  }
  const crlf = /\r\n/.test(src);
  let c = src.replace(/\r\n/g, '\n');
  c = c.replace(
    README_VERSION_BLOCK,
    `<!-- XN:VERSION -->\n当前版本 **v${entry.version}**\n<!-- /XN:VERSION -->`
  );
  let recent = false;
  const bullet = `- **v${entry.version}** ${entry.title}`;
  const m = c.match(README_RECENT_BLOCK);
  if (m) {
    recent = true;
    const lines = m[1].split('\n').map((x) => x.trim()).filter(Boolean);
    const keep = [bullet, ...lines.filter((x) => x.indexOf('**v' + entry.version + '**') < 0)].slice(0, 5);
    c = c.replace(
      README_RECENT_BLOCK,
      `<!-- XN:RECENT -->\n${keep.join('\n')}\n<!-- /XN:RECENT -->`
    );
  }
  return {
    text: crlf ? c.replace(/\n/g, '\r\n') : c,
    ok: true,
    reason: recent ? '' : 'README 里找不到 <!-- XN:RECENT --> 标记（版本块已更新，最近更新没动）'
  };
}

function patchReadme(text, entry) {
  return patchReadmeChecked(text, entry).text;
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

/* ---------- 试运行缓存 ---------- */

function hashText(s) {
  /* FNV-1a 32 位：只用来做缓存 key，不需要抗碰撞。 */
  let h = 0x811c9dc5;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* 缓存 key 必须带上「这一轮实际输入」（Q67）：只按 owner/repo 存，改了反馈、
   换了模型/思考强度，10 分钟内还是会把旧方案原样还给你。 */
export function planCacheKey(owner, repo, ctx) {
  const c = ctx || {};
  const feedback = (c.feedback || []).map((f) =>
    [String(f.ts || ''), String(f.type || ''), String(f.body || '').slice(0, 160)].join('|'));
  const material = [
    'branch=' + (c.branch || ''),
    'version=' + (c.version || ''),
    'model=' + (c.model || ''),
    'effort=' + (c.effort || ''),
    'feedback=' + feedback.join('\n')
  ].join('\n');
  return 'iterate:plan:v2:' + owner + '/' + repo + ':' + hashText(material);
}

/* 读缓存时的新鲜度判定，和写入用的 TTL 是同一个常量（Q68）。 */
export function cacheFresh(at, now) {
  const t = Number(at);
  if (!t) return false;
  const n = typeof now === 'number' ? now : Date.now();
  return n - t < PLAN_CACHE_TTL_SECONDS * 1000;
}

/* ---------- 版本 ---------- */

/* 当前版本取多源最大 semver（Q73）：只信 changelog[0] 的话，手改首条或漏同步
   package.json 都会让版本跳变/回退。所有候选里取最大的那个再 +1 才稳。 */
export function pickBaseVersion(list, fallback) {
  let best = '';
  (list || []).forEach((v) => {
    const s = String(v || '').trim();
    if (!parseVersion(s)) return;
    if (!best || cmpVersion(s, best) > 0) best = s;
  });
  return best || fallback || '';
}

/* ---------- tag ---------- */

/* 422 不能一律当 exists（Q72）：同名的 tag 可能指着旧 commit。
   annotated tag 要先 deref（git/tags/<sha>）才能拿到它指向的 commit。 */
export function resolveTagTarget(refData, annotated) {
  const obj = refData && refData.object;
  if (!obj || !obj.sha) return '';
  if (obj.type === 'tag') {
    const inner = annotated && annotated.object;
    return inner && inner.type === 'commit' ? inner.sha : '';
  }
  return obj.type === 'commit' ? obj.sha : '';
}

/* 把已经传好的 blob 挂到分支上。只推一次：409 说明分支被并发提交顶掉了，
   交给调用方（runIteration）重新读取文件、用原 plan 重跑 validatePlan/verifyFiles
   之后再用新 blobs 构造提交 —— 绝不能拿「按旧基线校验过的 blobs」直接覆盖别人的提交。
   （K5：原来这里直接换新 head 重建 tree/commit，会静默覆盖并发提交里同一文件的改动。） */
async function pushChanges(owner, repo, branch, token, blobs, message) {
  const ref = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
  if (ref.status !== 200) {
    return { ok: false, status: 502, error: '读分支失败：' + ((ref.data && ref.data.message) || ref.status) };
  }
  const headSha = ref.data.object.sha;
  const head = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${headSha}`, token);
  if (head.status !== 200) return { ok: false, status: 502, error: '读提交失败：' + head.status };

  const tree = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: head.data.tree.sha, tree: blobs })
  });
  if (tree.status !== 201) {
    return { ok: false, status: 502, error: '建 tree 失败：' + ((tree.data && tree.data.message) || tree.status) };
  }

  const commit = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.data.sha, parents: [headSha] })
  });
  if (commit.status !== 201) {
    return { ok: false, status: 502, error: '建提交失败：' + ((commit.data && commit.data.message) || commit.status) };
  }

  const upd = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.data.sha, force: false })
  });
  if (upd.status === 200) return { ok: true, sha: commit.data.sha, headSha };
  /* 409 时 commit.data.sha 是「不在任何分支上」的孤儿提交：不放进结果，避免用户以为已提交。 */
  return {
    ok: false,
    status: upd.status === 409 ? 409 : 502,
    headSha,
    error: '更新分支失败：' + ((upd.data && upd.data.message) || ('HTTP ' + upd.status))
  };
}

export async function runIteration(env, opts) {
  opts = opts || {};
  if (opts.authorized !== true) return jsonBody({ ok: false, error: '未授权' }, 401);

  const owner = String(env.XN_REPO_OWNER || '').trim();
  const repo = String(env.XN_REPO_NAME || '').trim();
  const token = String(opts.token || env.XN_GH_TOKEN || '').trim();
  const dryRun = !!opts.dryRun;
  const triageOnly = !!opts.triageOnly;
  const EFFORTS = ['low', 'medium', 'high', 'max'];
  opts.reasoningEffort = EFFORTS.indexOf(String(opts.reasoningEffort || '')) >= 0
    ? String(opts.reasoningEffort) : 'max';

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

  /* 工单拆解：单独的「整理反馈」走一次；真跑也顺带跑一次，前端队列才有数据。 */
  let tickets = [];
  const triageFeedback = async () => {
    if (!feedback.length) {
      say('没有反馈，工单为空');
      return [];
    }
    const triage = await askModel(
      env, opts,
      '你是工单拆解器。把用户反馈拆成可执行工单，合并重复项，不发明用户没说过的问题。只输出 JSON。',
      `反馈：\n${feedbackText(feedback)}\n\n输出：{"tickets":[{"title":"不超过16字","kind":"bug|feature|content","severity":1-3,"why":"依据","scope":"页面或文件"}]}\n最多 5 条。没有可做的就返回 {"tickets":[]}。`,
      1200
    );
    const data = pickJson(triage.text);
    const list = Array.isArray(data && data.tickets) ? data.tickets.slice(0, 5) : [];
    say('拆出 ' + list.length + ' 条工单');
    return list;
  };

  if (triageOnly) {
    tickets = await triageFeedback();
    return jsonBody({ ok: true, triageOnly: true, tickets, log });
  }

  /* 真跑：把 triage 结果一并回传（前端队列要用）；拆不动只记一笔，不影响这次改动。 */
  if (!dryRun) {
    try {
      tickets = await triageFeedback();
    } catch (e) {
      say('工单拆解失败（不影响这次改动）：' + e.message);
      tickets = [];
    }
  }

  /* 2. 仓库信息与文件（并行） */
  const info = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, token);
  if (info.status !== 200) {
    return jsonBody({ ok: false, error: '读仓库失败：' + ((info.data && info.data.message) || info.status), ...(dryRun ? {} : { tickets }), log }, 502);
  }
  const branch = String(opts.branch || env.XN_ITER_BRANCH || '').trim() || info.data.default_branch || 'main';
  const trialBranch = branch !== (info.data.default_branch || 'main');
  say('目标分支：' + branch + (trialBranch ? '（试跑分支，不打 tag）' : ''));

  const optional = new Set([ARCHIVE_FILE, LESSONS_FILE]);
  /* GitHub contents API 自带每个文件的 blob sha：记下来当基线。
     409 后重新读取时用它对出「这期间哪些文件被并发改过」，并重跑校验（K5）。 */
  const readSourceFiles = async () => {
    const shas = {};
    const reads = await Promise.all(EDITABLE.concat([README_FILE, CHANGELOG_FILE, ARCHIVE_FILE, LESSONS_FILE, PKG_FILE]).map(async (p) => {
      try {
        const f = await readFile(owner, repo, p, branch, token, optional.has(p));
        return [p, f];
      } catch (e) {
        return [p, { error: e.message }];
      }
    }));
    const filesNow = {};
    const missing = [];
    reads.forEach(([p, f]) => {
      if (f.error) missing.push(p + '：' + f.error);
      else {
        filesNow[p] = f.content;
        shas[p] = f.sha || '';
      }
    });
    return { files: filesNow, shas, missing };
  };
  const source = await readSourceFiles();
  const files = source.files;
  const fileShas = source.shas;
  if (source.missing.length) {
    return jsonBody({ ok: false, error: '读文件失败：' + source.missing.slice(0, 3).join('；'), ...(dryRun ? {} : { tickets }), log }, 502);
  }

  const recent = parseArrayFile(files[CHANGELOG_FILE], 'changelog.js');
  let earlyPkg = null;
  try { earlyPkg = JSON.parse(String(files[PKG_FILE] || '{}')); } catch (e) { earlyPkg = null; }
  const cur = pickBaseVersion([
    ...recent.map((x) => x && x.version),
    (String(files[VERSION_FILE] || '').match(/XN_VERSION\s*=\s*["']([^"']+)["']/) || [])[1],
    earlyPkg && earlyPkg.version
  ], '1.5.0');
  const recentTop = (recent[0] && recent[0].version) || '';
  say(`当前版本 ${cur}，最近版本 ${recentTop || '?'}`);
  if (recentTop && cmpVersion(cur, recentTop) > 0) {
    say(`注意：更新日志首条是 ${recentTop}，但 package.json / version.js 里有更高版本，按 ${cur} 继续（避免版本回退）`);
  }

  /* 教训：改代码前先读，这是 magpie 那套机制里最关键的一步。 */
  const lessons = await loadLessons(env, files[LESSONS_FILE]);
  if (lessons.length) {
    const hard = lessons.filter((l) => Number(l.seen) >= HARD_THRESHOLD).length;
    say(`历史教训 ${lessons.length} 条（硬规则 ${hard} 条），已并入提示词`);
  } else {
    say('还没有历史教训');
  }

  /* 3. 模型出方案 */
  const digestInfo = digest(files);
  const cacheKey = planCacheKey(owner, repo, {
    branch,
    version: cur,
    model: [opts.model, env.XN_MODEL, env.XN_GATEWAY_MODEL, env.XN_ITER_MODEL].filter(Boolean).join(','),
    effort: opts.reasoningEffort,
    feedback
  });
  if (dryRun && env.XN_KV && opts.useCache !== false) {
    try {
      const cached = await env.XN_KV.get(cacheKey, 'json');
      if (cached && cacheFresh(cached.at)) {
        say(`命中 ${PLAN_CACHE_TTL_SECONDS / 60} 分钟内的同输入试运行方案，没有重复调用模型`);
        return jsonBody(Object.assign({}, cached.result, { log, cacheHit: true }), 200);
      }
    } catch (e) { /* 缓存坏了继续 */ }
  }

  const planPrompt = `仓库：${owner}/${repo}，当前版本 ${cur}。\n\n` +
    `历史教训（以前踩过的坑，逐条对照，别再犯）：\n${lessonsForPrompt(lessons)}\n\n` +
    `用户反馈：\n${feedbackText(feedback)}\n\n` +
    `代码（节选，按文件给结构 + 正文）：\n${digestInfo.text}\n\n` +
    `请挑 1 个最值得做的问题，给出可验证的改动。优先用 patches（改几行最稳、最不容易出错）；` +
    `确实需要整份重写时才用 rewrite，且 content 控制在 12000 字以内（超过会被截断）；一次最多重写 3 个文件或新建 2 个。\n` +
    `输出一个 JSON 对象，不要解释、不要 markdown 代码块：\n` +
    `{"mode":"patch|rewrite","bump":"patch|minor|major","title":"不超过18字","fixes":["改了什么"],"features":[],"verify":"你打算怎么验证","notTried":"你没法验证什么",` +
    `"patches":[{"file":"白名单文件","find":"原文里逐字存在且只出现一次的片段","replace":"替换成"}],` +
    `"rewrites":[{"file":"","content":"完整文件"}],"creates":[{"file":"assets/新文件.js","content":"..."}]}\n` +
    `规则：file 只能是 ${EDITABLE.join(' / ')}；find 必须从上面正文里逐字复制（含缩进标点），至少 8 字、在该文件里只出现一次；最多 ${MAX_PATCHES} 处；` +
    `标注「中间省略」的段落和没给正文的文件都看不到，不许对它们下 patch（会被服务端拒绝）；` +
    `不许 eval / new Function / document.write / 外链脚本 / javascript: / 动态 import 非字面量 / 字面量外链 fetch；不许改 server、cloudflare、.github、tests；` +
    `patch 模式不要同时给 rewrites。`;

  /* 4. 出方案 + 校验。校验不过就把错误喂回去再试一次：
     小模型一次就编对 find 的概率不高，单次失败直接 422 会让自迭代几乎跑不起来。
     重试时把「哪一处、为什么错、find 长什么样」逐条回喂（Q65），
     而不是只说一句「find 要逐字复制」——泛泛的提示实测改不动模型。 */
  const SYSTEM = '你是代码修改计划器。只输出一个 JSON 对象。改动必须小、可验证、能通过括号扫描。';
  let plan = null;
  let applied = null;
  const attempts = [];
  for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
    let retryNote = '';
    if (attempt > 1) {
      const lastFail = attempts[attempts.length - 1] || { error: '' };
      const detail = (lastFail.skipped || []).slice(0, 6).map((s) =>
        `- 第 ${s.index} 处 ${s.file}：${s.reason}` +
        (s.find ? `\n  find 片段：${String(s.find).replace(/\s+/g, ' ').slice(0, 90)}` : '')
      ).join('\n');
      retryNote = `\n\n【上一次失败】${lastFail.error}\n` +
        (detail ? `具体到每一处：\n${detail}\n` : '') +
        (String(lastFail.error).indexOf('JSON') >= 0
          ? '上一次输出不完整或不是 JSON，多半是内容太长被截断。这次只输出 patches，最多 2 处，不要 rewrites、不要 creates。'
          : 'find 必须从上面给了正文的那几段里逐字复制（含缩进标点）；省略掉的中段、没给正文的文件一律不要动。');
    }
    say(`第 ${attempt} 次让模型出方案（思考强度 ${opts.reasoningEffort || 'max'}）…`);
    const reply = await askModel(env, opts, SYSTEM, planPrompt + retryNote, 8000);
    if (reply.reasoning) say('模型思考：' + reply.reasoning.replace(/\s+/g, ' ').slice(0, 600));
    const rawText = reply.text;
    const candidate = pickJson(rawText);
    if (!candidate) {
      attempts.push({ attempt, error: '模型没给出可解析的 JSON', raw: String(rawText || '').slice(0, 300) });
      continue;
    }
    /* 看不到的段落不许改：find 只命中省略区的补丁直接丢掉，别让它「猜着改」（Q62/Q63）。 */
    const vis = screenPatches(files, candidate.patches, digestInfo.windows);
    if (vis.dropped.length) {
      candidate.patches = vis.patches;
      if (!vis.patches.length) {
        const why = '这一版只改了看不见的中段：' +
          vis.dropped.map((s) => `第 ${s.index} 处 ${s.file}`).join('，');
        attempts.push({ attempt, error: why, title: String(candidate.title || '').slice(0, 40), mode: candidate.mode, skipped: vis.dropped });
        continue;
      }
    }
    const bumpTry = ['patch', 'minor', 'major'].indexOf(candidate.bump) >= 0 ? candidate.bump : 'patch';
    candidate.version = bumpVersion(cur, bumpTry);
    try {
      applied = validatePlan(files, candidate, EDITABLE, {
        maxPatches: MAX_PATCHES, maxRewrites: 3, maxCreates: 2, partial: true
      });
      if (vis.dropped.length) applied.skipped = vis.dropped.concat(applied.skipped || []);
      plan = candidate;
    } catch (e) {
      const skipped = (e.skipped || []).concat(vis.dropped).map((s) => {
        const src = (candidate.patches || [])[s.index - 1] || {};
        return Object.assign({}, s, { find: String(src.find || '').slice(0, 120) });
      });
      attempts.push({
        attempt,
        error: e.message,
        title: String(candidate.title || '').slice(0, 40),
        mode: candidate.mode,
        patches: (candidate.patches || []).slice(0, MAX_PATCHES).map((p) => ({
          file: p.file,
          find: String(p.find || '').slice(0, 120)
        })),
        rewrites: (candidate.rewrites || []).map((r) => r.file),
        skipped,
        reason: e.message
      });
    }
  }

  if (!plan) {
    const last = attempts[attempts.length - 1] || { error: '未知原因' };
    /* 失败也要留下痕迹：同一条规则再踩一次就 +1，踩够 3 次升级成硬规则。 */
    try { await recordFailure(env, last.error); } catch (e) { /* 记账失败不影响返回 */ }
    const detail = (last.skipped || []).map((s) => `第 ${s.index} 处 ${s.file}：${s.reason}`);
    if (detail.length) say('对不上的补丁：' + detail.join('；').slice(0, 300));
    return jsonBody({
      ok: false,
      error: (attempts.length > 1 ? '连试两版都没通过校验：' : '这一版没通过校验：') + last.error,
      attempt: last,
      attempts,
      /* 失败时也要把 skipped 明细吐出来：以前只在成功路径打印，用户根本看不到（Q66）。 */
      skipped: last.skipped || [],
      ...(dryRun ? {} : { tickets }),
      log
    }, 422);
  }

  /* 把「应用补丁 → 升版本 / 写 changelog / README / 教训 / package → 自检」收成一处：
     409 重试时会用新 head 的文件重新跑这一遍，保证 blobs 不是按旧基线校验出来的（K5）。 */
  function buildChange(sourceFiles, curNow, recentNow, lessonsNow, appliedNow) {
    const bump = ['patch', 'minor', 'major'].indexOf(plan.bump) >= 0 ? plan.bump : 'patch';
    const next = plan.version;
    say(`方案：${plan.title || '未命名'}（${appliedNow.mode}，动 ${appliedNow.touched.length} 个文件）`);

    /* 只提醒、不拦截的改动（Q77）：innerHTML 之类项目里本来就在用，
       一刀切会误杀；但把它写进日志和响应，人和 review 都能看见。 */
    const warnings = changeWarnings([
      ...(plan.patches || []).map((p) => String((p && p.replace) || '')),
      ...(plan.rewrites || []).map((r) => String((r && r.content) || '')),
      ...(plan.creates || []).map((c) => String((c && c.content) || ''))
    ].join('\n'));
    if (warnings.length) say('提醒（不拦截）：' + warnings.join('；'));

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
    const out = appliedNow.files;
    out[VERSION_FILE] = '/* 当前版本。从更新日志首条推导，避免两处不一致。 */\n' +
      'window.XN_VERSION = (window.XN_CHANGELOG && window.XN_CHANGELOG[0] && window.XN_CHANGELOG[0].version) || ' +
      JSON.stringify(next) + ';\n';

    const recentList = [entry].concat(recentNow.filter((x) => x.version !== next));
    const archiveText = sourceFiles[ARCHIVE_FILE] || 'window.XN_CHANGELOG_ARCHIVE = [];\n';
    let archive = [];
    try { archive = parseArrayFile(archiveText, 'changelog.archive.js'); } catch (e) { archive = []; }
    const overflow = recentList.slice(12);
    /* 带原文进去：没变的条目原样保留，diff 只剩新加的那一条（Q74）。 */
    out[CHANGELOG_FILE] = writeArrayFile('XN_CHANGELOG', recentList.slice(0, 12), '版本记录（最近 12 条）。', sourceFiles[CHANGELOG_FILE]);
    if (overflow.length) {
      out[ARCHIVE_FILE] = writeArrayFile('XN_CHANGELOG_ARCHIVE', overflow.concat(archive).slice(0, 300), '旧版本记录（只读归档）。', sourceFiles[ARCHIVE_FILE]);
    }

    /* README 标记丢了就不再静默返回原文：记一条日志 + 响应里的 warning，且不提交空改动（Q75）。 */
    const readme = patchReadmeChecked(sourceFiles[README_FILE] || '', entry);
    if (readme.ok) {
      out[README_FILE] = readme.text;
      say(readme.reason ? 'README 版本块已更新；' + readme.reason : 'README 已更新（版本块 + 最近更新）');
    } else {
      say('README 没有更新：' + readme.reason);
    }
    if (readme.reason) warnings.push('README：' + readme.reason);

    /* package.json 的版本必须一起升：check.mjs 和单测都会比对 changelog 首条，
       只改 changelog 不改 package.json，CI 必挂（实测踩过）。 */
    try {
      const pkg = JSON.parse(String(sourceFiles[PKG_FILE] || '{}'));
      if (pkg && typeof pkg === 'object') {
        pkg.version = next;
        out[PKG_FILE] = JSON.stringify(pkg, null, 2) + '\n';
        say('package.json 版本已同步到 ' + next);
      }
    } catch (e) {
      say('package.json 解析失败，版本没同步：' + e.message);
    }

    /* 教训随版本一起入库：既给人 review，也让下一次迭代能读到。 */
    const lessonsText = renderLessons(lessonsNow, 'v' + next);
    if (lessonsText !== String(sourceFiles[LESSONS_FILE] || '')) {
      out[LESSONS_FILE] = lessonsText;
      say('教训文件已更新（' + lessonsNow.length + ' 条）');
    }
    say('版本：' + curNow + ' → ' + next + '（' + bump + '）');

    const check = verifyFiles(out, Object.keys(out));
    say(check.detail);

    const changedFiles = [...new Set(appliedNow.touched.concat([VERSION_FILE, CHANGELOG_FILE, ARCHIVE_FILE, README_FILE, LESSONS_FILE, PKG_FILE]))]
      .filter((p) => typeof out[p] === 'string');

    const skipped = appliedNow.skipped || [];
    if (skipped.length) say('跳过 ' + skipped.length + ' 处对不上的补丁：' + skipped.map((s) => s.reason).join('；').slice(0, 300));

    return {
      ok: check.ok,
      detail: check.detail,
      bump,
      next,
      from: curNow,
      warnings,
      entry,
      out,
      check,
      changedFiles,
      skipped,
      applied: appliedNow
    };
  }

  function makeResult(built) {
    return {
      ok: true,
      dryRun,
      version: built.next,
      from: built.from,
      bump: built.bump,
      effort: opts.reasoningEffort,
      title: built.entry.title,
      fixes: built.entry.fixes,
      features: built.entry.features,
      verify: built.check.detail,
      notTried: built.entry.notes,
      files: built.changedFiles,
      patches: built.applied.touched,
      skipped: built.skipped,
      warnings: built.warnings,
      /* 试运行没有提交，url 留空；真跑会在下面覆盖成 commit 链接。 */
      url: '',
      compareUrl: '',
      log
    };
  }

  let current = buildChange(files, cur, recent, lessons, applied);
  if (!current.ok) {
    return jsonBody({
      ok: false,
      error: '自检没通过：' + current.detail,
      attempt: { title: current.entry.title, patches: (plan.patches || []).map((p) => ({ file: p.file })) },
      /* 自检失败时也把「哪些补丁被跳过」带出来（Q66）。 */
      skipped: current.skipped,
      tickets,
      log
    }, 422);
  }

  let result = makeResult(current);

  if (dryRun) {
    if (env.XN_KV) {
      try {
        await env.XN_KV.put(cacheKey, JSON.stringify({ at: Date.now(), result }), { expirationTtl: PLAN_CACHE_TTL_SECONDS });
      } catch (e) { /* 缓存写不进不影响结果 */ }
    }
    say('试运行结束，没有写入仓库。');
    return jsonBody(result, 200);
  }

  /* 真跑：工单一起回传，前端队列才有数据（没有就是空数组）。 */
  result.tickets = tickets;

  /* 6. 一次性提交：blob 先传。遇到 409（分支被并发推进）不能直接换 head 重建——
     先重新读文件、用原 plan 重跑 validatePlan/verifyFiles，过了才重试一次；
     再 409 就收手，绝不无限重试，也不把孤儿 commit 当结果返回（K5）。 */
  let pushed = null;
  for (let round = 1; round <= 2; round++) {
    if (round === 2) {
      say(`分支 ${branch} 被并发提交顶掉（409），重新读取文件并重校方案…`);
      const again = await readSourceFiles();
      if (again.missing.length) {
        return jsonBody({ ok: false, status: 502, error: '读文件失败：' + again.missing.slice(0, 3).join('；'), tickets, log }, 502);
      }
      const recentAgain = parseArrayFile(again.files[CHANGELOG_FILE], 'changelog.js');
      let pkgAgain = null;
      try { pkgAgain = JSON.parse(String(again.files[PKG_FILE] || '{}')); } catch (e) { pkgAgain = null; }
      const curAgain = pickBaseVersion([
        ...recentAgain.map((x) => x && x.version),
        (String(again.files[VERSION_FILE] || '').match(/XN_VERSION\s*=\s*["']([^"']+)["']/) || [])[1],
        pkgAgain && pkgAgain.version
      ], '1.5.0');
      /* 用基线 sha 对比，日志里能看出这期间到底哪些文件被别人改了。 */
      const moved = [...new Set(current.changedFiles)].filter((p) => String(again.shas[p] || '') !== String(fileShas[p] || ''));
      if (moved.length) say('这些文件在并发提交里被改了，重新校验：' + moved.slice(0, 6).join('、'));
      const bumpAgain = ['patch', 'minor', 'major'].indexOf(plan.bump) >= 0 ? plan.bump : 'patch';
      plan.version = bumpVersion(curAgain, bumpAgain);
      let appliedAgain = null;
      try {
        appliedAgain = validatePlan(again.files, plan, EDITABLE, {
          maxPatches: MAX_PATCHES, maxRewrites: 3, maxCreates: 2, partial: true
        });
      } catch (e) {
        say('重新校验没通过：' + e.message);
        return jsonBody({
          ok: false, status: 409, code: 'branch-moved',
          error: '分支已变动，请重跑（重新校验没通过：' + e.message + '）',
          tickets, log
        }, 409);
      }
      const lessonsAgain = await loadLessons(env, again.files[LESSONS_FILE]);
      current = buildChange(again.files, curAgain, recentAgain, lessonsAgain, appliedAgain);
      if (!current.ok) {
        say('重新校验没通过：' + current.detail);
        return jsonBody({
          ok: false, status: 409, code: 'branch-moved',
          error: '分支已变动，请重跑（自检没通过：' + current.detail + '）',
          tickets, log
        }, 409);
      }
      result = makeResult(current);
      result.tickets = tickets;
      say(`重新校验通过：版本 ${curAgain} → ${current.next}`);
    }

    say('上传 ' + current.changedFiles.length + ' 个 blob…');
    const blobs = await Promise.all(current.changedFiles.map(async (p) => {
      const b = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: b64encode(current.out[p]), encoding: 'base64' })
      });
      if (b.status !== 201) throw new Error('创建 blob 失败：' + p + '（' + b.status + '）');
      return { path: p, mode: '100644', type: 'blob', sha: b.data.sha };
    }));

    const message = [
      `feat: ${current.entry.title} (v${current.next})`,
      '',
      `云端自迭代 · 反馈 ${feedback.length} 条`,
      `改到：${current.changedFiles.join('、')}`,
      `验证：${current.check.detail}`,
      `没验证：${current.entry.notes || '真机、多浏览器、真实服务商'}`
    ].join('\n');

    const push = await pushChanges(owner, repo, branch, token, blobs, message);
    if (push.ok) { pushed = push; break; }

    if (push.status !== 409) {
      return jsonBody({ ok: false, error: push.error, tickets, log }, push.status);
    }
    if (round === 2) {
      say('第二次碰到 409，停止重试（不做无限重试）；本次没有写进任何分支。');
      return jsonBody({
        ok: false, status: 409, code: 'branch-moved',
        error: '分支已变动，请重跑（已重新校验并重试一次，仍被并发提交顶掉）',
        tickets, log
      }, 409);
    }
    /* 第一轮 409：下一轮会重新读文件、重跑校验，再试一次。 */
  }
  if (!pushed) {
    return jsonBody({ ok: false, status: 409, code: 'branch-moved', error: '分支已变动，请重跑', tickets, log }, 409);
  }
  const commitSha = pushed.sha;
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;
  /* compareUrl：试跑分支看「相对默认分支差了什么」，正式分支看「这一笔改了什么」。 */
  const compareUrl = trialBranch
    ? `https://github.com/${owner}/${repo}/compare/${info.data.default_branch || 'main'}...${branch}`
    : `https://github.com/${owner}/${repo}/compare/${commitSha}~1...${commitSha}`;
  say('已提交 ' + commitSha.slice(0, 7) + ' 到 ' + branch);

  /* 7. 打 tag：由 release.yml 在 tag 上打 exe 并创建 release。
     试跑分支不打 tag —— 那边还没 review 过，不能顺手发版。 */
  const tag = 'v' + current.next;
  if (trialBranch) {
    say('试跑分支，跳过打 tag');
    return jsonBody(Object.assign({}, result, {
      tag: '',
      tagState: 'skipped',
      commit: commitSha.slice(0, 7),
      branch,
      url: commitUrl,
      compareUrl
    }), 200);
  }
  let tagState = 'created';
  let tagAt = '';
  const tagRes = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/tags/' + tag, sha: commitSha })
  });
  if (tagRes.status === 422) {
    /* 422 只能说明「ref 建不出来」，不能说明它指着谁：核对该 tag 当前指向（Q72）。
       指向同一个 commit 才叫幂等重跑；指向别处就是版本冲突，不能当 exists 糊过去。 */
    const existing = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, token
    );
    let annotated = null;
    const obj = existing.status === 200 && existing.data && existing.data.object;
    if (obj && obj.type === 'tag') {
      annotated = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/tags/${obj.sha}`, token);
    }
    tagAt = resolveTagTarget(existing.data, annotated && annotated.status === 200 ? annotated.data : null);
    if (tagAt === commitSha) {
      tagState = 'exists';
      say('tag ' + tag + ' 已存在且指向这次提交，跳过（幂等重跑）');
    } else if (tagAt) {
      tagState = 'conflict';
      say('tag ' + tag + ' 已存在但指向 ' + tagAt.slice(0, 7) + '，不是这次的 ' + commitSha.slice(0, 7) + '；没覆盖，版本号需要人工处理');
    } else {
      tagState = 'failed';
      say('打 tag 失败：' + ((tagRes.data && tagRes.data.message) || tagRes.status) + '（同名 ref 存在但读不到目标）');
    }
  } else if (tagRes.status !== 201) {
    tagState = 'failed';
    say('打 tag 失败：' + ((tagRes.data && tagRes.data.message) || tagRes.status));
  } else {
    say('已打 tag ' + tag + '，Actions 会开始打 exe');
  }

  say('完成，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒');
  return jsonBody(Object.assign({}, result, {
    tag: tagState === 'created' ? tag : '',
    tagState,
    tagAt: tagAt ? tagAt.slice(0, 7) : '',
    commit: commitSha.slice(0, 7),
    branch,
    url: commitUrl,
    compareUrl,
    releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${tag}`
  }), 200);
}

export {
  patchReadme, pickJson, verifyFiles, pushChanges,
  PLAN_CACHE_TTL_SECONDS
};
