/* 小暖 · 插件宿主 v2
 *
 * 设计参照 DSH（cordis）的「一行能力」，但保留小暖的无构建形态：
 *   插件 = 一个对象，登记在 window.XN_PLUGINS 或运行时 register()
 *   宿主 = 负责挂载/卸载/错误隔离/视图路由/设置项收集
 *
 * 插件契约（全部可选，但 id 必填）：
 * {
 *   id: 'view-study',            // 唯一
 *   name: '学习台',
 *   version: '2.0.0',
 *   description: '',
 *   defaultEnabled: true,
 *   requires: ['view-chat'],     // 依赖的插件 id；缺失则跳过并给出原因
 *   view: { ... },               // 视图对象（init/onShow/render…）：注册后可用
 *   nav: { order: 20, icon: '' },// 视图在侧栏/路由里的顺序
 *   mount(ctx) {}, unmount(ctx) {},// 非视图插件的挂载/卸载
 *   settings: [{ key, type, label, default }] // 声明式设置项（P2 用）
 * }
 *
 * 宿主保证：
 *   - 一个插件挂载失败不影响其它插件与主流程（错误隔离 + toast）
 *   - unregister/setEnabled(false) 一定调用 unmount 与所有 onDispose
 *   - 视图通过 XN.plugin.view(id) 取得；XM.views 保留为兼容别名
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  var plugins = [];          /* 全部已登记 */
  var mounted = {};          /* id -> true */
  var viewRegistry = {};     /* viewId -> view 对象 */
  var viewOwners = {};       /* viewId -> pluginId */
  var disposers = {};        /* pluginId -> [fn] */
  var events = root.XN && root.XN.emit ? null : null;

  function log(level, msg, extra) {
    var fn = console[level] || console.log;
    try { fn.call(console, '[plugin] ' + msg, extra || ''); } catch (e) {}
  }

  function emit(name, payload) {
    if (XN.emit) { try { XN.emit(name, payload); } catch (e) {} }
  }

  function toast(msg, kind) {
    if (XN.toast) XN.toast(msg, kind);
    else log('warn', msg);
  }

  function enabledMap() {
    var cfg = (XN.state && XN.state.cfg) || {};
    if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
    return cfg.plugins;
  }

  function isEnabled(p) {
    var m = enabledMap();
    if (m[p.id] === true) return true;
    if (m[p.id] === false) return false;
    return p.defaultEnabled !== false;
  }

  function missingRequires(p) {
    if (!Array.isArray(p.requires) || !p.requires.length) return [];
    return p.requires.filter(function (dep) {
      return !plugins.some(function (x) { return x.id === dep; });
    });
  }

  function makeCtx(p) {
    var list = disposers[p.id] = disposers[p.id] || [];
    return {
      XN: XN,
      root: root,
      id: p.id,
      toast: toast,
      onDispose: function (fn) { if (typeof fn === 'function') list.push(fn); },
      addSettingsCard: function (card) {
        var state = XN.state || {};
        state.__pluginCards = state.__pluginCards || [];
        state.__pluginCards.push({ pluginId: p.id, title: card.title || p.name, render: card.render });
      }
    };
  }

  /* ---------- 视图注册 ---------- */
  function registerView(p, view) {
    if (!view || typeof view !== 'object') return;
    var ids = [].concat(p.id, view.id ? 'view-' + view.id : []).filter(Boolean);
    var vid = view.id || (p.id.indexOf('view-') === 0 ? p.id.slice(5) : p.id);
    if (viewRegistry[vid] && viewOwners[vid] !== p.id) {
      log('warn', '视图 ' + vid + ' 已被 ' + viewOwners[vid] + ' 注册，跳过 ' + p.id);
      return;
    }
    viewRegistry[vid] = view;
    viewOwners[vid] = p.id;
    if (view.title) {
      root.XN_VIEW_TITLES = root.XN_VIEW_TITLES || {};
      root.XN_VIEW_TITLES[vid] = view.title;
    }
    /* 兼容：老代码还在读 XN.views */
    XN.views = XN.views || {};
    XN.views[vid] = view;
  }

  function unregisterView(p) {
    Object.keys(viewOwners).forEach(function (vid) {
      if (viewOwners[vid] !== p.id) return;
      delete viewRegistry[vid];
      delete viewOwners[vid];
      if (XN.views) delete XN.views[vid];
    });
  }

  /* ---------- 生命周期 ---------- */
  function mount(p) {
    if (!p || !p.id) return false;
    if (mounted[p.id]) return true;
    if (!isEnabled(p)) { emit('plugin:skip', { id: p.id, reason: 'disabled' }); return false; }
    var miss = missingRequires(p);
    if (miss.length) {
      log('warn', p.id + ' 缺少依赖：' + miss.join(', '));
      emit('plugin:skip', { id: p.id, reason: 'missing-requires', missing: miss });
      return false;
    }
    try {
      if (p.view) registerView(p, p.view);
      if (typeof p.mount === 'function') p.mount(makeCtx(p));
      mounted[p.id] = true;
      emit('plugin:mounted', { id: p.id });
      return true;
    } catch (e) {
      log('error', p.id + ' 挂载失败：' + (e && e.message), e);
      toast((p.name || p.id) + ' 没挂上：' + (e && e.message), 'error');
      emit('plugin:error', { id: p.id, phase: 'mount', error: String(e && e.message) });
      return false;
    }
  }

  function unmount(p) {
    if (!p || !mounted[p.id]) return false;
    try {
      if (typeof p.unmount === 'function') p.unmount(makeCtx(p));
    } catch (e) {
      log('error', p.id + ' 卸载钩子报错：' + (e && e.message), e);
    }
    (disposers[p.id] || []).forEach(function (fn) {
      try { fn(); } catch (e) { log('warn', p.id + ' 清理失败', e); }
    });
    disposers[p.id] = [];
    if (p.view) unregisterView(p);
    delete mounted[p.id];
    emit('plugin:unmounted', { id: p.id });
    return true;
  }

  function register(p) {
    if (!p || !p.id) throw new Error('插件必须有 id');
    var exist = plugins.filter(function (x) { return x.id === p.id; })[0];
    if (exist) { log('warn', '重复注册，忽略：' + p.id); return exist; }
    plugins.push(p);
    if (XN.state && XN.state.cfg) mount(p);
    else emit('plugin:registered', { id: p.id });
    return p;
  }

  function boot() {
    (root.XN_PLUGINS || []).forEach(function (p) {
      if (!plugins.some(function (x) { return x.id === p.id; })) plugins.push(p);
    });
    plugins.slice().forEach(mount);
  }

  function setEnabled(id, on) {
    var p = plugins.filter(function (x) { return x.id === id; })[0];
    if (!p) return false;
    enabledMap()[id] = !!on;
    if (on) mount(p); else unmount(p);
    if (XN.saveConfig) { try { XN.saveConfig(); } catch (e) {} }
    emit('plugins:change', { id: id, enabled: !!on });
    return true;
  }

  /* ---------- 视图查询（宿主给路由用） ---------- */
  function view(id) { return viewRegistry[id] || null; }

  function views() {
    return Object.keys(viewRegistry).map(function (vid) {
      var owner = plugins.filter(function (p) { return p.id === viewOwners[vid]; })[0] || {};
      return { id: vid, title: (owner.view && owner.view.title) || owner.name || (root.XN_VIEW_TITLES || {})[vid] || vid, plugin: owner.id };
    });
  }

  function list() {
    return plugins.map(function (p) {
      return {
        id: p.id,
        name: p.name || p.id,
        version: p.version || '',
        description: p.description || '',
        enabled: isEnabled(p),
        mounted: !!mounted[p.id],
        view: !!(p.view && viewOwners[p.view.id || p.id.replace(/^view-/, '')])
      };
    });
  }

  XN.plugin = {
    version: 2,
    register: register,
    boot: boot,
    mount: function (id) {
      var p = plugins.filter(function (x) { return x.id === id; })[0];
      return p ? mount(p) : false;
    },
    unmount: function (id) {
      var p = plugins.filter(function (x) { return x.id === id; })[0];
      return p ? unmount(p) : false;
    },
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    view: view,
    views: views,
    mounted: function () { return Object.keys(mounted); },
    list: list,
    cards: function () { return (XN.state && XN.state.__pluginCards) || []; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
