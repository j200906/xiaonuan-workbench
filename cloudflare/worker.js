/**
 * 小暖 · 边缘服务（Cloudflare Pages Functions / Workers 通用）
 *
 * 安全边界：
 *   - 管理接口只认 HMAC 会话令牌，不认明文密码（密码只在 /api/admin/verify 用一次）
 *   - 所有写接口同源校验 + 限流 + 请求体上限
 *   - /api/fetch 逐跳校验重定向，并用 DoH 解析结果挡住内网与 DNS 重绑定
 *   - 不再返回 Access-Control-Allow-Origin: *
 */

import { runIteration } from './iterate.js';
import {
  safeBase, safeFetch,
  constantTimeEqual, issueToken, verifyToken, bearer,
  clientIp, sameOrigin, corsHeaders, SECURITY_HEADERS,
  rateLimit, readJson, b64encode
} from './shared.js';

const AI_CHOICES = [
  { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7-Flash', note: '云端唯一' }
];
const AI_MODEL = '@cf/zai-org/glm-4.7-flash';
const AI_FALLBACK = '@cf/zai-org/glm-4.7-flash';
const MAX_CHAT_BYTES = 262144;
const MAX_FEEDBACK_BYTES = 16384;

/* 同一 isolate 里同一 IP 的迭代同一时刻只放一个：KV 计数是读-改-写，
   并发点两下会绕过 4 次/小时的额度（Q94 复核 F3）。 */
const iterateInFlight = new Set();

function baseHeaders(request, env, extra) {
  return Object.assign({}, SECURITY_HEADERS, corsHeaders(request, env), extra || {});
}

function json(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: baseHeaders(request, env, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
  });
}

function withHeaders(res, request, env) {
  const headers = new Headers(res.headers);
  const add = baseHeaders(request, env);
  Object.keys(add).forEach((k) => {
    if (!headers.has(k)) headers.set(k, add[k]);
  });
  return new Response(res.body, { status: res.status, headers });
}

function pickAiModel(raw, env) {
  const want = String(raw || '');
  if (AI_CHOICES.some((m) => m.id === want)) return want;
  if (env.XN_AI_MODEL && want === env.XN_AI_MODEL) return want;
  return env.XN_AI_MODEL || AI_MODEL;
}

function hasUpstream(env) { return !!env.XN_API_KEY; }
function hasAI(env) { return !!env.AI; }

/* 网关下发策略：只把「看起来真的能用」的地址下发给前端。
 * - 空串 / 解析不出 URL / 非 http(s)：返回 null，调用方干脆不下发 gateway 字段
 *   （前端 models.js 的 gatewayReady 就会是 false，不会默认选中它）
 * - 临时隧道（*.trycloudflare.com）：地址照发，但标 stale: true，前端可以提示或禁用
 * - reachableHint：只有运维显式验证过（XN_GATEWAY_VERIFIED=1）才是 true，
 *   前端据此决定「能不能直接点」；没验证过的一律先当不可用。 */
function gatewayInfo(env) {
  const base = String((env && env.XN_GATEWAY_BASE) || '').trim();
  if (!base) return null;
  let url;
  try { url = new URL(base); } catch (e) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    base,
    model: (env && env.XN_GATEWAY_MODEL) || '',
    stale: /(^|\.)trycloudflare\.com$/i.test(url.hostname),
    reachableHint: String((env && env.XN_GATEWAY_VERIFIED) || '') === '1'
  };
}

/* 只读 Authorization：X-Admin-Token 是管理会话，绝不能当模型 Key 转发出去 */
function authOnly(request) {
  const h = request.headers.get('Authorization') || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function browserSameSite(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  return !site || site === 'same-origin' || site === 'none';
}

function allowedModel(model, env) {
  if (!hasUpstream(env)) return true; /* 用自带模型时由 pickAiModel 收口 */
  const list = String(env.XN_ALLOWED_MODELS || env.XN_MODEL || 'deepseek-chat')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return list.indexOf(model) >= 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      if (!sameOrigin(request, env)) return new Response(null, { status: 403, headers: SECURITY_HEADERS });
      return new Response(null, { status: 204, headers: baseHeaders(request, env) });
    }

    try {
      if (path === '/api/health') {
        return json({
          ok: true,
          backend: hasUpstream(env) ? 'upstream' : (hasAI(env) ? 'workers-ai' : 'none'),
          model: hasUpstream(env) ? (env.XN_MODEL || 'deepseek-chat') : (env.XN_AI_MODEL || AI_MODEL),
          hasKey: hasUpstream(env),
          hasAI: hasAI(env),
          rateLimit: !!env.XN_KV
        }, 200, request, env);
      }

      if (path === '/api/config') {
        const gateway = gatewayInfo(env);
        return json({
          proxy: hasUpstream(env) || hasAI(env),
          backend: hasUpstream(env) ? 'upstream' : (hasAI(env) ? 'workers-ai' : 'none'),
          model: hasUpstream(env) ? (env.XN_MODEL || 'deepseek-chat') : (env.XN_AI_MODEL || AI_MODEL),
          models: hasAI(env) ? AI_CHOICES : [],
          /* 没配置或明显失效就不带这个字段：前端 gatewayReady=false，不会默认选它 */
          ...(gateway ? { gateway } : {}),
          repo: {
            owner: env.XN_REPO_OWNER || '',
            name: env.XN_REPO_NAME || '',
            locked: !!(env.XN_REPO_OWNER && env.XN_REPO_NAME),
            serverToken: !!env.XN_GH_TOKEN
          }
        }, 200, request, env);
      }

      if (path === '/api/admin/verify') {
        if (method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405, request, env);
        if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        const rl = await rateLimit(env, 'admin', clientIp(request), 5, 60, false);
        if (!rl.ok) return json({ ok: false, error: '试得太频繁，等一分钟' }, 429, request, env);
        if (!env.XN_ADMIN_PASSWORD) {
          return json({ ok: false, reason: 'not_configured' }, 501, request, env);
        }
        let body;
        try { body = await readJson(request, 4096); }
        catch (e) { return json({ ok: false, error: e.message }, e.status || 400, request, env); }
        const ok = constantTimeEqual(String(body.password || ''), String(env.XN_ADMIN_PASSWORD || ''));
        if (!ok) return json({ ok: false, error: '密码不对' }, 401, request, env);
        const token = await issueToken(env, 43200);
        return json({ ok: true, token, expires: Date.now() + 43200000 }, 200, request, env);
      }

      if (path === '/api/admin/check') {
        if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        const rl = await rateLimit(env, 'admin-check', clientIp(request), 30, 60, false);
        if (!rl.ok) return json({ ok: false, error: '太频繁' }, 429, request, env);
        const ok = await verifyToken(env, bearer(request));
        return json({ ok }, ok ? 200 : 401, request, env);
      }

      if (path === '/api/chat') {
        if (method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405, request, env);
        if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        const rl = await rateLimit(env, 'chat', clientIp(request), 30, 60, false);
        if (!rl.ok) return json({ ok: false, error: '请求太频繁（30/分钟）' }, 429, request, env);

        /* 先校验请求形状：坏请求不该因为"服务器没配模型"而看起来像配置问题 */
        try {
          const peek = await readJson(request.clone(), MAX_CHAT_BYTES);
          if (!peek || !Array.isArray(peek.messages) || !peek.messages.length) {
            return json({ ok: false, error: 'messages 不对' }, 400, request, env);
          }
        } catch (e) {
          return json({ ok: false, error: e.message }, e.status || 400, request, env);
        }

        /* 管理令牌只用于管理接口（X-Admin-Token），不能当模型 Key 转发给上游（Q94 复核 F2）。 */
        const asKey = authOnly(request);
        if (asKey && await verifyToken(env, asKey)) {
          return json({
            ok: false,
            error: '管理令牌不能当模型 Key 用：模型 Key 放 Authorization，管理令牌放 X-Admin-Token'
          }, 400, request, env);
        }

        if (authOnly(request) && !env.XN_API_KEY) {
          /* 客户端带了自己的 Key，走代理 */
          return withHeaders(await proxyChat(request, env), request, env);
        }
        if (hasUpstream(env)) return withHeaders(await proxyChat(request, env), request, env);
        if (hasAI(env)) return withHeaders(await aiChat(request, env), request, env);
        return json({ ok: false, error: '服务器没配模型：加一个 XN_API_KEY，或启用 AI 绑定' }, 503, request, env);
      }

      if (path === '/api/iterate') {
        if (method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405, request, env);
        if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        /* 迭代界面不再要求先输密码。但公开触发不能直接写 main、更不能发版：
           没解锁的请求一律落到试跑分支，人是最后那道 merge 关。 */
        const admin = await verifyToken(env, bearer(request));
        const publicBranch = String(env.XN_PUBLIC_ITERATE_BRANCH || 'iterate/public').trim();
        let payload;
        try { payload = await readJson(request, 524288); }
        catch (e) { return json({ ok: false, error: e.message }, e.status || 400, request, env); }
        /* 试运行单独记账：它只烧模型 token、不写仓库，不该和真跑抢同一份 10 次/小时。
           分开以后，试运行即使打满也不会把真跑额度吃掉。 */
        const dry = !!(payload && payload.dryRun);
        const rlKey = (admin ? 'iterate' : 'iterate-pub') + (dry ? '-dry' : '');
        const rlMax = admin ? (dry ? 20 : 10) : (dry ? 8 : 4);
        const rl = await rateLimit(env, rlKey, clientIp(request), rlMax, 3600, true);
        if (!rl.ok) {
          return json({ ok: false, error: `迭代太频繁（${rlMax} 次/小时，${dry ? '试运行' : '真跑'}）` }, 429, request, env);
        }
        /* 同一 IP 的迭代串行：KV 计数是读-改-写，并发点击会绕过每小时额度。 */
        const flightKey = rlKey + ':' + clientIp(request);
        if (iterateInFlight.has(flightKey)) {
          return json({ ok: false, error: '同一次迭代还没跑完，等它结束再点' }, 429, request, env);
        }
        iterateInFlight.add(flightKey);
        try {
          const opts = Object.assign({}, payload, {
            authorized: true,
            ...(admin ? {} : { branch: publicBranch })
          });
          const res = await runIteration(env, opts);
          /* 公开模式在响应里标明落到了哪个分支，界面照实显示 */
          if (admin) return withHeaders(res, request, env);
          const data = await res.clone().json().catch(() => null);
          const tagged = data ? Object.assign({}, data, { publicMode: true, branch: publicBranch }) : null;
          return withHeaders(tagged ? Response.json(tagged, { status: res.status }) : res, request, env);
        } catch (e) {
          return json({ ok: false, error: '迭代失败：' + (e.message || String(e)) }, 500, request, env);
        } finally {
          iterateInFlight.delete(flightKey);
        }
      }

      if (path === '/api/search') {
        if (method !== 'GET') return json({ ok: false, error: '只接受 GET' }, 405, request, env);
        if (!sameOrigin(request, env) || !browserSameSite(request)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        const rl = await rateLimit(env, 'search', clientIp(request), 20, 60, false);
        if (!rl.ok) return json({ ok: false, error: '搜得太频繁' }, 429, request, env);
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
        if (!q) return json({ ok: false, error: '缺 q' }, 400, request, env);
        return withHeaders(await webSearch(q, env), request, env);
      }

      if (path === '/api/fetch') {
        if (method !== 'GET') return json({ ok: false, error: '只接受 GET' }, 405, request, env);
        if (!sameOrigin(request, env) || !browserSameSite(request)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
        const rl = await rateLimit(env, 'fetch', clientIp(request), 10, 60, false);
        if (!rl.ok) return json({ ok: false, error: '抓得太频繁' }, 429, request, env);
        const target = String(url.searchParams.get('url') || '');
        return withHeaders(await fetchPage(target, request, env), request, env);
      }

      if (path === '/api/feedback') {
        if (method === 'POST') {
          if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
          const rl = await rateLimit(env, 'feedback', clientIp(request), 5, 60, false);
          if (!rl.ok) return json({ ok: false, error: '提交太频繁' }, 429, request, env);
          const saved = await saveFeedback(request, env);
          return json(saved, saved && saved.ok ? 200 : (saved.status || 400), request, env);
        }
        if (method === 'GET') {
          if (!(await verifyToken(env, bearer(request)))) {
            return json({ ok: false, error: '管理员会话无效' }, 401, request, env);
          }
          return json(await listFeedback(request, env), 200, request, env);
        }
        if (method === 'DELETE') {
          /* 删除是管理动作：必须带管理员令牌，且默认要求同源（浏览器管理页）。 */
          if (!sameOrigin(request, env)) return json({ ok: false, error: '来源不允许' }, 403, request, env);
          if (!(await verifyToken(env, bearer(request)))) {
            return json({ ok: false, error: '管理员会话无效' }, 401, request, env);
          }
          return json(await deleteFeedback(request, env), 200, request, env);
        }
        return json({ ok: false, error: '只接受 GET / POST / DELETE' }, 405, request, env);
      }

      if (path.startsWith('/api/')) return json({ ok: false, error: '没有这个接口' }, 404, request, env);

      if (!env.ASSETS) return json({ ok: false, error: '没有静态资源绑定' }, 500, request, env);
      const asset = await env.ASSETS.fetch(request);
      const type = asset.headers.get('Content-Type') || '';
      const headers = new Headers(asset.headers);
      if (type.indexOf('text/html') >= 0) {
        Object.keys(SECURITY_HEADERS).forEach((k) => headers.set(k, SECURITY_HEADERS[k]));
        headers.set('Cache-Control', 'no-cache');
      } else {
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', url.searchParams.get('v')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      }
      return new Response(asset.body, { status: asset.status, headers });
    } catch (e) {
      return json({ ok: false, error: '服务器出错了：' + (e.message || String(e)) }, 500, request, env);
    }
  }
};

/* ---------- 联网 ---------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const UA = 'XiaoNuan/1.5 (study helper; +https://github.com/j200906/xiaonuan-workbench)';

async function webSearch(q, env) {
  const cacheKey = 'search:' + q.toLowerCase();
  if (env.XN_KV) {
    try {
      const hit = await env.XN_KV.get(cacheKey, 'json');
      if (hit) return new Response(JSON.stringify(hit), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=60' }
      });
    } catch (e) { /* 缓存坏了不影响搜索 */ }
  }

  let items = [];
  let source = 'duckduckgo';
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
    const html = await res.text();
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && items.length < 6) {
      let link = m[1];
      const mm = link.match(/uddg=([^&]+)/);
      if (mm) link = decodeURIComponent(mm[1]);
      const title = stripTags(m[2]);
      if (!title) continue;
      items.push({ title, url: link, snippet: '' });
    }
    const snips = [];
    const re2 = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let s2;
    while ((s2 = re2.exec(html)) && snips.length < 6) snips.push(stripTags(s2[1]));
    items.forEach((it, i) => { it.snippet = snips[i] || ''; });
  } catch (e) { items = []; }

  if (!items.length) {
    items = await wikiSearch(q);
    source = 'wikipedia';
  }

  const payload = { ok: true, q, count: items.length, items, source };
  if (env.XN_KV && items.length) {
    try { await env.XN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }); } catch (e) {}
  }
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function wikiSearch(q) {
  const api = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=' +
    encodeURIComponent(q);
  try {
    const res = await fetch(api, { headers: { 'User-Agent': 'XiaoNuan/1.5 (study helper)' } });
    const j = await res.json();
    return ((j.query && j.query.search) || []).map((h) => ({
      title: h.title,
      url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(h.title),
      snippet: stripTags(h.snippet || '')
    }));
  } catch (e) {
    return [];
  }
}

async function fetchPage(target, request, env) {
  let got;
  try {
    got = await safeFetch(target, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: '打不开：' + e.message }, 403);
  }
  const res = got.res;
  if (!res.ok) return jsonResponse({ ok: false, error: '目标站返回 ' + res.status }, 502);

  const type = res.headers.get('Content-Type') || '';
  if (!/text\/|json|xml/i.test(type)) {
    return jsonResponse({ ok: false, error: '这个地址不是网页文本（' + type + '）' }, 415);
  }
  const len = Number(res.headers.get('Content-Length') || 0);
  if (len > 3 * 1024 * 1024) return jsonResponse({ ok: false, error: '页面太大' }, 413);

  const raw = await res.text();
  if (raw.length > 2 * 1024 * 1024) return jsonResponse({ ok: false, error: '页面太大' }, 413);

  const text = type.indexOf('html') >= 0 ? stripTags(raw) : raw;
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 120) : got.url;

  return jsonResponse({ ok: true, url: got.url, title, text: text.slice(0, 20000) });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* ---------- 上游转发 ---------- */

async function proxyChat(request, env) {
  let payload;
  try { payload = await readJson(request, MAX_CHAT_BYTES); }
  catch (e) { return jsonResponse({ ok: false, error: e.message }, e.status || 400); }

  if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) {
    return jsonResponse({ ok: false, error: 'messages 不对' }, 400);
  }
  if (payload.messages.length > 100) return jsonResponse({ ok: false, error: '消息太多了' }, 400);

  const totalChars = payload.messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
  if (totalChars > 200000) return jsonResponse({ ok: false, error: '上下文太长了' }, 413);

  const clientK = authOnly(request);
  const usingServerKey = !clientK;
  const model = String(payload.model || env.XN_MODEL || 'deepseek-chat');
  if (usingServerKey && !allowedModel(model, env)) {
    return jsonResponse({ ok: false, error: '服务器只允许使用 ' + (env.XN_MODEL || 'deepseek-chat') }, 403);
  }

  const fallback = (env.XN_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const base = safeBase(payload.providerBase, fallback, env);
  const key = clientK || env.XN_API_KEY;

  const body = {
    model,
    messages: payload.messages.slice(0, 100).map((m) => ({
      role: ['system', 'assistant', 'user', 'tool'].indexOf(m && m.role) >= 0 ? m.role : 'user',
      content: String((m && m.content) || '').slice(0, 120000),
      ...(m && m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m && m.tool_call_id ? { tool_call_id: String(m.tool_call_id).slice(0, 80) } : {})
    })),
    temperature: Math.max(0, Math.min(2, payload.temperature == null ? 0.8 : Number(payload.temperature))),
    stream: !!payload.stream
  };
  if (payload.max_tokens) body.max_tokens = Math.max(1, Math.min(8192, Number(payload.max_tokens) || 1024));
  if (/^(marvis\/|.*deepseek-v4)/i.test(model)) body.reasoning_effort = 'low';
  if (Array.isArray(payload.tools) && payload.tools.length && payload.tools.length <= 20) {
    body.tools = payload.tools;
    body.tool_choice = 'auto';
  }

  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify(body),
      redirect: 'manual'
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: '连不上上游：' + e.message }, 502);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResponse({ ok: false, error: '上游返回了重定向，已拒绝跟随' }, 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  if (body.stream) headers.set('X-Accel-Buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers });
}

/* ---------- Cloudflare 自带推理 ---------- */

async function aiChat(request, env) {
  let payload;
  try { payload = await readJson(request, MAX_CHAT_BYTES); }
  catch (e) { return jsonResponse({ ok: false, error: e.message }, e.status || 400); }

  if (!payload || !Array.isArray(payload.messages)) {
    return jsonResponse({ ok: false, error: 'messages 不对' }, 400);
  }

  const model = pickAiModel(payload.model, env);
  const messages = payload.messages.slice(0, 100).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
    content: String((m && m.content) || '').slice(0, 120000)
  }));

  const run = async (name) => {
    const params = { messages, stream: !!payload.stream, max_tokens: payload.max_tokens || 1200 };
    if (String(name).indexOf('glm') >= 0) params.chat_template_kwargs = { enable_thinking: false };
    return env.AI.run(name, params);
  };

  const textOf = (o) => {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (typeof o.response === 'string' && o.response) return o.response;
    if (o.choices && o.choices[0] && o.choices[0].message) return o.choices[0].message.content || '';
    return '';
  };

  let out;
  try {
    out = await run(model);
  } catch (e) {
    try { out = await run(AI_FALLBACK); }
    catch (e2) { return jsonResponse({ ok: false, error: '自带模型跑不动：' + (e2.message || e2) }, 502); }
  }

  if (!payload.stream && !textOf(out).trim()) {
    try {
      const retry = await env.AI.run(model, {
        messages, stream: false, max_tokens: 4000,
        chat_template_kwargs: { enable_thinking: false }
      });
      if (textOf(retry).trim()) out = retry;
    } catch (e) { /* 保留原结果 */ }
  }

  if (payload.stream) {
    const upstreamStream = out instanceof ReadableStream ? out : new Response(out).body;
    const decoder = new TextDecoder();
    let buffer = '';

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const reader = upstreamStream.getReader();
        const push = (delta) => {
          if (!delta.content && !delta.reasoning_content) return;
          controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n'));
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const raw = t.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              try {
                const obj = JSON.parse(raw);
                const d = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
                const text = obj.response !== undefined ? obj.response : d.content;
                const think = obj.reasoning || obj.reasoning_content || d.reasoning_content;
                if (text || think) push({ content: text || '', reasoning_content: think || '' });
              } catch (e) { /* 忽略坏行 */ }
            }
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
        } catch (e) {
          push({ content: '\n\n[出错了：' + (e.message || e) + ']' });
        }
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  const text = typeof out === 'string'
    ? out
    : (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || '');
  return jsonResponse({ choices: [{ message: { role: 'assistant', content: text } }] });
}

/* ---------- 反馈 ---------- */

async function ipHash(request) {
  try {
    const data = new TextEncoder().encode(clientIp(request) + '|' + (new Date().toISOString().slice(0, 10)));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return b64encode(String.fromCharCode.apply(null, new Uint8Array(digest).subarray(0, 8)));
  } catch (e) {
    return '';
  }
}

/* 反馈保留期：默认 180 天，环境变量 XN_FEEDBACK_TTL_DAYS 可调（1–365）。
   审计里问「存一年有没有删除接口/隐私说明」——现在两者都有。 */
function feedbackTtlDays(env) {
  const n = Number((env && env.XN_FEEDBACK_TTL_DAYS) || 180);
  if (!isFinite(n)) return 180;
  return Math.max(1, Math.min(365, Math.round(n)));
}

async function saveFeedback(request, env) {
  let item;
  try { item = await readJson(request, MAX_FEEDBACK_BYTES); }
  catch (e) { return { ok: false, error: e.message, status: e.status || 400 }; }

  const body = String((item && item.body) || '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  if (body.length > 2000) return { ok: false, error: '内容太长' };

  const ttlDays = feedbackTtlDays(env);
  const record = {
    id: String(item.id || '').replace(/[^\w.-]/g, '').slice(0, 40) || ('srv-' + Date.now().toString(36)),
    ts: new Date().toISOString(),
    type: String(item.type || '其他').replace(/[<>&"']/g, '').slice(0, 20),
    body: body.slice(0, 2000),
    contact: String(item.contact || '').replace(/[<>&"']/g, '').slice(0, 80),
    ua: (request.headers.get('User-Agent') || '').slice(0, 120),
    ipHash: await ipHash(request),
    retentionDays: ttlDays,
    status: 'new'
  };

  if (!env.XN_KV) return { ok: true, saved: 'none' };
  try {
    const key = 'fb:' + record.ts + ':' + Math.random().toString(36).slice(2, 7);
    await env.XN_KV.put(key, JSON.stringify(record), { expirationTtl: ttlDays * 86400 });
    return { ok: true, saved: 'kv', retentionDays: ttlDays };
  } catch (e) {
    return { ok: false, error: '存储写不进去' };
  }
}

async function listFeedback(request, env) {
  if (!env.XN_KV) return { ok: false, error: '这台服务器没配存储（KV）' };
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 200), 500));
  const listed = await env.XN_KV.list({ prefix: 'fb:', limit });
  const items = [];
  for (const k of listed.keys) {
    const raw = await env.XN_KV.get(k.name);
    if (!raw) continue;
    try { items.push(JSON.parse(raw)); } catch (e) { /* 坏数据跳过 */ }
  }
  items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { ok: true, count: items.length, items };
}

/* 删除反馈：管理员令牌 + 同源（见路由）。支持 ?all=1 全删、?id=xxx 单条、
   ?before=YYYY-MM-DD 删更早的。KV 只能按 prefix 列，删除前逐条读出来比对；
   记录量很小（个人工作台），一次列全量即可。 */
async function deleteFeedback(request, env) {
  if (!env.XN_KV) return { ok: false, error: '这台服务器没配存储（KV）' };
  const url = new URL(request.url);
  const all = url.searchParams.get('all') === '1';
  const id = String(url.searchParams.get('id') || '').trim();
  const before = String(url.searchParams.get('before') || '').trim();
  if (!all && !id && !before) {
    return { ok: false, error: '要指定 ?all=1、?id=（记录 id）或 ?before=YYYY-MM-DD，避免误删' };
  }
  if (before) {
    /* 不是格式对就算数：2026-13-45 / 9999-99-99 这种「格式像日期」的会被 Date 纠正，
       真正的日期必须 ISO 回写完全一致，而且不能是未来（全删要显式 ?all=1）。 */
    const d = new Date(before + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before) ||
        !isFinite(d.getTime()) ||
        d.toISOString().slice(0, 10) !== before) {
      return { ok: false, error: 'before 要是真实日期 YYYY-MM-DD' };
    }
    if (before > new Date().toISOString().slice(0, 10)) {
      return { ok: false, error: 'before 不能是未来日期；要全删请用 ?all=1' };
    }
  }

  const names = [];
  let cursor;
  do {
    const page = await env.XN_KV.list(Object.assign({ prefix: 'fb:', limit: 1000 }, cursor ? { cursor } : {}));
    page.keys.forEach((k) => names.push(k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const doomed = [];
  if (all) {
    names.forEach((n) => doomed.push(n));
  } else {
    for (const name of names) {
      const raw = await env.XN_KV.get(name);
      if (!raw) { doomed.push(name); continue; }
      let rec = null;
      try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (id && rec && String(rec.id || '') === id) { doomed.push(name); continue; }
      if (before && rec && String(rec.ts || '').slice(0, 10) < before) doomed.push(name);
    }
  }

  await Promise.all(doomed.map((name) => env.XN_KV.delete(name)));
  return { ok: true, deleted: doomed.length, scanned: names.length };
}
