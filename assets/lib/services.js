/* 小暖 · 能力接口层（P3）
 *
 * 借 DSH 的「能力是行」：模型、搜索、抓网页、存储都是**具名服务**。
 * 默认实现指向现有的 API / tools / store；插件或部署方可以整块换掉，不用改调用方。
 *
 *   XN.services.register('llm', { chatRaw(), chatText(), streamChat() })
 *   XN.services.use('llm')      // 取当前实现
 *   XN.services.reset('llm')    // 回到默认
 *   XN.services.list()          // [{name, impl, builtin}]
 *
 * 约定：服务方法是「即取即用」的，默认实现内部再懒加载原模块，
 * 这样不会因为脚本顺序导致这里拿到 undefined。
 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};

  var defaults = {};
  var current = {};
  var meta = {};

  function define(name, factory, opts) {
    defaults[name] = factory;
    meta[name] = Object.assign({ builtin: true }, opts || {});
    current[name] = null;
  }

  function isFn(v) { return typeof v === 'function'; }

  /* ---------- 默认实现 ---------- */
  define('llm', function () {
    var api = XN.api || XN.API || {};
    return {
      chatRaw: function (m, o) { return api.chatRaw(m, o); },
      chatText: function (m, o) { return api.chatText ? api.chatText(m, o) : api.chatRaw(m, o); },
      streamChat: function (m, o) { return api.streamChat ? api.streamChat(m, o) : api.chatRaw(m, o); },
      ready: function () { return isFn(api.chatRaw); }
    };
  });

  define('fetch', function () {
    return {
      /* 抓网页正文；offset 是续读偏移（服务端从 v1.5.13 起支持） */
      get: async function (url, offset) {
        var q = 'api/fetch?url=' + encodeURIComponent(url) + (offset > 0 ? '&offset=' + offset : '');
        var res = await fetch(q, { headers: { Accept: 'application/json' } });
        var data = await res.json();
        if (!data || data.ok === false) throw new Error((data && data.error) || ('抓取失败 ' + res.status));
        return data;
      },
      ready: function () { return true; }
    };
  });

  define('search', function () {
    return {
      run: async function (query) {
        if (XN.TOOLS && isFn(XN.TOOLS.run)) return XN.TOOLS.run('web_search', { query: query });
        throw new Error('搜索能力未接入');
      },
      ready: function () { return !!(XN.TOOLS && isFn(XN.TOOLS.run)); }
    };
  });

  define('storage', function () {
    var st = XN.store || {};
    return {
      get: function (k, d) { return st.get ? st.get(k, d) : d; },
      set: function (k, v) { return st.set ? st.set(k, v) : v; },
      remove: function (k) { return st.remove ? st.remove(k) : undefined; },
      keys: function () { return st.keys ? st.keys() : []; },
      ready: function () { return isFn(st.get); }
    };
  });

  /* 每次取用都重建默认实例（原模块可能后加载）；外部覆盖的实例原样返回 */
  function use(name) {
    if (!defaults[name]) throw new Error('未知服务：' + name);
    if (current[name]) return current[name];
    return defaults[name]();
  }

  function register(name, impl) {
    if (!name || !impl || typeof impl !== 'object') throw new Error('服务注册需要 (name, impl)');
    if (!defaults[name]) {
      defaults[name] = function () { return impl; };
      meta[name] = { builtin: false };
    }
    current[name] = impl;
    meta[name].builtin = false;
    if (XN.emit) { try { XN.emit('services:change', { name: name }); } catch (e) {} }
    return impl;
  }

  function reset(name) {
    if (current[name]) {
      current[name] = null;
      if (meta[name]) meta[name].builtin = true;
      if (XN.emit) { try { XN.emit('services:change', { name: name }); } catch (e) {} }
      return true;
    }
    return false;
  }

  function list() {
    return Object.keys(defaults).map(function (n) {
      var impl = use(n);
      return { name: n, builtin: !!meta[n].builtin, ready: isFn(impl.ready) ? !!impl.ready() : true, methods: Object.keys(impl) };
    });
  }

  XN.services = { use: use, register: register, reset: reset, list: list, names: function () { return Object.keys(defaults); } };
})(typeof window !== 'undefined' ? window : globalThis);
