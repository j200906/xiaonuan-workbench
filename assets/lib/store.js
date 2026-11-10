/* 小暖 · 本机存储
 * - 所有键统一到 xn.v2.*，旧键只读一次并迁移
 * - 坏 JSON 先备份再重置，不再静默吞掉
 * - 配额满时先剪枝再重试，并把真实原因告诉界面 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  var PREFIX = 'xn.v2.';
  var KEYS = {
    cfg: PREFIX + 'cfg',
    sessions: PREFIX + 'sessions',
    current: PREFIX + 'current',
    notes: PREFIX + 'notes',
    goals: PREFIX + 'goals',
    feedback: PREFIX + 'feedback',
    key: PREFIX + 'key',
    admin: PREFIX + 'adminToken',
    theme: PREFIX + 'theme',
    timer: PREFIX + 'timer',
    mem: PREFIX + 'mem',
    memBuffer: PREFIX + 'memBuffer',
    view: PREFIX + 'view',
    gist: PREFIX + 'gist'
  };

  /* 旧版本用过的键。只读，不再写。 */
  var LEGACY = {
    cfg: ['xn.cfg.v1'],
    sessions: ['xn.sessions.v1'],
    current: ['xn.current.v1'],
    notes: ['xn.notes.v1'],
    goals: ['xn.goals.v1'],
    feedback: ['xn.fb.v1'],
    key: ['xn.key.v1'],
    admin: ['xn.admin'],
    theme: ['xn.theme.local'],
    timer: ['xn.timer.v1'],
    mem: ['xn.mem.v2', 'xn.mem.v1'],
    view: ['xn.view']
  };

  var issues = [];
  var pruneHook = null;

  function noteIssue(kind, detail) {
    var issue = { kind: kind, detail: String(detail || ''), at: Date.now() };
    issues.push(issue);
    if (issues.length > 50) issues.shift();
    if (XN.emit) XN.emit('storage:issue', issue);
  }

  function rawGet(key, area) {
    try { return (area || root.localStorage).getItem(key); } catch (e) { return null; }
  }
  function rawSet(key, value, area) {
    (area || root.localStorage).setItem(key, value);
  }

  function backupBad(key, raw) {
    try {
      var name = 'xn.bad.' + Date.now() + '.' + key.replace(/[^\w.-]/g, '_');
      root.localStorage.setItem(name, String(raw).slice(0, 20000));
      /* 只留最近 3 份，别让坏数据把配额吃光 */
      var bad = [];
      for (var i = 0; i < root.localStorage.length; i++) {
        var k = root.localStorage.key(i);
        if (k && k.indexOf('xn.bad.') === 0) bad.push(k);
      }
      bad.sort();
      while (bad.length > 3) root.localStorage.removeItem(bad.shift());
    } catch (e) { /* 备份失败也不能挡住主流程 */ }
  }

  function parse(raw, key, fallback) {
    if (raw == null || raw === '') return fallback;
    try {
      var val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch (e) {
      backupBad(key, raw);
      noteIssue('bad-json', key + ' 内容损坏，已备份并重置');
      try { root.localStorage.removeItem(key); } catch (e2) {}
      return fallback;
    }
  }

  function get(key, fallback) {
    var raw = rawGet(key);
    if (raw != null) return parse(raw, key, fallback);
    return fallback;
  }

  function set(key, value) {
    var text;
    try { text = JSON.stringify(value); }
    catch (e) { noteIssue('serialize', key + ' 无法序列化'); return false; }

    try {
      rawSet(key, text);
      return true;
    } catch (e) {
      var quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      noteIssue(quota ? 'quota' : 'write', key + ' 写入失败：' + ((e && e.message) || e));
      if (!quota) return false;
    }

    /* 配额满：调用方注册的剪枝函数先腾地方，只重试一次 */
    if (typeof pruneHook === 'function') {
      try { pruneHook(); } catch (e) { noteIssue('prune', e && e.message); }
    }
    try {
      rawSet(key, text);
      noteIssue('quota-recovered', key + ' 剪枝后写入成功');
      return true;
    } catch (e2) {
      noteIssue('quota-fatal', key + ' 剪枝后仍写不进去');
      return false;
    }
  }

  function remove(key) {
    try { root.localStorage.removeItem(key); } catch (e) {}
  }

  /* 旧键迁移：新键没有、旧键有时才搬；成功后删旧键，避免两边打架。 */
  function migrate() {
    var moved = [];
    Object.keys(LEGACY).forEach(function (name) {
      var key = KEYS[name];
      if (!key) return;
      if (rawGet(key) != null) return;
      for (var i = 0; i < LEGACY[name].length; i++) {
        var old = LEGACY[name][i];
        var raw = rawGet(old);
        if (raw == null) continue;
        try {
          rawSet(key, raw);
          root.localStorage.removeItem(old);
          moved.push(old + ' -> ' + key);
        } catch (e) {
          noteIssue('migrate', old + ' 迁移失败：' + (e && e.message));
        }
        break;
      }
    });
    if (moved.length && root.console && root.console.info) root.console.info('[xn] 已迁移本机数据', moved);
    return moved;
  }

  function usage() {
    var total = 0;
    var rows = [];
    try {
      for (var i = 0; i < root.localStorage.length; i++) {
        var k = root.localStorage.key(i);
        if (!k || k.indexOf('xn.') !== 0) continue;
        var len = (root.localStorage.getItem(k) || '').length;
        var cost = len * 2;
        total += cost;
        rows.push({ key: k, bytes: cost });
      }
    } catch (e) { /* 隐私模式下拿不到 */ }
    rows.sort(function (a, b) { return b.bytes - a.bytes; });
    return { bytes: total, rows: rows };
  }

  function onPrune(fn) { pruneHook = fn; }

  function sessionGet(key, fallback) {
    try {
      var raw = root.sessionStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function sessionSet(key, value) {
    try { root.sessionStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function sessionRemove(key) {
    try { root.sessionStorage.removeItem(key); } catch (e) {}
  }

  XN.KEYS = KEYS;
  XN.store = {
    KEYS: KEYS,
    LEGACY: LEGACY,
    get: get,
    set: set,
    remove: remove,
    migrate: migrate,
    usage: usage,
    onPrune: onPrune,
    issues: function () { return issues.slice(); },
    sessionGet: sessionGet,
    sessionSet: sessionSet,
    sessionRemove: sessionRemove,
    /* 兼容旧 API */
    readJSON: get,
    writeJSON: set
  };

  XN.readJSON = get;
  XN.writeJSON = set;
})(typeof window !== 'undefined' ? window : globalThis);
