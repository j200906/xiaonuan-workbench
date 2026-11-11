/* 小暖 · 反馈箱 */
(function (root) {
  'use strict';

  var XN = root.XN;
  var $one = XN.$, $$ = XN.$$, t = XN.t;
  var state = XN.state, S = XN.store;
  var API = XN.api;

  function dateText(ts) {
    if (typeof ts === 'number') return XN.fmtDate(ts) + ' ' + XN.fmtTime(ts);
    var d = new Date(ts);
    if (!isNaN(d.getTime())) return XN.fmtDate(d.getTime()) + ' ' + XN.fmtTime(d.getTime());
    return String(ts || '').slice(0, 16).replace('T', ' ');
  }

  /* 字段清洗：类型与联系方式去掉标签和控制字符再截断；
     正文只清控制字符、保留换行，长度与服务端上限一致。
     展示层一律走 XN.esc，这里再挡一道，别让脏数据先进本机存储。 */
  function cleanText(value, max) {
    var s = String(value == null ? '' : value);
    s = s.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
    if (max > 0 && s.length > max) s = s.slice(0, max);
    return s;
  }

  function cleanBody(value) {
    var s = String(value == null ? '' : value);
    /* 只清掉控制字符，保留制表、换行、回车，正文排版不乱 */
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return s.trim().slice(0, 2000);
  }

  function normalize(item, origin) {
    var body = cleanBody((item && item.body) || '');
    return {
      id: String((item && item.id) || '') || ('x-' + Math.abs(hash(body + '|' + ((item && item.ts) || '')))),
      /* 服务器记录的真 id（worker.js 里的 record.id）。没有真 id 的云端条目就不给删除按钮，
         免得拿本地合成 id 去删。二次 normalize 时要保住空串，不能被上面合成的 id 覆盖。 */
      serverId: String(((item && item.serverId != null) ? item.serverId : (item && item.id)) || ''),
      /* 兜底类型是数据值（对齐 index.html 的 chip data-type），不翻译；展示走 typeLabel */
      type: cleanText((item && item.type) || '其他', 20) || '其他',
      body: body,
      contact: cleanText((item && item.contact) || '', 80),
      ts: (item && item.ts) || Date.now(),
      status: String((item && item.status) || 'local'),
      origin: origin || 'local'
    };
  }

  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return h;
  }

  /* 类型是数据而不是文案：本地存量、云端记录、index.html 里 chip 的 data-type
     都用中文值（想法/故障/内容/其他），所以只在展示层按当前语言翻标签，值本身不动。 */
  var TYPE_KEYS = {
    '想法': 'fb.typeIdea',
    '故障': 'fb.typeBug',
    '内容': 'fb.typeContent',
    '其他': 'fb.typeOther'
  };

  function typeLabel(type) {
    var key = TYPE_KEYS[type];
    return key ? t(key) : String(type == null ? '' : type);
  }

  /* 本地后端（127.0.0.1 / localhost 上的后端）也算「有后端」：
     这类页面请求走同源相对路径，反馈接口是通的。 */
  function hasBackend() {
    if (API.isProxy()) return true;
    var origin = String((root.location && root.location.origin) || '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false;
    var base = String((API.apiBase && API.apiBase()) || '');
    return !base || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(base);
  }

  var feedback = {
    /* 默认类型同样是对齐 index.html 的数据值，不翻译（展示层用 typeLabel） */
    type: '想法',
    cloud: [],

    init() {
      $$('#fbTypes .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          $$('#fbTypes .chip').forEach((c) => c.classList.remove('on'));
          chip.classList.add('on');
          this.type = chip.dataset.type;
        });
      });

      var body = $one('#fbBody');
      body.setAttribute('maxlength', '2000');
      body.addEventListener('input', () => {
        if (body.value.length > 2000) body.value = body.value.slice(0, 2000);
        $one('#fbCount').textContent = body.value.length + ' / 2000';
      });

      var contact = $one('#fbContact');
      if (contact) contact.setAttribute('maxlength', '80');
      $one('#fbForm').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
      $one('#fbPull').addEventListener('click', () => this.pullCloud());
      $one('#fbExport').addEventListener('click', () => {
        var all = this.merged();
        if (!all.length) { XN.toast(t('fb.emptyToast')); return; }
        XN.download('xiaonuan-feedback-' + XN.util.todayStr() + '.json', JSON.stringify(all, null, 2));
      });
      /* 「导出 CSV」不发 HTML 里，按钮在这里注入（见 ensureCsvButton） */
      this.ensureCsvButton();
      $one('#fbClear').addEventListener('click', () => {
        if (!state.feedback.length && !this.cloud.length) return;
        if (!confirm(t('fb.clearAsk'))) return;
        state.feedback = [];
        this.cloud = [];
        S.set(S.KEYS.feedback, state.feedback);
        this.render();
        XN.toast(t('fb.cleared'));
      });

      /* 条目里的「删除」是每次 render 重新生成的，用事件委托接，别绑到具体节点上。 */
      var list = $one('#fbList');
      if (list) {
        list.addEventListener('click', (e) => {
          var hit = e.target && e.target.closest ? e.target.closest('[data-fb-del]') : null;
          if (!hit) return;
          e.preventDefault();
          this.deleteCloud(hit.getAttribute('data-fb-del'), hit);
        });
      }

      var wipe = $one('#fbWipe');
      if (wipe) wipe.addEventListener('click', () => this.wipeCloud());
    },

    onShow() { this.render(); },

    localList() {
      return (state.feedback || []).map(function (x) { return normalize(x, 'local'); });
    },

    cloudList() {
      return (this.cloud || []).map(function (x) { return normalize(x, 'cloud'); });
    },

    /* 同一条反馈投到服务器后会有两份记录：id 不同、时间差几秒。
       用 type+body 去重，云端那条只在本地没有时补进来。 */
    merged() {
      var local = this.localList();
      var seen = {};
      local.forEach(function (x) { seen[x.type + '|' + x.body] = 1; });
      var cloud = this.cloudList().filter(function (x) { return !seen[x.type + '|' + x.body]; });
      return local.concat(cloud).sort(function (a, b) {
        return new Date(b.ts).getTime() - new Date(a.ts).getTime();
      });
    },

    /* ---------- 导出 CSV（M2） ----------
       index.html 不动：按钮由 ensureCsvButton 注入到「导出」旁边。
       列：时间/类型/正文/联系方式/状态。Excel 认 BOM，所以正文前补 \ufeff；
       字段按 RFC4180：含逗号/引号/换行的才加引号，内部双引号翻倍。 */
    ensureCsvButton() {
      var btn = $one('#fbExportCsv');
      if (btn) return btn;
      var anchor = $one('#fbExport');
      var meta = $one('#fbMeta');
      var head = (anchor && anchor.parentNode) || (meta && meta.parentNode);
      if (!head) return null;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'fbExportCsv';
      btn.className = 'btn ghost sm';
      btn.textContent = t('fb.exportCsv');
      btn.title = t('fb.exportCsvTitle');
      btn.addEventListener('click', () => this.exportCsv());
      if (anchor && anchor.parentNode === head) head.insertBefore(btn, anchor.nextSibling);
      else head.appendChild(btn);
      return btn;
    },

    csvCell(value) {
      var s = String(value == null ? '' : value);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },

    /* CSV 里的时间用 YYYY-MM-DD HH:mm：Excel 能认成日期，排序也不会乱；
       界面上的 dateText 是「11 月 10 日 22:25」，导出缺少年份。 */
    csvTime(ts) {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts == null ? '' : ts).slice(0, 16).replace('T', ' ');
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    toCsv(list) {
      var self = this;
      var rows = [[t('fb.csvTime'), t('fb.csvType'), t('fb.csvBody'), t('fb.csvContact'), t('fb.csvStatus')]];
      (list || []).forEach(function (f) {
        rows.push([
          self.csvTime(f.ts),
          typeLabel(f.type),
          f.body,
          f.contact,
          f.origin === 'cloud' ? t('fb.srcCloud') : (f.status === 'sent' ? t('fb.statusSent') : t('fb.statusLocal'))
        ]);
      });
      return rows.map(function (cells) {
        return cells.map(function (c) { return self.csvCell(c); }).join(',');
      }).join('\r\n');
    },

    exportCsv() {
      var all = this.merged();
      if (!all.length) { XN.toast(t('fb.emptyToast')); return; }
      XN.download('xiaonuan-feedback-' + XN.util.todayStr() + '.csv',
        '\ufeff' + this.toCsv(all), 'text/csv;charset=utf-8');
      XN.toast(t('fb.exportedCsv', { n: all.length }));
    },

    async submit() {
      var body = $one('#fbBody').value.trim();
      if (!body) { XN.toast(t('fb.needBody')); $one('#fbBody').focus(); return; }
      var item = {
        id: XN.uid('f'),
        type: this.type,
        body: body.slice(0, 2000),
        contact: $one('#fbContact').value.trim().slice(0, 80),
        ts: Date.now(),
        status: 'local'
      };

      var endpoint = ((state.cfg.feedback && state.cfg.feedback.endpoint) || '').trim();
      if (!endpoint && API.isProxy()) endpoint = 'api/feedback';
      /* 允许相对路径（api/feedback）和 http(s)；其他伪协议一律丢掉 */
      if (endpoint && /^[a-z][a-z0-9+.-]*:/i.test(endpoint) && !/^https?:/i.test(endpoint)) {
        endpoint = '';
      }

      if (endpoint) {
        try {
          var res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
            credentials: 'same-origin'
          });
          item.status = res.ok ? 'sent' : 'local';
        } catch (e) { item.status = 'local'; }
      }

      state.feedback.unshift(normalize(item, 'local'));
      if (state.feedback.length > 300) state.feedback = state.feedback.slice(0, 300);
      S.set(S.KEYS.feedback, state.feedback);
      $one('#fbBody').value = '';
      $one('#fbContact').value = '';
      $one('#fbCount').textContent = '0 / 2000';
      this.render();
      XN.toast(item.status === 'sent' ? t('fb.sent') : t('fb.savedLocal'));
    },

    async pullCloud() {
      if (!state.admin) { XN.toast(t('fb.needAdmin')); return; }
      if (!hasBackend()) { XN.toast(t('fb.noCloud')); return; }
      var btn = $one('#fbPull');
      btn.disabled = true;
      try {
        var r = await API.adminFetch('api/feedback?limit=200');
        if (r.res.status === 401) { XN.lockAdmin(); throw new Error(t('fb.sessionExpired')); }
        if (!r.res.ok || !r.data || !r.data.ok) {
          throw new Error((r.data && r.data.error) || ('HTTP ' + r.res.status));
        }
        this.cloud = (r.data.items || []).map(function (x) { return normalize(x, 'cloud'); });
        this.render();
        XN.toast(t('fb.cloudCount', { n: this.cloud.length }));
      } catch (e) {
        if (e && e.status === 401) XN.lockAdmin();
        XN.toast(e.message || t('fb.pullFailed'));
      }
      btn.disabled = false;
    },

    /* DELETE api/feedback 的统一收尾：401 按现有逻辑锁回未解锁态；其余错误 toast 原因。
       成功返回响应体（里面有 deleted 条数），失败返回 null。 */
    async removeFromServer(path) {
      try {
        var r = await API.adminFetch(path, { method: 'DELETE' });
        if (r.res.status === 401) { XN.lockAdmin(); throw new Error(t('fb.sessionExpired')); }
        if (!r.res.ok || !r.data || !r.data.ok) {
          throw new Error((r.data && r.data.error) || ('HTTP ' + r.res.status));
        }
        return r.data;
      } catch (e) {
        if (e && e.status === 401) XN.lockAdmin();
        XN.toast(e.message || t('fb.deleteFailed'));
        return null;
      }
    },

    /* 删一条云端反馈。id 用服务器给的 record.id（normalize 里存成 serverId）。 */
    async deleteCloud(id, btn) {
      if (!state.admin) { XN.toast(t('fb.needAdmin')); return; }
      if (!API.isProxy()) { XN.toast(t('fb.noCloud')); return; }
      var key = String(id || '');
      if (!key) return;
      var item = (this.cloud || []).filter(function (x) { return x.serverId === key; })[0];
      if (!item) { XN.toast(t('fb.cloudMissing')); return; }
      if (!confirm(t('fb.deleteCloudAsk'))) return;

      if (btn) btn.disabled = true;
      var data = await this.removeFromServer('api/feedback?id=' + encodeURIComponent(key));
      if (!data) { if (btn) btn.disabled = false; return; }

      this.cloud = (this.cloud || []).filter(function (x) { return x.serverId !== key; });
      this.render();
      XN.toast(data.deleted ? t('fb.cloudDeleted', { n: data.deleted }) : t('fb.cloudNotFound'));
    },

    /* 清空云端全部反馈（?all=1）。确认后一次删干净。 */
    async wipeCloud() {
      if (!state.admin) { XN.toast(t('fb.needAdmin')); return; }
      if (!API.isProxy()) { XN.toast(t('fb.noCloud')); return; }
      if (!confirm(t('fb.wipeAsk'))) return;

      var btn = $one('#fbWipe');
      if (btn) btn.disabled = true;
      var data = await this.removeFromServer('api/feedback?all=1');
      if (btn) btn.disabled = false;
      if (!data) return;

      this.cloud = [];
      this.render();
      XN.toast(t('fb.wiped', { n: data.deleted || 0 }));
    },

    render() {
      var list = $one('#fbList');
      if (!list) return;
      var all = this.merged();
      $one('#fbMeta').textContent = t('fb.count', { n: all.length });
      /* 空列表时 CSV 按钮置灰（按钮是注入的，可能还没建，ensureCsvButton 兼作创建） */
      var csvBtn = this.ensureCsvButton();
      if (csvBtn) csvBtn.disabled = !all.length;

      var endpoint = ((state.cfg.feedback && state.cfg.feedback.endpoint) || '').trim() || (API.isProxy() ? 'api/feedback' : '');
      $one('#fbSink').textContent = endpoint
        ? t('fb.sinkRemote', { u: endpoint })
        : t('fb.sinkLocal');

      var pullable = state.admin && hasBackend();
      $one('#fbPull').hidden = !pullable;
      var wipeBtn = $one('#fbWipe');
      if (wipeBtn) wipeBtn.hidden = !pullable;

      if (!all.length) {
        list.innerHTML = '<p class="fb-empty">' + XN.esc(t('fb.empty')) + '</p>';
        return;
      }

      list.innerHTML = all.map((f) => (
        '<div class="fb-item' + (f.origin === 'cloud' ? ' cloud' : '') + '">' +
        '<div class="top"><span class="type">' + XN.esc(typeLabel(f.type)) + '</span>' +
        '<span>' + XN.esc(dateText(f.ts)) + '</span>' +
        '<span>' + (f.origin === 'cloud' ? t('fb.srcCloud') : (f.status === 'sent' ? t('fb.statusSent') : t('fb.statusLocal'))) + '</span>' +
        (f.origin === 'cloud' && pullable && f.serverId
          ? '<button type="button" class="btn ghost sm danger" style="margin-left:auto" data-fb-del="' +
            XN.esc(f.serverId) + '" title="' + t('fb.deleteCloudTitle') + '">' + t('fb.delete') + '</button>'
          : '') +
        '</div>' +
        '<p>' + XN.esc(f.body) + '</p>' +
        (f.contact ? '<div class="contact">' + t('fb.contactLine') + XN.esc(f.contact) + '</div>' : '') +
        '</div>'
      )).join('');
    }
  };

  XN.views = XN.views || {};
  /* 视图改成插件注册：插件运行时注册清单，没装插件系统就退回老的直接挂载。 */
  if (XN && XN.plugin) {
    XN.plugin.register({ id: 'view-feedback', name: t('nav.feedback'), version: '2.0.0', view: feedback, nav: { order: 50 } });
  } else {
    XN.views.feedback = feedback;
  }
})(window);
