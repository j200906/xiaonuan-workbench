/* 小暖 · 设置（含外观、导航、人设、模型、管理模式） */
(function (root) {
  'use strict';

  var XN = root.XN;
  var $ = XN.$, $$ = XN.$$, t = XN.t;
  var state = XN.state, S = XN.store, API = XN.api, M = XN.models;

  var ARCH_KEYS = ['study', 'feedback', 'changelog', 'settings'];

  function providerOptions() {
    var groups = M.providerGroups();
    var html = '';
    groups.forEach(function (g) {
      html += '<optgroup label="' + XN.esc(g.label) + '">';
      g.ids.forEach(function (id) {
        var p = M.PROVIDERS[id];
        if (!p) return;
        var disabled = (id === 'gateway' && !M.runtime().gatewayReady) ||
          (id === 'cloud' && !M.runtime().cloudEnabled);
        html += '<option value="' + id + '"' + (disabled ? ' disabled' : '') + '>' +
          XN.esc(p.label) + (disabled ? (id === 'cloud' ? '（未启用）' : '（服务器未配置）') : '') + '</option>';
      });
      html += '</optgroup>';
    });
    return html;
  }

  var settings = {
    init() {
      var sel = $('#setProvider');
      if (sel) sel.innerHTML = providerOptions();

      $('#setForm').addEventListener('submit', (e) => { e.preventDefault(); this.commit(true); });
      $('#setTest').addEventListener('click', () => this.test());
      $('#setProvider').addEventListener('change', () => {
        var p = $('#setProvider').value;
        var preset = M.provider(p);
        if (preset.base) $('#setBase').value = preset.base;
        if (preset.model) $('#setModel').value = preset.model;
        this.syncProvider();
      });

      /* 旧「云端自迭代」卡片已随 index.html 一起撤掉（改由「迭代」页负责）。
         这里不再绑定 #ciDry / #ciRun，避免空节点把 init 打断。 */
      if ($('#ciDry')) {
        $('#ciDry').addEventListener('click', () => {
          if (XN.IT && XN.IT.cloudRun) XN.IT.cloudRun(true);
        });
      }
      if ($('#ciRun')) {
        $('#ciRun').addEventListener('click', () => {
          if (XN.IT && XN.IT.cloudRun) XN.IT.cloudRun(false);
        });
      }

      /* 管理密码那栏已经从界面撤掉：自迭代不再需要先解锁。
         这里保留判空，免得旧页面/缓存里还带着表单时脚本报错。 */
      if ($('#adminForm')) {
        $('#adminForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          var msg = $('#adminMsg');
          msg.textContent = '正在确认…';
          var r = await XN.unlockAdmin($('#adminPwd').value);
          if (r.ok) {
            $('#adminPwd').value = '';
            msg.textContent = '已解锁：现在可以自迭代、改架构。';
            this.render();
            XN.switchView('settings');
          } else {
            msg.textContent = r.error || '没成功。';
          }
        });
      }
      if ($('#adminLock')) {
        $('#adminLock').addEventListener('click', () => {
          XN.lockAdmin();
          this.render();
          if ($('#adminMsg')) $('#adminMsg').textContent = '已锁定。';
        });
      }

      $('#dataExport').addEventListener('click', () => {
        var dump = {
          exportedAt: new Date().toISOString(),
          version: root.XN_VERSION,
          config: this.publicConfig(),
          sessions: state.sessions,
          notes: state.notes,
          goals: state.goals,
          feedback: state.feedback
        };
        XN.download('xiaonuan-data-' + XN.util.todayStr() + '.json', JSON.stringify(dump, null, 2));
      });
      $('#dataClear').addEventListener('click', () => {
        if (!confirm('清空对话、笔记、目标、反馈和计时？配置和 Key 会保留。')) return;
        state.sessions = [];
        state.notes = [];
        state.feedback = [];
        state.goals = { date: XN.util.todayStr(), items: [] };
        state.timer = { min: 25, left: 1500, running: false, endsAt: 0, done: 0, date: XN.util.todayStr() };
        S.set(S.KEYS.notes, state.notes);
        S.set(S.KEYS.feedback, state.feedback);
        S.set(S.KEYS.goals, state.goals);
        S.set(S.KEYS.timer, state.timer);
        S.set(S.KEYS.sessions, []);
        XN.newSession(true);
        this.render();
        if (XN.views.study && XN.views.study.onShow) XN.views.study.onShow();
        if (XN.views.feedback && XN.views.feedback.onShow) XN.views.feedback.onShow();
        XN.toast('清空了');
      });

      this.bindAppearance();
      this.bindNav();
      this.bindPersona();
      this.bindConfig();
      this.bindAiPatch();
      this.bindLanguage();
    },

    onShow() { this.render(); },

    publicConfig() {
      var cfg = JSON.parse(JSON.stringify(state.cfg));
      if (cfg.tutor) {
        delete cfg.tutor.ownProvider;
      }
      return cfg;
    },

    /* 迭代是管理员功能：先验密码，验过才切过去；取消就什么都不做 */
  openIterateGuarded() {
    if (XN.state && XN.state.admin) { XN.switchView('iterate'); return; }
    var old = document.querySelector('#iteratePwdDialog');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'iteratePwdDialog';
    box.className = 'modal-mask';
    box.innerHTML = '<div class="modal-card card" role="dialog" aria-modal="true" aria-labelledby="itPwdTitle">' +
      '<header class="card-head"><h2 id="itPwdTitle">打开迭代页</h2><span class="card-meta">需要管理员密码</span></header>' +
      '<label class="field"><span class="label">管理密码</span>' +
      '<input id="iteratePwd" type="password" autocomplete="off" placeholder="由服务器校验"></label>' +
      '<p class="hint" id="iteratePwdMsg">密码只发给服务器校验，成功后本次会话内可进入迭代页。</p>' +
      '<div class="arch-btns"><button class="btn primary sm" id="iteratePwdOk" type="button">打开</button>' +
      '<button class="btn ghost sm" id="iteratePwdCancel" type="button">取消</button></div>' +
      '</div>';
    document.body.appendChild(box);
    var pwd = box.querySelector('#iteratePwd');
    var msg = box.querySelector('#iteratePwdMsg');
    var close = function () { box.remove(); };
    box.querySelector('#iteratePwdCancel').addEventListener('click', close);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    var submit = async function () {
      var v = String(pwd.value || '');
      if (!v) { msg.textContent = '先填密码。'; return; }
      msg.textContent = '正在校验…';
      var r = await XN.unlockAdmin(v);
      if (r && r.ok) { close(); XN.switchView('iterate'); }
      else { msg.textContent = (r && r.error) || '密码不对。'; }
    };
    box.querySelector('#iteratePwdOk').addEventListener('click', submit);
    pwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    pwd.focus();
  },

  /* 插件：DSH 那种「一行挂一个能力」的最小版 */
  renderPlugins() {
    var board = document.querySelector('#view-settings .board');
    if (!board || board.querySelector('#pluginCard')) return;
    var list = (XN.plugin && XN.plugin.list) ? XN.plugin.list() : [];
    var card = document.createElement('article');
    card.className = 'card wide';
    card.id = 'pluginCard';
    var html = '<header class="card-head"><h2>插件</h2><span class="card-meta">' + list.length + ' 个</span></header>';
    if (!list.length) {
      html += '<p class="hint">还没有插件。把 assets/plugins/*.js 加进 index.html 就会出现在这里。</p>';
    } else {
      html += '<div class="kv">';
      list.forEach(function (p) {
        html += '<div class="kv-row"><span>' + XN.esc(p.name) + (p.version ? ' <em>v' + XN.esc(p.version) + '</em>' : '') +
          (p.description ? '<br><small class="hint">' + XN.esc(p.description) + '</small>' : '') +
          '</span><label class="switch"><input type="checkbox" data-plugin="' + XN.esc(p.id) + '"' + (p.enabled ? ' checked' : '') + '><i></i></label></div>';
      });
      html += '</div>';
    }
    card.innerHTML = html;
    board.appendChild(card);
    card.querySelectorAll('input[data-plugin]').forEach(function (el) {
      el.addEventListener('change', function () {
        XN.plugin.setEnabled(el.getAttribute('data-plugin'), el.checked);
        card.remove();
        this.renderPlugins();
      }, false);
    });
  },

  /* 反馈箱与迭代收进设置：给两个入口按钮 */
  renderQuickLinks() {
    var board = document.querySelector('#view-settings .board');
    if (!board || board.querySelector('#quickLinksCard')) return;
    var card = document.createElement('article');
    card.className = 'card wide';
    card.id = 'quickLinksCard';
    card.innerHTML = '<header class="card-head"><h2>工具</h2><span class="card-meta">从设置进入</span></header>' +
      '<div class="arch-btns">' +
      '<button class="btn sm" id="openFeedbackBtn" type="button">打开反馈箱</button>' +
      '<button class="btn ghost sm" id="openIterateBtn" type="button">迭代（管理员）</button>' +
      '</div>' +
      '<p class="hint">反馈箱不再占侧栏；迭代页也不再挂在主界面，只有从这里的入口才会打开。</p>';
    board.appendChild(card);
    var fb = card.querySelector('#openFeedbackBtn');
    if (fb) fb.addEventListener('click', function () { XN.switchView('feedback'); });
    var it = card.querySelector('#openIterateBtn');
    var self = this;
    if (it) it.addEventListener('click', function () { self.openIterateGuarded(); });
  },

  render() {
      var keyEl = $('#setKey');
      keyEl.value = '';
      keyEl.placeholder = state.key ? '已保存（留空表示不改）' : 'sk-…';
      $('#setBase').value = state.cfg.tutor.baseUrl;
      $('#setModel').value = state.cfg.tutor.model;
      var pid = (state.cfg.tutor.provider && state.cfg.tutor.provider.id) || M.providerOfBase(state.cfg.tutor.baseUrl);
      if (pid === 'gateway' && !M.runtime().gatewayReady) pid = 'custom';
      $('#setProvider').value = M.PROVIDERS[pid] ? pid : 'custom';
      this.syncProvider();

      $('#setKeyMeta').textContent = state.key ? '已配置' : (API.isProxy() ? '走后端代理' : '未配置');
      $('#verMeta').textContent = 'v' + (root.XN_VERSION || '?') + ' · ' + XN.util.todayStr();

      /* 云端自迭代卡片已撤掉（改由「迭代」页负责），GitHub Token 也不再进 DOM。
         这几行保留判空写法，兼容旧缓存页面里的残留节点。 */
      if ($('#adminState')) $('#adminState').textContent = state.admin ? '已解锁' : '未解锁';
      if ($('#adminLock')) $('#adminLock').hidden = !state.admin;
      if ($('#adminUnlock')) $('#adminUnlock').textContent = state.admin ? '重新解锁' : '解锁改代码';

      this.renderAppearance();
      this.renderNavEditor();
      this.renderPersona();
      this.renderLanguage();
      this.renderPreview();
      this.renderStorage();
      this.renderQuickLinks();
      this.renderPlugins();

      var locale = $('#setLocale');
      if (locale) locale.value = XN.i18n.locale();
    },

    renderStorage() {
      var used = S.usage();
      $('#storageMeta').textContent = XN.bytes(used.bytes);
      var rows = [
        ['对话', state.sessions.filter((s) => s.messages.length).length + ' 个'],
        ['笔记', state.notes.length + ' 条'],
        ['今日目标', state.goals.items.filter((g) => g.done).length + ' / ' + state.goals.items.length],
        ['反馈', state.feedback.length + ' 条'],
        ['本地占用', XN.bytes(used.bytes)]
      ];
      $('#dataList').innerHTML = rows.map((r) =>
        '<div class="kv-row"><span>' + XN.esc(r[0]) + '</span><span>' + XN.esc(r[1]) + '</span></div>'
      ).join('');
    },

    syncProvider() {
      var p = $('#setProvider').value;
      var cloud = p === 'cloud';
      var gateway = p === 'gateway';
      $('#rowKey').hidden = cloud;
      $('#rowBase').hidden = cloud || gateway;
      $('#rowModel').hidden = cloud || gateway;
      var msg = $('#setMsg');
      if (cloud) {
        msg.textContent = '用服务器自带的模型，不用填 Key。质量一般，没配 Key 时先用它。';
      } else if (gateway) {
        msg.textContent = '本机网关的地址和模型由服务器下发；Key 只在本次会话里保存，不写进本机长期存储。';
      } else if (msg.textContent.indexOf('服务器自带') >= 0 || msg.textContent.indexOf('本机网关') >= 0) {
        msg.textContent = '';
      }
    },

    commit(shouldTest) {
      var key = $('#setKey').value.trim();
      var provider = $('#setProvider').value;
      var base = $('#setBase').value.trim();
      var model = $('#setModel').value.trim();
      var remember = $('#setRemember') ? $('#setRemember').checked : false;
      var preset = M.provider(provider);

      if (provider === 'cloud') {
        state.cfg.tutor.provider = { id: 'cloud', base: '' };
        state.cfg.tutor.baseUrl = '/api';
      } else if (provider === 'gateway') {
        state.cfg.tutor.provider = { id: 'gateway', base: M.runtime().gatewayBase };
        state.cfg.tutor.baseUrl = M.runtime().gatewayBase;
        state.cfg.tutor.model = M.runtime().gatewayModel || state.cfg.tutor.model;
        if (key) {
          state.gatewayKey = key;
          S.sessionSet('xn.v2.gatewayKey', key);
        }
      } else {
        if (base) state.cfg.tutor.baseUrl = base;
        else if (preset.base) state.cfg.tutor.baseUrl = preset.base;
        if (model) state.cfg.tutor.model = model;
        else if (preset.model) state.cfg.tutor.model = preset.model;
        state.cfg.tutor.provider = { id: provider, base: state.cfg.tutor.baseUrl };
        state.cfg.tutor.ownProvider = { id: provider, base: state.cfg.tutor.baseUrl };
        if (key) {
          state.key = key;
          XN.saveStoredKey(key, remember);
        }
      }
      if (provider === 'gateway' && key) {
        /* 网关钥匙只用于自迭代，不覆盖用户自己的聊天 Key */
        state.key = state.gatewayKey || state.key;
      }
      XN.saveConfig();
      this.render();
      XN.renderModelPick();
      XN.updateConn('ok');
      if (shouldTest) this.test();
      else XN.toast('存下了');
    },

    async test() {
      var msg = $('#setMsg');
      msg.className = 'hint';
      msg.textContent = '正在试…';
      var key = $('#setKey').value.trim() || state.key;
      if (!key && !API.isProxy()) { msg.textContent = '先填 Key。'; return; }
      try {
        var text = await API.chatText([{ role: 'user', content: '只回一个字：好' }], {
          key: key, maxTokens: 8, temperature: 0, timeoutMs: 40000
        });
        msg.textContent = '通了。模型 ' + state.cfg.tutor.model + ' 返回：' + String(text).slice(0, 20);
        XN.updateConn('ok');
        XN.toast('连接正常');
      } catch (e) {
        msg.textContent = e.message || '没通';
        XN.updateConn('off');
      }
    },

    /* ---------- 外观 ---------- */
    bindAppearance() {
      $$('#ctlAccent button').forEach((b) => b.addEventListener('click', () => {
        this.setStyle('accent', b.dataset.color);
        $('#accentPick').value = b.dataset.color;
      }));
      $('#accentPick').addEventListener('input', (e) => this.setStyle('accent', e.target.value));
      $('#ctlRadius').addEventListener('input', (e) => {
        this.setStyle('radius', Number(e.target.value));
        $('#outRadius').textContent = e.target.value;
      });
      $('#ctlFont').addEventListener('input', (e) => {
        this.setStyle('fontSize', Number(e.target.value));
        $('#outFont').textContent = e.target.value;
      });
      $('#ctlTheme').addEventListener('click', (e) => {
        var b = e.target.closest('button[data-theme]');
        if (!b) return;
        S.remove(S.KEYS.theme);
        this.setStyle('theme', b.dataset.theme);
        this.renderAppearance();
      });
      $('#ctlDensity').addEventListener('click', (e) => {
        var b = e.target.closest('button[data-density]');
        if (!b) return;
        this.setStyle('density', b.dataset.density);
        this.renderAppearance();
      });
    },

    setStyle(key, value) {
      state.cfg.style[key] = value;
      XN.saveConfig();
      XN.applyConfig();
      this.renderAppearance();
      this.renderPreview();
    },

    renderAppearance() {
      var s = state.cfg.style;
      $$('#ctlAccent button').forEach((b) => b.classList.toggle('on', String(b.dataset.color).toLowerCase() === String(s.accent).toLowerCase()));
      $('#accentPick').value = s.accent;
      $('#ctlRadius').value = s.radius;
      $('#outRadius').textContent = s.radius;
      $('#ctlFont').value = s.fontSize;
      $('#outFont').textContent = s.fontSize;
      $$('#ctlTheme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
      $$('#ctlDensity button').forEach((b) => b.classList.toggle('on', b.dataset.density === s.density));
    },

    /* ---------- 导航 ---------- */
    bindNav() {
      var box = $('#navEditor');
      box.addEventListener('click', (e) => {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var row = btn.closest('.nav-row');
        var id = row.dataset.id;
        var nav = state.cfg.nav.slice();
        var idx = nav.findIndex((n) => n.id === id);
        if (idx < 0) return;
        var act = btn.dataset.act;
        if (act === 'up' && idx > 0) { var t1 = nav[idx - 1]; nav[idx - 1] = nav[idx]; nav[idx] = t1; }
        if (act === 'down' && idx < nav.length - 1) { var t2 = nav[idx + 1]; nav[idx + 1] = nav[idx]; nav[idx] = t2; }
        if (act === 'toggle') nav[idx].show = !nav[idx].show;
        state.cfg.nav = nav;
        XN.saveConfig();
        XN.applyConfig();
        this.renderNavEditor();
      });

      box.addEventListener('input', (e) => {
        var input = e.target.closest('input[type="text"]');
        if (!input) return;
        var id = input.closest('.nav-row').dataset.id;
        var label = input.value.trim().slice(0, 8) || t('nav.' + id);
        state.cfg.labels[id] = label;
        XN.saveConfig();
        XN.renderSideLinks();
        if (state.view === id) XN.switchView(id);
      });
    },

    renderNavEditor() {
      var box = $('#navEditor');
      if (!box) return;
      box.innerHTML = state.cfg.nav.map((item, i) => {
        var label = (state.cfg.labels && state.cfg.labels[item.id]) || t('nav.' + item.id);
        return '<div class="nav-row' + (item.show ? '' : ' off') + '" data-id="' + item.id + '">' +
          '<span class="idx">' + (i + 1) + '</span>' +
          '<input type="text" value="' + XN.esc(label) + '" maxlength="8" aria-label="改名">' +
          '<div class="moves">' +
          '<button type="button" data-act="up" title="上移" aria-label="上移">↑</button>' +
          '<button type="button" data-act="down" title="下移" aria-label="下移">↓</button>' +
          '<button type="button" data-act="toggle" title="显示/隐藏" aria-label="显示或隐藏">' + (item.show ? '隐' : '显') + '</button>' +
          '</div></div>';
      }).join('');
    },

    /* ---------- 人设 ---------- */
    bindPersona() {
      var prompt = $('#ctlPrompt');
      var timer = 0;
      prompt.addEventListener('input', () => {
        $('#promptMeta').textContent = '字数 ' + prompt.value.length;
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.cfg.tutor.systemPrompt = prompt.value;
          XN.saveConfig();
        }, 400);
      });
      $('#ctlTemp').addEventListener('input', (e) => {
        var v = Number(e.target.value);
        state.cfg.tutor.temperature = v;
        $('#outTemp').textContent = v.toFixed(1);
        XN.saveConfig();
      });
      $('#promptReset').addEventListener('click', () => {
        if (!confirm('用默认人设覆盖当前这一版？')) return;
        state.cfg.tutor.systemPrompt = '';
        XN.saveConfig();
        this.renderPersona();
        XN.toast('已恢复默认人设（动态拼装）');
      });
    },

    renderPersona() {
      var prompt = $('#ctlPrompt');
      if (!prompt) return;
      var custom = String(state.cfg.tutor.systemPrompt || '').trim();
      var text = custom;
      if (!custom && XN.systemPromptFor) {
        try { text = XN.systemPromptFor(XN.currentSession()); } catch (e) { text = ''; }
      }
      prompt.value = text;
      prompt.dataset.dynamic = custom ? '' : '1';
      prompt.placeholder = '留空 = 用原版人设动态拼（含时间、记忆、情绪）';
      $('#promptMeta').textContent = (custom ? '自定义' : '动态拼装') + ' · ' + prompt.value.length + ' 字';
      var hint = $('#personaHint');
      if (hint) {
        hint.textContent = custom
          ? '这是你固定下来的人设，会原样发给模型。点「恢复默认人设」可以回到动态拼装。'
          : '这是当前真正发给模型的人设（含记忆、目标、时间和情绪提示）。直接修改会把它固定下来。';
      }
      $('#ctlTemp').value = state.cfg.tutor.temperature;
      $('#outTemp').textContent = Number(state.cfg.tutor.temperature).toFixed(1);
    },

    /* ---------- 配置 ---------- */
    bindConfig() {
      $('#cfgExport').addEventListener('click', () => {
        XN.download('xiaonuan-config-' + XN.util.todayStr() + '.json', JSON.stringify(this.publicConfig(), null, 2));
      });
      $('#cfgImportBtn').addEventListener('click', () => $('#cfgImport').click());
      $('#cfgImport').addEventListener('change', (e) => {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > 512 * 1024) { XN.toast('配置文件太大了'); return; }
        var reader = new FileReader();
        reader.onload = () => {
          try {
            var cfg = JSON.parse(reader.result);
            if (!cfg || typeof cfg !== 'object') throw new Error('不是对象');
            state.cfg = XN.mergeConfig(XN.defaultConfig(), cfg);
            state.cfg.nav = (state.cfg.nav || []).filter((n) => n.id !== 'chat' && ARCH_KEYS.indexOf(n.id) >= 0);
            if (!state.cfg.nav.length) state.cfg.nav = XN.defaultConfig().nav;
            XN.saveConfig();
            XN.applyConfig();
            this.render();
            XN.toast('导入成功');
          } catch (err) {
            XN.toast('这个文件读不出来：' + err.message);
          }
        };
        reader.readAsText(file);
        e.target.value = '';
      });
      $('#cfgReset').addEventListener('click', () => {
        if (!confirm('恢复默认配置？人设、配色、导航文案都会回到初版。')) return;
        state.cfg = XN.defaultConfig();
        XN.saveConfig();
        XN.applyConfig();
        this.render();
        XN.toast('回到默认');
      });
    },

    renderPreview() {
      var pre = $('#cfgPreview');
      if (!pre) return;
      var view = this.publicConfig();
      view.tutor.systemPrompt = (view.tutor.systemPrompt || '').slice(0, 40) + (view.tutor.systemPrompt ? '…（略）' : '');
      pre.textContent = JSON.stringify(view, null, 2);
    },

    /* ---------- 语言 ---------- */
    bindLanguage() {
      var sel = $('#setLocale');
      if (!sel) return;
      sel.innerHTML = XN.i18n.locales.map((code) =>
        '<option value="' + code + '">' + (XN.i18n.name ? XN.i18n.name(code) : code) + '</option>'
      ).join('');
      sel.addEventListener('change', () => {
        XN.i18n.setLocale(sel.value);
        this.render();
        XN.applyConfig();
        if (XN.views.changelog && XN.views.changelog.onShow) XN.views.changelog.onShow();
      });
    },

    renderLanguage() {
      var sel = $('#setLocale');
      if (sel) sel.value = XN.i18n.locale();
    },

    /* ---------- 一句话改版 ---------- */
    bindAiPatch() {
      $('#aiPatchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        this.aiPatch();
      });
    },

    parseJSON(raw) {
      if (!raw) return null;
      var text = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try { return JSON.parse(text); } catch (e) {}
      var start = text.indexOf('{');
      if (start < 0) return null;
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < text.length; i++) {
        var ch = text.charAt(i);
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
            try { return JSON.parse(text.slice(start, i + 1)); } catch (e2) { return null; }
          }
        }
      }
      return null;
    },

    validatePatch(patch) {
      var changes = [];
      var clean = {};
      var cur = state.cfg;

      if (patch.style && typeof patch.style === 'object') {
        var s = {};
        var st = patch.style;
        if (typeof st.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(st.accent) &&
            st.accent.toLowerCase() !== String(cur.style.accent).toLowerCase()) {
          changes.push('主色 ' + cur.style.accent + ' → ' + st.accent);
          s.accent = st.accent;
        }
        if (st.radius != null && isFinite(st.radius)) {
          var r = Math.min(26, Math.max(0, Math.round(Number(st.radius))));
          if (r !== cur.style.radius) { changes.push('圆角 ' + cur.style.radius + ' → ' + r); s.radius = r; }
        }
        if (st.fontSize != null && isFinite(st.fontSize)) {
          var f = Math.min(19, Math.max(13, Math.round(Number(st.fontSize))));
          if (f !== cur.style.fontSize) { changes.push('字号 ' + cur.style.fontSize + ' → ' + f); s.fontSize = f; }
        }
        if (['light', 'dark', 'auto'].indexOf(st.theme) >= 0 && st.theme !== cur.style.theme) {
          changes.push('明暗 ' + cur.style.theme + ' → ' + st.theme);
          s.theme = st.theme;
        }
        if (['cozy', 'compact'].indexOf(st.density) >= 0 && st.density !== cur.style.density) {
          changes.push('密度 ' + cur.style.density + ' → ' + st.density);
          s.density = st.density;
        }
        if (Object.keys(s).length) clean.style = s;
      }

      if (typeof patch.brand === 'string') {
        var b = patch.brand.trim().slice(0, 6);
        if (b && b !== cur.brand) { changes.push('名字「' + cur.brand + '」→「' + b + '」'); clean.brand = b; }
      }

      if (patch.labels && typeof patch.labels === 'object') {
        var l = {};
        ARCH_KEYS.forEach(function (k) {
          var v = patch.labels[k];
          if (typeof v !== 'string') return;
          var text = v.trim().slice(0, 6);
          if (text && text !== cur.labels[k]) { changes.push(t('nav.' + k) + '改名为「' + text + '」'); l[k] = text; }
        });
        if (Object.keys(l).length) clean.labels = l;
      }

      if (Array.isArray(patch.nav)) {
        var uniq = [];
        patch.nav.filter(function (id) { return ARCH_KEYS.indexOf(id) >= 0; }).forEach(function (id) {
          if (uniq.indexOf(id) < 0) uniq.push(id);
        });
        ARCH_KEYS.forEach(function (id) { if (uniq.indexOf(id) < 0) uniq.push(id); });
        var curIds = cur.nav.map(function (n) { return n.id; });
        if (uniq.join(',') !== curIds.join(',')) {
          changes.push('侧栏顺序 ' + curIds.join(' / ') + ' → ' + uniq.join(' / '));
          clean.nav = uniq.map(function (id) {
            var old = cur.nav.filter(function (n) { return n.id === id; })[0];
            return { id: id, show: old ? old.show !== false : true };
          });
        }
      }
      return { changes: changes, clean: clean };
    },

    async aiPatch() {
      var input = $('#aiPatchInput');
      var want = input.value.trim();
      if (!want) { XN.toast('先说你想怎么改'); return; }

      var spec = '你可以修改的字段（只允许这些）：\n' +
        '- style.accent：十六进制颜色，如 "#2f6b5f"\n' +
        '- style.radius：0-26 的整数\n' +
        '- style.fontSize：13-19 的整数\n' +
        '- style.theme："light" | "dark" | "auto"\n' +
        '- style.density："cozy" | "compact"\n' +
        '- brand：页面名字，≤6 个中文字\n' +
        '- labels.study / labels.feedback / labels.changelog / labels.settings：侧栏名称，≤6 个中文字\n' +
        '- nav：侧栏顺序，只能包含 study/feedback/changelog/settings，不能重复\n\n' +
        '当前配置：' + JSON.stringify({
          style: state.cfg.style, brand: state.cfg.brand,
          labels: state.cfg.labels, nav: state.cfg.nav.map(function (n) { return n.id; })
        }) + '\n\n只输出 JSON，不要解释，不要代码块：\n{"patch":{...},"note":"一句话说明你改了什么"}';

      var preview = $('#patchPreview');
      preview.hidden = false;
      preview.innerHTML = '<h3>生成中…</h3>';
      try {
        var text = await API.chatText([
          { role: 'system', content: '你是页面配置编译器。严格按给定字段输出 JSON。' },
          { role: 'user', content: want + '\n\n' + spec }
        ], { maxTokens: 700, temperature: 0.2 });
        var parsed = this.parseJSON(text);
        if (!parsed || !parsed.patch) throw new Error('模型没给出可用的 JSON');
        var check = this.validatePatch(parsed.patch);
        if (!check.changes.length) throw new Error('没有可应用的改动（可能都被白名单挡了）');

        preview.innerHTML = '<h3>准备改这些</h3><ul>' + check.changes.map(function (c) {
          return '<li>' + XN.esc(c) + '</li>';
        }).join('') + '</ul>' + (parsed.note ? '<p class="note">' + XN.esc(parsed.note) + '</p>' : '') +
          '<div class="arch-btns"><button class="btn ghost sm" data-arch="cancel">放弃</button>' +
          '<button class="btn primary sm" data-arch="apply">应用</button></div>';

        preview.querySelector('[data-arch="cancel"]').addEventListener('click', function () { preview.hidden = true; });
        preview.querySelector('[data-arch="apply"]').addEventListener('click', function () {
          state.cfg = XN.mergeConfig(state.cfg, check.clean);
          XN.saveConfig();
          XN.applyConfig();
          settings.render();
          preview.hidden = true;
          input.value = '';
          XN.toast('改好了');
        });
      } catch (e) {
        preview.innerHTML = '<h3>没改成</h3><p class="note">' + XN.esc(e.message || '出错') + '</p>' +
          '<div class="arch-btns"><button class="btn ghost sm" data-arch="cancel">知道了</button></div>';
        preview.querySelector('[data-arch="cancel"]').addEventListener('click', function () { preview.hidden = true; });
      }
    }
  };

  XN.views = XN.views || {};
  /* 视图插件化：插件宿主在时走注册（宿主负责挂载/路由/开关），
     宿主不在时退回老的 XN.views 直挂，保证旧部署也能用。 */
  if (XN.plugin && typeof XN.plugin.register === 'function') {
    XN.plugin.register({
      id: 'view-settings',
      name: '设置',
      version: '2.0.0',
      view: settings,
      nav: { order: 40 }
    });
  } else {
    XN.views.settings = settings;
  }
})(window);
