/* 情绪判定 —— 对齐 xiaonuan_v5.8.py
 *
 * 两条路：
 *   1) 有模型可用时，让模型读一句话判情绪（和原程序 _EMO_LLM_PROMPT 一个思路）
 *   2) 模型不可用 / 失败时，退回关键词打分（persona.js 里那套词表）
 *
 * emoLLM 默认 auto：先跑关键词，只有关键词判中性或强度很低才补一次模型，
 * 并做 45 秒 / 6 次节流。设成 off / keyword 时完全不调模型。
 *
 * 输出统一为 { emo, intensity, negative, source, tip }
 */
window.XN_EMO = (function () {
  'use strict';

  var CATS = ['joy', 'sad', 'anger', 'anxiety', 'lonely', 'tired', 'neutral'];
  var LABEL = { joy: '开心', sad: '难过', anger: '生气', anxiety: '焦虑', lonely: '孤独', tired: '累', neutral: '平静' };
  var NEGATIVE = { sad: 1, anger: 1, anxiety: 1, lonely: 1, tired: 1 };

  /* 原程序的护栏：不同情绪下绝对不能说的话 */
  var GUARD = {
    joy: '别扫兴，别泼冷水。',
    sad: '严禁毒舌、严禁讲道理、严禁"想开点"。',
    anger: '别跟用户讲道理、别站到对面去，别劝"冷静"。',
    anxiety: '别列清单、别加压、别说"这有什么好焦虑的"。',
    lonely: '别轻描淡写，别用"大家都这样"敷衍。',
    tired: '吐槽一句之后必须立刻转为心疼，不能只吐槽。',
    neutral: '正常。'
  };

  var PROMPT = '你是情绪判读器。读用户这一句话，判断他此刻真实的情绪状态。\n' +
    '只输出 JSON，不要解释：\n' +
    '{"emo":"joy|sad|anger|anxiety|lonely|tired|neutral","intensity":0到1的小数,"tip":"这一轮该怎么接，不超过20字"}\n' +
    '注意：\n' +
    '- 表面说"没事"但内容在抱怨，判 sad 或 anger\n' +
    '- 只是陈述事实、问问题，判 neutral\n' +
    '- intensity 是情绪强度，随口一提给 0.2-0.4，明显难受给 0.6-0.8，崩溃给 0.9 以上';

  /* auto 模式的预算：45 秒窗口内最多问 6 次模型 */
  var EMO_WINDOW_MS = 45000;
  var EMO_MAX_CALLS = 6;
  /* 关键词已经够确定（非中性且强度达到这个值）就不问模型 */
  var KEYWORD_ENOUGH = 0.35;
  var callTimes = [];

  function fromKeyword(text) {
    if (window.XN_PERSONA && window.XN_PERSONA.detectEmotion) {
      var r = window.XN_PERSONA.detectEmotion(text);
      return {
        emo: r.emo,
        intensity: r.intensity,
        negative: !!NEGATIVE[r.emo],
        source: 'keyword',
        tip: ''
      };
    }
    return { emo: 'neutral', intensity: 0.3, negative: false, source: 'keyword', tip: '' };
  }

  function pickJson(text) {
    var s = String(text || '');
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  /* 读配置：默认 auto；off / keyword / none 一律按纯关键词处理 */
  function emoMode() {
    var st = window.XN && window.XN.state;
    var cfg = (st && st.cfg) || {};
    var tutor = cfg.tutor || {};
    var v = tutor.emoLLM == null ? 'auto' : String(tutor.emoLLM).toLowerCase();
    if (v === 'off' || v === 'keyword' || v === 'none') return 'keyword';
    return 'auto';
  }

  /* 滑动窗口节流：拿不到名额就不调模型，直接用关键词结果 */
  function takeSlot() {
    var t = Date.now();
    var kept = [];
    var i;
    for (i = 0; i < callTimes.length; i++) {
      if (t - callTimes[i] < EMO_WINDOW_MS) kept.push(callTimes[i]);
    }
    callTimes = kept;
    if (callTimes.length >= EMO_MAX_CALLS) return false;
    callTimes.push(t);
    return true;
  }

  /* chatFn(messages) -> 文本。没有就纯关键词。
     auto：关键词判中性或强度很低时才问一次模型，明确情绪不浪费调用。 */
  async function analyze(text, chatFn) {
    var base = fromKeyword(text);
    if (!chatFn) return base;
    if (emoMode() === 'keyword') return base;
    if (base.emo !== 'neutral' && base.intensity >= KEYWORD_ENOUGH) return base;
    if (!takeSlot()) return base;

    try {
      var raw = await chatFn([
        { role: 'system', content: PROMPT },
        { role: 'user', content: String(text || '').slice(0, 300) }
      ]);
      var j = pickJson(raw);
      if (!j || CATS.indexOf(j.emo) < 0) return base;

      var inten = Number(j.intensity);
      if (!isFinite(inten)) inten = 0.5;
      inten = Math.max(0, Math.min(1, inten));

      return {
        emo: j.emo,
        intensity: inten,
        negative: !!NEGATIVE[j.emo],
        source: 'llm',
        tip: String(j.tip || '').slice(0, 40)
      };
    } catch (e) {
      return base;
    }
  }

  /* 拼给人看的情绪提示：模型给了 tip 就带上，护栏永远附上 */
  function hint(result) {
    var r = result || { emo: 'neutral', intensity: 0.3, source: 'keyword' };
    var base = (window.XN_PERSONA && window.XN_PERSONA.emoHint && window.XN_PERSONA.emoHint[r.emo])
      || '正常聊天。';

    var guard = GUARD[r.emo] || GUARD.neutral;
    var out = base;

    if (r.source === 'llm' && r.tip) out = '这一轮这么接：' + r.tip + '（护栏：' + guard.replace(/。$/, '') + '）';

    var pct = Math.round((r.intensity || 0) * 100);
    if (r.emo !== 'neutral') {
      if (r.intensity >= 0.8) out += ' 强度很高（' + pct + '%），别讲道理、别转移话题，先把人接住。';
      else if (r.intensity >= 0.55) out += ' 强度明显（' + pct + '%），当成真难受来回应，别轻飘地带过。';
      else if (r.intensity >= 0.35) out += ' 强度中等（' + pct + '%），正常回应即可。';
      else out += ' 强度很轻（' + pct + '%，可能只是随口一提），别用力过猛。';
    }
    return out;
  }

  return {
    analyze: analyze,
    hint: hint,
    label: function (emo) { return LABEL[emo] || '平静'; },
    guard: GUARD
  };
})();
