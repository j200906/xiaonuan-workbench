/* 小暖 · DSH 插件兼容层
 *
 * DSH（cordis）插件长这样：
 *   export function apply(ctx) { ctx.on('event', fn); ctx.effect(() => dispose); }
 * 或者 export default { apply(ctx) {} }
 *
 * 这里提供一个**最小可用**的 ctx 垫片，把 DSH 插件能用的几件事映射到小暖：
 *   ctx.on / ctx.emit      事件
 *   ctx.effect(fn)         副作用登记（卸载时统一清理）
 *   ctx.logger(name)       日志
 *   ctx.set / ctx.get      服务（已知名字桥接到 XN.services）
 *   ctx.command(name)      命令注册（进 XN.commands）
 *   ctx.view({ id, ... })  视图注册（桥接到插件宿主的 view）
 *   ctx.tool(spec, fn)     工具注册（进 XN.dsh.tools）
 *   ctx.config             插件配置（manifest 里传进来）
 *
 * 明确不支持的（宁可拒绝，不假装支持）：
 *   - 完整的 cordis 依赖注入容器、服务作用域、生命周期树
 *   - YAML bundle / cordis.patch.yml 的叠加语义
 *   - Node 侧能力（fs / child_process / 打包期构建）
 * 遇到这些请在插件里自己降级，而不是指望这里兜住。
 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};

  var loaded = {};      /* url -> { ok, id, error } */
  var commands = {};    /* name -> { desc, run } */
  var tools = {};       /* name -> { spec, run } */
  var seq = 0;

  function log(level, msg, extra) {
    var fn = console[level] || console.log;
    try { fn.call(console, '[dsh] ' + msg, extra || ''); } catch (e) {}
  }

  function createContext(id, config) {
    var disposers = [];
    var disposed = false;

    function onDispose(fn) { if (typeof fn === 'function') disposers.push(fn); }

    var ctx = {
      id: id,
      config: config || {},
      logger: function (name) {
        var tag = (name || id || 'plugin');
        return {
          debug: function () { log('log', tag + ' ' + Array.prototype.join.call(arguments, ' ')); },
          info: function () { log('log', tag + ' ' + Array.prototype.join.call(arguments, ' ')); },
          warn: function () { log('warn', tag + ' ' + Array.prototype.join.call(arguments, ' ')); },
          error: function () { log('error', tag + ' ' + Array.prototype.join.call(arguments, ' ')); }
        };
      },
      on: function (event, fn) {
        if (typeof XN.on !== 'function' || typeof fn !== 'function') return function () {};
        var off = XN.on(event, fn);
        var dispose = function () { if (typeof off === 'function') off(); };
        onDispose(dispose);
        return dispose;
      },
      emit: function (event, payload) { if (typeof XN.emit === 'function') XN.emit(event, payload); },
      effect: function (fn) {
        try { var d = fn(); if (typeof d === 'function') onDispose(d); }
        catch (e) { log('error', (id || '') + ' effect 失败：' + e.message); }
      },
      set: function (name, value) {
        if (XN.services && XN.services.register && /^(llm|fetch|search|storage)$/.test(name)) {
          try { XN.services.register(name, value); } catch (e) {}
          return value;
        }
        XN.dsh.shared = XN.dsh.shared || {};
        XN.dsh.shared[name] = value;
        return value;
      },
      get: function (name) {
        XN.dsh.shared = XN.dsh.shared || {};
        if (XN.dsh.shared[name] !== undefined) return XN.dsh.shared[name];
        if (XN.services && /^(llm|fetch|search|storage)$/.test(name)) return XN.services.use(name);
        return undefined;
      },
      command: function (name, desc) {
        return {
          action: function (run) {
            commands[name] = { desc: desc || '', run: run };
            return run;
          }
        };
      },
      view: function (def) {
        if (!XN.plugin || !XN.plugin.register) throw new Error('小暖的插件宿主不可用');
        var vid = (def && (def.id || def.name)) || ('dsh-' + (++seq));
        return XN.plugin.register({
          id: 'view-' + vid,
          name: (def && (def.title || def.name)) || vid,
          version: (def && def.version) || '0.0.0',
          description: (def && def.description) || '',
          view: def
        });
      },
      tool: function (spec, run) {
        if (spec && spec.name) tools[spec.name] = { spec: spec, run: run };
        return run;
      },
      dispose: function () { disposeAll(); },
      get disposed() { return disposed; }
    };

    function disposeAll() {
      if (disposed) return;
      disposed = true;
      disposers.splice(0).reverse().forEach(function (fn) {
        try { fn(); } catch (e) { log('warn', (id || '') + ' 清理失败：' + e.message); }
      });
    }

    ctx.__disposeAll = disposeAll;
    return ctx;
  }

  /* 找一个可调用的入口：apply / activate / default */
  function pickApply(mod) {
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.apply === 'function') return mod.apply;
    if (mod && typeof mod.activate === 'function') return mod.activate;
    if (mod && mod.default) {
      if (typeof mod.default === 'function') return mod.default;
      if (typeof mod.default.apply === 'function') return mod.default.apply;
    }
    return null;
  }

  /* 直接跑一个已拿到的模块对象（可测，不涉及加载） */
  function runModule(mod, opts) {
    var o = opts || {};
    var id = o.id || ('dsh-' + (++seq));
    var apply = pickApply(mod);
    if (!apply) return { ok: false, error: '没有找到 apply()/activate()/default 导出（不是 DSH 插件？）' };
    var ctx = createContext(id, o.config);
    try {
      var ret = apply(ctx);
      return Promise.resolve(ret).then(function () {
        return { ok: true, id: id, ctx: ctx };
      });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'apply 抛错：' + e.message });
    }
  }

  /* 加载一个 DSH 插件：先按 ESM import，失败再退回经典 <script> */
  async function load(url, opts) {
    var o = opts || {};
    if (!url) return { ok: false, error: '缺少插件地址' };
    if (loaded[url] && loaded[url].ok && !o.reload) return loaded[url];

    var id = o.id || ('dsh-' + url.replace(/[^A-Za-z0-9]+/g, '-').slice(-40));
    var ctx = createContext(id, o.config);
    var mod = null;

    /* 动态 import 只认完整 URL：裸相对路径会当成模块说明符直接失败 */
    var absUrl = url;
    try { absUrl = new URL(url, root.location && root.location.href ? root.location.href : 'http://localhost/').href; } catch (e) {}
    try {
      mod = await import(/* @vite-ignore */ absUrl);
    } catch (e) {
      try {
        mod = await loadClassic(url);
      } catch (e2) {
        loaded[url] = { ok: false, error: '加载失败：' + (e2.message || e.message) };
        return loaded[url];
      }
    }

    var run = await runModule(mod, { id: id, config: o.config });
    if (!run.ok) { loaded[url] = run; return loaded[url]; }
    loaded[url] = { ok: true, id: run.id, url: url, ctx: run.ctx, dispose: run.ctx.__disposeAll };
    if (typeof XN.emit === 'function') XN.emit('dsh:loaded', { url: url, id: id });
    return loaded[url];
  }

  function loadClassic(url) {
    return new Promise(function (resolve, reject) {
      var doc = root.document;
      if (!doc) return reject(new Error('没有 document'));
      var s = doc.createElement('script');
      s.src = url;
      s.async = true;
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('脚本加载超时')); } }, 8000);
      s.onload = function () { if (done) return; done = true; clearTimeout(timer); resolve(root.__DSH_LAST__ || {}); };
      s.onerror = function () { if (done) return; done = true; clearTimeout(timer); reject(new Error('脚本加载失败')); };
      doc.head.appendChild(s);
    });
  }

  function runCommand(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var c = commands[name];
    if (!c) return Promise.reject(new Error('没有命令：' + name));
    return Promise.resolve(c.run.apply(null, args));
  }

  XN.dsh = {
    version: 1,
    load: load,
    runModule: runModule,
    createContext: createContext,
    commands: function () { return Object.keys(commands).map(function (k) { return { name: k, desc: commands[k].desc }; }); },
    tools: function () { return Object.keys(tools); },
    runCommand: runCommand,
    loaded: function () { return Object.keys(loaded).map(function (u) { return Object.assign({ url: u }, { ok: loaded[u].ok, error: loaded[u].error || '' }); }); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
