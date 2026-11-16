/* 小暖 · 兜底回复（移植自 v5.8 的 FALLBACK + rule_reply）
 *
 * 为什么要有：
 *   模型是会挂的——超时、限流、Key 过期、网络抖。挂的时候现在的界面只留一条红字错误，
 *   聊天直接断在那里。v5.8 的做法是：按这轮的情绪，从本地文案里挑一句接住，
 *   用户几乎感觉不到失败，还能继续聊。
 *
 * 这层不含任何网络调用，纯本地数据 + 纯函数。
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  /* 七种情绪 × 若干句。全部是「接住话」而不是「道歉」：
     用户不需要知道是模型挂了，他需要有人应一声。 */
  var FALLBACK = {
    joy: [
      '欸？发生什么好事啦，快展开说说！',
      '哇哦，这么开心，是不是偷偷吃好吃的了？'
    ],
    sad: [
      '好嘛好嘛，别难过了，抱抱你。',
      '哎哟，谁惹你啦？跟我说说，我替你骂他！'
    ],
    anger: [
      '太离谱了！这事儿换谁都得生气，不气不气哈。',
      '好啦（顺毛），别气坏了身子，不值得。'
    ],
    anxiety: [
      '别慌别慌，深呼吸。问题不大，慢慢来，我在呢。',
      '天塌下来有个高的顶着，别太焦虑啦。'
    ],
    lonely: [
      '欸？这不是还有我吗？我陪你聊天呀。',
      '孤单啦？那我给你讲个冷笑话回回血？'
    ],
    tired: [
      '我去，你要化身为化神境大能了？快去睡！',
      '好家伙，又熬夜，快去躺平，身体要紧！'
    ],
    neutral: [
      '欸？然后呢然后呢？',
      '原来如此，那你怎么想的呀？',
      '哎嘿，我在听，你接着说。'
    ]
  };

  /* 连着几次都失败还硬要回答时，别一直说同一句 */
  var LAST = { key: '', ts: 0, idx: 0 };

  function pick(emo) {
    var key = FALLBACK[emo] ? emo : 'neutral';
    var list = FALLBACK[key];
    var now = Date.now();
    var idx = 0;
    /* 同一情绪短时间内重复：换一句，别复读 */
    if (LAST.key === key && now - LAST.ts < 60000) idx = (LAST.idx + 1) % list.length;
    LAST.key = key;
    LAST.ts = now;
    LAST.idx = idx;
    return list[idx];
  }

  /**
   * 生成兜底回复。
   * @param {string} emo  情绪 id（joy/sad/anger/anxiety/lonely/tired/neutral）
   * @param {object} mem  XN_MEM（可选，用来加「最近一直不顺」这类跟进）
   * @param {object} opts { reason: 'network'|'empty'|'abort' }
   */
  function reply(emo, mem, opts) {
    opts = opts || {};
    var text = pick(emo || 'neutral');

    /* 连续负面情绪：v5.8 会补一句关心 */
    try {
      if (mem && typeof mem.negativeStreak === 'function' && mem.negativeStreak() >= 3) {
        text += ' 最近好像一直不太顺，愿意的话可以跟我说说。';
      }
    } catch (e) {}

    /* 中止（用户自己点停）不要加尾巴；真失败才说明原因 */
    if (opts.reason === 'abort') return text;
    if (opts.reason === 'network') text += '\n\n（刚才网有点抖，没接上；你要再说一遍我就能接住。）';
    else if (opts.reason === 'empty') text += '\n\n（这次模型没吐出字来，换个说法我再试试？）';
    return text;
  }

  XN.fallback = {
    table: FALLBACK,
    pick: pick,
    reply: reply
  };
})(typeof window !== 'undefined' ? window : globalThis);
