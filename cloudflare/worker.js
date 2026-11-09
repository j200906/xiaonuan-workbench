/**
 * 小暖 · Cloudflare Worker 版
 *
 * 一个 Worker 同时干三件事：
 *   1. 把 public/ 里的静态文件发出去（ASSETS 绑定）
 *   2. /api/chat 代理到 OpenAI 兼容接口，Key 只存在 Worker 的 secret 里
 *   3. /api/feedback 收反馈（配了 KV 就存 KV，没配就只回执）
 *
 * 这样访客打开网页不需要任何 Key，也不会看到 Key。
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (path === '/api/health') {
      return json({ ok: true, model: env.XN_MODEL || 'deepseek-chat', hasKey: !!env.XN_API_KEY });
    }

    if (path === '/api/config') {
      return json({ proxy: !!env.XN_API_KEY, model: env.XN_MODEL || 'deepseek-chat' });
    }

    if (path === '/api/chat') {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      if (!env.XN_API_KEY) return json({ ok: false, error: '服务器没配 XN_API_KEY' }, 503);
      return cors(await proxyChat(request, env));
    }

    if (path === '/api/feedback') {
      if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
      return cors(await saveFeedback(request, env));
    }

    if (path.startsWith('/api/')) return json({ ok: false, error: '没有这个接口' }, 404);

    return env.ASSETS.fetch(request);
  }
};

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
    ts: new Date().toISOString(),
    type: String(item.type || '其他').slice(0, 20),
    body: body.slice(0, 2000),
    contact: String(item.contact || '').slice(0, 80),
    ua: (request.headers.get('User-Agent') || '').slice(0, 120)
  };

  if (env.XN_KV) {
    const key = 'fb:' + record.ts + ':' + Math.random().toString(36).slice(2, 7);
    await env.XN_KV.put(key, JSON.stringify(record));
    return json({ ok: true, saved: 'kv' });
  }
  // 没配 KV：收下但不存，前端本来也留了一份在本机
  return json({ ok: true, saved: 'none' });
}
