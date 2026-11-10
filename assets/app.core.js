/* 小暖 · 核心
 * 只做四件事：状态与配置、路由、会话与发送、管理模式。
 * 视图逻辑在 views.*.js，模型请求在 lib/api.js。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var U = XN.util, S = XN.store, API = XN.api, MD = XN.md, M = XN.models;
  var $ = U.$, $$ = U.$$, t = XN.t;

  var VIEW_IDS = ['chat', 'study', 'feedback', 'settings', 'changelog', 'iterate'];
  var VIEW_META = {
    chat: { title: 'nav.chat' },
    study: { title: 'nav.study' },
    feedback: { title: 'nav.feedback' },
    settings: { title: 'nav.settings' },
    changelog: { title: 'nav.changelog' },
    iterate: { title: 'nav.iterate' }
  };

  function defaultConfig() {
    return {
      version: 3,
      brand: '小暖',
      labels: { chat: t('nav.chat'), study: t('nav.study'), feedback: t('nav.feedback'), settings: t('nav.settings'), changelog: t('nav.changelog'), iterate: t('nav.iterate') },
      nav: [
        { id: 'study', show: true },
        { id: 'feedback', show: true },
        { id: 'changelog', show: true },
        { id: 'settings', show: true }
      ],
      style: { accent: '#b4553a', radius: 14, fontSize: 15, theme: 'light', density: 'cozy' },
      tutor: {
        provider: { id: 'custom', base: '' },
        ownProvider: { id: 'deepseek', base: 'https://api.deepseek.com/v1' },
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        temperature: 0.8,
        stream: true,
        historyTurns: 14,
        systemPrompt: '',
        emoLLM: 'auto'
      },
      feedback: { endpoint: '' },
      limits: { sessions: 30, messagesPerSession: 60, notesPage: 20 }
    };
  }

  function mergeConfig(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!patch || typeof patch !== 'object') return out;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (U.isPlainObject(v) && U.isPlainObject(out[k])) out[k] = mergeConfig(out[k], v);
      else if (v !== undefined) out[k] = v;
    });
    return out;
  }

  var state = {
    key: '',
    admin: false,
    cfg: defaultConfig(),
    sessions: [],
    currentId: '',
    notes: [],
    goals: { date: U.todayStr(), items: [] },
    feedback: [],
    timer: { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: U.todayStr() },
    sending: false,
    abort: null,
    pendingText: '',
    view: 'chat',
    conn: 'idle',
    web: false,
    lastEmo: null,
    lastEmoAt: 0,
    emoCalls: 0,
    cloudRepo: null,
    autoProxy: false,
    localMode: false,
    gatewayKey: '',
    lastOwnProvider: null
  };
  XN.state = state;
  XN.KEYS = S.KEYS;

  /* ---------- 配置 ---------- */
  function saveConfig() {
    S.set(S.KEYS.cfg, state.cfg);
    if (XN.emit) XN.emit('config:change', state.cfg);
  }
  XN.saveConfig = saveConfig;

  function hex2rgb(h) {
    h = String(h || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    if (!isFinite(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(a) {
    return '#' + a.map(function (v) {
      v = Math.round(U.clamp(v, 0, 255));
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }
  function mix(a, b, k) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
  }
  function luminance(hex) {
    var c = hex2rgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function resolvedTheme() {
    var local = S.get(S.KEYS.theme, '');
    var mode = local || (state.cfg.style && state.cfg.style.theme) || 'light';
    if (mode === 'auto') {
      return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return mode === 'dark' ? 'dark' : 'light';
  }

  function applyConfig() {
    var cfg = state.cfg;
    var el = document.documentElement;
    var theme = resolvedTheme();
    el.setAttribute('data-theme', theme);
    el.setAttribute('data-density', cfg.style.density === 'compact' ? 'compact' : 'cozy');

    var panel = theme === 'dark' ? '#1d1c15' : '#fffefb';
    var accent = cfg.style.accent || '#b4553a';
    el.style.setProperty('--accent', accent);
    el.style.setProperty('--accent-soft', mix(accent, panel, theme === 'dark' ? 0.84 : 0.9));
    el.style.setProperty('--accent-line', mix(accent, panel, theme === 'dark' ? 0.68 : 0.74));
    el.style.setProperty('--accent-ink', luminance(accent) > 0.62 ? '#201d18' : '#ffffff');
    el.style.setProperty('--radius', U.clamp(cfg.style.radius, 0, 26) + 'px');
    el.style.setProperty('--fs', U.clamp(cfg.style.fontSize, 12, 20) + 'px');

    var brand = cfg.brand || t('app.name');
    if ($('#brandName')) $('#brandName').textContent = brand;
    document.title = brand;

    renderSideLinks();
    updateHeader();
    if (XN.emit) XN.emit('theme:change', theme);
  }
  XN.applyConfig = applyConfig;

  function renderSideLinks() {
    var labels = state.cfg.labels || {};
    $$('.side-link').forEach(function (btn) {
      var id = btn.dataset.view;
      if (!id) return;
      var span = btn.querySelector('span');
      if (span) span.textContent = labels[id] || t((VIEW_META[id] && VIEW_META[id].title) || 'nav.chat');

      if (id === 'chat') {
        btn.hidden = false;
        return;
      }
      /* 迭代页只在管理员验过密码后出现在侧栏 */
      if (id === 'iterate') {
        btn.hidden = !state.admin;
        return;
      }
      var item = (state.cfg.nav || []).filter(function (n) { return n.id === id; })[0];
      btn.hidden = !item || item.show === false;
    });

    /* 固定顺序：对话 → 可排序项 → 迭代 → 设置 → 连接状态 */
    var side = $('.side-foot');
    if (side) {
      var conn = side.querySelector('.conn');
      /* 反馈箱和迭代已经收进设置页，不再出现在侧栏 */
    var order = ['chat'].concat((state.cfg.nav || []).filter(function (n) { return n.id !== 'feedback' && n.id !== 'iterate'; }).map(function (n) { return n.id; })).concat(['settings']);
      order.forEach(function (id) {
        var btn = side.querySelector('.side-link[data-view="' + id + '"]');
        if (btn) side.insertBefore(btn, conn || null);
      });
    }
  }
  XN.renderSideLinks = renderSideLinks;

  /* 模型显示名：给用户看的永远是友好名，绝不露 `@cf/…` 这类云端原始 id。
   * 取值顺序：调用方给的 name → XN.models 云端清单里的 name → 去掉 `@cf/` 只留末段 → 原始 id。
   * 注意：只影响显示文案，state.cfg.tutor.model / option 的 value 仍是原始 id。 */
  function friendlyModel(id, name) {
    var raw = String(id || '').trim();
    var given = String(name || '').trim();
    if (given && given !== raw) return given;
    var known = '';
    try { known = String(M.label(raw) || '').trim(); } catch (e) { known = ''; }
    if (known && known !== raw && known.indexOf('@cf/') !== 0) return known;
    if (raw.indexOf('@cf/') === 0) {
      var parts = raw.split('/');
      var tail = String(parts[parts.length - 1] || '').trim();
      return tail || raw;
    }
    return raw;
  }
  XN.friendlyModel = friendlyModel;

  /* 模型条文案：永远显示一个友好的模型名，配置里为空也不留白。
     只负责「把 id 说成人话」，不再往页面写——输入框右下角那条已经删掉了。 */
  function modelLabel() {
    var model = String((state.cfg.tutor && state.cfg.tutor.model) || '').trim() || defaultConfig().tutor.model;
    return friendlyModel(model) || 'deepseek-chat';
  }
  XN.modelLabel = modelLabel;

  /* 标题用的是 cfg.labels；但它的默认值也是中文并已持久化，
   于是切语言时标题永远不变。这里把「等于任一语言默认值」的存储值当成没改过，改用 t()。 */
function labelFor(view) {
  var key = 'nav.' + view;
  var stored = (state.cfg.labels || {})[view];
  if (!stored) return t(key);
  if (root.XN && root.XN.i18n && root.XN.i18n.tFor) {
    var langs = ['zh-CN', 'zh-TW', 'en'];
    for (var i = 0; i < langs.length; i++) {
      if (root.XN.i18n.tFor(langs[i], key) === stored) return t(key);
    }
  }
  return stored;
}

function updateHeader() {
    var titleEl = $('#mainTitle');
    if (titleEl) {
      if (state.view === 'chat') {
        var s = currentSession();
        titleEl.textContent = s && s.messages.length ? sessionTitle(s) : labelFor('chat');
      } else {
        titleEl.textContent = labelFor(state.view) || t((VIEW_META[state.view] && VIEW_META[state.view].title) || 'nav.chat');
      }
    }
    $$('.side-link').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === state.view);
    });
    var chip = $('#verChip');
    if (chip) chip.textContent = 'v' + (root.XN_VERSION || '?');
  }

  function switchView(id) {
    if (VIEW_IDS.indexOf(id) < 0) id = 'chat';
    /* 迭代页不再需要先解锁管理密码：界面上早已没有密码栏，state.admin 恒为 false，
       旧门会把点「迭代」的人直接弹回设置页。未解锁时迭代接口自己只跑试运行/试跑分支，
       兜底在服务端，前端不再拦。 */
    state.view = id;
    $$('.pane').forEach(function (p) { p.hidden = p.dataset.view !== id; });
    updateHeader();
    S.sessionSet(S.KEYS.view, id);
    var view = XN.views && XN.views[id];
    if (view && view.onShow) {
      try { view.onShow(); } catch (e) { console.error('[xn] view', id, e); U.toast('这个页面出了点问题：' + e.message, 'error'); }
    }
    if (id === 'chat') setTimeout(function () { scrollBottom(true); }, 20);
    closeSide();
  }
  XN.switchView = switchView;

  function closeSide() {
    var app = $('#app');
    if (app) app.classList.remove('side-open');
    var scrim = $('#scrim');
    if (scrim) scrim.hidden = true;
  }
  function openSide() {
    var app = $('#app');
    if (app) app.classList.add('side-open');
    var scrim = $('#scrim');
    if (scrim) scrim.hidden = false;
  }

  /* ---------- 会话 ---------- */
  function sessionTitle(s) {
    var first = (s.messages || []).filter(function (m) { return m.role === 'user' && m.content; })[0];
    var text = first ? first.content.replace(/\s+/g, ' ').trim() : t('nav.chat');
    return text.length > 22 ? text.slice(0, 21) + '…' : text;
  }
  XN.sessionTitle = sessionTitle;

  function currentSession() {
    return state.sessions.filter(function (s) { return s.id === state.currentId; })[0] || null;
  }
  XN.currentSession = currentSession;

  var saving = false;
  function saveSessions() {
    if (saving) return;
    saving = true;
    var limits = state.cfg.limits || {};
    var maxSessions = limits.sessions || 30;
    var maxMsgs = limits.messagesPerSession || 60;

    var list = state.sessions
      .filter(function (s) { return (s.messages && s.messages.length) || s.id === state.currentId; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, maxSessions)
      .map(function (s) {
        var msgs = s.messages.filter(function (m) { return !m.pending; });
        var trimmed = msgs.slice(-maxMsgs).map(function (m) {
          return {
            id: m.id, role: m.role, content: m.content, reasoning: m.reasoning,
            ts: m.ts, error: m.error || '', incomplete: !!m.incomplete,
            tools: m.tools || null
          };
        });
        return { id: s.id, ts: s.ts, title: sessionTitle(s), messages: trimmed };
      });

    S.set(S.KEYS.sessions, list);
    S.set(S.KEYS.current, state.currentId);
    saving = false;
  }
  XN.saveSessions = saveSessions;

  function newSession(silent) {
    var s = { id: U.uid('s'), ts: Date.now(), messages: [] };
    state.sessions.unshift(s);
    state.currentId = s.id;
    saveSessions();
    renderSessions();
    renderThread();
    switchView('chat');
    setTimeout(function () {
      var input = $('#input');
      if (input) input.focus();
    }, 40);
    if (!silent) U.toast(t('chat.newSession'));
    return s;
  }
  XN.newSession = newSession;

  function openSession(id) {
    if (state.sending && state.abort) state.abort.abort();
    state.currentId = id;
    saveSessions();
    renderSessions();
    renderThread();
    switchView('chat');
    maybeConsolidate();
  }

  function deleteSession(id, ev) {
    if (ev) ev.stopPropagation();
    var s = state.sessions.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    if (s.messages.length && !confirm(t('chat.deleteAsk'))) return;
    state.sessions = state.sessions.filter(function (x) { return x.id !== id; });
    if (state.currentId === id) {
      var next = state.sessions.filter(function (x) { return x.messages.length; })[0];
      state.currentId = next ? next.id : '';
      if (!state.currentId) {
        newSession(true);
        U.toast(t('chat.deleted'));
        return;
      }
    }
    saveSessions();
    renderSessions();
    renderThread();
    U.toast(t('chat.deleted'));
  }

  function renderSessions() {
    var box = $('#sessionList');
    if (!box) return;
    var list = state.sessions
      .filter(function (s) { return (s.messages && s.messages.length) || s.id === state.currentId; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var empty = $('#sessionEmpty'), label = $('#sessionLabel');
    if (empty) empty.hidden = list.length > 0;
    if (label) label.hidden = list.length === 0;

    box.innerHTML = list.map(function (s) {
      return '<div class="session' + (s.id === state.currentId ? ' on' : '') + '" data-id="' + U.esc(s.id) + '">' +
        '<button class="ses-main" type="button">' +
        '<span class="ses-title">' + U.esc(sessionTitle(s)) + '</span>' +
        '<span class="ses-time">' + U.fmtTime(s.ts) + '</span>' +
        '</button>' +
        '<button class="ses-del" type="button" title="删除" aria-label="删除对话">×</button>' +
        '</div>';
    }).join('');
  }
  XN.renderSessions = renderSessions;

  /* ---------- 对话渲染 ---------- */
  function scrollBottom(force) {
    var box = $('#messages');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 180;
    if (force || near) box.scrollTop = box.scrollHeight;
  }
  XN.scrollBottom = scrollBottom;

  /* 主页空态：只留一个最简容器，不再渲染问候标题和建议条。
     id 必须保留：视图切换、新建会话等逻辑都靠 #chatEmpty 判断是否空态。 */
  function emptyState() {
    return '<div class="empty" id="chatEmpty"></div>';
  }

  function messageNode(m) {
    var div = document.createElement('div');
    div.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot');
    div.dataset.id = m.id || '';

    if (m.role === 'user') {
      div.innerHTML = '<div class="body"><div class="content"></div></div>';
      div.querySelector('.content').textContent = m.content;
      return div;
    }

    div.innerHTML = '<div class="body">' +
      '<div class="who-line"><span>' + U.esc(state.cfg.brand || t('app.name')) + '</span><span>' + U.fmtTime(m.ts) + '</span></div>' +
      '<div class="reasoning" hidden></div>' +
      '<div class="content"></div>' +
      (m.error ? '<p class="err"></p>' : '') +
      '<div class="msg-tools">' +
      '<button type="button" data-copy>' + U.esc(t('chat.copy')) + '</button>' +
      '<button type="button" data-retry>' + U.esc(t('chat.retry')) + '</button>' +
      '</div></div>';

    if (m.reasoning) {
      var r = div.querySelector('.reasoning');
      r.hidden = false;
      r.textContent = m.reasoning;
    }
    if (m.error) div.querySelector('.err').textContent = m.error;

    var content = div.querySelector('.content');
    if (m.pending) content.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    else if (m.content) content.innerHTML = MD.render(m.content);

    div.querySelector('[data-copy]').addEventListener('click', function () {
      U.copyText(m.content || '').then(function () { U.toast(t('chat.copied')); }, function () { U.toast(t('chat.copyFailed')); });
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
      return;
    }
    var thread = document.createElement('div');
    thread.className = 'thread';
    s.messages.forEach(function (m) { thread.appendChild(messageNode(m)); });
    box.innerHTML = '';
    box.appendChild(thread);
    scrollBottom(true);
  }
  XN.renderThread = renderThread;

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
    var connected = !!state.key || API.isProxy();
    if (dot) dot.classList.toggle('off', mode === 'off' || !connected);
    if (!text) return;
    if (mode === 'busy') text.textContent = t('nav.busy');
    else if (!connected) text.textContent = t('nav.noKey');
    else if (mode === 'off') text.textContent = t('nav.connError');
    else text.textContent = (state.admin ? t('settings.admin') + ' · ' : '') + (state.cfg.tutor.model ? friendlyModel(state.cfg.tutor.model) : t('nav.connected'));
  }
  XN.updateConn = updateConn;

  /* ---------- 人设 / 记忆 ---------- */
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
    if (!root.XN_PERSONA || !root.XN_PERSONA.build) return '你叫小暖。';

    var q = lastUserText(session);
    var mem = root.XN_MEM;
    var act = mem && mem.getActiveMemories ? mem.getActiveMemories() : null;
    var memories = act && act.explicit ? act.explicit : (state.memory || []);
    var trails = mem && mem.activate ? mem.activate(q, 6) : [];

    var prompt = root.XN_PERSONA.build({
      query: q,
      emo: state.lastEmo || root.XN_PERSONA.detectEmotion(q),
      memories: memories,
      notes: state.notes || [],
      goals: ((state.goals && state.goals.items) || []).filter(function (g) { return !g.done; }).map(function (g) { return g.text; }),
      name: mem && mem.name ? mem.name() : ''
    });

    if (act && act.implicit && act.implicit.length) {
    prompt += '\n【我印象里（不一定对，别当成他说过）】' + act.implicit.slice(0, 8).join('；');
  }
  if (memories.length) {
    prompt += '\n【记忆的使用方式】带（今天/昨天/N天前）的是旧事；与用户现在的说法冲突时，以现在为准，不要拿旧事反驳他。';
  }
  if (trails.length) {
      prompt += '\n【顺着这句话联想起来的事】' + trails.map(function (x) { return x.content; }).join('；');
    }
    if (mem && mem.relation) {
      var rel = mem.relation();
      prompt += '\n【你们的关系】' + rel.label + '（有效互动 ' + rel.interactions + ' 次）';
    }
    if (mem && mem.promises) {
      var live = mem.promises().filter(function (x) { return !x.kept; });
      if (live.length) prompt += '\n【你答应过、还没做到的事】' + live.slice(0, 5).map(function (x) { return x.text; }).join('；');
    }
    if (root.XN_EMO && root.XN_EMO.hint) {
      prompt = prompt.replace(/情绪应对提示：[^\n]*/, '情绪应对提示：' + root.XN_EMO.hint(state.lastEmo));
    }
    return prompt;
  }

  function buildMessages(extraSystem) {
    var sys = systemPromptFor(currentSession());
    if (extraSystem) sys += '\n\n' + extraSystem;
    var msgs = [{ role: 'system', content: sys }];
    var turns = U.clamp(state.cfg.tutor.historyTurns, 2, 40);
    var s = currentSession();
    var hist = (s ? s.messages : []).filter(function (m) {
      return (m.role === 'user' && m.content) || (m.role === 'assistant' && m.content && !m.pending);
    }).slice(-turns * 2);
    hist.forEach(function (m) {
      msgs.push({ role: m.role, content: m.content });
    });
    return API.fitMessages(msgs, 24000);
  }

  /* ---------- 发送 ---------- */
  function needsTools(text) {
    if (state.web) return true;
    return /今天|现在|几点|几号|星期|日期|今年|新闻|天气|最新/.test(String(text || ''));
  }

  async function detectEmotion(text) {
    if (!root.XN_EMO) return null;
    var chatFn = null;
    var mode = state.cfg.tutor.emoLLM;
    if (mode !== false) {
      var quick = root.XN_PERSONA ? root.XN_PERSONA.detectEmotion(text) : { emo: 'neutral', intensity: 0.3 };
      var needLlm = quick.emo === 'neutral' || quick.intensity < 0.45;
      var throttleOk = Date.now() - state.lastEmoAt > 45000 && state.emoCalls < 6;
      if (needLlm && throttleOk && (state.key || API.isProxy())) {
        state.lastEmoAt = Date.now();
        state.emoCalls++;
        chatFn = function (messages) {
          return API.chatText(messages, { maxTokens: 90, temperature: 0 }).catch(function () { return ''; });
        };
      }
    }
    try { return await root.XN_EMO.analyze(text, chatFn); }
    catch (e) { return null; }
  }

  async function runAssistant() {
    var s = currentSession() || newSession(true);
    var bot = { id: U.uid('m'), role: 'assistant', content: '', reasoning: '', ts: Date.now(), pending: true, tools: [] };
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

    var thinkingCleared = false;
    function clearThinking() {
      if (thinkingCleared) return;
      thinkingCleared = true;
      contentEl.classList.remove('thinking');
    }
    contentEl.textContent = t('chat.thinking');
    contentEl.classList.add('thinking');

    var reasoningEl = null;
    function ensureReasoning() {
      if (reasoningEl) return reasoningEl;
      reasoningEl = node.querySelector('.reasoning');
      reasoningEl.hidden = false;
      return reasoningEl;
    }

    try {
      var msgs = buildMessages();
      var res;
      var userText = lastUserText(s);

      if (needsTools(userText) && root.XN_TOOLS) {
        contentEl.textContent = state.web ? '正在查资料…' : '正在看时间…';
        var loopRes = await root.XN_TOOLS.loopWithFallback({
          messages: msgs,
          specs: root.XN_TOOLS.specsFor(state.web),
          signal: ctrl.signal,
          chat: function (m, tools) { return API.chatRaw(m, { tools: tools, signal: ctrl.signal }); },
          textChat: function (m) { return API.chatRaw(m, { signal: ctrl.signal }).then(function (r) { return r.content; }); },
          onTool: function (name, args, result) {
            bot.tools.push({ name: name, ok: !!(result && result.ok) });
            U.toast('用了工具：' + name + (result && result.ok ? '' : '（没跑通）'));
          }
        });
        res = { text: (loopRes && loopRes.content) || '', reasoning: '' };
        bot.content = res.text;
        contentEl.textContent = bot.content;
        clearThinking();
      } else if (state.cfg.tutor.stream === false) {
        var plain = await API.chatRaw(msgs, { signal: ctrl.signal });
        res = { text: plain.content, reasoning: plain.reasoning };
        bot.content = res.text;
        bot.reasoning = res.reasoning || '';
        if (bot.reasoning) ensureReasoning().textContent = bot.reasoning;
        contentEl.textContent = bot.content;
        clearThinking();
      } else {
        res = await API.streamChat(msgs, {
          stream: true,
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
            ensureReasoning().textContent = bot.reasoning;
            scrollBottom();
          }
        });
        if (!state.cfg.tutor.stream && res.text && !bot.content) {
          bot.content = res.text;
          contentEl.textContent = bot.content;
        }
        if (res.aborted) bot.incomplete = true;
      }

      if (!bot.content.trim()) {
        bot.error = t('chat.emptyReply');
      }
      clearThinking();
      node.classList.remove('streaming');
      contentEl.innerHTML = bot.content ? MD.render(bot.content) : '';
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
        if (!bot.content) bot.content = t('chat.stopped');
        bot.incomplete = !!bot.content;
        contentEl.innerHTML = MD.render(bot.content);
      } else {
        bot.error = (e && e.message) || t('common.failed');
        contentEl.innerHTML = bot.content ? MD.render(bot.content) : '';
        var pe = document.createElement('p');
        pe.className = 'err';
        pe.textContent = bot.error;
        bodyEl.appendChild(pe);
        if (e && (e.status === 401 || e.status === 403)) updateConn('off');
      }
    } finally {
      bot.pending = false;
      state.abort = null;
      setSending(false);
      saveSessions();
      renderSessions();
      updateHeader();
      if (root.XN_MEM && root.XN_MEM.pushBuffer && bot.content) {
        root.XN_MEM.pushBuffer('小暖：' + bot.content.slice(0, 200));
      }
    }
  }

  async function sendMessage(raw) {
    if (state.sending) return;
    var text = String(raw == null ? ($('#input') ? $('#input').value : '') : raw).trim();
    if (!text) return;

    if (!state.key && !API.isProxy()) {
      showKeyBar(text);
      return;
    }

    var mRemember = text.match(/^记住[，,：:\s]*(.+)$/);
    var mForget = text.match(/^忘(?:了|掉)[，,：:\s]*(.+)$/);
    if (mRemember) {
      var item = mRemember[1].trim();
      if (item && root.XN_MEM) root.XN_MEM.addExplicit(item);
      if (item) U.toast('记住了：' + item.slice(0, 30));
    } else if (mForget) {
      var topic = mForget[1].trim();
      var removed = root.XN_MEM ? root.XN_MEM.forget(topic) : 0;
      U.toast(removed ? '忘了 ' + removed + ' 条' : '没找到相关的记忆');
    }

    state.lastEmo = await detectEmotion(text);

    if (root.XN_MEM) {
      try {
        if (root.XN_MEM.meaningful && root.XN_MEM.meaningful(text)) {
          root.XN_MEM.addImplicit(text.slice(0, 160), 'dialog');
          root.XN_MEM.pushBuffer('用户：' + text.slice(0, 200));
        }
      } catch (e) {}
    }

    var s = currentSession() || newSession(true);
    var userMsg = { id: U.uid('m'), role: 'user', content: text, ts: Date.now() };
    s.messages.push(userMsg);
    s.ts = Date.now();
    if (!s.title) s.title = sessionTitle(s);
    /* 关系只按"用户真的发了一条新消息"计数：重试、重新生成都不会重复加 */
    if (root.XN_MEM && root.XN_MEM.touch) root.XN_MEM.touch(userMsg.id);

    var input = $('#input');
    if (input) { input.value = ''; autoGrow(); }
    renderThread();
    renderSessions();
    updateHeader();
    await runAssistant();
  }
  XN.sendMessage = sendMessage;

  /* ---------- Key 行内提示 ---------- */
  function showKeyBar(pending) {
    if (pending) state.pendingText = pending;
    var bar = $('#keyBar');
    if (!bar) return;
    bar.hidden = false;
    var msg = $('#keyMsg');
    if (msg) { msg.textContent = ''; msg.className = 'keybar-msg'; }
    $('#keyBase').value = state.cfg.tutor.baseUrl || '';
    $('#keyModel').value = state.cfg.tutor.model || '';
    setTimeout(function () { $('#keyInput').focus(); }, 30);
  }
  XN.showKeyBar = showKeyBar;

  function hideKeyBar() {
    var bar = $('#keyBar');
    if (bar) bar.hidden = true;
    state.pendingText = '';
  }

  function saveStoredKey(key, remember) {
    try {
      if (!key) {
        localStorage.removeItem(S.KEYS.key);
        sessionStorage.removeItem(S.KEYS.key);
        return;
      }
      if (remember) {
        localStorage.setItem(S.KEYS.key, key);
        sessionStorage.removeItem(S.KEYS.key);
      } else {
        sessionStorage.setItem(S.KEYS.key, key);
        localStorage.removeItem(S.KEYS.key);
      }
    } catch (e) {}
  }
  XN.saveStoredKey = saveStoredKey;

  function storedKey() {
    try { return localStorage.getItem(S.KEYS.key) || sessionStorage.getItem(S.KEYS.key) || ''; }
    catch (e) { return ''; }
  }

  async function saveKeyFromBar() {
    var key = $('#keyInput').value.trim();
    var base = $('#keyBase').value.trim();
    var model = $('#keyModel').value.trim();
    var remember = $('#keyRemember') ? $('#keyRemember').checked : false;
    var msg = $('#keyMsg');

    if (base) state.cfg.tutor.baseUrl = base;
    if (model) state.cfg.tutor.model = model;
    if (!key && !API.isProxy()) {
      msg.textContent = '先填一个 Key。';
      $('#keyInput').focus();
      return;
    }

    var btn = $('#keySave');
    btn.disabled = true;
    msg.className = 'keybar-msg';
    msg.textContent = '正在试一下…';
    try {
      await API.chatText([{ role: 'user', content: '只回一个字：好' }], { key: key, maxTokens: 8, temperature: 0, timeoutMs: 30000 });
    } catch (e) {
      msg.textContent = e.message || '没通。';
      btn.disabled = false;
      return;
    }
    btn.disabled = false;

    state.key = key;
    saveStoredKey(key, remember);
    state.cfg.tutor.provider = { id: M.providerOfBase(base || state.cfg.tutor.baseUrl), base: base || state.cfg.tutor.baseUrl };
    if (state.cfg.tutor.provider.id !== 'cloud') state.cfg.tutor.ownProvider = { id: state.cfg.tutor.provider.id, base: state.cfg.tutor.baseUrl };
    saveConfig();
    updateConn('ok');
    msg.className = 'keybar-msg ok';
    msg.textContent = '通了。';
    var pending = state.pendingText;
    hideKeyBar();
    if (pending) sendMessage(pending);
    else U.toast('接上了');
  }

  /* ---------- 管理模式 ---------- */
  function adminToken() {
    return S.sessionGet(S.KEYS.admin, '');
  }
  XN.adminToken = adminToken;

  async function unlockAdmin(password) {
    var pwd = String(password || '');
    if (!pwd) return { ok: false, error: '先填密码。' };
    if (!API.isProxy()) return { ok: false, error: '管理密码必须由服务器校验，本地静态页面不支持解锁。' };
    try {
      var j = await API.adminVerify(pwd);
      state.admin = true;
      S.sessionSet(S.KEYS.admin, j.token);
      renderSideLinks();
      updateConn('ok');
      if (XN.views && XN.views.settings && XN.views.settings.render) {
        try { XN.views.settings.render(); } catch (e) {}
      }
      return { ok: true, expires: j.expires };
    } catch (e) {
      return { ok: false, error: e.message || t('error.adminNet') };
    }
  }
  XN.unlockAdmin = unlockAdmin;

  function lockAdmin() {
    state.admin = false;
    S.sessionRemove(S.KEYS.admin);
    renderSideLinks();
    updateConn('ok');
    if (state.view === 'iterate') switchView('settings');
  }
  XN.lockAdmin = lockAdmin;

  /* ---------- 模型选择 ---------- */
  function providerId() {
    var p = state.cfg.tutor.provider;
    if (p && p.id) return p.id;
    return API.isProxy() ? 'cloud' : 'custom';
  }

  function renderModelPick() {
    var trigger = $('#modelPickTrigger');
    var menu = $('#modelMenu');
    if (!trigger || !menu) return;

    var cur = state.cfg.tutor.model || '';
    var groups = M.groups(providerId(), cur);
    var sel = $('#modelPick');
    var options = [];
    groups.forEach(function (g) {
      g.items.forEach(function (m) {
        if (!m.disabled && m.id) options.push('<option value="' + U.esc(m.id) + '">' + U.esc(friendlyModel(m.id, m.name)) + '</option>');
      });
    });
    sel.innerHTML = options.join('');
    sel.value = cur;

    var idx = 0;
    menu.innerHTML = groups.map(function (g) {
      return '<div class="mp-group"><div class="mp-group-label">' + U.esc(g.label) + '</div>' +
        g.items.map(function (m) {
          var on = m.id === cur;
          var id = 'mp-opt-' + (idx++);
          return '<div class="mp-opt' + (m.disabled ? ' disabled' : '') + '" id="' + id + '" role="option" data-id="' + U.esc(m.id) + '" aria-selected="' + on + '"' +
            (m.disabled ? ' aria-disabled="true"' : ' tabindex="-1"') + '>' +
            '<svg class="mp-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4 5 9l4.5-5.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<span class="mp-name">' + U.esc(friendlyModel(m.id, m.name)) + '</span>' +
            '<span class="mp-tag">' + U.esc(m.note || '') + '</span></div>';
        }).join('') + '</div>';
    }).join('');

    $('#modelPickText').textContent = cur ? friendlyModel(cur) : t('chat.selectModel');
    trigger.title = cur ? friendlyModel(cur) : '';
    trigger.disabled = false;
  }
  XN.renderModelPick = renderModelPick;

  function selectModel(id) {
    if (!id) return;
    if (M.isCloud(id) && !M.runtime().cloudEnabled) {
      U.toast('这个部署没启用云端自带模型，请在设置里填自己的 API。');
      return;
    }
    var old = state.cfg.tutor.model;
    state.cfg.tutor.model = id;

    if (M.isCloud(id)) {
      state.cfg.tutor.ownProvider = state.cfg.tutor.provider && state.cfg.tutor.provider.id !== 'cloud'
        ? { id: state.cfg.tutor.provider.id, base: state.cfg.tutor.baseUrl }
        : state.cfg.tutor.ownProvider;
      state.cfg.tutor.provider = { id: 'cloud', base: '' };
      state.cfg.tutor.baseUrl = '/api';
    } else if (providerId() === 'cloud') {
      var own = state.cfg.tutor.ownProvider || { id: 'custom', base: '' };
      state.cfg.tutor.provider = { id: own.id, base: own.base };
      state.cfg.tutor.baseUrl = own.base || state.cfg.tutor.baseUrl;
      if (!own.base) U.toast(t('chat.noProvider'));
    }
    if (old !== id) saveConfig();
    updateHeader();
    renderModelPick();
    U.toast('换成 ' + friendlyModel(id));
  }
  XN.selectModel = selectModel;

  /* ---------- 兼容包装 ---------- */
  function apiChat(messages, opts) {
    opts = opts || {};
    if (opts.stream) {
      return API.streamChat(messages, opts).then(function (r) {
        return { text: r.text, reasoning: r.reasoning };
      });
    }
    return API.chatRaw(messages, opts).then(function (r) {
      return { text: r.content, reasoning: r.reasoning };
    });
  }
  function apiChatRaw(messages, opts) {
    return API.chatRaw(messages, opts).then(function (r) {
      return { content: r.content, toolCalls: r.toolCalls };
    });
  }
  XN.apiChat = apiChat;
  XN.apiChatRaw = apiChatRaw;

  /* ---------- 记忆巩固 ---------- */
  var consolidating = false;
  function maybeConsolidate() {
    if (consolidating || !root.XN_MEM || !root.XN_MEM.maybeConsolidate) return;
    if (!state.key && !API.isProxy()) return;
    consolidating = true;
    var task = root.XN_MEM.maybeConsolidate(function (text) {
      return API.chatText([
        { role: 'system', content: '把这段对话压成一句不超过 40 字的中文摘要，只保留对以后有用的偏好、目标或事实。只输出摘要。' },
        { role: 'user', content: String(text).slice(0, 3000) }
      ], { maxTokens: 100, temperature: 0.2 }).then(function (s) { return String(s || '').trim(); });
    });
    if (task && typeof task.then === 'function') {
      task.catch(function () {}).then(function () { consolidating = false; });
    } else {
      consolidating = false;
    }
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    $('#btnNew').addEventListener('click', function () { newSession(); });

    /* 侧栏用事件委托：以后动态加视图也不会漏绑 */
    document.addEventListener('click', function (e) {
      var link = e.target.closest('.side-link[data-view]');
      if (link) { switchView(link.dataset.view); return; }

      var ses = e.target.closest('.session');
      if (ses) {
        if (e.target.closest('.ses-del')) deleteSession(ses.dataset.id, e);
        else openSession(ses.dataset.id);
      }
    });

    $('#sideOpen').addEventListener('click', openSide);
    $('#sideClose').addEventListener('click', closeSide);
    $('#scrim').addEventListener('click', closeSide);

    $('#btnTheme').addEventListener('click', function () {
      var next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      S.set(S.KEYS.theme, next);
      applyConfig();
    });

    var wrap = $('#modelPickWrap');
    var trigger = $('#modelPickTrigger');
    var menu = $('#modelMenu');

    function closePick() {
      if (!wrap) return;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function openPick() {
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      var opts = $$('.mp-opt:not(.disabled)', menu);
      if (opts.length) opts[0].focus();
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.classList.contains('is-open') ? closePick() : openPick();
    });
    menu.addEventListener('click', function (e) {
      var opt = e.target.closest('.mp-opt');
      if (!opt || opt.classList.contains('disabled')) return;
      selectModel(opt.dataset.id);
      closePick();
      trigger.focus();
    });
    menu.addEventListener('keydown', function (e) {
      var opts = $$('.mp-opt:not(.disabled)', menu);
      var idx = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(opts.length - 1, idx + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(0, idx - 1)].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') {
        if (idx >= 0) { e.preventDefault(); selectModel(opts[idx].dataset.id); closePick(); trigger.focus(); }
      } else if (e.key === 'Escape') { closePick(); trigger.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (wrap && !wrap.contains(e.target)) closePick();
    });

    $('#modelPick').addEventListener('change', function () {
      if (this.value) selectModel(this.value);
    });

    var webBtn = $('#btnWeb');
    if (webBtn) {
      var paint = function () {
        webBtn.setAttribute('aria-pressed', state.web ? 'true' : 'false');
        webBtn.classList.toggle('on', state.web);
      };
      paint();
      webBtn.addEventListener('click', function () {
        state.web = !state.web;
        paint();
        U.toast(state.web ? t('chat.webOn') : t('chat.webOff'));
      });
    }

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
        closePick();
      }
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        newSession();
      }
    });

    /* 页面隐藏前落盘，并把缓冲送去巩固 */
    function flush() {
      saveSessions();
      maybeConsolidate();
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    root.addEventListener('pagehide', flush);

    /* 存储出问题要让用户知道，而不是静默丢数据 */
    XN.on('storage:issue', function (issue) {
      if (issue.kind === 'quota' || issue.kind === 'quota-fatal') {
        U.toast('本机存储满了：先导出备份，再删掉旧对话。', 'error', 5000);
      }
    });
  }

  /* ---------- 启动 ---------- */
  async function detectProxy() {
    if (!root.location || !/^https?:$/.test(location.protocol)) return;
    var cfg = await API.fetchConfig();
    if (!cfg) return;

    state.localMode = !!cfg.local;
    if (cfg.repo) state.cloudRepo = cfg.repo;
    if (cfg.gateway && cfg.gateway.base) {
      M.setRuntime({ gatewayBase: cfg.gateway.base, gatewayModel: cfg.gateway.model || '' });
    }
    M.setRuntime({ cloudEnabled: cfg.backend === 'workers-ai' });
    if (cfg.models && cfg.models.length) M.setCloudModels(cfg.models);

    if (cfg.proxy) {
      state.autoProxy = true;
      if (!storedKey() && state.cfg.tutor.baseUrl === defaultConfig().tutor.baseUrl) {
        state.cfg.tutor.baseUrl = '/api';
        if (cfg.backend === 'workers-ai') {
          state.cfg.tutor.provider = { id: 'cloud', base: '' };
          if (cfg.model) state.cfg.tutor.model = cfg.model;
        } else {
          /* 本地/自建后端：走 /api 代理，但模型仍是你自己的服务商 */
          state.cfg.tutor.provider = { id: 'custom', base: '/api' };
          state.cfg.tutor.ownProvider = { id: 'custom', base: '/api' };
          if (cfg.model) state.cfg.tutor.model = cfg.model;
        }
        saveConfig();
      }
    }
  }

  function loadState() {
    S.migrate();

    var saved = S.get(S.KEYS.cfg, null);
    state.cfg = saved ? mergeConfig(defaultConfig(), saved) : defaultConfig();
    state.cfg.nav = (state.cfg.nav || []).filter(function (n) { return n.id !== 'chat'; });
    if (!state.cfg.nav.length) state.cfg.nav = defaultConfig().nav;
    state.cfg.labels = mergeConfig(defaultConfig().labels, state.cfg.labels || {});
    if (Array.isArray(state.cfg.nav)) {
      state.cfg.nav = state.cfg.nav.filter(function (n) { return n && n.id !== 'feedback' && n.id !== 'iterate'; });
    }

    state.key = storedKey();
    state.gatewayKey = S.sessionGet('xn.v2.gatewayKey', '');
    state.notes = S.get(S.KEYS.notes, []);
    if (!Array.isArray(state.notes)) state.notes = [];
    state.feedback = S.get(S.KEYS.feedback, []);
    if (!Array.isArray(state.feedback)) state.feedback = [];

    state.goals = S.get(S.KEYS.goals, { date: U.todayStr(), items: [] });
    if (!state.goals || !Array.isArray(state.goals.items)) state.goals = { date: U.todayStr(), items: [] };
    if (state.goals.date !== U.todayStr()) {
      state.goals.date = U.todayStr();
      state.goals.items.forEach(function (g) { g.done = false; });
      S.set(S.KEYS.goals, state.goals);
    }

    state.timer = S.get(S.KEYS.timer, { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: U.todayStr() });
    if (!state.timer || typeof state.timer !== 'object') state.timer = { min: 25, left: 1500, running: false, endsAt: 0, done: 0, date: U.todayStr() };
    if (state.timer.date !== U.todayStr()) {
      state.timer.date = U.todayStr();
      state.timer.done = 0;
      state.timer.running = false;
      state.timer.endsAt = 0;
      S.set(S.KEYS.timer, state.timer);
    }

    var sessions = S.get(S.KEYS.sessions, null);
    if (!sessions) {
      var legacy = S.get('xn.chat.v1', []);
      sessions = Array.isArray(legacy) && legacy.length
        ? [{ id: U.uid('s'), ts: Date.now(), title: '', messages: legacy }]
        : [];
    }
    state.sessions = Array.isArray(sessions) ? sessions : [];
    state.currentId = S.get(S.KEYS.current, '') || '';
    state.admin = !!adminToken();

    /* 配额剪枝：先砍旧会话和旧反馈，配置与 Key 永远不动 */
    S.onPrune(function () {
      state.sessions = state.sessions.slice(0, 6);
      state.feedback = state.feedback.slice(0, 50);
      saveSessions();
      S.set(S.KEYS.feedback, state.feedback);
    });
  }

  async function boot() {
    loadState();
    await detectProxy();
    XN.i18n.apply();
    applyConfig();
    bind();
    renderModelPick();

    if (XN.views) {
      Object.keys(XN.views).forEach(function (k) {
        var v = XN.views[k];
        if (v && v.init) {
          try { v.init(); } catch (e) { console.error('[xn] init', k, e); }
        }
      });
    }

    if (!state.sessions.length) {
      state.sessions.push({ id: U.uid('s'), ts: Date.now(), messages: [] });
      state.currentId = state.sessions[0].id;
    } else if (!currentSession()) {
      state.currentId = state.sessions[0].id;
    }

    renderSessions();
    renderThread();
    renderSideLinks();
    updateConn(state.key || API.isProxy() ? 'ok' : 'idle');

    var want = S.sessionGet(S.KEYS.view, 'chat');
    switchView(VIEW_IDS.indexOf(want) >= 0 ? want : 'chat');
    XN.ready = true;
    if (XN.emit) XN.emit('ready');
  }

  XN.boot = boot;
  XN.defaultConfig = defaultConfig;
  XN.mergeConfig = mergeConfig;
  XN.viewMeta = VIEW_META;
  XN.resolvedTheme = resolvedTheme;
  XN.maybeConsolidate = maybeConsolidate;
  XN.systemPromptFor = systemPromptFor;

  /* 旧代码兼容 */
  XN.md = MD.render;
  XN.esc = U.esc;
  XN.$ = $;
  XN.$$ = $$;
  XN.toast = U.toast;
  XN.uid = U.uid;
  XN.todayStr = U.todayStr;
  XN.fmtDate = U.fmtDate;
  XN.fmtTime = U.fmtTime;
  XN.bytes = U.bytes;
  XN.download = U.download;
  XN.readJSON = S.get;
  XN.writeJSON = S.set;

  /* defer 脚本按文档顺序执行，并且都在 DOMContentLoaded 之前跑完；
     这里统一挂 DOMContentLoaded，保证排在后面的视图模块都已注册。
     CSS 只会推迟脚本开始执行的时刻，不会打乱脚本之间的先后关系；
     本文件若被动态注入（readyState 已是 interactive），也等 DOMContentLoaded 再 boot。 */
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})(window);
