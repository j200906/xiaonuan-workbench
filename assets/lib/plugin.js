/* 小暖 · 最小插件运行时
 *
 * 借 DSH（cordis）的思路：能力不是写死在核心里，而是「一行一行挂上去的」。
 * 差别只是形态——DSH 用 YAML 行 + npm 包，小暖用 JS 清单 + 一个 register()。
 *
 * 一个插件就是一个对象：
 * {
 *   id: 'export-session',        // 唯一
 *   name: '导出会话',
 *   version: '1.0.0',
 *   description: '把当前会话导出成 Markdown',
 *   defaultEnabled: true,
 *   mount(ctx) { ... },          // 挂载：注册 UI / 工具 / 设置项
 *   unmount(ctx) { ... }         // 可选：卸载时清理
 * }
 *
 * ctx 提供：XN、root、toast()、onDispose(fn)、addSettingsCard({title, render})
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var plugins = [];
  var mounted = {};
  var disposers = {};

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

  function toast(msg, kind) {
    if (XN.toast) XN.toast(msg, kind);
    else console.log('[plugin]', msg);
  }

  function makeCtx(p) {
    var disposersOfPlugin = disposers[p.id] = [];
    return {
      XN: XN,
      root: root,
      id: p.id,
      toast: toast,
      onDispose: function (fn) { if (typeof fn === 'function') disposersOfPlugin.push(fn); },
      addSettingsCard: function (card) {
        (XN.state.__pluginCards = XN.state.__pluginCards || []).push({
          pluginId: p.id,
          title: card.title || p.name,
          render: card.render
        });
      }
    };
  }

  function mount(p) {
    if (!p || !p.id || mounted[p.id]) return;
    if (!isEnabled(p)) return;
    try {
      if (typeof p.mount === 'function') p.mount(makeCtx(p));
      mounted[p.id] = true;
    } catch (e) {
      console.error('[xn] plugin mount failed: ' + p.id, e);
      toast(p.name + ' 没挂上：' + e.message, 'error');
    }
  }

  function unmount(p) {
    if (!mounted[p.id]) return;
    try {
      if (typeof p.unmount === 'function') p.unmount(makeCtx(p));
      (disposers[p.id] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
    } catch (e) {
      console.error('[xn] plugin unmount failed: ' + p.id, e);
    }
    mounted[p.id] = false;
    delete mounted[p.id];
  }

  function register(p) {
    if (!p || !p.id) throw new Error('插件必须有 id');
    if (plugins.some(function (x) { return x.id === p.id; })) return;
    plugins.push(p);
    if (XN.state && XN.state.cfg != null) mount(p); /* 运行时注册：配置已就绪就直接挂 */
  }

  /* 启动时把清单里的插件挂上；没有 XN.state.cfg 时延后到第一次 setEnabled 调用前 */
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
    if (XN.saveConfig) XN.saveConfig();
    if (XN.emit) XN.emit('plugins:change', id);
    return true;
  }

  XN.plugin = {
    register: register,
    boot: boot,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    mounted: function () { return Object.keys(mounted); },
    list: function () {
      return plugins.map(function (p) {
        return {
          id: p.id,
          name: p.name || p.id,
          version: p.version || '',
          description: p.description || '',
          enabled: isEnabled(p),
          mounted: !!mounted[p.id]
        };
      });
    },
    cards: function () { return XN.state.__pluginCards || []; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
