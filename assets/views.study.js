/* 小暖 · 学习台：目标 / 专注 / 笔记 */
(function (root) {
  'use strict';

  var XN = root.XN;
  var $ = XN.$, $$ = XN.$$, t = XN.t;
  var state = XN.state, S = XN.store;
  /* 笔记分页上限来自 cfg.limits.notesPage，不再写死 20；坏值回落到 20 */
  function pageSize() {
    var lim = (state.cfg && state.cfg.limits) || {};
    var n = Number(lim.notesPage);
    if (!isFinite(n) || n < 5) n = 20;
    return Math.min(200, Math.floor(n));
  }
  var PAGE = pageSize();

  var study = {
    noteLimit: PAGE,

    init() {
      /* boot 里 loadState 已经跑完，这里拿到的才是用户配置 */
      this.noteLimit = pageSize();
      this.ensureExportButton();
      $('#goalForm').addEventListener('submit', (e) => {
        e.preventDefault();
        this.addGoal();
      });

      $('#noteNew').addEventListener('click', () => this.openNote(null));
      $('#noteCancel').addEventListener('click', () => { $('#noteForm').hidden = true; });
      $('#noteForm').addEventListener('submit', (e) => { e.preventDefault(); this.commitNote(); });
      $('#noteSearch').addEventListener('input', XN.util.debounce(() => {
        this.noteLimit = pageSize();
        this.renderNotes();
      }, 150));
      $('#noteMore').addEventListener('click', () => {
        this.noteLimit += pageSize();
        this.renderNotes();
      });

      $$('#timerPreset button').forEach((b) => b.addEventListener('click', () => {
        if (state.timer.running) { XN.toast(t('study.pauseFirst')); return; }
        state.timer.min = Number(b.dataset.min);
        state.timer.left = state.timer.min * 60;
        this.saveTimer();
        this.renderTimer();
      }));

      $('#timerStart').addEventListener('click', () => this.toggleTimer());
      $('#timerReset').addEventListener('click', () => {
        state.timer.running = false;
        state.timer.endsAt = 0;
        state.timer.left = state.timer.min * 60;
        this.saveTimer();
        this.renderTimer();
      });

      /* 页面休眠/切后台后 endsAt 仍然有效；回来时立刻校时，避免跳数 */
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.tick();
      });
      setInterval(() => this.tick(), 500);
      this.renderTimer();
    },

    onShow() {
      this.renderGoals();
      this.renderNotes();
      this.renderTimer();
    },

    saveTimer() { S.set(S.KEYS.timer, state.timer); },
    saveGoals() { S.set(S.KEYS.goals, state.goals); },
    saveNotes() { S.set(S.KEYS.notes, state.notes); },

    /* 笔记导出：按钮由 JS 注入到笔记列表下方，不改 index.html。
       #noteList 的 innerHTML 每次 renderNotes 都会被重写，所以按钮挂在外层容器上。 */
    ensureExportButton() {
      var list = $('#noteList');
      if (!list || $('#noteExportMd')) return;
      var wrap = document.createElement('div');
      wrap.className = 'note-export';
      wrap.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin:2px 0 10px';
      wrap.innerHTML = '<button class="btn ghost sm" id="noteExportMd" type="button">' +
        t('study.exportMd') + '</button>';
      list.parentNode.insertBefore(wrap, list.nextSibling);
      var btn = wrap.querySelector('#noteExportMd');
      btn.addEventListener('click', () => this.exportNotesMarkdown());
      this.syncExportButton();
    },

    syncExportButton() {
      var btn = $('#noteExportMd');
      if (!btn) return;
      var n = (state.notes || []).length;
      btn.disabled = !n;
      btn.title = n ? t('study.exportTitle', { n: n }) : t('study.exportNone');
    },

    exportNotesMarkdown() {
      var notes = state.notes || [];
      if (!notes.length) {
        XN.toast(t('study.exportEmpty'));
        this.syncExportButton();
        return;
      }
      var day = XN.util.todayStr();
      var lines = [t('study.mdTitle', { n: notes.length, date: day }), ''];
      notes.forEach((n) => {
        var date = XN.util.dayKey(n.updated || n.ts) || XN.fmtDate(n.updated || n.ts);
        lines.push('## ' + (n.title || t('study.untitled')) + ' · ' + date);
        lines.push('');
        lines.push(String(n.body || '').trim());
        lines.push('');
      });
      XN.download('xiaonuan-notes-' + day + '.md', lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'text/markdown;charset=utf-8');
      XN.toast(t('study.exported', { n: notes.length }));
    },

    addGoal() {
      var input = $('#goalInput');
      var text = input.value.trim();
      if (!text) return;
      if (state.goals.items.some((g) => g.text === text)) { XN.toast(t('study.goalExists')); return; }
      if (state.goals.items.length >= 12) { XN.toast(t('study.goalFull')); return; }
      state.goals.date = XN.util.todayStr();
      state.goals.items.push({ id: XN.uid('g'), text: text.slice(0, 80), done: false, ts: Date.now() });
      input.value = '';
      this.saveGoals();
      this.renderGoals();
    },

    renderGoals() {
      var list = $('#goalList');
      if (!list) return;
      var items = state.goals.items;
      if (!items.length) {
        list.innerHTML = '<p class="goal-empty">' + t('study.goalEmpty') + '</p>';
      } else {
        list.innerHTML = items.map((g) => (
          '<label class="goal' + (g.done ? ' done' : '') + '" data-id="' + XN.esc(g.id) + '">' +
          '<input type="checkbox"' + (g.done ? ' checked' : '') + '>' +
          '<span>' + XN.esc(g.text) + '</span>' +
          '<button type="button" class="del" title="' + t('study.deleteTitle') +
          '" aria-label="' + t('study.deleteGoalLabel') + '">×</button>' +
          '</label>'
        )).join('');
      }
      $('#goalMeta').textContent = items.filter((g) => g.done).length + ' / ' + items.length;

      $$('.goal', list).forEach((row) => {
        var id = row.dataset.id;
        var box = row.querySelector('input');
        box.addEventListener('change', () => {
          var item = state.goals.items.filter((g) => g.id === id)[0];
          if (!item) return;
          item.done = box.checked;
          this.saveGoals();
          this.renderGoals();
        });
        row.querySelector('.del').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          state.goals.items = state.goals.items.filter((g) => g.id !== id);
          this.saveGoals();
          this.renderGoals();
        });
      });
    },

    openNote(note) {
      var form = $('#noteForm');
      form.hidden = false;
      form.dataset.id = note ? note.id : '';
      $('#noteTitle').value = note ? note.title : '';
      $('#noteBody').value = note ? note.body : '';
      $('#noteTag').value = note ? note.tag || '' : '';
      $('#noteTitle').focus();
    },

    commitNote() {
      var form = $('#noteForm');
      var title = $('#noteTitle').value.trim();
      var body = $('#noteBody').value.trim();
      var tag = $('#noteTag').value.trim();
      if (!title && !body) { XN.toast(t('study.needContent')); return; }
      var id = form.dataset.id;
      if (id) {
        var note = state.notes.filter((n) => n.id === id)[0];
        if (note) {
          note.title = (title || t('study.untitled')).slice(0, 60);
          note.body = body.slice(0, 20000);
          note.tag = tag.slice(0, 16);
          note.updated = Date.now();
        }
        XN.toast(t('study.updated'));
      } else {
        state.notes.unshift({
          id: XN.uid('n'), title: (title || t('study.untitled')).slice(0, 60),
          body: body.slice(0, 20000), tag: tag.slice(0, 16),
          ts: Date.now(), updated: Date.now()
        });
        XN.toast(t('study.saved'));
      }
      this.saveNotes();
      form.hidden = true;
      this.noteLimit = Math.max(this.noteLimit, PAGE);
      this.renderNotes();
    },

    filtered() {
      var q = ($('#noteSearch').value || '').trim().toLowerCase();
      if (!q) return state.notes;
      return state.notes.filter((n) => {
        return (n.title + ' ' + n.body + ' ' + (n.tag || '')).toLowerCase().indexOf(q) >= 0;
      });
    },

    renderNotes() {
      var list = $('#noteList');
      if (!list) return;
      this.syncExportButton();
      var all = this.filtered();
      var items = all.slice(0, this.noteLimit);

      if (!all.length) {
        list.innerHTML = '<p class="note-empty">' + (($('#noteSearch').value || '').trim()
          ? t('study.searchNone') : t('study.noteEmpty')) + '</p>';
        $('#noteMoreWrap').hidden = true;
        return;
      }

      list.innerHTML = items.map((n) => (
        '<article class="note" data-id="' + XN.esc(n.id) + '" tabindex="0" role="button">' +
        '<h3>' + XN.esc(n.title) + '</h3>' +
        '<p>' + XN.esc(String(n.body || t('study.noteBlank')).slice(0, 180)) + '</p>' +
        '<div class="meta"><span>' + XN.fmtDate(n.updated || n.ts) + '</span>' +
        (n.tag ? '<span class="tag">' + XN.esc(n.tag) + '</span>' : '') +
        '</div></article>'
      )).join('');

      $('#noteMoreWrap').hidden = all.length <= this.noteLimit;
      $('#noteMore').textContent = t('study.more') +
        t('study.remaining', { n: Math.max(0, all.length - this.noteLimit) });

      $$('.note', list).forEach((el) => {
        var open = () => {
          var note = state.notes.filter((n) => n.id === el.dataset.id)[0];
          if (note) this.openNote(note);
        };
        el.addEventListener('click', open);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      });
    },

    toggleTimer() {
      var tm = state.timer;
      if (tm.running) {
        tm.running = false;
        tm.left = Math.max(0, Math.round((tm.endsAt - Date.now()) / 1000));
        tm.endsAt = 0;
        this.saveTimer();
        this.renderTimer();
        return;
      }
      if (tm.left <= 0 || tm.left > tm.min * 60) tm.left = tm.min * 60;
      tm.running = true;
      tm.endsAt = Date.now() + tm.left * 1000;
      this.saveTimer();
      this.renderTimer();
    },

    tick() {
      if (!state.timer.running) return;
      var left = Math.round((state.timer.endsAt - Date.now()) / 1000);
      if (left <= 0) {
        state.timer.running = false;
        state.timer.left = 0;
        state.timer.endsAt = 0;
        state.timer.done = (state.timer.done || 0) + 1;
        this.saveTimer();
        this.renderTimer();
        XN.toast(t('study.roundDone'));
        return;
      }
      state.timer.left = left;
      this.renderTimer();
      if (left % 30 === 0) this.saveTimer();
    },

    renderTimer() {
      var num = $('#timerNum'), phase = $('#timerPhase'), btn = $('#timerStart');
      if (!num) return;
      var tm = state.timer;
      num.textContent = String(Math.floor(tm.left / 60)).padStart(2, '0') + ':' + String(tm.left % 60).padStart(2, '0');
      num.className = 'timer-num' + (tm.running ? ' running' : (tm.left === 0 ? ' done' : ''));
      if (tm.running) phase.textContent = t('study.focusing');
      else if (tm.left === 0) phase.textContent = t('study.done');
      else if (tm.left < tm.min * 60) phase.textContent = t('study.paused');
      else phase.textContent = t('study.notStarted');
      btn.textContent = tm.running ? t('study.pause') : (tm.left === 0 ? t('study.again') : t('study.start'));
      $$('#timerPreset button').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === tm.min));
    }
  };

  XN.views = XN.views || {};
  /* 插件宿主 v2：视图登记为插件；宿主不在时退回老路径（兼容） */
  if (XN.plugin && XN.plugin.register) {
    XN.plugin.register({
      id: 'view-study',
      name: t('nav.study'),
      version: '2.0.0',
      view: study,
      nav: { order: 20 }
    });
  } else {
    XN.views.study = study;
  }
})(window);
