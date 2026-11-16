/* 小暖 · 记忆增强层（移植自 v5.8）
 *
 * 补四件 v5.8 有、网页版没有的事：
 *   1. 衰减与重要性：旧事会淡去，重要的留住，常被提起的加分（间隔重复）
 *   2. 复活/撤回：说错「忘掉」能撤回，删掉的记忆能被恢复
 *   3. 冲突判定：新记忆和旧的矛盾时，判断该不该取代（带预算，防止反复烧模型）
 *   4. 人格特质：让 AI 自己攒出观点和习惯，且互斥（不会同时「话多」和「沉默」）
 *
 * 依赖 XN_MEM 的 load() / save()：load 返回内部对象引用，改完调 save 即可落盘。
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  var DAY = 86400000;
  var MAX_TRAITS = 15;
  var MIN_STRENGTH = 3;
  var CONFLICT_WINDOW = 5;          /* 5 小时内最多判几次冲突 */
  var CONFLICT_WINDOW_MS = 5 * 3600 * 1000;

  /* 负向情绪（和 persona 里保持一致） */
  var NEGATIVE = { sad: 1, anger: 1, anxiety: 1, lonely: 1, tired: 1 };

  /* 特质互斥对：同一个维度不该同时成立 */
  var OPPOSITE_PAIRS = [
    ['话多', '沉默'], ['主动', '被动'], ['直接', '委婉'], ['严肃', '爱开玩笑'],
    ['理性', '感性'], ['乐观', '悲观'], ['急切', '从容'], ['简洁', '啰嗦']
  ];

  function mem() { return root.XN_MEM || null; }
  function data() {
    var m = mem();
    if (!m || typeof m.load !== 'function') return null;
    return m.load();
  }
  function persist() {
    var m = mem();
    if (m && typeof m.save === 'function') m.save();
  }

  function num(v, dflt) {
    var n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }
  function toMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    var t = Date.parse(String(ts));
    return Number.isFinite(t) ? t : 0;
  }

  /* ==================== 1. 衰减与重要性 ==================== */

  /**
   * 记忆保留分数：越高越不容易淡出。
   * 公式照 v5.8：新鲜度（按重要性和天数指数衰减）× 访问次数 × 间隔重复 × 重要性权重
   */
  function retention(item, nowTs) {
    var it = item || {};
    var imp = Math.max(1, Math.min(10, num(it.importance, 6)));
    var now = nowTs || Date.now();
    var last = toMs(it.lastAccess || it.ts) || now;
    var days = Math.max((now - last) / DAY, 0);

    /* 重要的事忘得慢：8 + imp*3 天半衰 */
    var fresh = Math.pow(0.5, days / (8 + imp * 3));
    var acc = Math.max(0, num(it.accessCount, 0));

    /* 间隔重复：被反复提起的事，间隔越均匀越牢 */
    var spacing = 1;
    var stamps = Array.isArray(it.accessStamps) ? it.accessStamps.map(toMs).filter(Boolean).sort() : [];
    if (stamps.length >= 2) {
      var gaps = [];
      for (var i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / DAY);
      var avg = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length;
      spacing = 1 + 0.5 * Math.log1p(Math.max(0, avg));
    }

    var score = (1 + Math.log1p(acc)) * spacing * (0.35 + 0.65 * imp / 10) * fresh;
    if (it.source === 'explicit') score *= 2;
    return score;
  }

  /* 淡出阈值：低于这个分数就不再主动往 prompt 里塞 */
  var FADE_BELOW = 0.35;

  /**
   * 跑一遍衰减：给每条记忆算分，低于阈值的标 faded。
   * @returns {{faded:number, active:number}}
   */
  function decay(force) {
    var d = data();
    if (!d) return { faded: 0, active: 0 };
    var now = Date.now();
    var lastRun = num(d.lastDecay, 0);
    if (!force && now - lastRun < 6 * 3600 * 1000) return counts(d);

    var faded = 0;
    ['explicit', 'implicit'].forEach(function (bucket) {
      (d[bucket] || []).forEach(function (it) {
        if (!it || it.status === 'deleted') return;
        if (!it.importance) it.importance = it.source === 'explicit' ? 8 : 6;
        var s = retention(it, now);
        it.score = Math.round(s * 100) / 100;
        if (it.source !== 'explicit' && s < FADE_BELOW) {
          if (it.status !== 'faded') faded++;
          it.status = 'faded';
        } else if (it.status === 'faded') {
          it.status = 'active'; /* 又被提到了就复活 */
        }
      });
    });

    d.lastDecay = now;
    persist();
    var c = counts(d);
    c.faded = faded;
    return c;
  }

  function counts(d) {
    var out = { active: 0, faded: 0, superseded: 0, deleted: 0 };
    ['explicit', 'implicit'].forEach(function (b) {
      (d[b] || []).forEach(function (it) {
        if (!it) return;
        var s = it.status || 'active';
        if (out[s] == null) out[s] = 0;
        out[s]++;
      });
    });
    return out;
  }

  /** 记一次「被用到」：访问计数 + 时间戳（间隔重复的数据来源） */
  function touchMemory(item) {
    if (!item) return;
    item.accessCount = num(item.accessCount, 0) + 1;
    item.lastAccess = Date.now();
    item.accessStamps = (item.accessStamps || []).concat([Date.now()]).slice(-8);
    item.status = 'active';
  }

  /* ==================== 2. 复活 / 撤回遗忘 ==================== */

  var lastForget = null; /* { ids: [], ts, snapshot } */

  function snapshotForget(topic) {
    var d = data();
    if (!d) return 0;
    var key = String(topic || '').toLowerCase();
    var ids = [];
    (d.explicit || []).forEach(function (it) {
      if (it && String(it.content || '').toLowerCase().indexOf(key) >= 0) ids.push(it.id);
    });
    if (ids.length) {
      lastForget = { ids: ids, ts: Date.now(), snapshot: JSON.parse(JSON.stringify(d)) };
    }
    return ids.length;
  }

  /**
   * 撤回上一次「忘掉」。必须在 10 分钟内，否则算真的忘了。
   * @returns {number} 恢复了几条
   */
  function revive() {
    if (!lastForget || Date.now() - lastForget.ts > 10 * 60 * 1000) return 0;
    var m = mem();
    if (!m) return 0;
    var cur = data();
    var snap = lastForget.snapshot;
    var restored = 0;

    (snap.explicit || []).forEach(function (old) {
      if (lastForget.ids.indexOf(old.id) < 0) return;
      var exists = (cur.explicit || []).some(function (x) { return x.id === old.id; });
      if (!exists) {
        cur.explicit.unshift(old);
        restored++;
      }
    });
    persist();
    lastForget = null;
    return restored;
  }

  function canRevive() {
    return !!(lastForget && Date.now() - lastForget.ts <= 10 * 60 * 1000);
  }

  /* ==================== 3. 冲突判定 ==================== */

  function budgetOk(d) {
    var now = Date.now();
    var b = d.conflictBudget || { start: now, used: 0 };
    if (now - num(b.start, 0) > CONFLICT_WINDOW_MS) {
      b = { start: now, used: 0 };
      d.conflictBudget = b;
    }
    return num(b.used, 0) < CONFLICT_WINDOW;
  }

  function budgetSpend(d) {
    var b = d.conflictBudget || { start: Date.now(), used: 0 };
    b.used = num(b.used, 0) + 1;
    d.conflictBudget = b;
    persist();
  }

  /**
   * 新记忆和旧记忆矛盾时，判断该不该取代。
   * 没有可用的模型就不判，直接并存（宁可两条都在，也不要瞎删）。
   * @param {string} newContent 新内容
   * @param {function} chatFn  (messages) => Promise<string>  可选
   * @returns {Promise<{replaced:number, kept:'new'|'old'|'both'}>}
   */
  function judgeConflict(newContent, chatFn) {
    var d = data();
    if (!d) return Promise.resolve({ replaced: 0, kept: 'both' });
    var text = String(newContent || '').trim();
    if (!text) return Promise.resolve({ replaced: 0, kept: 'both' });

    /* 找可能冲突的旧条目：字符重合度高的 */
    var cands = [];
    (d.explicit || []).forEach(function (it) {
      if (!it || it.status === 'deleted') return;
      var c = String(it.content || '');
      if (c === text) return;
      var hit = 0;
      for (var i = 0; i < text.length && i < 24; i++) if (c.indexOf(text[i]) >= 0) hit++;
      if (hit >= Math.min(6, Math.floor(text.length * 0.4))) cands.push(it);
    });
    if (!cands.length) return Promise.resolve({ replaced: 0, kept: 'new' });
    if (typeof chatFn !== 'function' || !budgetOk(d)) {
      return Promise.resolve({ replaced: 0, kept: 'both' });
    }

    var prompt = [
      {
        role: 'system',
        content: '判断新说法是否取代旧记忆。只输出一个 JSON：{"verdict":"new"|"old"|"both","reason":"不超过20字"}。\n' +
          'new=新说法更可信，旧的作废；old=旧的更对，新的忽略；both=两件事不冲突或无法判断。'
      },
      {
        role: 'user',
        content: '旧记忆：\n' + cands.slice(0, 3).map(function (c, i) { return (i + 1) + '. ' + c.content; }).join('\n') +
          '\n\n新说法：' + text
      }
    ];

    budgetSpend(d);
    return Promise.resolve()
      .then(function () { return chatFn(prompt); })
      .then(function (raw) {
        var s = String(raw || '');
        var m = s.match(/\{[\s\S]*\}/);
        if (!m) return { replaced: 0, kept: 'both' };
        var j = JSON.parse(m[0]);
        if (j.verdict === 'new') {
          var n = 0;
          cands.forEach(function (c) {
            c.status = 'superseded';
            c.supersededAt = Date.now();
            n++;
          });
          persist();
          return { replaced: n, kept: 'new' };
        }
        return { replaced: 0, kept: j.verdict === 'old' ? 'old' : 'both' };
      })
      .catch(function () { return { replaced: 0, kept: 'both' }; });
  }

  /* ==================== 4. 人格特质演化 ==================== */

  function traitList() {
    var d = data();
    if (!d) return [];
    if (!Array.isArray(d.traits)) d.traits = [];
    return d.traits;
  }

  function isOpposite(a, b) {
    var x = String(a || ''), y = String(b || '');
    for (var i = 0; i < OPPOSITE_PAIRS.length; i++) {
      var p = OPPOSITE_PAIRS[i];
      if ((x.indexOf(p[0]) >= 0 && y.indexOf(p[1]) >= 0) || (x.indexOf(p[1]) >= 0 && y.indexOf(p[0]) >= 0)) return true;
    }
    return false;
  }

  /**
   * 攒一条特质。同类加分，互斥的减分；达到强度阈值才生效。
   * @returns {{added:boolean, strength:number}}
   */
  function addTrait(content) {
    var d = data();
    if (!d) return { added: false, strength: 0 };
    var text = String(content || '').trim().slice(0, 40);
    if (!text) return { added: false, strength: 0 };
    if (!Array.isArray(d.traits)) d.traits = [];

    /* 已有的：同义就加分 */
    for (var i = 0; i < d.traits.length; i++) {
      var t = d.traits[i];
      if (!t) continue;
      if (t.content === text) {
        t.strength = num(t.strength, 1) + 1;
        t.ts = Date.now();
        persist();
        return { added: false, strength: t.strength };
      }
    }

    /* 互斥的：把对方削弱，弱到 0 就删掉 */
    d.traits = d.traits.filter(function (t) {
      if (!t) return false;
      if (isOpposite(t.content, text)) {
        t.strength = num(t.strength, 1) - 2;
        return t.strength > 0;
      }
      return true;
    });

    d.traits.push({ content: text, strength: 1, ts: Date.now() });
    if (d.traits.length > MAX_TRAITS) d.traits = d.traits.slice(-MAX_TRAITS);
    persist();
    return { added: true, strength: 1 };
  }

  /** 当前生效的特质（强度够的） */
  function activeTraits() {
    return traitList()
      .filter(function (t) { return t && num(t.strength, 0) >= MIN_STRENGTH; })
      .map(function (t) { return t.content; });
  }

  /* ==================== 5. 跟进事项 ==================== */

  function followups() {
    var d = data();
    if (!d) return [];
    if (!Array.isArray(d.followups)) d.followups = [];
    return d.followups;
  }

  function addFollowup(topic, dueInHours) {
    var d = data();
    if (!d) return null;
    var text = String(topic || '').trim().slice(0, 40);
    if (!text) return null;
    if (!Array.isArray(d.followups)) d.followups = [];
    /* 同一个话题不重复排 */
    var dup = d.followups.filter(function (f) { return f && f.topic === text && !f.done; })[0];
    if (dup) return dup;

    var item = { id: 'f' + Date.now().toString(36), topic: text, due: Date.now() + (num(dueInHours, 24) * 3600 * 1000), done: false };
    d.followups.unshift(item);
    if (d.followups.length > 30) d.followups.length = 30;
    persist();
    return item;
  }

  function dueFollowups() {
    var now = Date.now();
    return followups().filter(function (f) { return f && !f.done && num(f.due, 0) <= now; });
  }

  function finishFollowup(id) {
    var d = data();
    if (!d) return false;
    var f = followups().filter(function (x) { return x && x.id === id; })[0];
    if (!f) return false;
    f.done = true;
    f.doneAt = Date.now();
    persist();
    return true;
  }

  /* ==================== 6. 主动引擎所需的状态 ==================== */

  function proactiveState() {
    var d = data();
    if (!d) return { lastAt: 0, dayKey: '', count: 0 };
    if (!d.proactive) d.proactive = { lastAt: 0, dayKey: '', count: 0 };
    return d.proactive;
  }

  function markProactive() {
    var d = data();
    if (!d) return;
    var st = proactiveState();
    var today = new Date().toISOString().slice(0, 10);
    if (st.dayKey !== today) { st.dayKey = today; st.count = 0; }
    st.lastAt = Date.now();
    st.count = num(st.count, 0) + 1;
    persist();
  }

  function proactiveCountToday() {
    var st = proactiveState();
    var today = new Date().toISOString().slice(0, 10);
    return st.dayKey === today ? num(st.count, 0) : 0;
  }

  function lastProactiveAt() {
    return num(proactiveState().lastAt, 0);
  }

  /* ==================== 7. 记忆流水（给 recall 用） ==================== */

  function history(topic) {
    var d = data();
    if (!d) return [];
    var key = String(topic || '').toLowerCase();
    var out = [];
    ['explicit', 'implicit'].forEach(function (b) {
      (d[b] || []).forEach(function (it) {
        if (!it) return;
        var c = String(it.content || '');
        if (key && c.toLowerCase().indexOf(key) < 0) return;
        out.push({
          content: c,
          status: it.status || 'active',
          from: it.ts,
          to: it.supersededAt || null,
          supersededBy: it.supersededBy || null,
          importance: num(it.importance, 6),
          score: it.score
        });
      });
    });
    return out.sort(function (a, b) { return num(b.from, 0) - num(a.from, 0); });
  }

  function stageStats() {
    var d = data();
    if (!d) return { buffer: 0, active: 0, faded: 0, superseded: 0, deleted: 0 };
    var c = counts(d);
    c.buffer = (root.XN_MEM && root.XN_MEM.bufferSize) ? root.XN_MEM.bufferSize() : 0;
    return c;
  }

  /* ==================== 导出 ==================== */
  XN.memPlus = {
    /* 衰减 */
    retention: retention,
    decay: decay,
    touchMemory: touchMemory,
    counts: counts,
    /* 复活 */
    snapshotForget: snapshotForget,
    revive: revive,
    canRevive: canRevive,
    /* 冲突 */
    judgeConflict: judgeConflict,
    /* 特质 */
    addTrait: addTrait,
    activeTraits: activeTraits,
    isOpposite: isOpposite,
    /* 跟进 */
    addFollowup: addFollowup,
    dueFollowups: dueFollowups,
    finishFollowup: finishFollowup,
    followups: followups,
    /* 主动状态 */
    markProactive: markProactive,
    proactiveCountToday: proactiveCountToday,
    lastProactiveAt: lastProactiveAt,
    /* 查询 */
    history: history,
    stageStats: stageStats,
    NEGATIVE: NEGATIVE
  };
})(typeof window !== 'undefined' ? window : globalThis);
