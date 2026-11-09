/* 小暖 · 核心：会话、配置、门禁、对话 */
(function (N) {
  'use strict';

  var ADMIN_PASSWORD = 'xiaonuanai';
  var KEYS = {
    cfg: 'xn.cfg.v1',
    sessions: 'xn.sessions.v1',
    current: 'xn.current.v1',
    legacyChat: 'xn.chat.v1',
    notes: 'xn.notes.v1',
    goals: 'xn.goals.v1',
    fb: 'xn.fb.v1',
    key: 'xn.key.v1',
    admin: 'xn.admin',
    theme: 'xn.theme.local',
    timer: 'xn.timer.v1',
    mem: 'xn.mem.v1',
    view: 'xn.view'
  };

  var VIEW_META = {
    chat: { title: '新对话' },
    study: { title: '学习台' },
    feedback: { title: '反馈箱' },
    arch: { title: '架构' },
    settings: { title: '设置' },
    changelog: { title: '更新日志' },
    iterate: { title: '迭代' }
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
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDate(ts) {
    var d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
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
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
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
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove(); resolve();
      } catch (e) { reject(e); }
    });
  }

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
    catch (e) { toast('本机存储写不进去了（可能满了）'); return false; }
  }

  /* ---------- 配置 ---------- */
  function defaultConfig() {
    return {
      version: 2,
      brand: '小暖',
      labels: { study: '学习台', feedback: '反馈箱', arch: '架构', settings: '设置' },
      nav: [
        { id: 'study', show: true },
        { id: 'feedback', show: true },
        { id: 'settings', show: true }
      ],
      style: { accent: '#b4553a', radius: 14, fontSize: 15, theme: 'light', density: 'cozy' },
      tutor: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        temperature: 0.8,
        stream: true,
        historyTurns: 14,
        systemPrompt: ''   // 空 = 用 persona.js 动态拼；填了就用你填的
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
    sessions: [],
    currentId: '',
    notes: [],
    goals: { date: todayStr(), items: [] },
    feedback: [],
    timer: { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: todayStr() },
    sending: false,
    abort: null,
    pendingText: '',
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
    document.title = (cfg.brand || '小暖');

    renderSideLinks();
    updateHeader();
  }

  function renderSideLinks() {
    var order = (state.cfg.nav || []).filter(function (n) { return n.id !== 'chat'; });
    order.forEach(function (item) {
      var btn = document.querySelector('.side-link[data-view="' + item.id + '"]');
      if (!btn) return;
      var label = (state.cfg.labels && state.cfg.labels[item.id]) || VIEW_META[item.id].title;
      var span = btn.querySelector('span');
      if (span) span.textContent = label;
      var visible = item.show !== false;
      btn.hidden = !visible;
    });
  }

  function updateHeader() {
    var titleEl = $('#mainTitle');
    if (!titleEl) return;
    if (state.view === 'chat') {
      var s = currentSession();
      titleEl.textContent = s && s.messages.length ? sessionTitle(s) : ((state.cfg.labels && state.cfg.labels.chat) || '新对话');
    } else {
      titleEl.textContent = (state.cfg.labels && state.cfg.labels[state.view]) || VIEW_META[state.view].title;
    }
    $$('.side-link').forEach(function (b) {
      b.classList.toggle('on', state.view !== 'chat' && b.dataset.view === state.view);
    });
    var pill = $('#modelPill');
    if (pill) pill.textContent = state.cfg.tutor.model || 'deepseek-chat';
  }

  var VIEW_IDS = ['chat', 'study', 'feedback', 'settings', 'changelog', 'iterate'];
  function switchView(id) {
    if (VIEW_IDS.indexOf(id) < 0) id = 'chat';
    if (id === 'arch') id = 'settings';               // 架构已并入设置
    if (id === 'iterate' && !state.admin) id = 'settings';
    state.view = id;
    $$('.pane').forEach(function (v) { v.hidden = v.dataset.view !== id; });
    updateHeader();
    try { sessionStorage.setItem(KEYS.view, id); } catch (e) {}
    if (N.views && N.views[id] && N.views[id].onShow) N.views[id].onShow();
    if (id === 'chat') setTimeout(function () { scrollBottom(true); }, 30);
    closeSide();
  }
  N.switchView = switchView;

  function closeSide() {
    document.getElementById('app').classList.remove('side-open');
    var scrim = $('#scrim');
    if (scrim) scrim.hidden = true;
  }
  function openSide() {
    document.getElementById('app').classList.add('side-open');
    var scrim = $('#scrim');
    if (scrim) scrim.hidden = false;
  }

  N.state = state;
  N.isProxy = isProxy;
  N.$ = $; N.$$ = $$; N.esc = esc; N.uid = uid; N.toast = toast;
  N.readJSON = readJSON; N.writeJSON = writeJSON; N.download = download;
  N.fmtTime = fmtTime; N.fmtDate = fmtDate; N.todayStr = todayStr; N.bytes = bytes;
  N.mergeConfig = mergeConfig; N.defaultConfig = defaultConfig;
  N.viewMeta = VIEW_META; N.KEYS = KEYS;

  function saveConfig() {
    writeJSON(KEYS.cfg, state.cfg);
    if (N.onConfigChange) N.onConfigChange();
  }
  N.saveConfig = saveConfig;
  N.applyConfig = applyConfig;
  N.renderSideLinks = renderSideLinks;

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
    function closeList() { if (list) { html += '</' + list + '>'; list = null; } }
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
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); closeList(); html += '<hr>'; continue; }
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
    if (status === 401 || status === 403) return 'Key 无效或没有权限（' + status + '）。检查一下是不是没复制完整。';
    if (status === 402 || low.indexOf('insufficient') >= 0 || low.indexOf('balance') >= 0) return '余额不足（' + status + '）。去服务商后台充点再试。';
    if (status === 404) return '接口路径或模型名不对（404）。确认 Base URL 带 /v1，模型名存在。';
    if (status === 429) return '请求太频繁（429）。等十几秒再试。';
    if (status >= 500) return '服务商那边出错了（' + status + '）。不是你写错了，过一会儿再试。';
    return '请求失败（' + status + '）。' + (detail ? String(detail).slice(0, 200) : '');
  }

  var MODEL_BY_PROVIDER = {
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    zhipu: ['glm-4-flash', 'glm-4-plus'],
    siliconflow: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    custom: []
  };

  // 云端只留一个；想要别的模型就去填自己的 Key
  var CLOUD_MODELS = [
    { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7-Flash', note: '云端唯一' }
  ];

  function currentProvider() {
    var p = state.cfg.tutor.provider;
    if (p && p.id) return p.id;
    return isProxy() ? 'cloud' : 'custom';
  }

  function modelLabel(id) {
    var hit = CLOUD_MODELS.filter(function (m) { return m.id === id; })[0];
    return hit ? hit.name : id;
  }

  function isCloudModel(id) {
    return String(id || '').indexOf('@cf/') === 0;
  }

  function buildGroups() {
    var prov = currentProvider();
    var groups = [];
    var own = (MODEL_BY_PROVIDER[prov] || []).slice();
    var cur = state.cfg.tutor.model || '';
    // 用云端模型时，不要把上一个服务商的模型名混进来
    if (prov === 'cloud') own = [];
    else if (cur && !isCloudModel(cur) && own.indexOf(cur) < 0) own.unshift(cur);
    if (own.length) {
      groups.push({
        label: '自己的 API',
        items: own.map(function (m) { return { id: m, name: m, note: '' }; })
      });
    }
    groups.push({ label: '云端自带（唯一，不用 Key）', items: CLOUD_MODELS });
    return groups;
  }

  function renderModelPick() {
    var trigger = $('#modelPickTrigger');
    var menu = $('#modelMenu');
    if (!trigger || !menu) return;

    var cur = state.cfg.tutor.model || '';
    var groups = buildGroups();

    // 隐藏的原生 select：状态同步 + 无障碍
    var sel = $('#modelPick');
    sel.innerHTML = groups.reduce(function (acc, g) {
      return acc.concat(g.items.map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
      }));
    }, []).join('');
    sel.value = cur;

    menu.innerHTML = groups.map(function (g) {
      return '<div class="mp-group"><div class="mp-group-label">' + esc(g.label) + '</div>' +
        g.items.map(function (m) {
          var on = m.id === cur;
          return '<div class="mp-opt" role="option" data-id="' + esc(m.id) + '" aria-selected="' + on + '">' +
            '<svg class="mp-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4 5 9l4.5-5.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<span class="mp-name">' + esc(m.name) + '</span>' +
            '<span class="mp-tag">' + esc(m.note || '') + '</span>' +
            '</div>';
        }).join('') + '</div>';
    }).join('');

    $('#modelPickText').textContent = cur ? modelLabel(cur) : '选模型';
    trigger.title = cur || '';
    trigger.disabled = false;
  }

  function selectModel(id) {
    state.cfg.tutor.model = id;
    if (isCloudModel(id)) {
      state.cfg.tutor.provider = { id: 'cloud', base: '' };
      state.cfg.tutor.baseUrl = '/api';
    } else if (!state.cfg.tutor.provider || state.cfg.tutor.provider.id === 'cloud') {
      // 从云端模型切回自己的模型，但没有存过服务商：回设置里挑一个
      toast('换成 ' + modelLabel(id) + ' 后，去设置里填一次 Key');
    }
    saveConfig();
    updateHeader();
    renderModelPick();
    toast('换成 ' + modelLabel(id));
  }
  N.renderModelPick = renderModelPick;
  N.selectModel = selectModel;

  function apiBase() { return String(state.cfg.tutor.baseUrl || '').trim().replace(/\/+$/, ''); }
  function isProxy() { return apiBase().charAt(0) === '/'; }
  function chatUrl() { return isProxy() ? apiBase() + '/chat' : apiBase() + '/chat/completions'; }

  async function apiChatRaw(messages, opts) {
    opts = opts || {};
    var proxy = isProxy();
    var key = state.key;
    if (!key && !proxy) throw ApiError('还没有填 API Key。');

    var body = {
      model: state.cfg.tutor.model || 'deepseek-chat',
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : state.cfg.tutor.temperature,
      stream: false
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (proxy && key && state.cfg.tutor.provider && state.cfg.tutor.provider.base) {
      body.providerBase = state.cfg.tutor.provider.base;
    }

    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;

    var res = await fetch(chatUrl(), { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!res.ok) {
      var raw = '';
      try { raw = await res.text(); } catch (e) {}
      throw ApiError('模型返回 ' + res.status + '：' + String(raw).slice(0, 140));
    }
    var j = await res.json();
    var msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: msg.content || '', toolCalls: msg.tool_calls || null };
  }
  N.apiChatRaw = apiChatRaw;

  function lastUserText(session) {
    var list = (session ? session.messages : []) || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user' && list[i].content) return list[i].content;
    }
    return '';
  }

  function systemPromptFor(session) {
    var custom = String(state.cfg.tutor.systemPrompt || '').trim();
    if (custom) return custom;
    if (!window.XN_PERSONA || !window.XN_PERSONA.build) return '你叫小暖。';

    var q = lastUserText(session);
    var mem = window.XN_MEM;

    var memories = state.memory || [];
    var extra = '';
    if (mem) {
      var act = mem.getActiveMemories ? mem.getActiveMemories() : null;
      var trails = mem.activate ? mem.activate(q, 6) : [];
      if (act && act.explicit && act.explicit.length) {
        memories = act.explicit.slice();
      }
      if (trails.length) {
        extra = trails.map(function (t) { return t.content; }).join('；');
      }
    }

    var prompt = window.XN_PERSONA.build({
      query: q,
      emo: state.lastEmo || window.XN_PERSONA.detectEmotion(q),
      memories: memories,
      notes: state.notes || [],
      goals: ((state.goals && state.goals.items) || []).filter(function (g) { return !g.done; }).map(function (g) { return g.text; }),
      name: mem && mem.name ? mem.name() : ''
    });

    if (extra) prompt += '\n【顺着这句话联想起来的事】' + extra;
    if (mem && mem.relation) {
      var rel = mem.relation();
      prompt += '\n【你们的关系】' + rel.label + '（聊过 ' + rel.interactions + ' 次）';
    }
    if (mem && mem.promises) {
      var live = mem.promises().filter(function (x) { return !x.kept; });
      if (live.length) prompt += '\n【你答应过、还没做到的事】' + live.slice(0, 5).map(function (x) { return x.text; }).join('；');
    }
    if (window.XN_EMO && window.XN_EMO.hint) {
      prompt = prompt.replace(/情绪应对提示：[^\n]*/, '情绪应对提示：' + window.XN_EMO.hint(state.lastEmo));
    }
    return prompt;
  }

  function buildMessages(extraSystem) {
    var sys = systemPromptFor(currentSession());
    if (extraSystem) sys += '\n\n' + extraSystem;
    var msgs = [{ role: 'system', content: sys }];
    var turns = clamp(state.cfg.tutor.historyTurns, 2, 40);
    var s = currentSession();
    var hist = (s ? s.messages : []).filter(function (m) {
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
    if (proxy && key && state.cfg.tutor.provider && state.cfg.tutor.provider.base) {
      body.providerBase = state.cfg.tutor.provider.base;
    }

    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;

    var res;
    try {
      res = await fetch(chatUrl(), {
        method: 'POST', headers: headers, body: JSON.stringify(body), signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw ApiError('请求没发出去。可能是断网、代理拦截，或者这个服务商不允许浏览器直连。');
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
      var d2 = await res.json();
      var m2 = (d2.choices && d2.choices[0] && d2.choices[0].message) || {};
      var t2 = (m2.content || '').trim();
      if (t2 && opts.onDelta) opts.onDelta(t2);
      return { text: t2, reasoning: (m2.reasoning_content || '').trim() };
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
    return { text: acc, reasoning: reasoning };
  }
  N.apiChat = apiChat;

  /* ---------- 会话 ---------- */
  function sessionTitle(s) {
    var first = (s.messages || []).filter(function (m) { return m.role === 'user' && m.content; })[0];
    var text = first ? first.content.replace(/\s+/g, ' ').trim() : '新对话';
    return text.length > 22 ? text.slice(0, 21) + '…' : text;
  }
  N.sessionTitle = sessionTitle;

  function currentSession() {
    return state.sessions.filter(function (s) { return s.id === state.currentId; })[0] || null;
  }
  N.currentSession = currentSession;

  function saveSessions() {
    var keep = state.sessions
      .filter(function (s) { return s.messages && s.messages.length; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, 30)
      .map(function (s) {
        return {
          id: s.id, ts: s.ts, title: sessionTitle(s),
          messages: s.messages.filter(function (m) { return !m.pending; }).slice(-60)
        };
      });
    writeJSON(KEYS.sessions, keep);
    writeJSON(KEYS.current, state.currentId);
  }
  N.saveSessions = saveSessions;

  function newSession() {
    var s = { id: uid(), ts: Date.now(), messages: [] };
    state.sessions.unshift(s);
    state.currentId = s.id;
    renderSessions();
    renderThread();
    switchView('chat');
    setTimeout(function () { $('#input').focus(); }, 50);
    return s;
  }
  N.newSession = newSession;

  function openSession(id) {
    state.currentId = id;
    renderSessions();
    renderThread();
    switchView('chat');
  }

  function deleteSession(id, ev) {
    if (ev) ev.stopPropagation();
    var s = state.sessions.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (s.messages.length && !confirm('删掉这个对话？删了就找不回来。')) return;
    state.sessions = state.sessions.filter(function (x) { return x.id !== id; });
    if (state.currentId === id) {
      var next = state.sessions.filter(function (x) { return x.messages.length; })[0];
      state.currentId = next ? next.id : '';
      if (!state.currentId) newSession();
    }
    saveSessions();
    renderSessions();
    renderThread();
    toast('删掉了');
  }

  function renderSessions() {
    var box = $('#sessionList');
    if (!box) return;
    var list = state.sessions
      // 当前这个即使还没说话也要显示，否则点了「新对话」界面上一点反应都没有
      .filter(function (s) {
        return (s.messages && s.messages.length) || s.id === state.currentId;
      })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    $('#sessionEmpty').hidden = list.length > 0;
    $('#sessionLabel').hidden = list.length === 0;
    box.innerHTML = list.map(function (s) {
      return '<div class="session' + (s.id === state.currentId ? ' on' : '') + '" data-id="' + s.id + '">' +
        '<button class="ses-main" type="button">' +
        '<span class="ses-title">' + esc(sessionTitle(s)) + '</span>' +
        '<span class="ses-time">' + fmtTime(s.ts) + '</span>' +
        '</button>' +
        '<button class="ses-del" type="button" title="删除">×</button>' +
        '</div>';
    }).join('');

    $$('.ses-main', box).forEach(function (b) {
      b.addEventListener('click', function () {
        openSession(b.closest('.session').dataset.id);
      });
    });
    $$('.ses-del', box).forEach(function (b) {
      b.addEventListener('click', function (ev) {
        deleteSession(b.closest('.session').dataset.id, ev);
      });
    });
  }
  N.renderSessions = renderSessions;

  /* ---------- 对话渲染 ---------- */
  function scrollBottom(force) {
    var box = $('#messages');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || near) box.scrollTop = box.scrollHeight;
  }
  N.scrollBottom = scrollBottom;

  function greeting() {
    var h = new Date().getHours();
    if (h < 5) return '还没睡？';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function emptyState() {
    var starters = (window.XN_PERSONA && window.XN_PERSONA.starters) || [];
    return '<div class="empty" id="chatEmpty">' +
      '<h2>' + greeting() + '</h2>' +
      '<p>今天想动哪一块？小暖不替你写完作业，但会陪你把卡住的拆开。</p>' +
      '<div class="chips">' + starters.map(function (s) {
        return '<button class="chip" type="button" data-prompt="' + esc(s) + '">' +
          esc(s.length > 18 ? s.slice(0, 17) + '…' : s) + '</button>';
      }).join('') + '</div></div>';
  }

  function messageNode(m) {
    var div = document.createElement('div');
    if (m.role === 'user') {
      div.className = 'msg user';
      div.innerHTML = '<div class="body"><div class="content"></div></div>';
      div.querySelector('.content').textContent = m.content;
      return div;
    }

    div.className = 'msg bot';
    div.innerHTML = '<div class="body">' +
      '<div class="who-line"><span>小暖</span><span>' + fmtTime(m.ts) + '</span></div>' +
      (m.reasoning ? '<div class="reasoning"></div>' : '') +
      '<div class="content"></div>' +
      (m.error ? '<p class="err">' + esc(m.error) + '</p>' : '') +
      '<div class="msg-tools">' +
      '<button type="button" data-copy>复制</button>' +
      '<button type="button" data-retry>重新生成</button>' +
      '</div></div>';

    if (m.reasoning) div.querySelector('.reasoning').textContent = m.reasoning;
    var content = div.querySelector('.content');
    if (m.pending) content.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    else if (m.content) content.innerHTML = md(m.content);

    div.querySelector('[data-copy]').addEventListener('click', function () {
      copyText(m.content || '').then(function () { toast('复制好了'); }, function () { toast('复制失败'); });
    });
    div.querySelector('[data-retry]').addEventListener('click', function () {
      var s = currentSession();
      if (!s) return;
      var idx = s.messages.indexOf(m);
      if (idx < 1) return;
      s.messages = s.messages.slice(0, idx);
      renderThread();
      runAssistant();
    });
    return div;
  }

  function renderThread() {
    var box = $('#messages');
    if (!box) return;
    var s = currentSession();
    if (!s || !s.messages.length) {
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
    s.messages.forEach(function (m) { thread.appendChild(messageNode(m)); });
    box.innerHTML = '';
    box.appendChild(thread);
    scrollBottom(true);
  }
  N.renderThread = renderThread;

  function autoGrow() {
    var input = $('#input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  function setSending(on) {
    state.sending = on;
    var send = $('#btnSend'), stop = $('#btnStop');
    if (send) send.disabled = on;
    if (stop) stop.hidden = !on;
    updateConn(on ? 'busy' : 'ok');
  }

  function updateConn(mode) {
    var dot = $('#connDot'), text = $('#connText');
    if (!dot) return;
    var connected = !!state.key || isProxy();
    dot.classList.toggle('off', mode === 'off' || !connected);
    if (!text) return;
    if (mode === 'busy') text.textContent = '生成中…';
    else if (!connected) text.textContent = '未配置 Key';
    else if (mode === 'off') text.textContent = '连接有问题';
    else text.textContent = (state.admin ? '架构模式 · ' : '') + (state.cfg.tutor.model || '已连接');
  }
  N.updateConn = updateConn;

  async function webSearchFor(q) {
    try {
      var res = await fetch('api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
      var j = await res.json();
      return (j && j.items) || [];
    } catch (e) {
      return [];
    }
  }

  async function runAssistant() {
    var s = currentSession();
    if (!s) s = newSession();
    var bot = { role: 'assistant', content: '', reasoning: '', ts: Date.now(), pending: true };
    s.messages.push(bot);
    s.ts = Date.now();
    renderThread();
    var nodes = $$('#messages .msg.bot');
    var node = nodes[nodes.length - 1];
    var contentEl = node.querySelector('.content');
    var bodyEl = node.querySelector('.body');

    var ctrl = new AbortController();
    state.abort = ctrl;
    setSending(true);

    // 模型要想十几秒：先给个可见的占位，别让界面像死了
    if (!contentEl.textContent) {
      contentEl.textContent = '正在想…';
      contentEl.classList.add('thinking');
    }
    var thinkingCleared = false;
    function clearThinking() {
      if (thinkingCleared) return;
      thinkingCleared = true;
      contentEl.classList.remove('thinking');
    }

    var reasoningEl = null;
    function ensureReasoning() {
      if (reasoningEl) return reasoningEl;
      reasoningEl = document.createElement('div');
      reasoningEl.className = 'reasoning';
      bodyEl.insertBefore(reasoningEl, contentEl);
      return reasoningEl;
    }

    try {
      var msgs = buildMessages();
      var res;
      if (state.web && window.XN_TOOLS) {
        // 走工具循环：模型自己决定搜不搜、搜什么
        var loopRes = await window.XN_TOOLS.loopWithFallback({
          messages: msgs,
          chat: function (m, tools) { return apiChatRaw(m, { tools: tools }); },
          textChat: function (m) { return apiChatRaw(m, {}); },
          onTool: function (name, args, result) {
            toast('用了工具：' + name + (result && result.ok ? '' : '（没跑通）'));
          }
        });
        res = { text: (loopRes && loopRes.content) || '' };
        bot.content = res.text;
        contentEl.textContent = bot.content;
      } else {
        res = await apiChat(msgs, {
        stream: !!state.cfg.tutor.stream,
        signal: ctrl.signal,
        onDelta: function (d) {
          clearThinking();
          bot.content += d;
          if (reasoningEl) reasoningEl.hidden = true;
          node.classList.add('streaming');
          contentEl.textContent = bot.content;
          scrollBottom();
        },
        onReasoning: function (r) {
          clearThinking();
          bot.reasoning += r;
          var el = ensureReasoning();
          el.textContent = bot.reasoning;
          el.hidden = false;
          scrollBottom();
        }
        });
      }

      if (!state.cfg.tutor.stream && res.text && !bot.content) {
        bot.content = res.text;
        contentEl.textContent = bot.content;
      }
      if (!bot.content.trim()) {
        bot.content = '';
        bot.error = '模型返回了空内容。可能被安全策略拦了，或者模型名不对。';
      }
      clearThinking();
      node.classList.remove('streaming');
      contentEl.innerHTML = bot.content ? md(bot.content) : '';
      if (bot.error) {
        var p = document.createElement('p');
        p.className = 'err';
        p.textContent = bot.error;
        bodyEl.appendChild(p);
      }
      state.conn = 'ok';
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
        bodyEl.appendChild(pe);
        if (e && e.status === 401) updateConn('off');
      }
    } finally {
      bot.pending = false;
      state.abort = null;
      setSending(false);
      saveSessions();
      renderSessions();
      updateHeader();
    }
  }

  /* ---------- Key 行内提示 ---------- */
  function showKeyBar(pending) {
    if (pending) state.pendingText = pending;
    var bar = $('#keyBar');
    bar.hidden = false;
    var msg = $('#keyMsg');
    msg.textContent = '';
    msg.className = 'keybar-msg';
    $('#keyBase').value = state.cfg.tutor.baseUrl || '';
    $('#keyModel').value = state.cfg.tutor.model || '';
    setTimeout(function () { $('#keyInput').focus(); }, 30);
  }
  N.showKeyBar = showKeyBar;

  function hideKeyBar() {
    var bar = $('#keyBar');
    if (bar) bar.hidden = true;
    state.pendingText = '';
  }

  async function saveKeyFromBar() {
    var key = $('#keyInput').value.trim();
    var base = $('#keyBase').value.trim();
    var model = $('#keyModel').value.trim();
    var msg = $('#keyMsg');
    if (base) state.cfg.tutor.baseUrl = base;
    if (model) state.cfg.tutor.model = model;

    if (!key && !isProxy()) {
      msg.textContent = '先填一个 Key。';
      $('#keyInput').focus();
      return;
    }

    var btn = $('#keySave');
    btn.disabled = true;
    msg.className = 'keybar-msg';
    msg.textContent = '正在试一下…';
    try {
      await apiChat([{ role: 'user', content: '只回一个字：好' }],
        { key: key, stream: false, maxTokens: 8, temperature: 0 });
    } catch (e) {
      msg.textContent = e.message || '没通。';
      btn.disabled = false;
      return;
    }
    btn.disabled = false;

    state.key = key;
    saveStoredKey(key, true);
    saveConfig();
    updateConn('ok');
    msg.className = 'keybar-msg ok';
    msg.textContent = '通了。';
    var pending = state.pendingText;
    hideKeyBar();
    if (pending) sendMessage(pending);
    else toast('接上了');
  }

  function saveStoredKey(key, remember) {
    try {
      if (!key) { localStorage.removeItem(KEYS.key); sessionStorage.removeItem(KEYS.key); return; }
      if (remember) {
        localStorage.setItem(KEYS.key, key);
        sessionStorage.removeItem(KEYS.key);
      } else {
        sessionStorage.setItem(KEYS.key, key);
        localStorage.removeItem(KEYS.key);
      }
    } catch (e) {}
  }
  N.saveStoredKey = saveStoredKey;

  function storedKey() {
    try { return localStorage.getItem(KEYS.key) || sessionStorage.getItem(KEYS.key) || ''; } catch (e) { return ''; }
  }

  /* ---------- 管理模式 ---------- */
  async function unlockAdmin(password) {
    var pwd = String(password || '');
    if (!pwd) return { ok: false, error: '先填密码。' };
    if (isProxy()) {
      try {
        var r = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        var j = await r.json();
        if (j && j.reason === 'not_configured') {
          if (pwd !== ADMIN_PASSWORD) return { ok: false, error: '密码不对。' };
        } else if (!j || !j.ok) {
          return { ok: false, error: '服务器说密码不对。' };
        }
      } catch (e) {
        return { ok: false, error: '问不到服务器，没法确认密码。' };
      }
    } else if (pwd !== ADMIN_PASSWORD) {
      return { ok: false, error: '密码不对。' };
    }

    state.admin = true;
    state.adminPwd = pwd;
    try { sessionStorage.setItem(KEYS.admin, '1'); } catch (e) {}
    renderSideLinks();
    updateConn('ok');
    var navIter = $('#navIterate');
    if (navIter) navIter.hidden = false;
    return { ok: true };
  }
  N.unlockAdmin = unlockAdmin;

  function lockAdmin() {
    state.admin = false;
    state.adminPwd = '';
    try { sessionStorage.removeItem(KEYS.admin); } catch (e) {}
    renderSideLinks();
    updateConn('ok');
    var navIter = $('#navIterate');
    if (navIter) navIter.hidden = true;
    if (state.view === 'iterate') switchView('settings');
  }
  N.lockAdmin = lockAdmin;

  /* ---------- 发送 ---------- */
  async function sendMessage(raw) {
    if (state.sending) return;
    var text = String(raw == null ? $('#input').value : raw).trim();
    if (!text) return;

    if (!state.key && !isProxy()) {
      showKeyBar(text);
      return;
    }

    // 「记住 / 忘了」两条最简单的长期记忆指令，对应原程序的 explicit memory
    var mRemember = text.match(/^记住[，,：:\s]*(.+)$/);
    var mForget = text.match(/^忘(?:了|掉)[，,：:\s]*(.+)$/);
    if (mRemember) {
      var item = mRemember[1].trim();
      if (item && (state.memory || []).indexOf(item) < 0) {
        state.memory = state.memory || [];
        state.memory.push(item);
        writeJSON(KEYS.mem, state.memory);
      }
      if (window.XN_MEM && item) window.XN_MEM.addExplicit(item);
    } else if (mForget) {
      var key = mForget[1].trim();
      state.memory = (state.memory || []).filter(function (x) { return x.indexOf(key) < 0; });
      writeJSON(KEYS.mem, state.memory);
      if (window.XN_MEM) window.XN_MEM.forget(key);
    }

    if (window.XN_EMO) {
      try {
        // 先用关键词，够用就不多打一次模型
        var quick = window.XN_EMO.analyze ? null : null;
        var chatFn = (state.cfg.tutor.emoLLM === true)
          ? function (m) { return apiChatRaw(m, { maxTokens: 90, temperature: 0 }).then(function (r) { return r.content; }); }
          : null;
        state.lastEmo = await window.XN_EMO.analyze(text, chatFn);
      } catch (e) { state.lastEmo = null; }
    }
    if (window.XN_MEM) {
      try {
        window.XN_MEM.touch();
        if (window.XN_MEM.pushBuffer) window.XN_MEM.pushBuffer('用户：' + text);
        if (window.XN_MEM.addImplicit) window.XN_MEM.addImplicit(text.slice(0, 120), 'dialog');
      } catch (e) {}
    }

    var s = currentSession();
    if (!s) s = newSession();
    s.messages.push({ role: 'user', content: text, ts: Date.now() });
    s.ts = Date.now();
    if (!s.title) s.title = sessionTitle(s);

    var input = $('#input');
    input.value = '';
    autoGrow();
    renderThread();
    renderSessions();
    updateHeader();
    await runAssistant();
  }
  N.sendMessage = sendMessage;

  /* ---------- 绑定 ---------- */
  function bind() {
    $('#btnNew').addEventListener('click', function () {
      var cur = currentSession();
      if (cur && !cur.messages.length) {
        // 已经是空对话：不清屏，但必须给出看得见的反馈，否则像是按钮坏了
        var box = $('#input');
        if (box) { box.value = ''; autoGrow(); box.focus(); }
        toast('已经是新对话了，直接说吧');
        return;
      }
      newSession();
      toast('新对话');
    });

    $$('.side-link').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.dataset.view); });
    });

    $('#sideOpen').addEventListener('click', openSide);
    $('#sideClose').addEventListener('click', closeSide);
    $('#scrim').addEventListener('click', closeSide);

    $('#btnTheme').addEventListener('click', function () {
      var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEYS.theme, next); } catch (e) {}
      applyConfig();
    });

    $('#modelPill').addEventListener('click', function () { switchView('settings'); });

    var pickWrap = $('#modelPickWrap');
    var pickTrigger = $('#modelPickTrigger');
    function closePick() {
      if (!pickWrap) return;
      pickWrap.classList.remove('is-open');
      if (pickTrigger) pickTrigger.setAttribute('aria-expanded', 'false');
    }
    if (pickTrigger) {
      pickTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = pickWrap.classList.toggle('is-open');
        pickTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      $('#modelMenu').addEventListener('click', function (e) {
        var opt = e.target.closest('.mp-opt');
        if (!opt) return;
        selectModel(opt.dataset.id);
        closePick();
      });
      document.addEventListener('click', function (e) {
        if (pickWrap && !pickWrap.contains(e.target)) closePick();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closePick();
      });
    }
    var webBtn = $('#btnWeb');
    if (webBtn) {
      var paintWeb = function () { webBtn.setAttribute('aria-pressed', state.web ? 'true' : 'false'); };
      paintWeb();
      webBtn.addEventListener('click', function () {
        state.web = !state.web;
        paintWeb();
        toast(state.web ? '联网已开：每次发消息前先查一遍' : '联网已关');
      });
    }

    // 隐藏的原生 select 仍然可能被外部改（无障碍/脚本），保持同步
    $('#modelPick').addEventListener('change', function () {
      if (this.value) selectModel(this.value);
    });

    var input = $('#input');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!state.sending) sendMessage();
      }
    });
    $('#composerForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!state.sending) sendMessage();
    });
    $('#btnStop').addEventListener('click', function () {
      if (state.abort) state.abort.abort();
    });

    $('#keySave').addEventListener('click', saveKeyFromBar);
    $('#keyInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveKeyFromBar(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (state.sending && state.abort) state.abort.abort();
        closeSide();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newSession();
      }
    });
  }

  /* ---------- 启动 ---------- */
  async function detectProxy() {
    try {
      if (storedKey()) return;
      if (state.cfg.tutor.baseUrl !== defaultConfig().tutor.baseUrl) return;
      var host = location.hostname;
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '') return;
      var res = await fetch('api/config', { cache: 'no-store' });
      if (!res.ok) return;
      var cfg = await res.json();
      if (cfg && cfg.repo) state.cloudRepo = cfg.repo;
      if (cfg && cfg.proxy) {
        state.cfg.tutor.baseUrl = '/api';
        if (!state.cfg.tutor.provider || !state.cfg.tutor.provider.id) {
          state.cfg.tutor.provider = { id: 'cloud', base: '' };
        }
        if (cfg.model) state.cfg.tutor.model = cfg.model;
        writeJSON(KEYS.cfg, state.cfg);
        state.autoProxy = true;
      }
    } catch (e) { /* 没有后端就当没这回事 */ }
  }

  async function boot() {
    var saved = readJSON(KEYS.cfg, null);
    state.cfg = saved ? mergeConfig(defaultConfig(), saved) : defaultConfig();
    state.cfg.nav = (state.cfg.nav || []).filter(function (n) { return n.id !== 'chat'; });
    if (!state.cfg.nav.length) state.cfg.nav = defaultConfig().nav;
    state.cfg.labels = mergeConfig(defaultConfig().labels, state.cfg.labels || {});

    state.key = storedKey();
    state.notes = readJSON(KEYS.notes, []);
    state.feedback = readJSON(KEYS.fb, []);
    state.goals = readJSON(KEYS.goals, { date: todayStr(), items: [] });
    state.timer = readJSON(KEYS.timer, { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: todayStr() });

    var sessions = readJSON(KEYS.sessions, null);
    if (!sessions) {
      var legacy = readJSON(KEYS.legacyChat, []);
      sessions = legacy && legacy.length
        ? [{ id: uid(), ts: Date.now(), title: '', messages: legacy }]
        : [];
    }
    state.sessions = sessions || [];
    state.currentId = readJSON(KEYS.current, '') || '';

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

    try { state.admin = sessionStorage.getItem(KEYS.admin) === '1'; } catch (e) {}

    await detectProxy();
    applyConfig();
    bind();
    renderModelPick();

    if (N.views) {
      Object.keys(N.views).forEach(function (k) {
        if (N.views[k] && N.views[k].init) N.views[k].init();
      });
    }

    if (!state.sessions.length) {
      state.sessions.push({ id: uid(), ts: Date.now(), messages: [] });
      state.currentId = state.sessions[0].id;
    } else if (!currentSession()) {
      state.currentId = state.sessions[0].id;
    }

    renderSessions();
    renderThread();
    var navIter = $('#navIterate');
    if (navIter) navIter.hidden = !state.admin;
    var verChip = $('#verChip');
    if (verChip) verChip.textContent = 'v' + (window.XN_VERSION || '1.0.0');
    updateConn(state.key || isProxy() ? 'ok' : 'idle');

    var want = 'chat';
    try { want = sessionStorage.getItem(KEYS.view) || 'chat'; } catch (e) {}
    switchView(want === 'iterate' && !state.admin ? 'settings' : want);
  }

  N.boot = boot;
  document.addEventListener('DOMContentLoaded', boot);
})(window.XN = window.XN || {});
