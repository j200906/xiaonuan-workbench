/*
 * ============================================================================
 * 小暖记忆引擎 v2 —— 纯浏览器 / 零依赖 / 严格 ES5
 * ----------------------------------------------------------------------------
 * 设计意图：
 *  1) 对齐 xiaonuan_v5.8.py 的记忆双层结构：显式记忆（用户亲口说的话、设定）
 *     与隐式记忆（对话中被观察到的偏好、笔记、目标、睡眠巩固摘要）。
 *     显式记忆在召回时权重更高（×1.5），因为它更可信、更"人设关键"。
 *  2) 全部落在 localStorage 单键 xn.mem.v2 里，不依赖后端、不发网络请求；
 *     任何一步读写都包 try/catch —— 隐私模式、配额满、坏 JSON 都不能让页面崩，
 *     坏数据一律重置为空白结构（宁可遗忘，不可闪退）。
 *  3) 召回不是向量检索，而是"联想"：中文切 2-gram + 英文单词，命中越多分越高，
 *     连续命中（比如"写作风格"整段对上）额外加权，越新的记忆略微更"亮"。
 *     第一轮直接命中标 via:'direct'，第二轮用高分记忆的内容再去捞一条邻居，
 *     标 via:'linked'，模仿人脑的"顺着想起"。
 *  4) 关系值 relation 用 warmth 驱动 stage 升级，给出"刚认识/熟了/老朋友/自己人"
 *     这种人味标签，供界面和人格提示词使用。
 *  5) 睡眠巩固 consolidate：白天零碎对话先 pushBuffer 进临时缓冲（上限 80 行），
 *     调用方给一个异步 summarizeFn 把碎片压成一句摘要，摘要以 source:'consolidate'
 *     写入隐式记忆，然后清掉已经处理过的缓冲行。缓冲只存在内存里（页面刷新即清空），
 *     避免半成品对话污染长期记忆。
 *  6) 代码保持 ES5 语法（var/function），不引用 eval/new Function，只依赖
 *     window / localStorage / JSON / Date / Math，方便直接 <script> 引入。
 * ============================================================================
 */
window.XN_MEM = (function () {
  'use strict';

  var KEY = 'xn.mem.v2';
  var MAX_EXPLICIT = 120;
  var MAX_IMPLICIT = 200;
  var MAX_BUFFER = 80;
  var MAX_EXPAND = 20;
  var DAY_MS = 86400000;
  var DECAY_DAYS = 30;
  var DECAY_FLOOR = 0.5;
  var EXPLICIT_WEIGHT = 1.5;

  /* 高频虚词 / 人称代词，切 2-gram 前先当噪声丢掉 */
  var STOP_CN = '的了吗呢吧啊呀哦嗯嘛我你您他她它们是在有就都也很不这那和与或把被给对么着呢啦哈';

  var data = null;
  var buffer = [];

  /* ---------------------------- 基础工具 ---------------------------- */

  function now() {
    return new Date().getTime();
  }

  function trim(s) {
    return ('' + s).replace(/^\s+/, '').replace(/\s+$/, '');
  }

  function isList(v) {
    return !!v && typeof v === 'object' && typeof v.length === 'number';
  }

  function toStr(v) {
    return typeof v === 'string' ? v : '';
  }

  function toTs(v) {
    if (typeof v === 'number' && v > 0 && v < 1e15) {
      return v;
    }
    return now();
  }

  function mkId(prefix) {
    return prefix + now() + '-' + Math.floor(Math.random() * 1679616).toString(36);
  }

  function blank() {
    return {
      name: '',
      explicit: [],
      implicit: [],
      relation: { stage: 0, warmth: 0, interactions: 0 },
      goals: [],
      promises: []
    };
  }

  /* ---------------------------- 存取 ---------------------------- */

  function normalize(d) {
    var out = blank();
    var i;
    var it;
    var c;

    if (!d || typeof d !== 'object') {
      return out;
    }

    out.name = toStr(d.name);

    if (isList(d.explicit)) {
      for (i = 0; i < d.explicit.length && out.explicit.length < MAX_EXPLICIT; i++) {
        it = d.explicit[i];
        if (!it || typeof it !== 'object') { continue; }
        c = trim(toStr(it.content));
        if (!c) { continue; }
        out.explicit.push({
          id: toStr(it.id) || mkId('e'),
          content: c,
          ts: toTs(it.ts)
        });
      }
    }

    if (isList(d.implicit)) {
      for (i = 0; i < d.implicit.length && out.implicit.length < MAX_IMPLICIT; i++) {
        it = d.implicit[i];
        if (!it || typeof it !== 'object') { continue; }
        c = trim(toStr(it.content));
        if (!c) { continue; }
        out.implicit.push({
          id: toStr(it.id) || mkId('i'),
          content: c,
          source: toStr(it.source) || 'dialog',
          ts: toTs(it.ts)
        });
      }
    }

    if (d.relation && typeof d.relation === 'object') {
      out.relation.stage = typeof d.relation.stage === 'number' && d.relation.stage > 0 ? Math.floor(d.relation.stage) : 0;
      out.relation.warmth = typeof d.relation.warmth === 'number' && d.relation.warmth > 0 ? Math.min(d.relation.warmth, 100) : 0;
      out.relation.interactions = typeof d.relation.interactions === 'number' && d.relation.interactions > 0 ? Math.floor(d.relation.interactions) : 0;
    }

    if (isList(d.goals)) {
      for (i = 0; i < d.goals.length; i++) {
        it = d.goals[i];
        if (!it || typeof it !== 'object') { continue; }
        c = trim(toStr(it.text));
        if (!c) { continue; }
        out.goals.push({
          id: toStr(it.id) || mkId('g'),
          text: c,
          kind: toStr(it.kind) || 'short_term',
          ts: toTs(it.ts),
          done: it.done === true
        });
      }
    }

    if (isList(d.promises)) {
      for (i = 0; i < d.promises.length; i++) {
        it = d.promises[i];
        if (!it || typeof it !== 'object') { continue; }
        c = trim(toStr(it.text));
        if (!c) { continue; }
        out.promises.push({
          id: toStr(it.id) || mkId('p'),
          text: c,
          ts: toTs(it.ts),
          kept: it.kept === true
        });
      }
    }

    return out;
  }

  function readStore() {
    var raw = null;
    var obj = null;

    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      return blank();
    }

    if (!raw) {
      return blank();
    }

    try {
      obj = JSON.parse(raw);
    } catch (e) {
      /* 坏 JSON：清掉脏键，重置为空记忆 */
      try { localStorage.removeItem(KEY); } catch (e2) { /* 忽略 */ }
      return blank();
    }

    return normalize(obj);
  }

  function load() {
    if (data === null) {
      data = readStore();
    }
    return data;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(load()));
    } catch (e) {
      return false;
    }
    return true;
  }

  /* ---------------------------- 昵称 ---------------------------- */

  function name() {
    return load().name;
  }

  function setName(n) {
    var d = load();
    d.name = trim(toStr(n));
    save();
    return d.name;
  }

  /* ---------------------------- 显式记忆 ---------------------------- */

  function findExplicit(d, content) {
    var i;
    var key = ('' + content).toLowerCase();
    for (i = 0; i < d.explicit.length; i++) {
      if (('' + d.explicit[i].content).toLowerCase() === key) {
        return i;
      }
    }
    return -1;
  }

  function addExplicit(text) {
    var d = load();
    var c = trim(toStr(text));
    if (!c) {
      return false;
    }
    if (findExplicit(d, c) >= 0) {
      return false;
    }
    d.explicit.unshift({ id: mkId('e'), content: c, ts: now() });
    if (d.explicit.length > MAX_EXPLICIT) {
      d.explicit = d.explicit.slice(0, MAX_EXPLICIT);
    }
    save();
    return true;
  }

  /* ---------------------------- 遗忘 ---------------------------- */

  function contains(text, topic) {
    return ('' + text).toLowerCase().indexOf(topic) >= 0;
  }

  function forget(topic) {
    var d = load();
    var t = trim(toStr(topic)).toLowerCase();
    var removed = 0;
    var i;
    var keep = [];

    if (!t) {
      return 0;
    }

    for (i = 0; i < d.explicit.length; i++) {
      if (contains(d.explicit[i].content, t)) {
        removed++;
      } else {
        keep.push(d.explicit[i]);
      }
    }
    d.explicit = keep;

    keep = [];
    for (i = 0; i < d.implicit.length; i++) {
      if (contains(d.implicit[i].content, t)) {
        removed++;
      } else {
        keep.push(d.implicit[i]);
      }
    }
    d.implicit = keep;

    if (removed > 0) {
      save();
    }
    return removed;
  }

  /* ---------------------------- 隐式记忆 ---------------------------- */

  function addImplicit(text, source) {
    var d = load();
    var c = trim(toStr(text));
    var src = toStr(source) || 'dialog';
    if (!c) {
      return false;
    }
    if (src !== 'dialog' && src !== 'note' && src !== 'goal' && src !== 'consolidate') {
      src = 'dialog';
    }
    d.implicit.unshift({ id: mkId('i'), content: c, source: src, ts: now() });
    if (d.implicit.length > MAX_IMPLICIT) {
      d.implicit = d.implicit.slice(0, MAX_IMPLICIT);
    }
    save();
    return true;
  }

  /* ---------------------------- 分词 ---------------------------- */

  function pushBigrams(seg, seq, uniq, map) {
    var i;
    var j;
    var chars = [];
    var ch;
    var g;

    if (!seg) {
      return;
    }

    for (i = 0; i < seg.length; i++) {
      ch = seg.charAt(i);
      chars.push(STOP_CN.indexOf(ch) >= 0 ? '\u0000' : ch);
    }

    for (j = 0; j + 1 < chars.length; j++) {
      if (chars[j] === '\u0000' || chars[j + 1] === '\u0000') {
        continue;
      }
      g = chars[j] + chars[j + 1];
      seq.push(g);
      if (map[g] !== 1) {
        map[g] = 1;
        uniq.push(g);
      }
    }
  }

  /* 返回 { seq: 有序 token, uni: 去重 token, map: 查表 } */
  function tokens(text) {
    var s = ('' + (text === null || text === undefined ? '' : text)).toLowerCase();
    var seq = [];
    var uni = [];
    var map = {};
    var seg = '';
    var re = /[a-z0-9_']+/g;
    var m;
    var i;
    var ch;

    while ((m = re.exec(s)) !== null) {
      if (m[0].length >= 2 && map[m[0]] !== 1) {
        map[m[0]] = 1;
        uni.push(m[0]);
        seq.push(m[0]);
      }
    }

    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      if (ch >= '\u4e00' && ch <= '\u9fff') {
        seg += ch;
      } else if (seg) {
        pushBigrams(seg, seq, uni, map);
        seg = '';
      }
    }
    if (seg) {
      pushBigrams(seg, seq, uni, map);
    }

    return { seq: seq, uni: uni, map: map };
  }

  /* 直接命中打分：每个命中的 2-gram +1，连续片段额外加权 */
  function directScore(q, contentSeq) {
    var present = {};
    var idxOf = {};
    var i;
    var j;
    var len;
    var total = 0;

    for (i = 0; i < contentSeq.length; i++) {
      present[contentSeq[i]] = 1;
    }

    for (i = 0; i < q.uni.length; i++) {
      if (present[q.uni[i]] === 1) {
        total += 1;
      }
    }

    if (total <= 0) {
      return 0;
    }

    for (i = 0; i < q.uni.length; i++) {
      idxOf[q.uni[i]] = i + 1;
    }

    j = 0;
    while (j < contentSeq.length) {
      if (idxOf[contentSeq[j]] === undefined) {
        j++;
        continue;
      }
      len = 1;
      while (
        j + len < contentSeq.length &&
        idxOf[contentSeq[j + len]] === idxOf[contentSeq[j + len - 1]] + 1
      ) {
        len++;
      }
      if (len >= 2) {
        total += 0.5 * (len - 1);
      }
      j += len;
    }

    return total;
  }

  /* 30 天线性衰减到 0.5 倍，之后不再降低 */
  function recency(ts) {
    var age = (now() - ts) / DAY_MS;
    var f;
    if (!(age > 0)) {
      age = 0;
    }
    f = 1 - (1 - DECAY_FLOOR) * (age / DECAY_DAYS);
    if (f < DECAY_FLOOR) {
      f = DECAY_FLOOR;
    }
    if (f > 1) {
      f = 1;
    }
    return f;
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  function byScore(a, b) {
    if (b.score === a.score) {
      return b._ts - a._ts;
    }
    return b.score - a.score;
  }

  function view(item, score, source, via) {
    return {
      content: item.content,
      score: round3(score),
      source: source,
      via: via,
      _ts: item.ts
    };
  }

  /* ---------------------------- 联想召回 ---------------------------- */

  function scored(row, base, via) {
    var w = row.explicit ? EXPLICIT_WEIGHT : 1;
    var src = row.explicit ? 'explicit' : (toStr(row.it.source) || 'implicit');
    return view(row.it, base * w * recency(row.it.ts), src, via);
  }

  function activate(query, limit) {
    var d = load();
    var lim = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 6;
    var q = tokens(query);
    var pool = [];
    var hit = {};
    var seeds = {};
    var rows = [];
    var df = {};
    var seedCount = 0;
    var total = 0;
    var i;
    var k;
    var s;
    var tkz;
    var row;
    var linkHits;
    var top;
    var out = [];

    if (!q.uni.length) {
      return out;
    }

    /* 一次性切词，供打分、种子、文档频率共用 */
    for (i = 0; i < d.explicit.length; i++) {
      tkz = tokens(d.explicit[i].content);
      rows.push({ it: d.explicit[i], explicit: true, seq: tkz.seq, uni: tkz.uni });
    }
    for (i = 0; i < d.implicit.length; i++) {
      tkz = tokens(d.implicit[i].content);
      rows.push({ it: d.implicit[i], explicit: false, seq: tkz.seq, uni: tkz.uni });
    }
    total = rows.length;

    for (i = 0; i < total; i++) {
      for (k = 0; k < rows[i].uni.length; k++) {
        df[rows[i].uni[k]] = (df[rows[i].uni[k]] || 0) + 1;
      }
    }

    /* 第一轮：直接命中 */
    for (i = 0; i < total; i++) {
      row = rows[i];
      s = directScore(q, row.seq);
      if (s > 0) {
        hit['k' + row.it.content] = 1;
        pool.push(scored(row, s, 'direct'));
      }
    }

    pool.sort(byScore);

    /* 第二轮：拿最强的几条直接命中当"种子"，顺着它们捞邻居；
       出现过半记忆的 token 太泛（如"用户"），不当种子 */
    top = pool.length < 3 ? pool.length : 3;
    for (i = 0; i < top; i++) {
      tkz = tokens(pool[i].content);
      for (k = 0; k < tkz.uni.length; k++) {
        if (q.map[tkz.uni[k]] === 1 || seeds[tkz.uni[k]] === 1) { continue; }
        if (df[tkz.uni[k]] * 2 > total) { continue; }
        seeds[tkz.uni[k]] = 1;
        seedCount++;
      }
    }

    if (seedCount > 0) {
      for (i = 0; i < total; i++) {
        row = rows[i];
        if (hit['k' + row.it.content] === 1) { continue; }
        linkHits = 0;
        for (k = 0; k < row.uni.length; k++) {
          if (seeds[row.uni[k]] === 1) { linkHits++; }
        }
        if (linkHits > 0) {
          hit['k' + row.it.content] = 1;
          pool.push(scored(row, linkHits * 0.4, 'linked'));
        }
      }
    }

    pool.sort(byScore);

    for (i = 0; i < pool.length && out.length < lim; i++) {
      out.push({
        content: pool[i].content,
        score: pool[i].score,
        source: pool[i].source,
        via: pool[i].via
      });
    }

    return out;
  }

  /* ---------------------------- 注入用记忆视图 ---------------------------- */

  function sortByTsDesc(list) {
    return list.slice(0).sort(function (a, b) {
      return b.ts - a.ts;
    });
  }

  function getActiveMemories() {
    var d = load();
    var ex = sortByTsDesc(d.explicit);
    var im = sortByTsDesc(d.implicit);
    var outEx = [];
    var outIm = [];
    var i;

    for (i = 0; i < ex.length && i < MAX_EXPAND; i++) {
      outEx.push(ex[i].content);
    }
    for (i = 0; i < im.length; i++) {
      outIm.push(im[i].content);
    }

    return {
      explicit: outEx,
      implicit: outIm,
      explicit_overflow: ex.length > MAX_EXPAND ? ex.length - MAX_EXPAND : 0
    };
  }

  /* ---------------------------- 关系 ---------------------------- */

  function labelOf(stage) {
    if (stage >= 30) {
      return '自己人';
    }
    if (stage >= 10) {
      return '老朋友';
    }
    if (stage >= 3) {
      return '熟了';
    }
    return '刚认识';
  }

  function relation() {
    var r = load().relation;
    return {
      stage: r.stage,
      warmth: r.warmth,
      interactions: r.interactions,
      label: labelOf(r.stage)
    };
  }

  function touch() {
    var d = load();
    var r = d.relation;
    var next;

    r.interactions += 1;
    r.warmth = Math.min(100, Math.round((r.warmth + 0.5) * 100) / 100);

    next = Math.floor(r.warmth / 10);
    if (next > r.stage) {
      r.stage = next;
    }

    save();
    return relation();
  }

  /* ---------------------------- 目标 ---------------------------- */

  function addGoal(text, kind) {
    var d = load();
    var c = trim(toStr(text));
    var k = trim(toStr(kind)) || 'short_term';
    var goal;

    if (!c) {
      return null;
    }

    goal = { id: mkId('g'), text: c, kind: k, ts: now(), done: false };
    d.goals.unshift(goal);
    save();
    return goal;
  }

  function goals(kind) {
    var d = load();
    var k = trim(toStr(kind));
    var out = [];
    var i;

    for (i = 0; i < d.goals.length; i++) {
      if (d.goals[i].done) {
        continue;
      }
      if (k && d.goals[i].kind !== k) {
        continue;
      }
      out.push(d.goals[i]);
    }
    return out;
  }

  function closeGoal(id) {
    var d = load();
    var i;
    for (i = 0; i < d.goals.length; i++) {
      if (d.goals[i].id === id) {
        d.goals[i].done = true;
        save();
        return true;
      }
    }
    return false;
  }

  /* ---------------------------- 承诺 ---------------------------- */

  function addPromise(text) {
    var d = load();
    var c = trim(toStr(text));
    var p;

    if (!c) {
      return null;
    }

    p = { id: mkId('p'), text: c, ts: now(), kept: false };
    d.promises.unshift(p);
    save();
    return p;
  }

  function promises() {
    var d = load();
    var open = [];
    var kept = [];
    var i;

    for (i = 0; i < d.promises.length; i++) {
      if (d.promises[i].kept) {
        kept.push(d.promises[i]);
      } else {
        open.push(d.promises[i]);
      }
    }
    return open.concat(kept);
  }

  function keepPromise(id) {
    var d = load();
    var i;
    for (i = 0; i < d.promises.length; i++) {
      if (d.promises[i].id === id) {
        d.promises[i].kept = true;
        save();
        return true;
      }
    }
    return false;
  }

  /* ---------------------------- 睡眠巩固 ---------------------------- */

  function pushBuffer(line) {
    var c = trim(toStr(line));
    if (!c) {
      return false;
    }
    buffer.push(c);
    if (buffer.length > MAX_BUFFER) {
      buffer = buffer.slice(buffer.length - MAX_BUFFER);
    }
    return true;
  }

  function consolidate(dialogLines, summarizeFn) {
    var d = load();
    var lines = [];
    var pending = buffer.length;
    var i;
    var res;

    if (isList(dialogLines)) {
      for (i = 0; i < dialogLines.length; i++) {
        if (typeof dialogLines[i] === 'string' && trim(dialogLines[i])) {
          lines.push(trim(dialogLines[i]));
        }
      }
    }
    for (i = 0; i < buffer.length; i++) {
      lines.push(buffer[i]);
    }

    if (!lines.length) {
      return null;
    }
    if (typeof summarizeFn !== 'function') {
      return null;
    }

    function done(summary) {
      var s = trim(toStr(summary));
      if (s) {
        addImplicit(s, 'consolidate');
      }
      /* 只清掉本轮已处理的行，等待期间新 push 的保留 */
      buffer = buffer.slice(pending);
      return s;
    }

    function failed() {
      return '';
    }

    try {
      res = summarizeFn(lines.join('\n'));
    } catch (e) {
      return null;
    }

    if (res && typeof res.then === 'function') {
      return res.then(done, failed);
    }

    done(res);
    return true;
  }

  /* ---------------------------- 对外接口 ---------------------------- */

  return {
    load: load,
    save: save,

    name: name,
    setName: setName,

    addExplicit: addExplicit,
    forget: forget,
    addImplicit: addImplicit,

    activate: activate,
    getActiveMemories: getActiveMemories,

    relation: relation,
    touch: touch,

    addGoal: addGoal,
    goals: goals,
    closeGoal: closeGoal,

    addPromise: addPromise,
    promises: promises,
    keepPromise: keepPromise,

    pushBuffer: pushBuffer,
    consolidate: consolidate
  };
})();
