/* 小暖 · 视图：学习台 / 反馈箱 / 架构 / 设置 */
(function (N) {
  'use strict';

  const { $, $$, state } = N;
  const esc = N.esc, toast = N.toast, uid = N.uid;
  const writeJSON = N.writeJSON, KEYS = N.KEYS;

  const save = {
    goals() { writeJSON(KEYS.goals, state.goals); },
    notes() { writeJSON(KEYS.notes, state.notes); },
    feedback() { writeJSON(KEYS.fb, state.feedback); },
    timer() { writeJSON(KEYS.timer, state.timer); }
  };

  N.views = N.views || {};

  /* ============================================================
     学习台
     ============================================================ */
  const study = {
    init() {
      $('#goalForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#goalInput');
        const text = input.value.trim();
        if (!text) return;
        if (state.goals.items.some((g) => g.text === text)) { toast('这条已经在了'); return; }
        state.goals.items.push({ id: uid(), text, done: false, ts: Date.now() });
        input.value = '';
        save.goals();
        this.renderGoals();
      });

      $('#noteNew').addEventListener('click', () => this.openNote(null));
      $('#noteCancel').addEventListener('click', () => { $('#noteForm').hidden = true; });
      $('#noteForm').addEventListener('submit', (e) => { e.preventDefault(); this.commitNote(); });
      $('#noteSearch').addEventListener('input', () => this.renderNotes());

      $$('#timerPreset button').forEach((b) => b.addEventListener('click', () => {
        if (state.timer.running) { toast('先暂停再换时长'); return; }
        state.timer.min = Number(b.dataset.min);
        state.timer.left = state.timer.min * 60;
        save.timer();
        this.renderTimer();
      }));
      $('#timerStart').addEventListener('click', () => {
        if (state.timer.running) {
          state.timer.running = false;
          state.timer.left = Math.max(0, Math.round((state.timer.endsAt - Date.now()) / 1000));
          save.timer();
          this.renderTimer();
          return;
        }
        if (state.timer.left <= 0) state.timer.left = state.timer.min * 60;
        state.timer.running = true;
        state.timer.endsAt = Date.now() + state.timer.left * 1000;
        save.timer();
        this.renderTimer();
      });
      $('#timerReset').addEventListener('click', () => {
        state.timer.running = false;
        state.timer.left = state.timer.min * 60;
        save.timer();
        this.renderTimer();
      });

      setInterval(() => this.tick(), 500);
      this.renderTimer();
    },

    onShow() {
      this.renderGoals();
      this.renderNotes();
      this.renderTimer();
    },

    renderGoals() {
      const list = $('#goalList');
      if (!list) return;
      const items = state.goals.items;
      if (!items.length) {
        list.innerHTML = '<p class="goal-empty">今天还没写目标。一条就够，写「必须做完」的那条。</p>';
      } else {
        list.innerHTML = items.map((g) => (
          `<label class="goal${g.done ? ' done' : ''}" data-id="${g.id}">
             <input type="checkbox" ${g.done ? 'checked' : ''}>
             <span>${esc(g.text)}</span>
             <button type="button" class="del" title="删掉">×</button>
           </label>`
        )).join('');
      }
      const done = items.filter((g) => g.done).length;
      $('#goalMeta').textContent = `${done} / ${items.length}`;
      $$('.goal', list).forEach((row) => {
        const id = row.dataset.id;
        const box = row.querySelector('input');
        box.addEventListener('change', () => {
          const item = state.goals.items.find((g) => g.id === id);
          if (!item) return;
          item.done = box.checked;
          save.goals();
          this.renderGoals();
        });
        row.querySelector('.del').addEventListener('click', (e) => {
          e.preventDefault();
          state.goals.items = state.goals.items.filter((g) => g.id !== id);
          save.goals();
          this.renderGoals();
        });
      });
    },

    openNote(note) {
      const form = $('#noteForm');
      form.hidden = false;
      form.dataset.id = note ? note.id : '';
      $('#noteTitle').value = note ? note.title : '';
      $('#noteBody').value = note ? note.body : '';
      $('#noteTag').value = note ? note.tag || '' : '';
      $('#noteTitle').focus();
    },

    commitNote() {
      const form = $('#noteForm');
      const title = $('#noteTitle').value.trim();
      const body = $('#noteBody').value.trim();
      const tag = $('#noteTag').value.trim();
      if (!title && !body) { toast('标题或正文至少写一个'); return; }
      const id = form.dataset.id;
      if (id) {
        const note = state.notes.find((n) => n.id === id);
        if (note) { note.title = title || '无标题'; note.body = body; note.tag = tag; note.updated = Date.now(); }
        toast('改好了');
      } else {
        state.notes.unshift({ id: uid(), title: title || '无标题', body, tag, ts: Date.now(), updated: Date.now() });
        toast('存下了');
      }
      save.notes();
      form.hidden = true;
      this.renderNotes();
    },

    renderNotes() {
      const list = $('#noteList');
      if (!list) return;
      const q = ($('#noteSearch').value || '').trim().toLowerCase();
      const items = state.notes.filter((n) => {
        if (!q) return true;
        return (n.title + ' ' + n.body + ' ' + (n.tag || '')).toLowerCase().includes(q);
      });
      if (!items.length) {
        list.innerHTML = '<p class="note-empty">' + (q ? '没搜到。' : '还没有笔记。把今天错的题、想通的点，用自己的话写一条。') + '</p>';
        return;
      }
      list.innerHTML = items.map((n) => (
        `<article class="note" data-id="${n.id}">
           <h3>${esc(n.title)}</h3>
           <p>${esc(n.body || '（空）')}</p>
           <div class="meta">
             <span>${N.fmtDate(n.updated || n.ts)}</span>
             ${n.tag ? `<span class="tag">${esc(n.tag)}</span>` : ''}
           </div>
         </article>`
      )).join('');
      $$('.note', list).forEach((el) => {
        el.addEventListener('click', () => {
          const note = state.notes.find((n) => n.id === el.dataset.id);
          if (note) this.openNote(note);
        });
      });
    },

    tick() {
      if (!state.timer.running) return;
      const left = Math.round((state.timer.endsAt - Date.now()) / 1000);
      if (left <= 0) {
        state.timer.running = false;
        state.timer.left = 0;
        state.timer.done = (state.timer.done || 0) + 1;
        save.timer();
        this.renderTimer();
        toast('一轮走完了。起来动两分钟。');
        return;
      }
      state.timer.left = left;
      this.renderTimer();
      if (left % 30 === 0) save.timer();
    },

    renderTimer() {
      const num = $('#timerNum'), phase = $('#timerPhase'), btn = $('#timerStart');
      if (!num) return;
      const t = state.timer;
      num.textContent = String(Math.floor(t.left / 60)).padStart(2, '0') + ':' + String(t.left % 60).padStart(2, '0');
      num.className = 'timer-num' + (t.running ? ' running' : (t.left === 0 ? ' done' : ''));
      if (t.running) phase.textContent = '专注中';
      else if (t.left === 0) phase.textContent = '完成';
      else if (t.left < t.min * 60) phase.textContent = '已暂停';
      else phase.textContent = '未开始';
      btn.textContent = t.running ? '暂停' : (t.left === 0 ? '再来一轮' : '开始');
      $$('#timerPreset button').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === t.min));
    }
  };
  N.views.study = study;

  /* ============================================================
     反馈箱
     ============================================================ */
  const feedback = {
    type: '想法',
    init() {
      $$('#fbTypes .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          $$('#fbTypes .chip').forEach((c) => c.classList.remove('on'));
          chip.classList.add('on');
          this.type = chip.dataset.type;
        });
      });

      const body = $('#fbBody');
      body.addEventListener('input', () => {
        $('#fbCount').textContent = body.value.length + ' / 2000';
      });

      $('#fbForm').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
      $('#fbPull').addEventListener('click', () => this.pullCloud());
      $('#fbExport').addEventListener('click', () => {
        if (!state.feedback.length) { toast('还是空的'); return; }
        N.download(`xiaonuan-feedback-${N.todayStr()}.json`, JSON.stringify(state.feedback, null, 2));
      });
      $('#fbClear').addEventListener('click', () => {
        if (!state.feedback.length) return;
        if (!confirm('清空这台设备上的全部反馈？导出过再删比较稳。')) return;
        state.feedback = [];
        save.feedback();
        this.render();
        toast('清空了');
      });
    },

    onShow() { this.render(); },

    async submit() {
      const body = $('#fbBody').value.trim();
      if (!body) { toast('写点东西再投'); $('#fbBody').focus(); return; }
      const item = { id: uid(), type: this.type, body, contact: $('#fbContact').value.trim(), ts: Date.now(), status: 'local' };

      // 部署在云端时默认就投服务器，不用手填地址
      const endpoint = ((state.cfg.feedback && state.cfg.feedback.endpoint) || '').trim()
        || (N.isProxy() ? 'api/feedback' : '');
      if (endpoint) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
          });
          item.status = res.ok ? 'sent' : 'local';
        } catch (err) { item.status = 'local'; }
      }

      state.feedback.unshift(item);
      save.feedback();
      $('#fbBody').value = '';
      $('#fbContact').value = '';
      $('#fbCount').textContent = '0 / 2000';
      this.render();
      toast(item.status === 'sent' ? '投到了服务器，本地也留了一份' : '收进去了（只在本机）');
    },

    async pullCloud() {
      if (!state.admin) { toast('先在设置里输密码解锁'); return; }
      if (!N.isProxy || !N.isProxy()) { toast('这个要部署在云端才能用'); return; }
      const btn = $('#fbPull');
      btn.disabled = true;
      try {
        const res = await fetch('api/feedback?limit=200', {
          headers: { 'X-Admin-Password': state.adminPwd || '' }
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        this.cloud = j.items || [];
        this.render();
        toast('云端 ' + this.cloud.length + ' 条');
      } catch (e) {
        toast(e.message || '拉不到');
      }
      btn.disabled = false;
    },

    render() {
      const list = $('#fbList');
      if (!list) return;
      const items = state.feedback;
      $('#fbMeta').textContent = items.length + ' 条';
      const endpoint = (state.cfg.feedback && state.cfg.feedback.endpoint || '').trim();
      const sink = endpoint || ((state.cfg.feedback && state.cfg.feedback.endpoint) || '').trim();
      const pullable = state.admin && N.isProxy && N.isProxy();
      if ($('#fbPull')) $('#fbPull').hidden = !pullable;
      $('#fbSink').textContent = sink
        ? '提交会同时发到 ' + sink + '，本地留一份备份。'
        : '只存在这台设备的浏览器里。部署到云端后会自动投到服务器。';

      const cloud = this.cloud || [];
      if (!items.length && !cloud.length) {
        list.innerHTML = '<p class="fb-empty">还没有反馈。第一条可以写「我打开后第一件事想干什么」。</p>';
        return;
      }
      list.innerHTML = items.map((f) => (
        `<div class="fb-item">
           <div class="top"><span class="type">${esc(f.type)}</span><span>${N.fmtDate(f.ts)}</span><span>${f.status === 'sent' ? '已上传' : '仅本机'}</span></div>
           <p>${esc(f.body)}</p>
           ${f.contact ? `<div class="contact">联系：${esc(f.contact)}</div>` : ''}
         </div>`
      )).join('') + (cloud.length ? (
        '<div class="fb-sep">云端收到的 ' + cloud.length + ' 条</div>' + cloud.map((f) => (
          `<div class="fb-item cloud">
             <div class="top"><span class="type">${esc(f.type || '其他')}</span><span>${esc(String(f.ts || '').slice(0, 16).replace('T', ' '))}</span><span>云端</span></div>
             <p>${esc(f.body)}</p>
             ${f.contact ? `<div class="contact">联系：${esc(f.contact)}</div>` : ''}
           </div>`
        )).join('')
      ) : '');
    }
  };
  N.views.feedback = feedback;

  /* ============================================================
     架构（解锁后可见）
     ============================================================ */
  const ARCH_KEYS = ['study', 'feedback', 'settings'];

  const arch = {
    init() {
      $('#navEditor').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const row = btn.closest('.nav-row');
        const id = row.dataset.id;
        const nav = state.cfg.nav.slice();
        const i = nav.findIndex((n) => n.id === id);
        if (i < 0) return;
        const act = btn.dataset.act;
        if (act === 'up' && i > 0) { [nav[i - 1], nav[i]] = [nav[i], nav[i - 1]]; }
        if (act === 'down' && i < nav.length - 1) { [nav[i + 1], nav[i]] = [nav[i], nav[i + 1]]; }
        if (act === 'toggle') nav[i].show = !nav[i].show;
        state.cfg.nav = nav;
        N.saveConfig(); N.applyConfig(); this.renderNavEditor();
      });

      $('#navEditor').addEventListener('input', (e) => {
        const input = e.target.closest('input[type="text"]');
        if (!input) return;
        const id = input.closest('.nav-row').dataset.id;
        const label = input.value.trim().slice(0, 8) || N.viewMeta[id].title;
        state.cfg.labels[id] = label;
        N.saveConfig(); N.applyConfig();
        if (state.view === id) N.switchView(id);
      });

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
        const b = e.target.closest('button[data-theme]');
        if (!b) return;
        try { localStorage.removeItem(KEYS.theme); } catch (err) {}
        this.setStyle('theme', b.dataset.theme);
        this.renderAppearance();
      });
      $('#ctlDensity').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-density]');
        if (!b) return;
        this.setStyle('density', b.dataset.density);
        this.renderAppearance();
      });

      const prompt = $('#ctlPrompt');
      let promptTimer;
      prompt.addEventListener('input', () => {
        $('#promptMeta').textContent = '字数 ' + prompt.value.length;
        clearTimeout(promptTimer);
        promptTimer = setTimeout(() => {
          state.cfg.tutor.systemPrompt = prompt.value;
          N.saveConfig();
        }, 400);
      });
      $('#ctlTemp').addEventListener('input', (e) => {
        const v = Number(e.target.value);
        state.cfg.tutor.temperature = v;
        $('#outTemp').textContent = v.toFixed(1);
        N.saveConfig();
      });
      $('#promptReset').addEventListener('click', () => {
        if (!confirm('用默认人设覆盖当前这一版？')) return;
        state.cfg.tutor.systemPrompt = window.XN_PERSONA.system;
        prompt.value = state.cfg.tutor.systemPrompt;
        $('#promptMeta').textContent = '字数 ' + prompt.value.length;
        N.saveConfig();
        toast('已恢复默认人设');
      });

      $('#cfgExport').addEventListener('click', () => {
        N.download(`xiaonuan-config-${N.todayStr()}.json`, JSON.stringify(state.cfg, null, 2));
      });
      $('#cfgImportBtn').addEventListener('click', () => $('#cfgImport').click());
      $('#cfgImport').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const cfg = JSON.parse(reader.result);
            if (!cfg || typeof cfg !== 'object') throw new Error('不是对象');
            state.cfg = N.mergeConfig(N.defaultConfig(), cfg);
            state.cfg.nav = (state.cfg.nav || []).filter((n) => n.id !== 'chat');
            N.saveConfig(); N.applyConfig(); this.renderAll();
            toast('导入成功');
          } catch (err) {
            toast('这个文件读不出来：' + err.message);
          }
        };
        reader.readAsText(file);
        e.target.value = '';
      });
      $('#cfgReset').addEventListener('click', () => {
        if (!confirm('恢复默认配置？人设、配色、导航文案都会回到初版。')) return;
        state.cfg = N.defaultConfig();
        N.saveConfig(); N.applyConfig(); this.renderAll();
        toast('回到默认');
      });

      $('#aiPatchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        this.aiPatch();
      });

      N.onConfigChange = () => { if (state.admin) this.renderPreview(); };
    },

    onShow() {
      if (!state.admin) { N.switchView('settings'); return; }
      this.renderAll();
    },

    setStyle(key, value) {
      state.cfg.style[key] = value;
      N.saveConfig(); N.applyConfig(); this.renderAppearance(); this.renderPreview();
    },

    renderAll() {
      if (!state.admin) return;
      this.renderNavEditor();
      this.renderAppearance();
      const prompt = $('#ctlPrompt');
      // 没自定义时，把动态拼出来的那份显示出来，方便用户看着改
      prompt.value = state.cfg.tutor.systemPrompt || (window.XN_PERSONA && window.XN_PERSONA.build
        ? window.XN_PERSONA.build({ memories: state.memory || [] })
        : '');
      prompt.placeholder = '留空 = 用原版人设动态拼（含时间、记忆、情绪）';
      $('#promptMeta').textContent = '字数 ' + prompt.value.length;
      $('#ctlTemp').value = state.cfg.tutor.temperature;
      $('#outTemp').textContent = Number(state.cfg.tutor.temperature).toFixed(1);
      this.renderPreview();
    },

    renderNavEditor() {
      const box = $('#navEditor');
      if (!box) return;
      box.innerHTML = state.cfg.nav.map((item, i) => {
        const label = (state.cfg.labels && state.cfg.labels[item.id]) || N.viewMeta[item.id].title;
        return `<div class="nav-row${item.show ? '' : ' off'}" data-id="${item.id}">
          <span class="idx">${i + 1}</span>
          <input type="text" value="${esc(label)}" maxlength="8" aria-label="改名">
          <div class="moves">
            <button type="button" data-act="up" title="上移">↑</button>
            <button type="button" data-act="down" title="下移">↓</button>
            <button type="button" data-act="toggle" title="显示/隐藏">${item.show ? '隐' : '显'}</button>
          </div>
        </div>`;
      }).join('');
    },

    renderAppearance() {
      const s = state.cfg.style;
      $$('#ctlAccent button').forEach((b) => b.classList.toggle('on', String(b.dataset.color).toLowerCase() === String(s.accent).toLowerCase()));
      $('#accentPick').value = s.accent;
      $('#ctlRadius').value = s.radius;
      $('#outRadius').textContent = s.radius;
      $('#ctlFont').value = s.fontSize;
      $('#outFont').textContent = s.fontSize;
      $$('#ctlTheme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
      $$('#ctlDensity button').forEach((b) => b.classList.toggle('on', b.dataset.density === s.density));
    },

    renderPreview() {
      const pre = $('#cfgPreview');
      if (!pre) return;
      const view = JSON.parse(JSON.stringify(state.cfg));
      view.tutor.systemPrompt = (view.tutor.systemPrompt || '').slice(0, 40) + '…（略）';
      pre.textContent = JSON.stringify(view, null, 2);
    },

    async aiPatch() {
      const input = $('#aiPatchInput');
      const want = input.value.trim();
      if (!want) { toast('先说你想怎么改'); return; }

      const spec = `你可以修改的字段（只允许这些）：
- style.accent：十六进制颜色，如 "#2f6b5f"
- style.radius：0-26 的整数
- style.fontSize：13-19 的整数
- style.theme："light" | "dark" | "auto"
- style.density："cozy" | "compact"
- brand：页面名字，≤6 个中文字
- labels.study / labels.feedback / labels.arch / labels.settings：侧栏名称，≤6 个中文字
- nav：侧栏顺序，只能包含 study/feedback/arch/settings，不能重复

当前配置：${JSON.stringify({
        style: state.cfg.style,
        brand: state.cfg.brand,
        labels: state.cfg.labels,
        nav: state.cfg.nav.map((n) => n.id)
      })}

只输出 JSON，不要解释，不要代码块：
{"patch":{...},"note":"一句话说明你改了什么"}`;

      const preview = $('#patchPreview');
      preview.hidden = false;
      preview.innerHTML = '<h3>生成中…</h3>';
      try {
        const res = await N.apiChat(
          [{ role: 'system', content: '你是页面配置编译器。严格按给定字段输出 JSON。' },
           { role: 'user', content: want + '\n\n' + spec }],
          { stream: false, temperature: 0.2, maxTokens: 700 }
        );
        const parsed = this.parseJSON(res.text);
        if (!parsed || !parsed.patch) throw new Error('模型没给出可用的 JSON');
        const check = this.validatePatch(parsed.patch);
        if (!check.changes.length) throw new Error('没有可应用的改动（可能都被白名单挡了）');

        preview.innerHTML = `<h3>准备改这些</h3><ul>${check.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
          ${parsed.note ? `<p class="note">${esc(parsed.note)}</p>` : ''}
          <div class="arch-btns"><button class="btn ghost sm" data-arch="cancel">放弃</button>
          <button class="btn primary sm" data-arch="apply">应用</button></div>`;

        preview.querySelector('[data-arch="cancel"]').addEventListener('click', () => { preview.hidden = true; });
        preview.querySelector('[data-arch="apply"]').addEventListener('click', () => {
          state.cfg = N.mergeConfig(state.cfg, check.clean);
          N.saveConfig(); N.applyConfig(); this.renderAll();
          preview.hidden = true;
          input.value = '';
          toast('改好了');
        });
      } catch (e) {
        preview.innerHTML = `<h3>没改成</h3><p class="note">${esc(e.message || '出错')}</p>
          <div class="arch-btns"><button class="btn ghost sm" data-arch="cancel">知道了</button></div>`;
        preview.querySelector('[data-arch="cancel"]').addEventListener('click', () => { preview.hidden = true; });
      }
    },

    parseJSON(raw) {
      if (!raw) return null;
      let text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try { return JSON.parse(text); } catch (e) {}
      const start = text.indexOf('{');
      if (start < 0) return null;
      for (let end = text.length; end > start; end--) {
        try { return JSON.parse(text.slice(start, end)); } catch (e) {}
      }
      return null;
    },

    validatePatch(patch) {
      const changes = [];
      const clean = {};
      const cur = state.cfg;

      if (patch.style && typeof patch.style === 'object') {
        const s = {};
        const st = patch.style;
        if (typeof st.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(st.accent) &&
            st.accent.toLowerCase() !== String(cur.style.accent).toLowerCase()) {
          changes.push(`主色 ${cur.style.accent} → ${st.accent}`);
          s.accent = st.accent;
        }
        if (st.radius != null && !isNaN(st.radius)) {
          const r = Math.min(26, Math.max(0, Math.round(Number(st.radius))));
          if (r !== cur.style.radius) { changes.push(`圆角 ${cur.style.radius} → ${r}`); s.radius = r; }
        }
        if (st.fontSize != null && !isNaN(st.fontSize)) {
          const f = Math.min(19, Math.max(13, Math.round(Number(st.fontSize))));
          if (f !== cur.style.fontSize) { changes.push(`字号 ${cur.style.fontSize} → ${f}`); s.fontSize = f; }
        }
        if (['light', 'dark', 'auto'].includes(st.theme) && st.theme !== cur.style.theme) {
          changes.push(`明暗 ${cur.style.theme} → ${st.theme}`);
          s.theme = st.theme;
        }
        if (['cozy', 'compact'].includes(st.density) && st.density !== cur.style.density) {
          changes.push(`密度 ${cur.style.density} → ${st.density}`);
          s.density = st.density;
        }
        if (Object.keys(s).length) clean.style = s;
      }

      if (typeof patch.brand === 'string') {
        const b = patch.brand.trim().slice(0, 6);
        if (b && b !== cur.brand) { changes.push(`名字「${cur.brand}」→「${b}」`); clean.brand = b; }
      }

      if (patch.labels && typeof patch.labels === 'object') {
        const l = {};
        ARCH_KEYS.forEach((k) => {
          const v = patch.labels[k];
          if (typeof v !== 'string') return;
          const t = v.trim().slice(0, 6);
          if (t && t !== cur.labels[k]) { changes.push(`${N.viewMeta[k].title}改名「${t}」`); l[k] = t; }
        });
        if (Object.keys(l).length) clean.labels = l;
      }

      if (Array.isArray(patch.nav)) {
        const uniq = [];
        patch.nav.filter((id) => ARCH_KEYS.includes(id)).forEach((id) => { if (!uniq.includes(id)) uniq.push(id); });
        ARCH_KEYS.forEach((id) => { if (!uniq.includes(id)) uniq.push(id); });
        const curIds = cur.nav.map((n) => n.id);
        if (uniq.join(',') !== curIds.join(',')) {
          changes.push('侧栏顺序 ' + curIds.join(' / ') + ' → ' + uniq.join(' / '));
          clean.nav = uniq.map((id) => {
            const old = cur.nav.find((n) => n.id === id);
            return { id, show: old ? old.show !== false : true };
          });
        }
      }

      return { changes, clean };
    }
  };
  N.views.arch = arch;

  /* ============================================================
     设置
     ============================================================ */
  // 本机网关（经 cloudflared 隧道）。隧道重启后地址会变，改这里或改用「自定义」。
  const GATEWAY = {
    base: 'https://eyed-permalink-unexpected-loops.trycloudflare.com/v1',
    model: 'marvis/deepseek-v4-1-flash-261017'
  };

  const PROVIDERS = {
    custom: {},
    deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    moonshot: { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    siliconflow: { base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    gateway: { base: GATEWAY.base, model: GATEWAY.model },
    cloud: { base: '/api', model: '云端自带' }
  };

  function providerOf(baseUrl) {
    const hit = Object.keys(PROVIDERS).find((k) => PROVIDERS[k].base === baseUrl);
    return hit || 'custom';
  }

  function isLocalUrl(u) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(String(u || ''));
  }

  function iterateModelArgs(mode) {
    if (mode === 'gateway') {
      return {
        apiKey: state.cfg.iterateKey || state.key || '',
        providerBase: GATEWAY.base,
        model: GATEWAY.model,
        local: false,
        gateway: true
      };
    }

    const model = state.cfg.tutor.model || '';
    const prov = state.cfg.tutor.provider || {};
    const base = prov.base || state.cfg.tutor.baseUrl || '';

    // 云端模型（@cf/ 开头）走服务器自带推理，不要把 Key 传过去
    if (!model || model.indexOf('@cf/') === 0) {
      return { apiKey: '', providerBase: '', model: '', local: false };
    }

    return {
      apiKey: state.key || '',
      providerBase: base,
      model: model,
      // 127.0.0.1 / localhost 只有你自己这台机器能访问，Cloudflare 够不着
      local: isLocalUrl(base)
    };
  }

  const settings = {
    init() {
      $('#setForm').addEventListener('submit', (e) => { e.preventDefault(); this.commit(true); });
      $('#setTest').addEventListener('click', () => this.test());
      $('#setProvider').addEventListener('change', () => {
        const p = $('#setProvider').value;
        const preset = PROVIDERS[p] || {};
        if (preset.base) $('#setBase').value = preset.base;
        if (preset.model) $('#setModel').value = preset.model;
        this.syncProvider();
      });

      $('#ciDry').addEventListener('click', () => this.cloudIterate(true));
      $('#ciRun').addEventListener('click', () => this.cloudIterate(false));

      $('#adminForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#adminMsg');
        msg.textContent = '正在确认…';
        const r = await N.unlockAdmin($('#adminPwd').value);
        if (r.ok) {
          $('#adminPwd').value = '';
          msg.textContent = '已解锁。下面出现了「云端自迭代」，侧栏也多了「迭代」。';
          this.render();
          N.switchView('settings');
        } else {
          msg.textContent = r.error || '没成功。';
        }
      });
      $('#adminLock').addEventListener('click', () => {
        N.lockAdmin();
        this.render();
        $('#adminMsg').textContent = '已锁定。';
      });

      $('#dataExport').addEventListener('click', () => {
        const dump = {
          exportedAt: new Date().toISOString(),
          config: state.cfg,
          sessions: state.sessions,
          notes: state.notes,
          goals: state.goals,
          feedback: state.feedback
        };
        N.download(`xiaonuan-data-${N.todayStr()}.json`, JSON.stringify(dump, null, 2));
      });
      $('#dataClear').addEventListener('click', () => {
        if (!confirm('清空对话、笔记、目标、反馈和计时？配置和 Key 会保留。')) return;
        state.sessions = [];
        state.notes = []; state.feedback = [];
        state.goals = { date: N.todayStr(), items: [] };
        state.timer = { min: 25, left: 25 * 60, running: false, endsAt: 0, done: 0, date: N.todayStr() };
        save.goals(); save.notes(); save.feedback(); save.timer();
        writeJSON(KEYS.sessions, []);
        N.newSession();
        this.render();
        if (N.views.study.onShow) N.views.study.onShow();
        if (N.views.feedback.onShow) N.views.feedback.onShow();
        toast('清空了');
      });
    },

    onShow() {
      this.render();
      // 外观/布局控件现在也在这个页面里，得跟着填充
      if (N.views.arch && N.views.arch.onShow) N.views.arch.onShow();
    },

    render() {
      const keyEl = $('#setKey');
      keyEl.value = '';
      keyEl.placeholder = state.key ? '已保存（留空表示不改）' : 'sk-…';
      $('#setBase').value = state.cfg.tutor.baseUrl;
      $('#setModel').value = state.cfg.tutor.model;
      $('#setProvider').value = providerOf(state.cfg.tutor.baseUrl);
      this.syncProvider();
      $('#setKeyMeta').textContent = state.key ? '已配置' : (state.cfg.tutor.baseUrl.charAt(0) === '/' ? '走后端代理' : '未配置');
      $('#verMeta').textContent = 'v1.1 · ' + N.todayStr();

      const ci = $('#cloudIterCard');
      if (ci) ci.hidden = !state.admin;
      const lock = state.cloudRepo || {};
      if ($('#ciOwner')) {
        $('#ciOwner').value = lock.locked ? (lock.owner + ' / ' + lock.name) : '未锁定';
        $('#ciOwner').readOnly = true;
      }
      if ($('#ciRepo')) $('#ciRepo').hidden = true;
      if ($('#ciTokenRow')) $('#ciTokenRow').hidden = !!lock.serverToken;
      if ($('#ciLockNote')) {
        $('#ciLockNote').textContent = lock.locked
          ? (lock.serverToken
            ? '仓库与 Token 都在服务器上，这里不用填。'
            : '仓库已锁定；Token 服务器没配，需要你每次提供。')
          : '服务器没锁定仓库，自迭代不可用。';
      }

      const adminState = $('#adminState');
      adminState.textContent = state.admin ? '已解锁' : '未解锁';
      $('#adminLock').hidden = !state.admin;
      $('#adminUnlock').textContent = state.admin ? '重新解锁' : '解锁改代码';

      let used = 0;
      Object.keys(localStorage).forEach((k) => {
        if (k.indexOf('xn.') === 0) used += (localStorage.getItem(k) || '').length * 2;
      });
      $('#storageMeta').textContent = N.bytes(used);

      const rows = [
        ['对话', state.sessions.filter((s) => s.messages.length).length + ' 个'],
        ['笔记', state.notes.length + ' 条'],
        ['今日目标', state.goals.items.filter((g) => g.done).length + ' / ' + state.goals.items.length],
        ['反馈', state.feedback.length + ' 条'],
        ['本地占用', N.bytes(used)]
      ];
      $('#dataList').innerHTML = rows.map((r) => `<div class="kv-row"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
    },

    commit(shouldTest) {
      const key = $('#setKey').value.trim();
      const provider = $('#setProvider').value;
      const base = $('#setBase').value.trim();
      const model = $('#setModel').value.trim();
      if (provider === 'gateway' && key) {
        state.cfg.iterateKey = key;   // 隧道钥匙，专供自迭代
      }
      if (provider === 'cloud') {
        state.cfg.tutor.baseUrl = '/api';
        state.cfg.tutor.provider = { id: 'cloud', base: '' };
      } else {
        if (base) state.cfg.tutor.baseUrl = base;
        if (model) state.cfg.tutor.model = model;
        state.cfg.tutor.provider = { id: provider, base: state.cfg.tutor.baseUrl };
      }
      if (key) {
        state.key = key;
        N.saveStoredKey(key, !!localStorage.getItem(KEYS.key));
      }
      N.saveConfig();
      this.render();
      if (N.renderModelPick) N.renderModelPick();
      if (shouldTest) this.test();
      else toast('存下了');
    },

    syncProvider() {
      const p = $('#setProvider').value;
      const cloud = p === 'cloud';
      $('#rowKey').hidden = cloud;
      $('#rowBase').hidden = cloud;
      $('#rowModel').hidden = cloud;
      const msg = $('#setMsg');
      if (cloud) {
        msg.textContent = '用服务器自带的模型，不用填 Key。质量一般，没配 Key 时先用它。';
      } else if (msg.textContent.indexOf('服务器自带') >= 0) {
        msg.textContent = '';
      }
    },

    async cloudIterate(dryRun) {
      const msg = $('#ciMsg');
      const logEl = $('#ciLog');
      if (!state.admin) { msg.textContent = '先在下面输入密码解锁。'; return; }
      if (!N.isProxy || !N.isProxy()) { msg.textContent = '这一项要部署在云端（Pages）才能用。'; return; }

      const lock = state.cloudRepo || {};
      if (!lock.locked) { msg.textContent = '服务器没锁定发布仓库，自迭代不可用。'; return; }
      if (iterateModelArgs().local) {
        msg.textContent = '你选的是本机地址（127.0.0.1），Cloudflare 访问不到你电脑。换成你自己的公网 API Key，或者用本机版跑。';
        return;
      }
      const owner = lock.owner;
      const repo = lock.name;
      const token = $('#ciToken') ? $('#ciToken').value.trim() : '';
      if (!token && !dryRun && !lock.serverToken) { msg.textContent = '要真的提交，得填 GitHub Token。'; return; }

      msg.textContent = dryRun ? '试运行中，可能要十几秒…' : '正在迭代，可能要几十秒…';
      logEl.hidden = false;
      logEl.textContent = '';

      try {
        const res = await fetch('api/iterate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            owner, repo, token,
            dryRun: !!dryRun,
            password: state.adminPwd || ''
          }, iterateModelArgs()))
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        logEl.textContent = (j.log || []).join('\n');
        msg.textContent = dryRun
          ? `打算改成 v${j.version}：${j.title}（还没提交）`
          : `已提交 v${j.version}：${j.title}`;
        toast(dryRun ? '方案已生成' : '已提交到仓库');
      } catch (e) {
        msg.textContent = e.message || '没成功';
        logEl.textContent = '失败：' + (e.message || '');
      }
    },

    async test() {
      const msg = $('#setMsg');
      msg.className = 'hint';
      msg.textContent = '正在试…';
      const key = $('#setKey').value.trim() || state.key;
      if (!key && state.cfg.tutor.baseUrl.charAt(0) !== '/') { msg.textContent = '先填 Key。'; return; }
      try {
        await N.apiChat([{ role: 'user', content: '只回一个字：好' }], { key, stream: false, maxTokens: 8, temperature: 0 });
        msg.textContent = '通了。模型 ' + state.cfg.tutor.model + ' 可用。';
        N.updateConn('ok');
        toast('连接正常');
      } catch (e) {
        msg.textContent = e.message || '没通';
        N.updateConn('off');
      }
    }
  };
  N.iterateArgs = iterateModelArgs;
  N.views.settings = settings;

  N.views.chat = {
    onShow() { N.renderThread(); N.scrollBottom && N.scrollBottom(true); }
  };

  /* ============================================================
     更新日志
     ============================================================ */
  const changelog = {
    init() {
      $('#clFrom').addEventListener('change', () => this.render());
      $('#clTo').addEventListener('change', () => this.render());
    },

    onShow() {
      this.fill();
      this.render();
    },

    list() {
      const raw = (window.XN_CHANGELOG || []).slice();
      const num = (v) => String(v).split('.').map(Number);
      return raw.sort((a, b) => {
        const A = num(a.version), B = num(b.version);
        for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0);
        return 0;
      });
    },

    fill() {
      const list = this.list();
      const from = $('#clFrom'), to = $('#clTo');
      if (!list.length) return;
      const opts = list.map((c) => `<option value="${esc(c.version)}">v${esc(c.version)}</option>`).join('');
      if (from.dataset.filled !== '1') {
        from.innerHTML = opts;
        to.innerHTML = opts;
        from.value = list[list.length - 1].version;
        to.value = list[0].version;
        from.dataset.filled = '1';
        to.dataset.filled = '1';
      }
      const meta = $('#clMeta');
      if (meta) meta.textContent = '当前 v' + (window.XN_VERSION || '?') + ' · 共 ' + list.length + ' 个版本';
    },

    render() {
      const list = this.list();
      const fromV = $('#clFrom').value || (list[list.length - 1] || {}).version;
      const toV = $('#clTo').value || (list[0] || {}).version;
      let iFrom = list.findIndex((c) => c.version === fromV);
      let iTo = list.findIndex((c) => c.version === toV);
      if (iFrom < 0) iFrom = list.length - 1;
      if (iTo < 0) iTo = 0;
      if (iFrom < iTo) { const t = iFrom; iFrom = iTo; iTo = t; }

      const range = iFrom === iTo ? [list[iTo]] : list.slice(iTo, iFrom);
      const fixes = range.reduce((n, c) => n + (c.fixes || []).length, 0);
      const feats = range.reduce((n, c) => n + (c.features || []).length, 0);
      const scope = iFrom === iTo ? `v${toV} 这一个版本` : `v${fromV} 之后 · ${range.length} 个版本`;
      $('#clSum').textContent = `${scope} · 修复 ${fixes} 项 · 新增 ${feats} 项`;

      const box = $('#clList');
      if (!range.length) {
        box.innerHTML = '<p class="it-empty">这段区间没有记录。</p>';
        return;
      }
      box.innerHTML = range.map((c) => `
        <article class="cl-item">
          <div class="cl-head">
            <strong>v${esc(c.version)}</strong>
            <span class="cl-title">${esc(c.title || '')}</span>
            <span class="cl-date">${esc(c.date || '')}</span>
          </div>
          ${(c.fixes && c.fixes.length) ? `<div class="cl-sec"><h4>修掉的</h4><ul>${c.fixes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          ${(c.features && c.features.length) ? `<div class="cl-sec"><h4>新增的</h4><ul>${c.features.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          ${c.notes ? `<p class="cl-note">${esc(c.notes)}</p>` : ''}
        </article>`).join('');
    }
  };
  N.views.changelog = changelog;

})(window.XN);
