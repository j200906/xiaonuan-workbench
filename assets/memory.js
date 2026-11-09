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

  var KEY = 'xn.v2.mem';
  var LEGACY_KEY = 'xn.mem.v2';
  var BUF_KEY = 'xn.v2.memBuffer';
  var MAX_EXPLICIT = 120;
  var MAX_IMPLICIT = 200;
  var MAX_BUFFER = 80;
  var MAX_EXPAND = 20;
  var DAY_MS = 86400000;
  var DECAY_DAYS = 30;
  var DECAY_FLOOR = 0.5;
  var EXPLICIT_WEIGHT = 1.5;

  /* 高频虚词 / 人称代词，切 2-gram 前先当噪声丢掉。
     表太短会让"我们明天要不要一起复习"这种句子召回一堆无关记忆。 */
  var STOP_CN = '的了吗呢吧啊呀哦嗯嘛我你您他她它们是在有就都也很不这那和与或把被给对么着呢啦哈' +
    '要会能可以什怎样些个一上下来去说到得地过还又再才只更最没别让使从向于为以之其此该等' +
    '吗嘛呗咯哇唉嗨喂请谢谢再见好的行成真太非常特别超级有点稍微比较如果因为所以但是然后';

  var data = null;
  var buffer = loadBuffer();

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
      promises: [],
      seen: {},
      msgCount: 0,
      lastConsolidate: 0
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

    if (d.seen && typeof d.seen === 'object') {
      Object.keys(d.seen).slice(-200).forEach(function (k) { out.seen[k] = 1; });
    }
    out.msgCount = typeof d.msgCount === 'number' && d.msgCount > 0 ? Math.floor(d.msgCount) : 0;
    out.lastConsolidate = typeof d.lastConsolidate === 'number' && d.lastConsolidate > 0 ? d.lastConsolidate : 0;

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
      if (!raw) raw = localStorage.getItem(LEGACY_KEY);
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

  function loadBuffer() {
    try {
      var raw = localStorage.getItem(BUF_KEY);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return isList(list) ? list.filter(function (x) { return typeof x === 'string'; }).slice(-MAX_BUFFER) : [];
    } catch (e) { return []; }
  }

  function saveBuffer() {
    try { localStorage.setItem(BUF_KEY, JSON.stringify(buffer)); } catch (e) { /* 配额满就留在内存 */ }
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

  /* 只把"有信息量"的话存进隐式记忆。
     以前每条用户消息都存，200 条上限几天就被"好""在吗"占满。 */
  function meaningful(text) {
    var s = trim(toStr(text));
    if (s.length < 12) return false;
    if (/^(你好|在吗|早安|晚安|谢谢|好的|好|嗯|哦|哈哈|ok|okay|hi|hello|test)[\s!！。.？?~～]*$/i.test(s)) return false;
    return true;
  }

  function similar(a, b) {
    var x = trim(toStr(a)).toLowerCase();
    var y = trim(toStr(b)).toLowerCase();
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length > 8 && y.length > 8 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return true;
    return false;
  }

  function addImplicit(text, source) {
    var d = load();
    var c = trim(toStr(text));
    var src = toStr(source) || 'dialog';
    if (!c) {
      return false;
    }
    if (src === 'dialog' && !meaningful(c)) {
      return false;
    }
    if (src !== 'dialog' && src !== 'note' && src !== 'goal' && src !== 'consolidate') {
      src = 'dialog';
    }
    for (var i = 0; i < d.implicit.length; i++) {
      if (similar(d.implicit[i].content, c)) {
        return false;
      }
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

  /* 直接命中打分：按 IDF 加权，越少见的 2-gram 越值钱。
     以前每个命中都 +1，"我们今天要不要一起复习"里的"我们"会把噪声全捞上来。 */
  function directScore(q, contentSeq, df, total) {
    var present = {};
    var idxOf = {};
    var i;
    var j;
    var len;
    var totalScore = 0;

    for (i = 0; i < contentSeq.length; i++) {
      present[contentSeq[i]] = 1;
    }

    for (i = 0; i < q.uni.length; i++) {
      if (present[q.uni[i]] === 1) {
        var weight = 1;
        if (df && total) {
          weight = Math.log(1 + total / (1 + (df[q.uni[i]] || 0)));
          if (weight < 0.35) weight = 0.35;
        }
        totalScore += weight;
      }
    }

    if (totalScore <= 0) {
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
        totalScore += 0.5 * (len - 1);
      }
      j += len;
    }

    return totalScore;
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
    if (q.uni.length > 60) {
      q.uni = q.uni.slice(0, 60);
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

    /* 第一轮：直接命中（IDF 加权） */
    for (i = 0; i < total; i++) {
      row = rows[i];
      s = directScore(q, row.seq, df, total);
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
    if (stage >= 3) return '自己人';
    if (stage >= 2) return '老朋友';
    if (stage >= 1) return '熟了';
    return '刚认识';
  }

  /* 关系等级由"有效互动次数"驱动，而不是 warmth/10：
     以前 warmth 上限 100、stage 上限 10，10/30 两个标签永远够不到。
     现在 10 / 30 / 80 次分别升一级，全部可达。 */
  function stageOf(interactions) {
    if (interactions >= 80) return 3;
    if (interactions >= 30) return 2;
    if (interactions >= 10) return 1;
    return 0;
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

  /* id 用来去重：重试、重新生成、工具回填都不该重复计数。 */
  function touch(id) {
    var d = load();
    var r = d.relation;
    var key = id ? String(id).slice(0, 80) : '';

    if (key) {
      if (d.seen[key]) return relation();
      d.seen[key] = 1;
      var keys = Object.keys(d.seen);
      if (keys.length > 200) {
        keys.slice(0, keys.length - 200).forEach(function (k) { delete d.seen[k]; });
      }
    }

    r.interactions += 1;
    r.warmth = Math.min(100, Math.round((r.warmth + 0.8) * 100) / 100);
    r.stage = Math.max(r.stage, stageOf(r.interactions));
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
    saveBuffer();
    return true;
  }

  function consolidate(dialogLines, summarizeFn) {
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
      if (s && s.length > 6) {
        addImplicit(s, 'consolidate');
      }
      /* 只清掉本轮已处理的行，等待期间新 push 的保留 */
      buffer = buffer.slice(pending);
      saveBuffer();
      var fresh = load();
      fresh.lastConsolidate = now();
      fresh.msgCount = 0;
      save();
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

  /* 触发点：会话切换 / 页面隐藏时调用。攒够 8 条、或离上次超过 12 小时且已有 4 条，才真的总结。
     以前 consolidate 是死代码，从来没被调用过。 */
  function maybeConsolidate(summarizeFn, force) {
    var d = load();
    var age = now() - (d.lastConsolidate || 0);
    var enough = buffer.length >= (force ? 1 : 8) ||
      (buffer.length >= 4 && age > 12 * 3600000);
    if (!enough) return null;
    return consolidate([], summarizeFn);
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
    consolidate: consolidate,
    maybeConsolidate: maybeConsolidate,
    bufferSize: function () { return buffer.length; },
    meaningful: meaningful
  };
})();
