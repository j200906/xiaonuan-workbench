/* 插件中心（视图插件）
 *
 * DSH 那种「能找到插件的地方」：已装列表 + 检查更新 + 从 URL 安装 +
 * 索引源（去哪找） + 逐个的回滚/禁用。
 *
 * 它自己就是一个插件——所以能被禁用、能被替换，这一点和 DSH 一致。
 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};
  root.XN_PLUGINS = root.XN_PLUGINS || [];

  var $ = function (s, r) { return (r || root.document).querySelector(s); };
  var esc = function (s) { return (XN.esc ? XN.esc(s) : String(s)); };
  var T = function (k, v) { return XN.t ? XN.t(k, v) : k; };

  function indexSources() {
    var cfg = (XN.state && XN.state.cfg) || {};
    cfg.pluginIndexes = Array.isArray(cfg.pluginIndexes) ? cfg.pluginIndexes : [];
    return cfg.pluginIndexes;
  }

  /* 拉一个索引 JSON：{ version:1, plugins:[{id,name,version,url,description}] } */
  async function fetchIndex(url) {
    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data || !Array.isArray(data.plugins)) throw new Error(T('plugins.badIndex'));
    return data.plugins;
  }

  function statusOf(id) {
    try {
      if (XN.plugin && XN.plugin.status) return XN.plugin.status(id) || {};
    } catch (e) {}
    return {};
  }

  var view = {
    id: 'plugins',
    title: 'plugins.title',

    init: function () {},

    onShow: function () { render(); }
  };

  function card(title, body, meta) {
    return '<article class="card wide"><header class="card-head"><h2>' + esc(title) + '</h2>' +
      (meta ? '<span class="card-meta">' + esc(meta) + '</span>' : '') + '</header>' + body + '</article>';
  }

  function installedHtml() {
    var list = (XN.plugin && XN.plugin.list) ? XN.plugin.list() : [];
    if (!list.length) return '<p class="hint">' + esc(T('plugins.empty')) + '</p>';
    var html = '<div class="kv">';
    list.forEach(function (p) {
      var st = statusOf(p.id);
      var badges = [];
      if (p.version) badges.push('v' + esc(p.version));
      if (st.pinned) badges.push(esc(T('plugins.pinned')));
      if (st.pendingUpdate) badges.push(esc(T('plugins.pendingOne')));
      html += '<div class="kv-row"><span><strong>' + esc(p.name) + '</strong> ' +
        '<em>' + badges.join(' · ') + '</em>' +
        (p.description ? '<br><small class="hint">' + esc(p.description) + '</small>' : '') +
        '</span><span class="arch-btns">' +
        '<label class="switch" title="' + esc(T('plugins.enable')) + '"><input type="checkbox" data-plugin="' + esc(p.id) + '"' +
        (p.enabled ? ' checked' : '') + '><i></i></label>' +
        (st.canRollback ? '<button class="btn ghost sm" data-rollback="' + esc(p.id) + '">' + esc(T('plugins.rollback')) + '</button>' : '') +
        '</span></div>';
    });
    html += '</div>';
    return html;
  }

  function indexHtml(available) {
    if (!available.length) return '<p class="hint">' + esc(T('plugins.noIndex')) + '</p>';
    var html = '<div class="kv">';
    available.forEach(function (p) {
      var installed = (XN.plugin && XN.plugin.list ? XN.plugin.list() : []).some(function (x) { return x.id === p.id; });
      html += '<div class="kv-row"><span><strong>' + esc(p.name || p.id) + '</strong> ' +
        (p.version ? '<em>v' + esc(p.version) + '</em>' : '') +
        (p.description ? '<br><small class="hint">' + esc(p.description) + '</small>' : '') +
        '</span><span>' +
        (installed
          ? '<span class="hint">' + esc(T('plugins.installed')) + '</span>'
          : '<button class="btn sm" data-install="' + esc(p.url) + '">' + esc(T('plugins.install')) + '</button>') +
        '</span></div>';
    });
    html += '</div>';
    return html;
  }

  function render() {
    var pane = $('#view-plugins');
    if (!pane) return;
    var board = pane.querySelector('.board');
    if (!board) return;
    var sources = indexSources();

    board.innerHTML =
      '<header class="pane-head"><h1>' + esc(T('plugins.title')) + '</h1>' +
      '<p class="sub">' + esc(T('plugins.sub')) + '</p></header>' +

      card(T('plugins.installed'), installedHtml(), (XN.plugin && XN.plugin.list ? XN.plugin.list().length : 0) + ' ' + T('plugins.count')) +

      card(T('plugins.addSource'),
        '<div class="field"><span class="label">' + esc(T('plugins.sourceLabel')) + '</span>' +
        '<input id="pluginIndexUrl" type="url" placeholder="https://example.com/index.json"></div>' +
        '<div class="arch-btns"><button class="btn sm" id="pluginAddIndex">' + esc(T('plugins.add')) + '</button>' +
        '<button class="btn ghost sm" id="pluginCheck">' + esc(T('plugins.check')) + '</button></div>' +
        (sources.length ? '<div class="kv">' + sources.map(function (u) {
          return '<div class="kv-row"><span><code>' + esc(u) + '</code></span><span><button class="btn ghost sm" data-remove-index="' + esc(u) + '">' + esc(T('plugins.remove')) + '</button></span></div>';
        }).join('') + '</div>' : '<p class="hint">' + esc(T('plugins.noSource')) + '</p>')) +

      card(T('plugins.fromUrl'),
        '<div class="field"><span class="label">' + esc(T('plugins.urlLabel')) + '</span>' +
        '<input id="pluginInstallUrl" type="url" placeholder="/assets/plugins/foo.js"></div>' +
        '<div class="arch-btns"><button class="btn sm" id="pluginInstall">' + esc(T('plugins.installFromUrl')) + '</button>' +
        '<button class="btn ghost sm" id="pluginInstallDsh">' + esc(T('plugins.installDsh')) + '</button></div>' +
        '<p class="hint">' + esc(T('plugins.dshHint')) + '</p>') +

      '<div id="pluginMarket">' + card(T('plugins.available'), '<p class="hint">' + esc(T('plugins.marketHint')) + '</p>') + '</div>';

    bind(board);
    if (sources.length) refreshMarket(board, sources);
  }

  function bind(board) {
    board.querySelectorAll('input[data-plugin]').forEach(function (el) {
      el.addEventListener('change', function () {
        XN.plugin.setEnabled(el.getAttribute('data-plugin'), el.checked);
        render();
      });
    });
    board.querySelectorAll('[data-rollback]').forEach(function (el) {
      el.addEventListener('click', function () {
        var r = XN.plugin.rollback(el.getAttribute('data-rollback'));
        if (XN.toast) XN.toast(r && r.ok ? T('plugins.rolledBack', { v: r.version }) : T('plugins.rollbackFail'), r && r.ok ? 'ok' : 'error');
        render();
      });
    });
    board.querySelectorAll('[data-install]').forEach(function (el) {
      el.addEventListener('click', function () {
        el.disabled = true;
        XN.plugin.install(el.getAttribute('data-install')).then(function () {
          if (XN.toast) XN.toast(T('plugins.installedOk'), 'ok');
          render();
        }).catch(function (e) {
          el.disabled = false;
          if (XN.toast) XN.toast(T('plugins.installFail') + '：' + e.message, 'error');
        });
      });
    });
    board.querySelectorAll('[data-remove-index]').forEach(function (el) {
      el.addEventListener('click', function () {
        var u = el.getAttribute('data-remove-index');
        var list = indexSources();
        var i = list.indexOf(u);
        if (i >= 0) list.splice(i, 1);
        if (XN.saveConfig) XN.saveConfig();
        render();
      });
    });

    var add = $('#pluginAddIndex', board);
    if (add) add.addEventListener('click', function () {
      var v = String(($('#pluginIndexUrl', board) || {}).value || '').trim();
      if (!v) return;
      var list = indexSources();
      if (list.indexOf(v) < 0) list.push(v);
      if (XN.saveConfig) XN.saveConfig();
      render();
    });

    var check = $('#pluginCheck', board);
    if (check) check.addEventListener('click', function () {
      check.disabled = true;
      XN.plugin.loadManifest().then(function (r) {
        if (XN.toast) XN.toast(r && r.ok ? T('plugins.checkDone', { loaded: (r.loaded || []).length }) : T('plugins.checkFail'), r && r.ok ? 'ok' : 'error');
        render();
      }).catch(function () { check.disabled = false; });
    });

    var dsh = $('#pluginInstallDsh', board);
    if (dsh) dsh.addEventListener('click', function () {
      var v = String(($('#pluginInstallUrl', board) || {}).value || '').trim();
      if (!v) return;
      dsh.disabled = true;
      (XN.dsh && XN.dsh.load ? XN.dsh.load(v, { reload: true }) : Promise.reject(new Error('兼容层不可用'))).then(function (r) {
        if (XN.toast) XN.toast(r && r.ok ? T('plugins.installedOk') : T('plugins.installFail') + '：' + ((r && r.error) || ''), r && r.ok ? 'ok' : 'error');
        dsh.disabled = false;
        render();
      }).catch(function (e) { dsh.disabled = false; if (XN.toast) XN.toast(T('plugins.installFail') + '：' + e.message, 'error'); });
    });

    var inst = $('#pluginInstall', board);
    if (inst) inst.addEventListener('click', function () {
      var v = String(($('#pluginInstallUrl', board) || {}).value || '').trim();
      if (!v) return;
      inst.disabled = true;
      XN.plugin.install(v).then(function () {
        if (XN.toast) XN.toast(T('plugins.installedOk'), 'ok');
        render();
      }).catch(function (e) {
        inst.disabled = false;
        if (XN.toast) XN.toast(T('plugins.installFail') + '：' + e.message, 'error');
      });
    });
  }

  async function refreshMarket(board, sources) {
    var box = $('#pluginMarket', board);
    if (!box) return;
    var all = [];
    var errors = [];
    for (var i = 0; i < sources.length; i++) {
      try {
        var list = await fetchIndex(sources[i]);
        list.forEach(function (p) { if (p && p.id && p.url) all.push(p); });
      } catch (e) {
        errors.push(sources[i] + '：' + e.message);
      }
    }
    var seen = {};
    all = all.filter(function (p) { if (seen[p.id]) return false; seen[p.id] = 1; return true; });
    box.innerHTML = card(T('plugins.available'), indexHtml(all) +
      (errors.length ? '<p class="hint">' + esc(T('plugins.indexErrors')) + '：' + esc(errors.join('；')) + '</p>' : ''),
      all.length + ' ' + T('plugins.count'));
    bind(board);
  }

  root.XN_PLUGINS.push({
    id: 'view-plugins',
    name: '插件中心',
    version: '3.0.0',
    description: '浏览、安装、更新、回滚插件',
    defaultEnabled: true,
    nav: { order: 45 },
    view: view
  });
})(typeof window !== 'undefined' ? window : globalThis);
