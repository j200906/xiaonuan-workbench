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

  function normalize(item, origin) {
    var body = String((item && item.body) || '').trim();
    return {
      id: String((item && item.id) || '') || ('x-' + Math.abs(hash(body + '|' + ((item && item.ts) || '')))),
      /* 服务器记录的真 id（worker.js 里的 record.id）。没有真 id 的云端条目就不给删除按钮，
         免得拿本地合成 id 去删。二次 normalize 时要保住空串，不能被上面合成的 id 覆盖。 */
      serverId: String(((item && item.serverId != null) ? item.serverId : (item && item.id)) || ''),
      type: String((item && item.type) || '其他').slice(0, 20),
      body: body.slice(0, 2000),
      contact: String((item && item.contact) || '').slice(0, 80),
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

  var feedback = {
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
      body.addEventListener('input', () => {
        $one('#fbCount').textContent = body.value.length + ' / 2000';
      });

      $one('#fbForm').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
      $one('#fbPull').addEventListener('click', () => this.pullCloud());
      $one('#fbExport').addEventListener('click', () => {
        var all = this.merged();
        if (!all.length) { XN.toast('还是空的'); return; }
        XN.download('xiaonuan-feedback-' + XN.util.todayStr() + '.json', JSON.stringify(all, null, 2));
      });
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

    async submit() {
      var body = $one('#fbBody').value.trim();
      if (!body) { XN.toast('写点东西再投'); $one('#fbBody').focus(); return; }
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

      state.feedback.unshift(item);
      if (state.feedback.length > 300) state.feedback = state.feedback.slice(0, 300);
      S.set(S.KEYS.feedback, state.feedback);
      $one('#fbBody').value = '';
      $one('#fbContact').value = '';
      $one('#fbCount').textContent = '0 / 2000';
      this.render();
      XN.toast(item.status === 'sent' ? t('fb.sent') : t('fb.savedLocal'));
    },

    async pullCloud() {
      if (!state.admin) { XN.toast('先在设置里输密码解锁'); return; }
      if (!API.isProxy()) { XN.toast('本地静态页面没有云端反馈'); return; }
      var btn = $one('#fbPull');
      btn.disabled = true;
      try {
        var r = await API.adminFetch('api/feedback?limit=200');
        if (r.res.status === 401) { XN.lockAdmin(); throw new Error('会话失效，请重新解锁'); }
        if (!r.res.ok || !r.data || !r.data.ok) {
          throw new Error((r.data && r.data.error) || ('HTTP ' + r.res.status));
        }
        this.cloud = (r.data.items || []).map(function (x) { return normalize(x, 'cloud'); });
        this.render();
        XN.toast('云端 ' + this.cloud.length + ' 条');
      } catch (e) {
        if (e && e.status === 401) XN.lockAdmin();
        XN.toast(e.message || '拉不到');
      }
      btn.disabled = false;
    },

    /* DELETE api/feedback 的统一收尾：401 按现有逻辑锁回未解锁态；其余错误 toast 原因。
       成功返回响应体（里面有 deleted 条数），失败返回 null。 */
    async removeFromServer(path) {
      try {
        var r = await API.adminFetch(path, { method: 'DELETE' });
        if (r.res.status === 401) { XN.lockAdmin(); throw new Error('会话失效，请重新解锁'); }
        if (!r.res.ok || !r.data || !r.data.ok) {
          throw new Error((r.data && r.data.error) || ('HTTP ' + r.res.status));
        }
        return r.data;
      } catch (e) {
        if (e && e.status === 401) XN.lockAdmin();
        XN.toast(e.message || '删不掉');
        return null;
      }
    },

    /* 删一条云端反馈。id 用服务器给的 record.id（normalize 里存成 serverId）。 */
    async deleteCloud(id, btn) {
      if (!state.admin) { XN.toast('先在设置里输密码解锁'); return; }
      if (!API.isProxy()) { XN.toast('本地静态页面没有云端反馈'); return; }
      var key = String(id || '');
      if (!key) return;
      var item = (this.cloud || []).filter(function (x) { return x.serverId === key; })[0];
      if (!item) { XN.toast('云端列表里没有这条了，先拉一次'); return; }
      if (!confirm('从云端删掉这条反馈？删了就找不回来。')) return;

      if (btn) btn.disabled = true;
      var data = await this.removeFromServer('api/feedback?id=' + encodeURIComponent(key));
      if (!data) { if (btn) btn.disabled = false; return; }

      this.cloud = (this.cloud || []).filter(function (x) { return x.serverId !== key; });
      this.render();
      XN.toast(data.deleted ? '云端删掉了 ' + data.deleted + ' 条' : '云端没找到这条，本地列表已同步');
    },

    /* 清空云端全部反馈（?all=1）。确认后一次删干净。 */
    async wipeCloud() {
      if (!state.admin) { XN.toast('先在设置里输密码解锁'); return; }
      if (!API.isProxy()) { XN.toast('本地静态页面没有云端反馈'); return; }
      if (!confirm('清空服务器上的全部反馈？删了就找不回来，先导出再删比较稳。')) return;

      var btn = $one('#fbWipe');
      if (btn) btn.disabled = true;
      var data = await this.removeFromServer('api/feedback?all=1');
      if (btn) btn.disabled = false;
      if (!data) return;

      this.cloud = [];
      this.render();
      XN.toast('云端清空了，删掉 ' + (data.deleted || 0) + ' 条');
    },

    render() {
      var list = $one('#fbList');
      if (!list) return;
      var all = this.merged();
      $one('#fbMeta').textContent = all.length + ' 条';

      var endpoint = ((state.cfg.feedback && state.cfg.feedback.endpoint) || '').trim() || (API.isProxy() ? 'api/feedback' : '');
      $one('#fbSink').textContent = endpoint
        ? '提交会同时发到 ' + endpoint + '，本地留一份备份。'
        : t('fb.sinkLocal');

      var pullable = state.admin && API.isProxy();
      $one('#fbPull').hidden = !pullable;
      var wipeBtn = $one('#fbWipe');
      if (wipeBtn) wipeBtn.hidden = !pullable;

      if (!all.length) {
        list.innerHTML = '<p class="fb-empty">' + XN.esc(t('fb.empty')) + '</p>';
        return;
      }

      list.innerHTML = all.map((f) => (
        '<div class="fb-item' + (f.origin === 'cloud' ? ' cloud' : '') + '">' +
        '<div class="top"><span class="type">' + XN.esc(f.type) + '</span>' +
        '<span>' + XN.esc(dateText(f.ts)) + '</span>' +
        '<span>' + (f.origin === 'cloud' ? '云端' : (f.status === 'sent' ? '已上传' : '仅本机')) + '</span>' +
        (f.origin === 'cloud' && pullable && f.serverId
          ? '<button type="button" class="btn ghost sm danger" style="margin-left:auto" data-fb-del="' +
            XN.esc(f.serverId) + '" title="从云端删除这条">删除</button>'
          : '') +
        '</div>' +
        '<p>' + XN.esc(f.body) + '</p>' +
        (f.contact ? '<div class="contact">联系：' + XN.esc(f.contact) + '</div>' : '') +
        '</div>'
      )).join('');
    }
  };

  XN.views = XN.views || {};
  XN.views.feedback = feedback;
})(window);
