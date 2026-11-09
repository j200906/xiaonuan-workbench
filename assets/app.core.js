/* 小暖工作台 · 核心：配置、门禁、导航、对话 */
(function (N) {
  'use strict';

  /* ---------- 常量 ---------- */
  var ADMIN_PASSWORD = 'xiaonuanai';
  var KEYS = {
    cfg: 'xn.cfg.v1',
    chat: 'xn.chat.v1',
    notes: 'xn.notes.v1',
    goals: 'xn.goals.v1',
    fb: 'xn.fb.v1',
    key: 'xn.key.v1',
    admin: 'xn.admin',
    theme: 'xn.theme.local',
    timer: 'xn.timer.v1',
    view: 'xn.view'
  };

  var VIEW_META = {
    chat: { title: '对话', hint: '和小暖聊，或者把今天要啃的东西丢进来。' },
    study: { title: '学习台', hint: '目标、专注、笔记。数据只存在这台设备上。' },
    feedback: { title: '反馈箱', hint: '哪里别扭、哪里断了，写下来。' },
    arch: { title: '架构', hint: '改布局、配色、文案和小暖的设定，改完立刻生效。' },
    settings: { title: '设置', hint: '接口、Key 和本机数据。' }
  };

  var ICONS = {
    chat: '<path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-6.2A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7Z"/>',
    study: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20"/>',
    feedback: '<path d="M4 6h16v10H9l-5 3Z"/><path d="M8 10h8M8 13h5"/>',
    arch: '<path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h9M17 17h3"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>'
  };

  /* ---------- 工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clamp(n, lo, hi) { n = Number(n); if (isNaN(n)) return lo; return Math.min(hi, Math.max(lo, n)); }
  function debounce(fn, wait) {
    var t; return function () {
      var a = arguments, self = this;
      clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, wait || 200);
    };
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDate(ts) {
    var d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtTime(ts);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove(); resolve();
      } catch (e) { reject(e); }
    });
  }

  /* ---------- 存储 ---------- */
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { toast('本机存储写不进去了（可能已满）'); return false; }
  }

  /* ---------- 默认配置 ---------- */
  function defaultConfig() {
    return {
      version: 1,
      brand: '小暖',
      brandSub: 'workbench',
      labels: { chat: '对话', study: '学习台', feedback: '反馈箱', arch: '架构', settings: '设置' },
      nav: [
        { id: 'chat', show: true },
        { id: 'study', show: true },
        { id: 'feedback', show: true },
        { id: 'arch', show: true },
        { id: 'settings', show: true }
      ],
      style: { accent: '#b4553a', radius: 14, fontSize: 15, theme: 'light', density: 'cozy' },
      tutor: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        temperature: 0.8,
        stream: true,
        historyTurns: 14,
        systemPrompt: (window.XN_PERSONA && window.XN_PERSONA.system) || '你叫小暖。'
      },
      feedback: { endpoint: '' }
    };
  }

  function mergeConfig(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !Array.isArray(out[k]) &&
          out[k] && typeof out[k] === 'object') {
        out[k] = mergeConfig(out[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    });
    return out;
  }

  /* ---------- 状态 ---------- */
  var state = {
    key: '',
    admin: false,
    cfg: defaultConfig(),
    messages: [],
    notes: [],
    goals: { date: todayStr(), items: [] },
    feedback: [],
    timer: { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: todayStr() },
    sending: false,
    abort: null,
    view: 'chat',
    conn: 'idle'
  };
  N.ADMIN_PASSWORD = ADMIN_PASSWORD;

  /* ---------- 颜色 ---------- */
  function hex2rgb(h) {
    h = String(h || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(a) {
    return '#' + a.map(function (v) {
      v = Math.round(clamp(v, 0, 255));
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function luminance(hex) {
    var c = hex2rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  N.colorMix = mix;

  /* ---------- 配置应用 ---------- */
  function resolvedTheme() {
    var local = localStorage.getItem(KEYS.theme);
    var t = local || (state.cfg.style && state.cfg.style.theme) || 'light';
    if (t === 'auto') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return t;
  }

  function applyConfig() {
    var cfg = state.cfg;
    var root = document.documentElement;
    var theme = resolvedTheme();
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', cfg.style.density === 'compact' ? 'compact' : 'cozy');

    var panel = theme === 'dark' ? '#1d1c15' : '#fffefb';
    var accent = cfg.style.accent;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-soft', mix(accent, panel, theme === 'dark' ? 0.84 : 0.9));
    root.style.setProperty('--accent-line', mix(accent, panel, theme === 'dark' ? 0.68 : 0.74));
    root.style.setProperty('--accent-ink', luminance(accent) > 0.62 ? '#201d18' : '#ffffff');
    root.style.setProperty('--radius', clamp(cfg.style.radius, 0, 26) + 'px');
    root.style.setProperty('--fs', clamp(cfg.style.fontSize, 12, 20) + 'px');

    if ($('#brandName')) $('#brandName').textContent = cfg.brand || '小暖';
    if ($('#brandSub')) $('#brandSub').textContent = cfg.brandSub || 'workbench';
    document.title = (cfg.brand || '小暖') + '工作台';

    renderNav();
    updateHeaderForView();
  }

  function allowedViews() {
    return (state.cfg.nav || []).filter(function (item) {
      if (item.id === 'arch') return state.admin && item.show;
      return item.show !== false;
    });
  }

  function renderNav() {
    var nav = $('#nav');
    if (!nav) return;
    var items = allowedViews();
    nav.innerHTML = items.map(function (item) {
      var meta = VIEW_META[item.id] || { title: item.id };
      var label = (state.cfg.labels && state.cfg.labels[item.id]) || meta.title;
      var on = item.id === state.view ? ' on' : '';
      return '<button type="button" data-view="' + item.id + '" class="' + on.trim() + '">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
        'stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[item.id] || '') + '</svg>' +
        '<span>' + esc(label) + '</span></button>';
    }).join('');
    $$('#nav button').forEach(function (btn) {
      btn.addEventListener('click', function () { switchView(btn.dataset.view); });
    });
    if (!items.some(function (i) { return i.id === state.view; })) {
      if (items.length) switchView(items[0].id);
    }
  }

  function updateHeaderForView() {
    var meta = VIEW_META[state.view] || { title: state.view, hint: '' };
    var label = (state.cfg.labels && state.cfg.labels[state.view]) || meta.title;
    if ($('#viewTitle')) $('#viewTitle').textContent = label;
    if ($('#viewHint')) $('#viewHint').textContent = meta.hint;
    $$('#nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === state.view);
    });
  }

  function switchView(id) {
    if (!id) return;
    if (!allowedViews().some(function (i) { return i.id === id; })) id = 'chat';
    state.view = id;
    $$('.view').forEach(function (v) { v.hidden = v.dataset.view !== id; });
    updateHeaderForView();
    try { sessionStorage.setItem(KEYS.view, id); } catch (e) {}
    if (N.views && N.views[id] && N.views[id].onShow) N.views[id].onShow();
    if (id === 'chat') setTimeout(scrollBottom, 30);
  }
  N.switchView = switchView;
  N.state = state;
  N.$ = $; N.$$ = $$; N.esc = esc; N.uid = uid; N.toast = toast;
  N.readJSON = readJSON; N.writeJSON = writeJSON; N.download = download;
  N.fmtTime = fmtTime; N.fmtDate = fmtDate; N.todayStr = todayStr; N.bytes = bytes;
  N.mergeConfig = mergeConfig; N.defaultConfig = defaultConfig;
  N.viewMeta = VIEW_META; N.KEYS = KEYS;

  function saveConfig() {
    writeJSON(KEYS.cfg, state.cfg);
    N.onConfigChange && N.onConfigChange();
  }
  N.saveConfig = saveConfig;
  N.applyConfig = applyConfig;
  N.renderNav = renderNav;

  /* ---------- Markdown ---------- */
  function inlineMd(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, function (m, c) { return '<code>' + c + '</code>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]{1,80})\]\((https?:[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function mdBlocks(src) {
    var lines = src.split('\n');
    var html = '', list = null, para = [];
    function flushPara() {
      if (para.length) {
        html += '<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
        para = [];
      }
    }
    function closeList() {
      if (list) { html += '</' + list + '>'; list = null; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (!line.trim()) { flushPara(); closeList(); continue; }
      var m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        var lv = Math.min(m[1].length, 3);
        html += '<h' + lv + '>' + inlineMd(m[2]) + '</h' + lv + '>';
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara();
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += '<li>' + inlineMd(line.replace(/^\s*[-*+]\s+/, '')) + '</li>';
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += '<li>' + inlineMd(line.replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushPara(); closeList();
        html += '<blockquote>' + inlineMd(line.replace(/^>\s?/, '')) + '</blockquote>';
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushPara(); closeList(); html += '<hr>'; continue;
      }
      para.push(line);
    }
    flushPara(); closeList();
    return html;
  }

  function md(src) {
    var text = String(src == null ? '' : src).replace(/\r\n/g, '\n');
    var parts = text.split('```');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i].replace(/^[A-Za-z0-9+#._-]*\n/, '').replace(/\n$/, '');
        out += '<pre><code>' + esc(code) + '</code></pre>';
      } else {
        out += mdBlocks(parts[i]);
      }
    }
    return out;
  }
  N.md = md;

  /* ---------- API ---------- */
  function ApiError(message, status) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.status = status;
    return e;
  }

  function friendlyError(status, detail) {
    var low = String(detail || '').toLowerCase();
    if (status === 401 || status === 403) return 'Key 无效或没有权限（' + status + '）。检查一下有没有复制完整。';
    if (status === 402 || low.indexOf('insufficient') >= 0 || low.indexOf('balance') >= 0) return '余额不足（' + status + '）。去服务商后台充点再试。';
    if (status === 404) return '接口路径或模型名不对（404）。检查 Base URL 是否带 /v1，模型名是否存在。';
    if (status === 429) return '请求太频繁被限流（429）。等十几秒再试。';
    if (status >= 500) return '服务商那边出错了（' + status + '）。不是你写错了，过会儿再试。';
    return '请求失败（' + status + '）。' + (detail ? String(detail).slice(0, 220) : '');
  }

  function apiBase() {
    return String(state.cfg.tutor.baseUrl || '').trim().replace(/\/+$/, '');
  }

  // Base URL 填成 /api 时走同源后端代理：Key 留在服务器，浏览器不带 Key
  function isProxy() { return apiBase().charAt(0) === '/'; }

  function chatUrl() { return isProxy() ? apiBase() + '/chat' : apiBase() + '/chat/completions'; }

  function buildMessages(extraSystem) {
    var sys = state.cfg.tutor.systemPrompt || '你叫小暖。';
    if (extraSystem) sys += '\n\n' + extraSystem;
    var msgs = [{ role: 'system', content: sys }];
    var turns = clamp(state.cfg.tutor.historyTurns, 2, 40);
    var hist = state.messages.filter(function (m) {
      return m.role === 'user' || (m.role === 'assistant' && m.content && !m.pending);
    }).slice(-turns * 2);
    hist.forEach(function (m) {
      if (!m.content) return;
      msgs.push({ role: m.role, content: m.content });
    });
    return msgs;
  }

  async function apiChat(messages, opts) {
    opts = opts || {};
    var proxy = isProxy();
    var key = opts.key || state.key;
    if (!key && !proxy) throw ApiError('还没有填 API Key。');
    if (!apiBase()) throw ApiError('还没有填 Base URL。');

    var body = {
      model: state.cfg.tutor.model || 'deepseek-chat',
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : state.cfg.tutor.temperature,
      stream: !!opts.stream
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    var res;
    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    try {
      res = await fetch(chatUrl(), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw ApiError('请求没发出去。可能是断网、代理拦截，或者这个服务商不允许浏览器直连（CORS）。');
    }

    if (!res.ok) {
      var detail = '';
      try {
        var raw = await res.text();
        try {
          var j = JSON.parse(raw);
          detail = (j.error && (j.error.message || j.error.type)) || j.message || raw;
        } catch (e2) { detail = raw; }
      } catch (e3) {}
      throw ApiError(friendlyError(res.status, detail), res.status);
    }

    if (!opts.stream) {
      var data = await res.json();
      var msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      return { text: (msg.content || '').trim(), reasoning: (msg.reasoning_content || '').trim() };
    }

    if (!res.body || !res.body.getReader) {
      var data2 = await res.json();
      var msg2 = (data2.choices && data2.choices[0] && data2.choices[0].message) || {};
      var t2 = (msg2.content || '').trim();
      if (t2 && opts.onDelta) opts.onDelta(t2);
      return { text: t2, reasoning: (msg2.reasoning_content || '').trim() };
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '', acc = '', reasoning = '', finished = false;

    while (!finished) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') { finished = true; break; }
        var json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        var delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (opts.onReasoning) opts.onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          acc += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content);
        }
      }
    }
    if (buf && buf.indexOf('data:') === 0) {
      var tail = buf.slice(5).trim();
      if (tail && tail !== '[DONE]') {
        try {
          var jt = JSON.parse(tail);
          var dt = (jt.choices && jt.choices[0] && jt.choices[0].delta) || {};
          if (dt.content) { acc += dt.content; if (opts.onDelta) opts.onDelta(dt.content); }
        } catch (e) {}
      }
    }
    return { text: acc, reasoning: reasoning };
  }
  N.apiChat = apiChat;

  /* ---------- 门禁 ---------- */
  function gateMsg(text, kind) {
    var el = $('#gateMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
  }

  function storedKey() {
    try {
      return localStorage.getItem(KEYS.key) || sessionStorage.getItem(KEYS.key) || '';
    } catch (e) { return ''; }
  }

  function saveKey(key, remember) {
    try {
      if (!key) {
        localStorage.removeItem(KEYS.key);
        sessionStorage.removeItem(KEYS.key);
        return;
      }
      if (remember) {
        localStorage.setItem(KEYS.key, key);
        sessionStorage.removeItem(KEYS.key);
      } else {
        sessionStorage.setItem(KEYS.key, key);
        localStorage.removeItem(KEYS.key);
      }
    } catch (e) {}
  }

  async function validate(key) {
    var probe = await apiChat(
      [{ role: 'user', content: '只回一个字：好' }],
      { key: key, stream: false, maxTokens: 8, temperature: 0 }
    );
    return probe;
  }

  function openApp() {
    $('#gate').hidden = true;
    $('#shell').hidden = false;
    $('#brandName').textContent = state.cfg.brand || '小暖';
    $('#brandSub').textContent = state.cfg.brandSub || 'workbench';
    $('#modeBadge').textContent = state.admin ? '架构模式' : '访客';
    $('#modeBadge').className = 'badge' + (state.admin ? ' admin' : '');
    applyConfig();
    var want = 'chat';
    try { want = sessionStorage.getItem(KEYS.view) || 'chat'; } catch (e) {}
    switchView(want);
    if (N.views && N.views.chat) N.views.chat.onShow();
    updateConn('ok');
  }

  function lock() {
    state.admin = false;
    try { sessionStorage.removeItem(KEYS.admin); } catch (e) {}
    try { sessionStorage.removeItem(KEYS.key); } catch (e) {}
    state.key = '';
    state.messages = [];
    $('#shell').hidden = true;
    $('#gate').hidden = false;
    $('#gateKey').value = '';
    $('#gatePwd').value = '';
    gateMsg('已退出。Key 若未勾选「记住」就已经从本机清掉了。', 'ok');
    renderNav();
  }

  function updateConn(mode) {
    var dot = $('#connDot'), text = $('#whoText');
    if (!dot) return;
    dot.classList.toggle('off', mode === 'off');
    if (text) {
      text.textContent = mode === 'off' ? '未连接' :
        (mode === 'busy' ? '生成中…' : (state.admin ? '架构模式 · 已连接' : '已连接'));
    }
  }
  N.updateConn = updateConn;

  async function onGateSubmit(ev) {
    ev.preventDefault();

    var base = $('#gateBase').value.trim();
    var model = $('#gateModel').value.trim();
    if (base) state.cfg.tutor.baseUrl = base;
    if (model) state.cfg.tutor.model = model;

    var key = $('#gateKey').value.trim();
    var pwd = $('#gatePwd').value;
    var proxy = isProxy();

    if (!key && !proxy) { gateMsg('先填 API Key。'); $('#gateKey').focus(); return; }
    if (pwd && !proxy && pwd !== ADMIN_PASSWORD) {
      gateMsg('管理密码不对。留空就只能调用小暖，不会进架构。');
      return;
    }

    var btn = $('#gateGo');
    btn.disabled = true;
    gateMsg(proxy ? '正在通过服务器验证…' : '正在验证 Key…', 'working');
    try {
      await validate(key);
    } catch (e) {
      gateMsg(e.message || '验证失败。');
      btn.disabled = false;
      return;
    }

    // 走后端代理时，密码交给服务器校验（服务器没配密码才回落到本地）
    if (pwd && proxy) {
      try {
        var vr = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        var vj = await vr.json();
        if (vj && vj.reason === 'not_configured') {
          if (pwd !== ADMIN_PASSWORD) {
            gateMsg('管理密码不对。');
            btn.disabled = false;
            return;
          }
        } else if (!vj || !vj.ok) {
          gateMsg('服务器说密码不对。');
          btn.disabled = false;
          return;
        }
      } catch (err) {
        gateMsg('问不到服务器，没法确认密码。');
        btn.disabled = false;
        return;
      }
    }

    btn.disabled = false;

    state.key = key;
    if (key) saveKey(key, $('#gateRemember').checked);
    state.admin = !!pwd;
    try { sessionStorage.setItem(KEYS.admin, state.admin ? '1' : '0'); } catch (e) {}
    saveConfig();
    gateMsg(state.admin ? '通过。架构已解锁。' : '通过。', 'ok');
    setTimeout(openApp, 160);
  }

  /* ---------- 对话 ---------- */
  function scrollBottom(force) {
    var box = $('#messages');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || near) box.scrollTop = box.scrollHeight;
  }
  N.scrollBottom = scrollBottom;

  function emptyState() {
    var starters = (window.XN_PERSONA && window.XN_PERSONA.starters) || [];
    return '<div class="empty" id="chatEmpty">' +
      '<div class="empty-mark">暖</div>' +
      '<h3>今天想动哪一块？</h3>' +
      '<p>小暖不会替你写完作业，但会陪你把卡住的地方拆开。</p>' +
      '<div class="chips">' + starters.map(function (s) {
        return '<button class="chip" data-prompt="' + esc(s) + '">' + esc(s.length > 16 ? s.slice(0, 15) + '…' : s) + '</button>';
      }).join('') + '</div></div>';
  }

  function toolRow(m, index) {
    return '<div class="msg-tools">' +
      '<button type="button" data-copy>复制</button>' +
      '<button type="button" data-retry>重新生成</button>' +
      '</div>';
  }

  function messageNode(m, index) {
    var isUser = m.role === 'user';
    var div = document.createElement('div');
    div.className = 'msg ' + (isUser ? 'user' : 'bot');
    div.dataset.index = index;

    if (isUser) {
      div.innerHTML = '<div class="body"><div class="who-line">你 · ' + fmtTime(m.ts) + '</div>' +
        '<div class="content"></div></div>';
      div.querySelector('.content').textContent = m.content;
      return div;
    }

    var errHtml = m.error ? '<p class="err">' + esc(m.error) + '</p>' : '';
    div.innerHTML = '<div class="av">暖</div><div class="body">' +
      '<div class="who-line">小暖 · ' + fmtTime(m.ts) + '</div>' +
      (m.reasoning ? '<div class="reasoning"></div>' : '') +
      '<div class="content"></div>' + errHtml + toolRow(m, index) + '</div>';
    if (m.reasoning) {
      var r = div.querySelector('.reasoning');
      r.textContent = m.reasoning;
    }
    var content = div.querySelector('.content');
    if (m.pending) {
      content.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    } else if (m.content) {
      content.innerHTML = md(m.content);
    }
    bindTools(div, m);
    return div;
  }

  function bindTools(node, m) {
    var copy = node.querySelector('[data-copy]');
    var retry = node.querySelector('[data-retry]');
    if (copy) copy.addEventListener('click', function () {
      copyText(m.content || '').then(function () { toast('复制好了'); },
        function () { toast('复制失败，手动选吧'); });
    });
    if (retry) retry.addEventListener('click', function () {
      var idx = state.messages.indexOf(m);
      if (idx < 0) return;
      var prevUser = null;
      for (var i = idx - 1; i >= 0; i--) {
        if (state.messages[i].role === 'user') { prevUser = state.messages[i]; break; }
      }
      if (!prevUser) return;
      state.messages = state.messages.slice(0, i + 1);
      renderThread();
      runAssistant();
    });
  }

  function renderThread() {
    var box = $('#messages');
    if (!box) return;
    if (!state.messages.length) {
      box.innerHTML = emptyState();
      $$('.chip[data-prompt]', box).forEach(function (chip) {
        chip.addEventListener('click', function () {
          var input = $('#input');
          input.value = chip.dataset.prompt;
          autoGrow();
          input.focus();
        });
      });
      return;
    }
    var thread = document.createElement('div');
    thread.className = 'thread';
    state.messages.forEach(function (m, i) { thread.appendChild(messageNode(m, i)); });
    box.innerHTML = '';
    box.appendChild(thread);
    scrollBottom(true);
  }
  N.renderThread = renderThread;

  function saveChat() {
    var keep = state.messages.filter(function (m) { return !m.pending; }).slice(-60);
    writeJSON(KEYS.chat, keep);
  }

  function autoGrow() {
    var input = $('#input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  function setSending(on) {
    state.sending = on;
    var send = $('#btnSend'), stop = $('#btnStop');
    if (send) send.disabled = on;
    if (stop) stop.hidden = !on;
    updateConn(on ? 'busy' : 'ok');
  }

  async function runAssistant() {
    var bot = { role: 'assistant', content: '', reasoning: '', ts: Date.now(), pending: true };
    state.messages.push(bot);
    renderThread();
    var nodes = $$('#messages .msg.bot');
    var node = nodes[nodes.length - 1];
    var contentEl = node.querySelector('.content');
    var bodyEl = node.querySelector('.body');

    var ctrl = new AbortController();
    state.abort = ctrl;
    setSending(true);

    var reasoningEl = null;
    function ensureReasoning() {
      if (reasoningEl) return reasoningEl;
      reasoningEl = document.createElement('div');
      reasoningEl.className = 'reasoning';
      bodyEl.insertBefore(reasoningEl, contentEl);
      return reasoningEl;
    }

    try {
      var res = await apiChat(buildMessages(), {
        stream: !!state.cfg.tutor.stream,
        signal: ctrl.signal,
        onDelta: function (d) {
          bot.content += d;
          if (reasoningEl) reasoningEl.hidden = true;
          node.classList.add('streaming');
          contentEl.textContent = bot.content;
          scrollBottom();
        },
        onReasoning: function (r) {
          bot.reasoning += r;
          var el = ensureReasoning();
          el.textContent = bot.reasoning;
          el.hidden = false;
          scrollBottom();
        }
      });

      if (!state.cfg.tutor.stream && res.text && !bot.content) {
        bot.content = res.text;
        contentEl.textContent = bot.content;
      }
      if (!bot.content.trim()) {
        bot.content = '';
        bot.error = '模型返回了空内容。可能是被安全策略拦了，或者模型名不对。';
      }
      node.classList.remove('streaming');
      contentEl.innerHTML = bot.content ? md(bot.content) : '';
      if (bot.error) {
        var p = document.createElement('p');
        p.className = 'err';
        p.textContent = bot.error;
        node.querySelector('.body').appendChild(p);
      }
    } catch (e) {
      node.classList.remove('streaming');
      if (e && e.name === 'AbortError') {
        if (!bot.content) bot.content = '（已停止）';
        contentEl.innerHTML = md(bot.content);
      } else {
        bot.error = (e && e.message) || '出错了。';
        contentEl.innerHTML = bot.content ? md(bot.content) : '';
        var pe = document.createElement('p');
        pe.className = 'err';
        pe.textContent = bot.error;
        node.querySelector('.body').appendChild(pe);
      }
    } finally {
      bot.pending = false;
      state.abort = null;
      setSending(false);
      saveChat();
    }
  }

  async function sendMessage(raw) {
    if (state.sending) return;
    var text = String(raw == null ? $('#input').value : raw).trim();
    if (!text) return;
    if (!state.key) { toast('先填 API Key'); return; }

    state.messages.push({ role: 'user', content: text, ts: Date.now() });
    var input = $('#input');
    input.value = '';
    autoGrow();
    renderThread();
    await runAssistant();
  }
  N.sendMessage = sendMessage;

  /* ---------- 绑定 ---------- */
  function bind() {
    $('#gateForm').addEventListener('submit', onGateSubmit);
    $('#btnLock').addEventListener('click', lock);

    $('#btnTheme').addEventListener('click', function () {
      var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEYS.theme, next); } catch (e) {}
      applyConfig();
    });

    var input = $('#input');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!state.sending) sendMessage();
      }
    });
    $('#btnSend').addEventListener('click', function () { sendMessage(); });
    $('#btnStop').addEventListener('click', function () {
      if (state.abort) state.abort.abort();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.sending && state.abort) state.abort.abort();
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (!$('#shell').hidden) { switchView('chat'); $('#input').focus(); }
      }
    });

    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').addEventListener &&
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if ((localStorage.getItem(KEYS.theme) || state.cfg.style.theme) === 'auto') applyConfig();
      });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var saved = readJSON(KEYS.cfg, null);
    state.cfg = saved ? mergeConfig(defaultConfig(), saved) : defaultConfig();

    var baseEl = $('#gateBase'), modelEl = $('#gateModel');
    if (baseEl) baseEl.value = state.cfg.tutor.baseUrl;
    if (modelEl) modelEl.value = state.cfg.tutor.model;

    state.messages = readJSON(KEYS.chat, []);
    state.notes = readJSON(KEYS.notes, []);
    state.feedback = readJSON(KEYS.fb, []);
    state.goals = readJSON(KEYS.goals, { date: todayStr(), items: [] });
    state.timer = readJSON(KEYS.timer, { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: todayStr() });

    if (state.goals.date !== todayStr()) {
      state.goals.date = todayStr();
      state.goals.items.forEach(function (g) { g.done = false; });
      writeJSON(KEYS.goals, state.goals);
    }
    if (state.timer.date !== todayStr()) {
      state.timer.date = todayStr();
      state.timer.done = 0;
      writeJSON(KEYS.timer, state.timer);
    }

    applyConfig();
    bind();

    if (N.views) {
      Object.keys(N.views).forEach(function (k) {
        if (N.views[k] && N.views[k].init) N.views[k].init();
      });
    }
    renderThread();

    var key = storedKey();
    var adminFlag = false;
    try { adminFlag = sessionStorage.getItem(KEYS.admin) === '1'; } catch (e) {}
    if (key) {
      state.key = key;
      // 架构解锁只在同一标签页内有效：换标签、换浏览器都要重新输密码
      state.admin = adminFlag;
      openApp();
    } else {
      $('#gate').hidden = false;
    }
  }

  N.boot = boot;
  document.addEventListener('DOMContentLoaded', boot);
})(window.XN = window.XN || {});
