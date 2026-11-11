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
 *
 * P4 安装式扩展（本文件新增；设置页 / 启动流程由 app.core 与 views.* 接入）：
 *   XN.plugin.loadManifest(url?)        远程 fetch 或本地 window.XN_PLUGIN_MANIFEST，
 *                                       校验后对 enabled !== false 且未注册的插件 install(url)；
 *                                       返回 { ok, loaded, skipped, errors, pending }（永不 reject）
 *   XN.plugin.pin(id, { version, url }) 锁版本：写记录 + 历史，之后 loadManifest 不跟随清单
 *   XN.plugin.rollback(id)              回滚到上一个 status === 'ok' 的历史记录
 *   XN.plugin.status(id)                { enabled, mounted, version, pinned, history, ... }
 *   XN.plugin.pendingUpdates()          清单里有新版本但没热替换的插件（id -> { version, url, from }）
 *
 * 记录持久化在 XN.state.cfg.pluginManifests：
 *   { [id]: { version, url, installedAt, status: 'ok'|'failed', pinned?, lastError?,
 *             history: [{ version, url, installedAt, status }, ...] } }   history 新的在前，最多 5 条
 *
 * 版本策略：不热替换。装上就装上；清单里版本不同只记 pendingUpdate。
 * pin/rollback 改的是「下次加载用哪个 url/version」的记录，下次 boot / loadManifest 生效。
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
  var installedUrls = {};    /* P4: url -> true，同一个脚本地址只注入一次 */
  var pendingUpdates = {};   /* P4: id -> { version, url, from }，清单里有新版本但没热替换 */

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

  function configMap(pluginId) {
    var cfg = (XN.state && XN.state.cfg) || {};
    if (!cfg.pluginConfig || typeof cfg.pluginConfig !== 'object') cfg.pluginConfig = {};
    if (!cfg.pluginConfig[pluginId] || typeof cfg.pluginConfig[pluginId] !== 'object') cfg.pluginConfig[pluginId] = {};
    return cfg.pluginConfig[pluginId];
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
      /* 声明式设置：插件按 key 读写自己的配置，宿主负责持久化 */
      config: function (key, fallback) {
        var m = configMap(p.id);
        return m[key] === undefined ? fallback : m[key];
      },
      setConfig: function (key, value) {
        configMap(p.id)[key] = value;
        if (XN.saveConfig) { try { XN.saveConfig(); } catch (e) {} }
        emit('plugin:config', { id: p.id, key: key, value: value });
        return value;
      },
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
      var why = (e && e.message) || String(e);
      log('error', p.id + ' 挂载失败：' + why, e);
      /* P4：如果这个插件有安装记录，把该条记成 failed，并提示能不能回滚 */
      var back = markMountFailed(p.id, e);
      toast((p.name || p.id) + ' 没挂上：' + why +
        (back ? '（可用 XN.plugin.rollback(\'' + p.id + '\') 回到 v' + (back.version || '?') + '）' : ''), 'error');
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

  /* 安装式加载（P4）：给一个 URL，注入脚本，插件文件自己 register */
  function items() {
    var out = {};
    plugins.forEach(function (x) { out[x.id] = x; });
    return out;
  }

  /* 智能安装：先按 ESM/DSH 方式试（能跑 apply(ctx) 的插件），
     再判断有没有插件自己 register 上来（经典脚本也可以被 import 执行），
     最后才退回经典 <script> 注入。 */
  /* 插件地址策略（代码级防线）：
     - 只允许 http(s)
     - 默认只允许同源；跨源必须在 cfg.pluginTrustedHosts 里显式信任
     为什么必须做：CSP script-src 'self' 能挡跨源脚本，但静态托管（GitHub Pages）
     没有 CSP 头，同一条链路就完全不设防。 */
  function resolvePluginUrl(url) {
    var loc = root.location || {};
    var base = loc.href || 'http://localhost/';
    var u;
    try { u = new URL(String(url || ''), base); } catch (e) { throw new Error('插件地址不合法'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('插件地址只支持 http(s)，拒绝 ' + u.protocol);
    }
    var sameOrigin = loc.origin ? u.origin === loc.origin : true;
    if (!sameOrigin) {
      var trusted = (XN.state && XN.state.cfg && Array.isArray(XN.state.cfg.pluginTrustedHosts))
        ? XN.state.cfg.pluginTrustedHosts : [];
      if (trusted.indexOf(u.host) < 0) {
        throw new Error('跨源插件需要先信任域名：' + u.host + '（设置里加 pluginTrustedHosts）');
      }
    }
    return u.href;
  }

  function installAuto(url, opts) {
    url = resolvePluginUrl(url);
    var snapshot = plugins.length;
    var esm = (root.XN && XN.dsh && typeof XN.dsh.load === 'function')
      ? XN.dsh.load(url, opts).catch(function () { return { ok: false }; })
      : Promise.resolve({ ok: false });
    return esm.then(function (r) {
      if (r && r.ok) return { ok: true, mode: 'esm' };
      if (plugins.length > snapshot) return { ok: true, mode: 'esm-registered' };
      return install(url).then(function () { return { ok: true, mode: 'classic' }; });
    });
  }

  function install(url) {
    return new Promise(function (resolve, reject) {
      if (!url) return reject(new Error('install 需要一个脚本地址'));
      /* 同一个地址只注入一次：脚本重复注入会重复 push XN_PLUGINS / 重复 register（虽然后者被忽略） */
      if (installedUrls[url]) return resolve({ ok: true, url: url, cached: true, plugins: Object.keys(mounted) });
      var doc = root.document;
      if (!doc) return reject(new Error('没有 document'));
      var s = doc.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () {
        installedUrls[url] = true;
        resolve({ ok: true, url: url, plugins: Object.keys(mounted) });
      };
      s.onerror = function () { reject(new Error('加载失败：' + url)); };
      doc.head.appendChild(s);
    });
  }

  /* ================= P4：清单 / 版本锁定 / 回滚 ================= */

  function findPlugin(id) {
    for (var i = 0; i < plugins.length; i++) if (plugins[i].id === id) return plugins[i];
    return null;
  }

  /* 已经静态加载（index.html 里直接 <script src>）的插件：在 XN_PLUGINS 里但可能还没 boot */
  function findListed(id) {
    var listed = root.XN_PLUGINS || [];
    for (var i = 0; i < listed.length; i++) if (listed[i] && listed[i].id === id) return listed[i];
    return null;
  }

  function manifestRecords() {
    var cfg = (XN.state && XN.state.cfg) || {};
    if (!cfg.pluginManifests || typeof cfg.pluginManifests !== 'object' || Array.isArray(cfg.pluginManifests)) {
      cfg.pluginManifests = {};
    }
    return cfg.pluginManifests;
  }

  function persist() {
    if (XN.saveConfig) { try { XN.saveConfig(); } catch (e) {} }
  }

  function pickRecord(rec) {
    return {
      version: String((rec && rec.version) || ''),
      url: String((rec && rec.url) || ''),
      installedAt: (rec && rec.installedAt) || 0,
      status: rec && rec.status === 'failed' ? 'failed' : 'ok'
    };
  }

  /* 历史数组：新的在前，最多 5 条（rollback 从里面挑最近的 ok） */
  function pushHistory(rec, entry) {
    if (!entry || (!entry.version && !entry.url)) return;
    rec.history = Array.isArray(rec.history) ? rec.history : [];
    var top = rec.history[0];
    if (top && top.version === entry.version && top.url === entry.url && top.status === entry.status) return;
    rec.history.unshift(pickRecord(entry));
    if (rec.history.length > 5) rec.history = rec.history.slice(0, 5);
  }

  function firstOkHistory(rec) {
    if (!rec || !Array.isArray(rec.history)) return null;
    for (var i = 0; i < rec.history.length; i++) {
      if (rec.history[i] && rec.history[i].status === 'ok') return rec.history[i];
    }
    return null;
  }

  function rollbackHint(id) {
    var prev = firstOkHistory(manifestRecords()[id]);
    if (!prev) return '';
    return '（可用 XN.plugin.rollback(\'' + id + '\') 回到 v' + (prev.version || '?') + '）';
  }

  function emitManifest(id, rec) {
    emit('plugin:manifest', { id: id, status: (rec && rec.status) || 'ok', version: (rec && rec.version) || '', url: (rec && rec.url) || '' });
  }

  /* 写 install/挂载结果：同版本只改 status，换版本才入历史 */
  function saveRecord(id, target, status, why) {
    var recs = manifestRecords();
    var rec = recs[id];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      rec = { version: '', url: '', installedAt: 0, status: 'ok', history: [] };
    }
    if (!Array.isArray(rec.history)) rec.history = [];
    var version = String((target && target.version) || '');
    var url = String((target && target.url) || '');
    if (version !== rec.version || url !== rec.url) pushHistory(rec, rec);
    rec.version = version;
    rec.url = url;
    rec.installedAt = Date.now();
    rec.status = status === 'failed' ? 'failed' : 'ok';
    if (why) rec.lastError = String(why); else delete rec.lastError;
    recs[id] = rec;
    if (rec.status === 'ok' && pendingUpdates[id] && pendingUpdates[id].version === version) delete pendingUpdates[id];
    persist();
    emitManifest(id, rec);
    return rec;
  }

  /* mount 抛错时调用：有记录的改成 failed，并把可回滚的 ok 版本返回给 toast/事件 */
  function markMountFailed(id, err) {
    var recs = manifestRecords();
    var rec = recs[id];
    var back = null;
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      var prev = firstOkHistory(rec);
      back = prev ? pickRecord(prev) : null;
      if (rec.status !== 'failed') {
        rec.status = 'failed';
        rec.lastError = String((err && err.message) || err || 'mount failed');
        recs[id] = rec;
        persist();
        emitManifest(id, rec);
      }
    }
    emit('plugin:failed', {
      id: id,
      error: String((err && err.message) || err || ''),
      fallback: back
    });
    return back;
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    var url = raw.url === undefined || raw.url === null ? '' : String(raw.url);
    if (!id || !url) return null;
    return {
      id: id,
      url: url,
      version: raw.version === undefined || raw.version === null ? '' : String(raw.version),
      enabled: raw.enabled !== false,
      description: raw.description === undefined || raw.description === null ? '' : String(raw.description)
    };
  }

  function validateManifest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '清单必须是对象';
    if (typeof data.version !== 'number' || !isFinite(data.version) || data.version <= 0) {
      return '清单缺少数值 version（清单格式版本）';
    }
    if (!Array.isArray(data.plugins)) return '清单 plugins 必须是数组';
    return '';
  }

  /* 有 url 就 fetch，没有就用本地 window.XN_PLUGIN_MANIFEST */
  function readManifest(url) {
    if (url) {
      if (typeof root.fetch !== 'function') return Promise.reject(new Error('当前环境没有 fetch，读不了远程清单'));
      return root.fetch(url).then(function (res) {
        if (!res) throw new Error('清单请求没有响应');
        if (res.ok === false) throw new Error('清单请求失败：HTTP ' + (res.status || '?'));
        if (typeof res.json !== 'function') throw new Error('清单响应不支持 json()');
        return res.json().then(function (data) { return data; }, function (e) {
          throw new Error('清单不是合法 JSON：' + ((e && e.message) || String(e)));
        });
      });
    }
    if (root.XN_PLUGIN_MANIFEST) return Promise.resolve(root.XN_PLUGIN_MANIFEST);
    return Promise.reject(new Error('没有本地清单：window.XN_PLUGIN_MANIFEST 未定义，可以传入远程清单 url'));
  }

  /* pin > 上次 ok 记录 > 清单本身；上次失败过就退回清单版本，避免一直撞坏 url */
  function pickTarget(item, rec) {
    var url = item.url;
    var version = item.version;
    if (rec && typeof rec === 'object' && rec.pinned) {
      url = rec.pinned.url || url;
      version = String(rec.pinned.version || version || '');
    } else if (rec && typeof rec === 'object' && rec.status !== 'failed' && rec.url) {
      url = rec.url;
      version = String(rec.version || version || '');
    }
    return { version: String(version || ''), url: String(url || '') };
  }

  function notePending(item, have) {
    pendingUpdates[item.id] = { version: item.version, url: item.url, from: String(have || '') };
    emit('plugin:pending-update', { id: item.id, version: item.version, from: String(have || ''), url: item.url });
  }

  function applyEntry(item, result) {
    var id = item.id;
    var rec = manifestRecords()[id] || null;

    if (item.enabled === false) {
      result.skipped.push(id);
      return Promise.resolve();
    }

    /* 已注册：只比版本，绝不热替换 */
    var p = findPlugin(id);
    if (p) {
      if (rec && rec.pinned) { result.skipped.push(id); return Promise.resolve(); }
      var have = String(p.version || '');
      if (item.version && item.version !== have) {
        notePending(item, have);
        result.pending.push(id);
      } else {
        result.skipped.push(id);
      }
      return Promise.resolve();
    }

    /* 静态已加载但还没 register：不要重复注入脚本 */
    var listed = findListed(id);
    if (listed) {
      var lhave = String(listed.version || '');
      if (item.version && item.version !== lhave) {
        notePending(item, lhave);
        result.pending.push(id);
      } else {
        result.skipped.push(id);
      }
      return Promise.resolve();
    }

    var target = pickTarget(item, rec);
    return install(target.url).then(function () {
      var reg = findPlugin(id);
      if (!reg) {
        var noReg = '脚本已注入但没有注册 ' + id;
        saveRecord(id, target, 'failed', noReg);
        result.errors.push({ id: id, reason: noReg + rollbackHint(id) });
        return;
      }
      var miss = missingRequires(reg);
      /* 版本以脚本自己声明的为准（清单写错时下次 loadManifest 还能发现 pendingUpdate） */
      var settled = { version: String(reg.version || target.version || ''), url: target.url };
      if (!isEnabled(reg) || miss.length) {
        saveRecord(id, settled, 'ok');
        result.loaded.push(id);
        return;
      }
      /* 宿主还没 boot（没有 XN.state.cfg）时 register 本来就不挂载，不能算挂载失败 */
      if (XN.state && XN.state.cfg && !mounted[id]) {
        var why = '插件 ' + id + ' 注入后挂载失败';
        saveRecord(id, settled, 'failed', why);
        result.errors.push({ id: id, reason: why + rollbackHint(id) });
        return;
      }
      saveRecord(id, settled, 'ok');
      result.loaded.push(id);
    }, function (err) {
      var msg = (err && err.message) || String(err);
      saveRecord(id, target, 'failed', msg);
      result.errors.push({ id: id, reason: '注入失败：' + msg + rollbackHint(id) });
    });
  }

  /* 读清单 → 校验 → 逐个安装/记账。永不 reject，失败都在返回值里 */
  function loadManifest(url) {
    var result = { ok: false, loaded: [], skipped: [], errors: [], pending: [] };
    var onRead = function (data) {
      var bad = validateManifest(data);
      if (bad) {
        result.errors.push({ id: '(清单)', reason: bad });
        return result;
      }
      result.ok = true;
      var chain = Promise.resolve();
      (data.plugins || []).forEach(function (raw) {
        var item = normalizeEntry(raw);
        if (!item) {
          result.errors.push({
            id: (raw && raw.id) ? String(raw.id) : '(未命名)',
            reason: '清单项缺少 id 或 url'
          });
          return;
        }
        chain = chain.then(function () { return applyEntry(item, result); });
      });
      return chain.then(function () { return result; });
    };
    var onReadErr = function (err) {
      result.errors.push({ id: '(清单)', reason: '读取清单失败：' + ((err && err.message) || String(err)) });
      return result;
    };
    return readManifest(url).then(onRead, onReadErr).then(function (r) { return r; }, function (err) {
      result.ok = false;
      result.errors.push({ id: '(清单)', reason: '清单处理出错：' + ((err && err.message) || String(err)) });
      return result;
    });
  }

  function pin(id, opts) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'pin 需要插件 id' };
    opts = opts || {};
    var version = opts.version === undefined || opts.version === null ? '' : String(opts.version);
    var url = opts.url === undefined || opts.url === null ? '' : String(opts.url);
    var recs = manifestRecords();
    var rec = recs[id];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      rec = { version: '', url: '', installedAt: 0, status: 'ok', history: [] };
    }
    if (!Array.isArray(rec.history)) rec.history = [];
    if (!version) {
      var p = findPlugin(id);
      version = String(rec.version || (p && p.version) || '');
    }
    if (!url) url = String(rec.url || '');
    if (!version && !url) return { ok: false, reason: 'pin 需要 version 或 url' };
    if ((rec.version || rec.url) && (rec.version !== version || rec.url !== url)) pushHistory(rec, rec);
    rec.version = version;
    rec.url = url;
    rec.installedAt = Date.now();
    if (rec.status !== 'failed') rec.status = 'ok';
    rec.pinned = { version: version, url: url, at: Date.now() };
    recs[id] = rec;
    if (pendingUpdates[id]) delete pendingUpdates[id];
    persist();
    emit('plugin:pin', { id: id, version: version, url: url });
    emitManifest(id, rec);
    return { ok: true, id: id, version: version, url: url };
  }

  function rollback(id) {
    var recs = manifestRecords();
    var rec = recs[id];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      return { ok: false, reason: '没有 ' + id + ' 的安装记录' };
    }
    var target = firstOkHistory(rec);
    if (!target) return { ok: false, reason: '没有可回滚的 ok 版本' };
    var prev = pickRecord(rec);
    if (prev.version !== target.version || prev.url !== target.url) pushHistory(rec, prev);
    rec.version = String(target.version || '');
    rec.url = String(target.url || '');
    rec.installedAt = Date.now();
    rec.status = 'ok';
    delete rec.pinned;   /* 显式回滚 = 不再锁新版本 */
    delete rec.lastError;
    recs[id] = rec;
    persist();
    emit('plugin:rollback', { id: id, version: rec.version, url: rec.url });
    emitManifest(id, rec);
    return { ok: true, id: id, version: rec.version, url: rec.url };
  }

  function status(id) {
    var rec = manifestRecords()[id] || null;
    var p = findPlugin(id);
    var history = [];
    if (rec && Array.isArray(rec.history)) {
      history = rec.history.map(function (h) { return pickRecord(h); });
    }
    var prev = firstOkHistory(rec);
    return {
      id: id,
      enabled: p ? isEnabled(p) : false,
      mounted: !!mounted[id],
      version: String((rec && rec.version) || (p && p.version) || ''),
      loadedVersion: String((p && p.version) || ''),
      url: String((rec && rec.url) || ''),
      status: rec ? (rec.status === 'failed' ? 'failed' : 'ok') : (p ? 'ok' : 'unknown'),
      pinned: rec && rec.pinned
        ? { version: String(rec.pinned.version || ''), url: String(rec.pinned.url || '') }
        : null,
      history: history,
      canRollback: !!prev,
      rollbackVersion: prev ? String(prev.version || '') : '',
      pendingUpdate: pendingUpdates[id] ? {
        version: String(pendingUpdates[id].version || ''),
        url: String(pendingUpdates[id].url || ''),
        from: String(pendingUpdates[id].from || '')
      } : null
    };
  }

  function pendingUpdateMap() {
    var out = {};
    Object.keys(pendingUpdates).forEach(function (k) { out[k] = pendingUpdates[k]; });
    return out;
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
    items: items,
    setConfig: function (id, key, value) {
      configMap(id)[key] = value;
      if (XN.saveConfig) { try { XN.saveConfig(); } catch (e) {} }
      emit('plugin:config', { id: id, key: key, value: value });
      return value;
    },
    getConfig: function (id, key, fallback) {
      var m = configMap(id);
      return m[key] === undefined ? fallback : m[key];
    },
    install: install,
    installAuto: installAuto,
    resolveUrl: resolvePluginUrl,
    /* P4 安装式扩展 */
    loadManifest: loadManifest,
    pin: pin,
    rollback: rollback,
    status: status,
    pendingUpdates: pendingUpdateMap,
    manifestRecords: manifestRecords,
    rollbackAvailable: function (id) { return !!firstOkHistory(manifestRecords()[id]); },
    configMap: configMap,
    cards: function () { return (XN.state && XN.state.__pluginCards) || []; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
