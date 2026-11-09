/**
 * 小暖 · 边缘服务（Cloudflare Pages Functions / Workers 通用）
 *
 * 干三件事：
 *   1. 把静态文件发出去
 *   2. /api/chat 代理模型请求 —— 两种后端，自动挑：
 *        有 XN_API_KEY  → 转发到 XN_BASE（DeepSeek 等 OpenAI 兼容接口）
 *        没有 Key，但有 AI 绑定 → 用 Cloudflare 自带的免费推理
 *   3. /api/feedback 收反馈（配了 KV 就存 KV）
 *
 * 这样访客打开网页不需要任何 Key，也不会看到 Key。
 */

import { runIteration } from './iterate.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const AI_MODEL = '@cf/zai-org/glm-4.7-flash';
const AI_FALLBACK = '@cf/qwen/qwen3-30b-a3b-fp8';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return new Response(res.body, { status: res.status, headers });
}

function hasUpstream(env) {
  return !!env.XN_API_KEY;
}

function hasAI(env) {
  return !!env.AI;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (path === '/api/health') {
      return json({
        ok: true,
        backend: hasUpstream(env) ? 'upstream' : (hasAI(env) ? 'workers-ai' : 'none'),
        model: hasUpstream(env) ? (env.XN_MODEL || 'deepseek-chat') : (env.XN_AI_MODEL || AI_MODEL),
        hasKey: hasUpstream(env),
        hasAI: hasAI(env)
      });
    }

    if (path === '/api/config') {
      return json({
        proxy: hasUpstream(env) || hasAI(env),
        backend: hasUpstream(env) ? 'upstream' : (hasAI(env) ? 'workers-ai' : 'none'),
        model: hasUpstream(env) ? (env.XN_MODEL || 'deepseek-chat') : (env.XN_AI_MODEL || AI_MODEL)
      });
    }

    if (path === '/api/chat') {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      if (hasUpstream(env)) return cors(await proxyChat(request, env));
      if (hasAI(env)) return cors(await aiChat(request, env));
      return json({ ok: false, error: '服务器没配模型：加一个 XN_API_KEY，或启用 AI 绑定' }, 503);
    }

    if (path === '/api/admin/verify') {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      if (!env.XN_ADMIN_PASSWORD) return json({ ok: false, reason: 'not_configured' }, 501);
      let pwd = '';
      try { pwd = String((await request.json()).password || ''); } catch (e) { pwd = ''; }
      return json({ ok: pwd === String(env.XN_ADMIN_PASSWORD) });
    }

    if (path === '/api/iterate') {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      let payload = {};
      try { payload = await request.json(); } catch (e) { payload = {}; }
      return cors(await runIteration(env, payload));
    }

    if (path === '/api/feedback') {
      if (request.method === 'POST') return cors(await saveFeedback(request, env));
      if (request.method === 'GET') return cors(await listFeedback(request, env));
      return json({ ok: false, error: '只接受 GET / POST' }, 405);
    }

    if (path.startsWith('/api/')) return json({ ok: false, error: '没有这个接口' }, 404);

    return env.ASSETS.fetch(request);
  }
};

/* ---------- 上游转发（DeepSeek 等） ---------- */

async function proxyChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是 JSON' }, 400);
  }
  if (!payload || !Array.isArray(payload.messages)) {
    return json({ ok: false, error: 'messages 不对' }, 400);
  }

  const base = (env.XN_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const body = {
    model: payload.model || env.XN_MODEL || 'deepseek-chat',
    messages: payload.messages,
    temperature: payload.temperature == null ? 0.8 : payload.temperature,
    stream: !!payload.stream
  };
  if (payload.max_tokens) body.max_tokens = payload.max_tokens;

  let upstream;
  try {
    upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.XN_API_KEY
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return json({ ok: false, error: '连不上上游：' + e.message }, 502);
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
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是 JSON' }, 400);
  }
  if (!payload || !Array.isArray(payload.messages)) {
    return json({ ok: false, error: 'messages 不对' }, 400);
  }

  const model = env.XN_AI_MODEL || AI_MODEL;
  const messages = payload.messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
    content: String(m.content || '')
  }));

  const run = async (name) => env.AI.run(name, {
    messages,
    stream: !!payload.stream,
    max_tokens: payload.max_tokens || 1024
  });

  let out;
  try {
    out = await run(model);
  } catch (e) {
    try {
      out = await run(AI_FALLBACK);
    } catch (e2) {
      return json({ ok: false, error: '自带模型跑不动：' + (e2.message || e2) }, 502);
    }
  }

  if (payload.stream) {
    // Workers AI 的流是 {response:"片段"}，要转成 OpenAI 的 {choices:[{delta:{content}}]}
    const upstreamStream = out instanceof ReadableStream ? out : new Response(out).body;
    const decoder = new TextDecoder();
    let buffer = '';

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const reader = upstreamStream.getReader();
        const push = (delta) => {
          if (!delta.content && !delta.reasoning_content) return;
          controller.enqueue(enc.encode(
            'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n'
          ));
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
              } catch (e) { /* 忽略解析不了的行 */ }
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
    : (out.response
      || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content)
      || '');
  return json({ choices: [{ message: { role: 'assistant', content: text } }] });
}

/* ---------- 反馈 ---------- */

async function saveFeedback(request, env) {
  let item;
  try {
    item = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是 JSON' }, 400);
  }
  const body = String((item && item.body) || '').trim();
  if (!body) return json({ ok: false, error: '内容为空' }, 400);

  const record = {
    id: String(item.id || '').slice(0, 40) || ('srv-' + Date.now().toString(36)),
    ts: new Date().toISOString(),
    type: String(item.type || '其他').slice(0, 20),
    body: body.slice(0, 2000),
    contact: String(item.contact || '').slice(0, 80),
    ua: (request.headers.get('User-Agent') || '').slice(0, 120),
    status: 'new'
  };

  if (env.XN_KV) {
    const key = 'fb:' + record.ts + ':' + Math.random().toString(36).slice(2, 7);
    await env.XN_KV.put(key, JSON.stringify(record));
    return json({ ok: true, saved: 'kv' });
  }
  // 没配 KV：收下但不存，前端本来也留了一份在本机
  return json({ ok: true, saved: 'none' });
}

async function listFeedback(request, env) {
  if (!env.XN_KV) return json({ ok: false, error: '这台服务器没配存储（KV）' }, 503);
  if (!env.XN_ADMIN_PASSWORD) return json({ ok: false, reason: 'not_configured' }, 501);

  const pwd = request.headers.get('X-Admin-Password') || '';
  if (pwd !== String(env.XN_ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 401);
  }

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);

  const listed = await env.XN_KV.list({ prefix: 'fb:', limit });
  const items = [];
  for (const k of listed.keys) {
    const raw = await env.XN_KV.get(k.name);
    if (!raw) continue;
    try { items.push(JSON.parse(raw)); } catch (e) { /* 坏数据跳过 */ }
  }
  items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return json({ ok: true, count: items.length, items });
}
