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

      if (!all.length) {
        list.innerHTML = '<p class="fb-empty">' + XN.esc(t('fb.empty')) + '</p>';
        return;
      }

      list.innerHTML = all.map((f) => (
        '<div class="fb-item' + (f.origin === 'cloud' ? ' cloud' : '') + '">' +
        '<div class="top"><span class="type">' + XN.esc(f.type) + '</span>' +
        '<span>' + XN.esc(dateText(f.ts)) + '</span>' +
        '<span>' + (f.origin === 'cloud' ? '云端' : (f.status === 'sent' ? '已上传' : '仅本机')) + '</span></div>' +
        '<p>' + XN.esc(f.body) + '</p>' +
        (f.contact ? '<div class="contact">联系：' + XN.esc(f.contact) + '</div>' : '') +
        '</div>'
      )).join('');
    }
  };

  XN.views = XN.views || {};
  XN.views.feedback = feedback;
})(window);
