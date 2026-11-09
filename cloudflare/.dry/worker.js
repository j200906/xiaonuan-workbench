var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
__name(json, "json");
function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}
__name(cors, "cors");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (path === "/api/health") {
      return json({ ok: true, model: env.XN_MODEL || "deepseek-chat", hasKey: !!env.XN_API_KEY });
    }
    if (path === "/api/config") {
      return json({ proxy: !!env.XN_API_KEY, model: env.XN_MODEL || "deepseek-chat" });
    }
    if (path === "/api/chat") {
      if (request.method !== "POST") return json({ ok: false, error: "\u53EA\u63A5\u53D7 POST" }, 405);
      if (!env.XN_API_KEY) return json({ ok: false, error: "\u670D\u52A1\u5668\u6CA1\u914D XN_API_KEY" }, 503);
      return cors(await proxyChat(request, env));
    }
    if (path === "/api/feedback") {
      if (request.method !== "POST") return json({ ok: false, error: "\u53EA\u63A5\u53D7 POST" }, 405);
      return cors(await saveFeedback(request, env));
    }
    if (path.startsWith("/api/")) return json({ ok: false, error: "\u6CA1\u6709\u8FD9\u4E2A\u63A5\u53E3" }, 404);
    return env.ASSETS.fetch(request);
  }
};
async function proxyChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F JSON" }, 400);
  }
  if (!payload || !Array.isArray(payload.messages)) {
    return json({ ok: false, error: "messages \u4E0D\u5BF9" }, 400);
  }
  const base = (env.XN_BASE || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const body = {
    model: payload.model || env.XN_MODEL || "deepseek-chat",
    messages: payload.messages,
    temperature: payload.temperature == null ? 0.8 : payload.temperature,
    stream: !!payload.stream
  };
  if (payload.max_tokens) body.max_tokens = payload.max_tokens;
  let upstream;
  try {
    upstream = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.XN_API_KEY
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return json({ ok: false, error: "\u8FDE\u4E0D\u4E0A\u4E0A\u6E38\uFF1A" + e.message }, 502);
  }
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (body.stream) headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}
__name(proxyChat, "proxyChat");
async function saveFeedback(request, env) {
  let item;
  try {
    item = await request.json();
  } catch (e) {
    return json({ ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F JSON" }, 400);
  }
  const body = String(item && item.body || "").trim();
  if (!body) return json({ ok: false, error: "\u5185\u5BB9\u4E3A\u7A7A" }, 400);
  const record = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    type: String(item.type || "\u5176\u4ED6").slice(0, 20),
    body: body.slice(0, 2e3),
    contact: String(item.contact || "").slice(0, 80),
    ua: (request.headers.get("User-Agent") || "").slice(0, 120)
  };
  if (env.XN_KV) {
    const key = "fb:" + record.ts + ":" + Math.random().toString(36).slice(2, 7);
    await env.XN_KV.put(key, JSON.stringify(record));
    return json({ ok: true, saved: "kv" });
  }
  return json({ ok: true, saved: "none" });
}
__name(saveFeedback, "saveFeedback");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
