/* 小暖 · 会话层（P1 收尾）
 *
 * 把「会话数据」从 app.core 里抽出来，成为可被插件/视图共用的服务：
 * 列表、当前会话、新建、切换、删除、改名、追加消息、标题推导。
 *
 * 数据仍存在 XN.state.sessions / XN.state.currentId（不引入第二份真相），
 * 这里只提供操作与查询；持久化沿用 XN.saveState（若存在）。
 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};

  function st() { return XN.state || {}; }
  function uid() { return (XN.util && XN.util.uid) ? XN.util.uid('s') : ('s-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)); }
  function save() { if (typeof XN.saveState === 'function') { try { XN.saveState(); } catch (e) {} } }

  function list() { return (st().sessions || []).slice(); }

  function byId(id) {
    return list().filter(function (s) { return s.id === id; })[0] || null;
  }

  function current() { return byId(st().currentId); }

  /* 标题：第一条用户消息，超长截断；没有就用「对话」 */
  function title(s) {
    var msgs = (s && s.messages) || [];
    var first = msgs.filter(function (m) { return m.role === 'user' && m.content; })[0];
    var text = first ? String(first.content).replace(/\s+/g, ' ').trim() : '';
    if (!text) text = (XN.t ? XN.t('nav.chat') : '对话');
    return text.length > 22 ? text.slice(0, 21) + '…' : text;
  }

  function create(opts) {
    var o = opts || {};
    var s = { id: o.id || uid(), ts: Date.now(), messages: [] };
    var all = st().sessions = st().sessions || [];
    all.unshift(s);
    st().currentId = s.id;
    save();
    return s;
  }

  function switchTo(id) {
    if (!byId(id)) return false;
    st().currentId = id;
    save();
    return true;
  }

  function remove(id) {
    var all = st().sessions || [];
    var idx = all.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return false;
    all.splice(idx, 1);
    if (!all.length) return create() && false;
    if (st().currentId === id) st().currentId = all[0].id;
    save();
    return true;
  }

  function rename(id, text) {
    var s = byId(id);
    if (!s) return false;
    s.title = String(text || '').slice(0, 60);
    save();
    return true;
  }

  function append(msg, id) {
    var s = id ? byId(id) : current();
    if (!s) return false;
    s.messages = s.messages || [];
    s.messages.push(msg);
    s.ts = Date.now();
    save();
    return s;
  }

  function count() { return (st().sessions || []).length; }

  XN.session = {
    list: list,
    byId: byId,
    current: current,
    title: title,
    create: create,
    switchTo: switchTo,
    remove: remove,
    rename: rename,
    append: append,
    count: count,
    save: save
  };
})(typeof window !== 'undefined' ? window : globalThis);
