/* 小暖 · 模型请求层
 * 统一处理：代理/直连、流式解析、超时、重试、上下文裁剪、错误话术。
 * 这一层不再碰 DOM，方便单测。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var t = XN.t || function (k) { return k; };

  var MAX_BODY_CHARS = 480000;
  var DEFAULT_TIMEOUT = 120000;
  var RETRY_STATUS = [429, 500, 502, 503, 504];

  function state() { return XN.state || {}; }
  function cfg() { return (state().cfg && state().cfg.tutor) || {}; }

  function apiBase() {
    return String(cfg().baseUrl || '').trim().replace(/\/+$/, '');
  }
  function isProxy() { return apiBase().charAt(0) === '/'; }
  function chatUrl() {
    return isProxy() ? apiBase() + '/chat' : apiBase() + '/chat/completions';
  }

  function ApiError(message, status, code) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status || 0;
    e.code = code || '';
    return e;
  }

  function friendly(status, detail) {
    var low = String(detail || '').toLowerCase();
    if (status === 401 || status === 403) return t('error.key');
    if (status === 402 || low.indexOf('insufficient') >= 0 || low.indexOf('balance') >= 0) return t('error.balance');
    if (status === 404) return t('error.notFound');
    if (status === 429) return t('error.rate');
    if (status === 408 || low.indexOf('timeout') >= 0) return t('error.timeout');
    if (status >= 500) return t('error.server');
    return t('common.failed') + '（' + status + '）' + (detail ? '：' + String(detail).slice(0, 180) : '');
  }

  /* 粗估 token：中文 1 字≈1 token，英文 4 字符≈1 token。只用于裁剪，不追求精确。 */
  function estimateTokens(text) {
    var s = String(text || '');
    var cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    var rest = s.length - cjk;
    return cjk + Math.ceil(rest / 3.5);
  }

  function messageTokens(m) {
    if (!m) return 0;
    var n = estimateTokens(m.content) + 4;
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
    return n;
  }

  /* 保留 system 与最近的对话；超预算时从最老的开始丢，并插入一条说明。 */
  function fitMessages(messages, budgetTokens) {
    var budget = budgetTokens || 24000;
    var list = (messages || []).slice();
    if (!list.length) return list;
    var total = list.reduce(function (n, m) { return n + messageTokens(m); }, 0);
    if (total <= budget) return list;

    var systems = list.filter(function (m) { return m && m.role === 'system'; });
    var rest = list.filter(function (m) { return m && m.role !== 'system'; });
    var kept = [];
    var used = systems.reduce(function (n, m) { return n + messageTokens(m); }, 0);
    var dropped = 0;

    for (var i = rest.length - 1; i >= 0; i--) {
      var cost = messageTokens(rest[i]);
      if (used + cost > budget && kept.length >= 2) { dropped = i + 1; break; }
      kept.unshift(rest[i]);
      used += cost;
    }
    if (dropped > 0) {
      systems = systems.concat([{
        role: 'system',
        content: '【说明】更早的 ' + dropped + ' 条对话因为长度限制已省略；需要时可以说"接着说前面那个"。'
      }]);
    }
    return systems.concat(kept);
  }

  function providerBaseFor(opts) {
    var model = opts.model || cfg().model || '';
    var prov = cfg().provider || {};
    if (XN.models && XN.models.isCloud(model)) return '';
    if (prov.cloud) return '';
    var base = String(opts.providerBase != null ? opts.providerBase : (prov.base || '')).trim();
    /* /api 是本站代理，不是上游地址，不能塞进 providerBase */
    return base.charAt(0) === '/' ? '' : base;
  }

  function buildBody(messages, opts) {
    var body = {
      model: opts.model || cfg().model || 'deepseek-chat',
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : (cfg().temperature != null ? cfg().temperature : 0.8),
      stream: !!opts.stream
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.tool_choice || 'auto';
    }
    if (isProxy()) {
      var base = providerBaseFor(opts);
      if (base) body.providerBase = base;
    }
    return body;
  }

  function headersFor(opts) {
    var headers = { 'Content-Type': 'application/json' };
    var key = opts.key != null ? opts.key : (state().key || '');
    var model = opts.model || cfg().model || '';
    /* 云端模型不要带任何 Key，避免把用户 Key 发给服务器 */
    if (key && !(XN.models && XN.models.isCloud(model))) {
      headers['Authorization'] = 'Bearer ' + key;
    }
    var token = opts.token || (XN.store && XN.store.sessionGet(XN.KEYS.admin, ''));
    if (isProxy() && token) headers['X-Admin-Token'] = token;
    return headers;
  }

  function bodyTooLarge(body) {
    try { return JSON.stringify(body).length > MAX_BODY_CHARS; }
    catch (e) { return true; }
  }

  function timeoutSignal(ms, external) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      try { ctrl.abort(new DOMException('timeout', 'AbortError')); } catch (e) { ctrl.abort(); }
    }, ms || DEFAULT_TIMEOUT);
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
    }
    return { signal: ctrl.signal, clear: function () { clearTimeout(timer); } };
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function readError(res) {
    var raw = '';
    try { raw = await res.text(); } catch (e) {}
    var detail = raw;
    try {
      var j = JSON.parse(raw);
      detail = (j.error && (j.error.message || j.error.type)) || j.message || raw;
    } catch (e2) {}
    return detail;
  }

  /* 单次请求；不重试。opts.stream 时返回 Response，否则返回解析后的消息。 */
  async function request(messages, opts) {
    opts = opts || {};
    var proxy = isProxy();
    var key = opts.key != null ? opts.key : (state().key || '');
    if (!key && !proxy) throw ApiError(t('error.noKey'), 0, 'no-key');
    if (!apiBase()) throw ApiError(t('error.noBase'), 0, 'no-base');

    var body = buildBody(messages, opts);
    if (bodyTooLarge(body)) throw ApiError('上下文太长了，先开一个新对话。', 413, 'too-large');

    var ts = timeoutSignal(opts.timeoutMs, opts.signal);
    var res;
    try {
      res = await fetch(chatUrl(), {
        method: 'POST',
        headers: headersFor(opts),
        body: JSON.stringify(body),
        signal: ts.signal,
        mode: 'cors',
        credentials: 'same-origin'
      });
    } catch (e) {
      ts.clear();
      if (e && e.name === 'AbortError') {
        if (opts.signal && opts.signal.aborted) throw e;
        throw ApiError(t('error.timeout'), 408, 'timeout');
      }
      throw ApiError(t('error.network'), 0, 'network');
    }

    if (!res.ok) {
      var detail = await readError(res);
      ts.clear();
      throw ApiError(friendly(res.status, detail), res.status, 'http');
    }
    return { res: res, clear: ts.clear };
  }

  function parseSSEChunk(buffer, onEvent) {
    var lines = String(buffer || '').split('\n');
    var rest = lines.pop() || '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { onEvent({ done: true }); continue; }
      var json;
      try { json = JSON.parse(payload); } catch (e) { continue; }
      var choice = (json.choices && json.choices[0]) || {};
      var delta = choice.delta || {};
      var message = choice.message || {};
      onEvent({
        content: delta.content || '',
        reasoning: delta.reasoning_content || delta.reasoning || '',
        toolCalls: delta.tool_calls || message.tool_calls || null,
        finish: choice.finish_reason || ''
      });
    }
    return rest;
  }

  /* 流式请求。返回 {text, reasoning, aborted, incomplete} */
  async function streamChat(messages, opts) {
    opts = opts || {};
    var got = await request(messages, Object.assign({}, opts, { stream: true }));
    var res = got.res;
    var out = { text: '', reasoning: '', aborted: false, incomplete: false };

    if (!res.body || !res.body.getReader) {
      var data = await res.json();
      var msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      out.text = String(msg.content || '');
      if (out.text && opts.onDelta) opts.onDelta(out.text);
      got.clear();
      return out;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    var done = false;

    try {
      while (!done) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = parseSSEChunk(buffer, function (ev) {
          if (ev.done) { done = true; return; }
          if (ev.reasoning) {
            out.reasoning += ev.reasoning;
            if (opts.onReasoning) opts.onReasoning(ev.reasoning);
          }
          if (ev.content) {
            out.text += ev.content;
            if (opts.onDelta) opts.onDelta(ev.content);
          }
        });
      }
      if (!done) out.incomplete = true;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        out.aborted = true;
        if (opts.signal && opts.signal.aborted) out.aborted = true;
      } else {
        out.incomplete = true;
      }
    } finally {
      got.clear();
      try { reader.releaseLock(); } catch (e2) {}
      if (out.incomplete && !out.aborted && out.text) {
        out.text += '\n\n（这条没写完：连接中断了）';
      }
    }
    return out;
  }

  /* 非流式；返回完整 message（含 tool_calls） */
  async function chatRaw(messages, opts) {
    opts = opts || {};
    var attempt = 0;
    var lastErr = null;
    while (attempt < 2) {
      attempt++;
      try {
        var got = await request(messages, Object.assign({}, opts, { stream: false }));
        var data = await got.res.json();
        got.clear();
        var msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        return {
          content: String(msg.content || ''),
          reasoning: String(msg.reasoning_content || msg.reasoning || ''),
          toolCalls: msg.tool_calls || null,
          raw: data
        };
      } catch (e) {
        lastErr = e;
        var retry = e && RETRY_STATUS.indexOf(e.status) >= 0;
        if (!retry || attempt >= 2 || (opts.signal && opts.signal.aborted)) break;
        await sleep(900 + Math.floor(Math.random() * 500));
      }
    }
    throw lastErr || ApiError('request failed', 0);
  }

  async function chatText(messages, opts) {
    var r = await chatRaw(messages, opts);
    return r.content;
  }

  /* ---------- 配置 / 管理 ---------- */
  async function fetchConfig() {
    try {
      var res = await fetch('api/config', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

  async function adminVerify(password) {
    var res = await fetch('api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: String(password || '') }),
      credentials: 'same-origin'
    });
    var j = null;
    try { j = await res.json(); } catch (e) {}
    if (res.status === 501 || (j && j.reason === 'not_configured')) {
      throw ApiError(t('error.adminOff'), 501, 'not_configured');
    }
    if (!res.ok || !j || !j.ok) throw ApiError(t('error.adminBad'), res.status, 'bad-password');
    if (!j.token) throw ApiError('服务器没有返回会话令牌，请更新后端。', 500, 'no-token');
    return j;
  }

  async function adminFetch(path, opts) {
    opts = opts || {};
    var token = XN.store ? XN.store.sessionGet(XN.KEYS.admin, '') : '';
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers['X-Admin-Token'] = token;
    var res = await fetch(path, Object.assign({}, opts, { headers: headers, credentials: 'same-origin' }));
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { res: res, data: data };
  }

  XN.api = {
    ApiError: ApiError,
    friendly: friendly,
    estimateTokens: estimateTokens,
    fitMessages: fitMessages,
    isProxy: isProxy,
    apiBase: apiBase,
    chatUrl: chatUrl,
    streamChat: streamChat,
    chatRaw: chatRaw,
    chatText: chatText,
    request: request,
    parseSSEChunk: parseSSEChunk,
    fetchConfig: fetchConfig,
    adminVerify: adminVerify,
    adminFetch: adminFetch
  };
})(typeof window !== 'undefined' ? window : globalThis);
