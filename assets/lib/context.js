/* 小暖 · 上下文指代消解（移植自 v5.8 的 resolve_context 系列）
 *
 * 解决什么问题：
 *   用户问「杭州天气怎么样」→ 它答了 → 用户接着问「那明天呢」。
 *   没这层的话，「明天呢」这三个字会被原样丢进搜索，搜回来一堆无关的东西，
 *   模型只能瞎猜。有这层就能还原成「杭州 明天 天气」。
 *
 * 原理（照 v5.8）：
 *   1. 认代词：它/那个/这个/该产品/刚才说的…
 *   2. 维护一个「话题栈」：把最近提到过的实体压进去
 *   3. 需要消解时，拿栈顶话题 + 本句保留的意图词/时间词拼回去
 *   4. 抽不出实体又不带代词 → 说明这话本身没信息量，标记 blocked，让上层去问
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  /* ---------- 词表（照 v5.8 原样） ---------- */
  var PRONOUN_RE = /(它们|她们|他们|它|她|他|这个|那个|这些|那些|该产品|该地|上述|上面说的|刚才说的|前面说的)/;

  var TIME_WORDS = ['今天', '明天', '后天', '昨天', '前天', '现在', '当前', '周末',
    '这周', '下周', '本周', '上午', '中午', '下午', '晚上', '今晚', '早上'];

  var INTENT_WORDS = ['天气', '气温', '温度', '预报', '实况', '下雨', '下雪', '价格', '多少钱',
    '股价', '汇率', '新闻', '消息', '地址', '电话', '营业时间', '票房',
    '比分', '赛程', '时间', '几点', '怎么样', '多少'];

  var FUNC_WORDS = ['帮我查一下', '帮我查下', '帮我看看', '帮我搜', '给我查', '查一查',
    '查一下', '查查', '查下', '查询', '帮我', '帮我查', '请问', '告诉我', '搜索', '搜一下', '看一下',
    '一下', '麻烦', '现在', '实时', '最新', '最近', '相关', '具体', '详细',
    '有没有', '是否', '是什么', '什么', '为什么', '为啥', '怎么', '如何',
    '介绍', '资料', '信息', '消息', '情况', '近况', '呢', '吗', '吧', '啊',
    '呀', '哦', '嘛', '的', '了', '得', '那', '这', '又', '还', '再',
    '未来', '三天', '两天', '一周', '小暖'];

  /* 停用字集合：由功能词/时间词/意图词拆成单字。
     用来判断「明天呢」「那个呢」这种片段其实没有信息量——不去掉的话，
     它们会被当成实体，导致「那明天呢」判断成"不需要消解"，接不上上文。 */
  var STOP_CHARS = (function () {
    var set = {};
    FUNC_WORDS.concat(TIME_WORDS).concat(INTENT_WORDS).forEach(function (w) {
      for (var i = 0; i < w.length; i++) set[w[i]] = 1;
    });
    '的了呢吗吧啊呀哦嘛那这又还再我你他她它们'.split('').forEach(function (c) { set[c] = 1; });
    return set;
  })();

  function allStop(seg) {
    for (var i = 0; i < seg.length; i++) {
      if (!STOP_CHARS[seg[i]]) return false;
    }
    return true;
  }

  var LEAD_VERB_RE = /^\s*(帮我|给我|麻烦|请)?\s*(查一查|查一下|查查|查下|查询|搜一下|搜索|看一下|看看|告诉我)/;

  /* ---------- 状态 ---------- */
  var FOCUS_MAX = 8;
  var DIALOG_MAX = 12;
  var focusStack = [];
  var dialogTail = [];
  var lastIntent = { kind: '', ts: 0 };
  var INTENT_TTL_MS = 5 * 60 * 1000; /* 5 分钟内算「还在聊这个」 */

  function clean(q) {
    var s = String(q == null ? '' : q).trim().replace(/^["'「『]+|["'」』]+$/g, '');
    s = s.replace(/\s+/g, ' ');
    return s.slice(0, 120);
  }

  function uniq(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    return out;
  }

  /* 从一句话里抽实体：引号里的、英文/数字串、中文片段 */
  function focusOf(q) {
    var s = String(q || '');
    var out = [];

    var quoted = s.match(/["“]([^"”]{2,30})["”]/g) || [];
    quoted.forEach(function (m) {
      var t = m.replace(/^["“]|["”]$/g, '');
      if (t) out.push(t);
    });

    var latin = s.match(/[A-Za-z0-9][A-Za-z0-9.\-+_ ]*[A-Za-z0-9]/g) || [];
    latin.forEach(function (t) {
      t = t.trim();
      if (t.length >= 2) out.push(t);
    });

    /* 中文片段：去掉功能词后剩下的连续汉字 */
    var zh = s.replace(/[\s\S]/g, function (c) {
      return /[\u4e00-\u9fa5]/.test(c) ? c : ' ';
    });
    zh.split(/\s+/).forEach(function (seg) {
      if (seg.length >= 2 && !allStop(seg)) out.push(seg);
    });

    return uniq(out);
  }

  /* 本句保留的时间词与意图词（「明天」「天气」这些别被丢掉） */
  function keepWords(q) {
    var s = String(q || '');
    var out = [];
    TIME_WORDS.concat(INTENT_WORDS).forEach(function (w) {
      if (s.indexOf(w) >= 0) out.push(w);
    });
    return uniq(out);
  }

  /* 城市/实体抽取：剥掉「帮我查一下」「今天」「天气」这类词，剩下第一个中文片段 */
  function extractCity(q) {
    var s = String(q || '').trim();
    s = s.replace(LEAD_VERB_RE, ' ');
    var drop = FUNC_WORDS.concat(TIME_WORDS).concat(INTENT_WORDS)
      .sort(function (a, b) { return b.length - a.length; });
    drop.forEach(function (w) { s = s.split(w).join(' '); });
    s = s.replace(new RegExp(PRONOUN_RE.source, 'g'), ' ');

    var segs = s.match(/[\u4e00-\u9fa5]{2,12}/g) || [];
    if (segs.length) return segs[0];

    var tail = s.replace(/\s+/g, ' ').trim();
    if (/^[A-Za-z\u4e00-\u9fa5][A-Za-z\u4e00-\u9fa5 ]{1,11}$/.test(tail)) return tail;
    return '';
  }

  function rememberDialog(role, text) {
    var t = String(text || '').trim();
    if (!t) return;
    dialogTail.push({ role: role, text: t.slice(0, 300) });
    if (dialogTail.length > DIALOG_MAX) dialogTail.shift();
  }

  function rememberFocus(q) {
    var fs = focusOf(q);
    for (var i = fs.length - 1; i >= 0; i--) {
      var idx = focusStack.indexOf(fs[i]);
      if (idx >= 0) focusStack.splice(idx, 1);
      focusStack.unshift(fs[i]);
    }
    if (focusStack.length > FOCUS_MAX) focusStack.length = FOCUS_MAX;
  }

  function lastTopic() {
    if (focusStack.length) return focusStack[0];
    for (var i = dialogTail.length - 1; i >= 0; i--) {
      var d = dialogTail[i];
      if (d.role !== 'user') continue;
      var fs = focusOf(d.text);
      if (fs.length) return fs[0];
      if (!PRONOUN_RE.test(d.text)) return null;
    }
    return null;
  }

  function needsResolve(q) {
    if (!q) return false;
    return PRONOUN_RE.test(q) || focusOf(q).length === 0;
  }

  /**
   * 消解一轮检索词。
   * @returns {{query:string, fallbackQuery:string, resolved:boolean, blocked:boolean}}
   *   blocked=true 表示「只有代词/虚词、上文也没有可指代的东西」——调用方应当去问用户，不要硬搜
   */
  function resolve(query, fallbackQuery) {
    var q = clean(query);
    var fb = clean(fallbackQuery);
    if (!q && !fb) return { query: '', fallbackQuery: '', resolved: false, blocked: true };

    var needQ = needsResolve(q);
    var needFb = !!fb && fb !== q && needsResolve(fb);
    if (!needQ && !needFb) return { query: q, fallbackQuery: fb, resolved: false, blocked: false };

    var topic = lastTopic();
    if (!topic) {
      var nq = needQ ? '' : q;
      var nfb = needFb ? '' : fb;
      if (!nq && !nfb) return { query: q, fallbackQuery: fb, resolved: false, blocked: true };
      return { query: nq, fallbackQuery: nfb, resolved: true, blocked: false };
    }

    function patch(orig) {
      var parts;
      if (PRONOUN_RE.test(orig)) {
        parts = [topic].concat(focusOf(orig).filter(function (x) { return x !== topic; }));
      } else {
        var own = focusOf(orig);
        parts = own.length ? own : [topic];
      }
      parts = uniq(parts.concat(keepWords(orig)));

      /* 上一句在聊天气、5 分钟内又说「明天」→ 把「天气」补回去 */
      var isWeatherIntent = lastIntent.kind === 'weather' &&
        Date.now() - lastIntent.ts < INTENT_TTL_MS &&
        /今天|明天|后天|昨天|现在|这周|下周|周末/.test(orig) &&
        !parts.some(function (p) { return /天气|气温|温度|预报/.test(p); });
      if (isWeatherIntent) parts.push('天气');

      return parts.join(' ');
    }

    return {
      query: needQ ? patch(q) : q,
      fallbackQuery: needFb ? patch(fb) : fb,
      resolved: true,
      blocked: false
    };
  }

  function markIntent(kind) {
    lastIntent = { kind: kind || '', ts: Date.now() };
  }

  function reset() {
    focusStack.length = 0;
    dialogTail.length = 0;
    lastIntent = { kind: '', ts: 0 };
  }

  XN.context = {
    PRONOUN_RE: PRONOUN_RE,
    TIME_WORDS: TIME_WORDS,
    INTENT_WORDS: INTENT_WORDS,
    focusOf: focusOf,
    extractCity: extractCity,
    keepWords: keepWords,
    rememberDialog: rememberDialog,
    rememberFocus: rememberFocus,
    lastTopic: lastTopic,
    needsResolve: needsResolve,
    resolve: resolve,
    markIntent: markIntent,
    reset: reset,
    /* 给测试用 */
    _state: function () { return { focusStack: focusStack.slice(), dialogTail: dialogTail.slice(), lastIntent: lastIntent }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
