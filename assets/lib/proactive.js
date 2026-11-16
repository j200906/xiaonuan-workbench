/* 小暖 · 主动引擎 + 目标推导（移植自 v5.8 的 ProactiveEngine / derive_goal）
 *
 * v5.8 里最像「活着」的部分：它会自己想起你。
 *   - 跟进：你上周提过「要考试」，到期主动问一句
 *   - 情绪回访：上次你情绪低落，6–48 小时后回来关心
 *   - 时间问候：早上/深夜按时间打招呼
 *   - 配额：每天最多 3 次、两次间隔至少 6 小时、你刚说完话就不打扰
 *
 * 这里只产出「该说什么」，不负责画界面——由 app.core 决定怎么呈现。
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  var MIN_GAP_HOURS = 6;        /* 两次主动之间至少隔这么久 */
  var MAX_PER_DAY = 3;          /* 每天上限 */
  var USER_RECENT_MS = 25 * 60 * 1000;  /* 用户刚说完话的静默期 */
  var NEGATIVE = { sad: 1, anger: 1, anxiety: 1, lonely: 1, tired: 1 };

  function mp() { return root.XN.memPlus || null; }
  function mem() { return root.XN_MEM || null; }

  function hoursSince(ts) {
    if (!ts) return null;
    return (Date.now() - ts) / 3600000;
  }

  function nowHms() {
    var d = new Date();
    return { h: d.getHours(), m: d.getMinutes() };
  }

  /* ---------------- 门槛检查 ---------------- */

  function gapOk() {
    var p = mp();
    if (!p) return true;
    var last = p.lastProactiveAt();
    if (!last) return true;
    return hoursSince(last) >= MIN_GAP_HOURS;
  }

  function quotaOk() {
    var p = mp();
    if (!p) return true;
    return p.proactiveCountToday() < MAX_PER_DAY;
  }

  function userJustSpoke() {
    var s = root.XN && XN.state;
    var last = s && s.lastUserAt ? s.lastUserAt : 0;
    if (!last) return false;
    return Date.now() - last < USER_RECENT_MS;
  }

  /* ---------------- 四个触发器 ---------------- */

  /* 1. 跟进：到期的待办话题 */
  function checkFollowUp() {
    var p = mp();
    if (!p) return null;
    var due = p.dueFollowups();
    if (!due.length) return null;
    var f = due[0];
    return {
      kind: 'followup',
      id: f.id,
      topic: f.topic,
      text: '欸，上次你说的「' + f.topic + '」，后来怎么样了？',
      hint: '用户之前提到「' + f.topic + '」，现在可以跟进问一句。'
    };
  }

  /* 2. 情绪回访：上次低落，隔了半天来关心 */
  function checkEmotionRevisit() {
    var s = root.XN && XN.state;
    if (!s) return null;
    var lastEmo = s.lastEmo;
    if (!lastEmo || !NEGATIVE[lastEmo.emo]) return null;

    var lastUser = s.lastUserAt || 0;
    if (!lastUser) return null;
    var h = hoursSince(lastUser);
    if (!(h >= 6 && h <= 48)) return null;

    var lastVisit = s.lastRevisitAt || 0;
    if (lastVisit && Date.now() - lastVisit < 24 * 3600 * 1000) return null;

    return {
      kind: 'revisit',
      text: '昨天那事儿……今天感觉好点没？',
      hint: '用户上次情绪低落，主动关心一句，别太用力。'
    };
  }

  /* 3. 时间问候：早上 / 深夜 */
  function checkTimeGreeting() {
    var t = nowHms();
    var s = root.XN && XN.state;
    var lastKey = s && s.lastGreetingKey ? s.lastGreetingKey : '';
    var today = new Date().toISOString().slice(0, 10);

    if (t.h >= 6 && t.h <= 9) {
      if (lastKey === today + ':morning') return null;
      return { kind: 'greeting', key: today + ':morning', text: '早啊，今天打算先干点啥？', hour: t.h };
    }
    if (t.h >= 23 || t.h < 2) {
      if (lastKey === today + ':night') return null;
      return { kind: 'greeting', key: today + ':night', text: '这个点了还不睡？明天要起不来我给你记账上。', hour: t.h };
    }
    return null;
  }

  /* 4. 长期目标：隔几轮轻轻带一下 */
  function checkGoalNudge() {
    var m = mem();
    if (!m || !m.goals) return null;
    var open = (m.goals() || []).filter(function (g) { return g && !g.done; });
    if (!open.length) return null;
    var s = root.XN && XN.state;
    var turns = (s && s.turnCount) || 0;
    if (!turns || turns % 5 !== 0) return null;
    return {
      kind: 'goal',
      text: '对了，你之前说要「' + open[0].text + '」，还记着吗？',
      hint: '长期目标是「' + open[0].text + '」，只带半步，别硬拐。'
    };
  }

  /**
   * 检查是否该主动开口。所有门槛都过了才返回内容。
   * @returns {{kind:string, text:string, hint?:string, id?:string, key?:string}|null}
   */
  function check() {
    if (!gapOk()) return null;
    if (!quotaOk()) return null;
    if (userJustSpoke()) return null;

    var r = checkFollowUp() || checkEmotionRevisit() || checkTimeGreeting() || checkGoalNudge();
    return r || null;
  }

  /** 真的发出去了才记账（避免只是检查就消耗配额） */
  function commit(hit) {
    if (!hit) return;
    var p = mp();
    if (p) p.markProactive();
    if (hit.kind === 'followup' && hit.id && p) p.finishFollowup(hit.id);
    var s = root.XN && XN.state;
    if (s) {
      if (hit.key) s.lastGreetingKey = hit.key;
      if (hit.kind === 'revisit') s.lastRevisitAt = Date.now();
    }
  }

  /* ---------------- 目标推导（每轮该干什么） ---------------- */

  /**
   * 决定这一轮小暖该用什么姿态回应。照 v5.8 的优先级：
   *   负面情绪强 → 安慰
   *   有到期跟进 → 顺口问
   *   有未兑现承诺 → 主动推进
   *   深夜+累 → 催睡
   *   长期目标 → 带半步
   *   其余 → 正常聊
   * @returns {{mode:'comfort'|'chat'|'push', action:string, why:string}}
   */
  function deriveGoal(emo, meta) {
    var e = emo || (root.XN && XN.state && XN.state.lastEmo) || {};
    var id = e.emo || 'neutral';
    var inten = Number(e.intensity);
    if (!Number.isFinite(inten)) inten = 0.5;

    if (NEGATIVE[id] && inten >= 0.55) {
      return { mode: 'comfort', action: '', why: '他现在是「' + id + '」、强度不低，这一轮只做一件事：让他好受一点' };
    }

    var p = mp();
    var due = p ? p.dueFollowups() : [];
    if (due.length) {
      return { mode: 'chat', action: '问他「' + due[0].topic + '」怎么样了', why: '他之前提过「' + due[0].topic + '」，现在到期了，顺口问一句' };
    }

    var m = mem();
    var ops = [];
    try { ops = m && m.promises ? m.promises().filter(function (x) { return x && !x.kept; }) : []; } catch (err) { ops = []; }
    if (ops.length) {
      return { mode: 'push', action: '兑现你答应过的「' + ops[0].text + '」', why: '这是你自己应下的事，别等他提' };
    }

    var t = nowHms();
    if ((id === 'tired' || t.h >= 23 || t.h < 5) && inten >= 0.4) {
      return { mode: 'push', action: '给一个五分钟内能收尾的动作，让他去睡', why: '现在 ' + t.h + ' 点，他这个状态该收了' };
    }

    if (NEGATIVE[id]) {
      return { mode: 'comfort', action: '', why: '他情绪偏负面，但不算重，轻轻应一句就行' };
    }

    var longs = [];
    try { longs = m && m.goals ? (m.goals() || []).filter(function (g) { return g && !g.done; }) : []; } catch (err) { longs = []; }
    var s = root.XN && XN.state;
    var turns = (s && s.turnCount) || 0;
    if (longs.length && turns > 0 && turns % 3 === 0) {
      return { mode: 'push', action: '顺着他这句话，往「' + longs[0].text + '」上带半步', why: '长期目标是「' + longs[0].text + '」，但只带半步，别硬拐' };
    }

    return { mode: 'chat', action: '', why: '正常聊天' };
  }

  /** 把 deriveGoal 的结论变成一句可以塞进 system prompt 的话 */
  function goalLine(goal) {
    if (!goal) return '';
    if (goal.mode === 'comfort') return '【这一轮只做一件事】' + goal.why;
    if (goal.mode === 'push' && goal.action) return '【这一轮的动作】' + goal.action + '（' + goal.why + '）';
    return '';
  }

  XN.proactive = {
    MIN_GAP_HOURS: MIN_GAP_HOURS,
    MAX_PER_DAY: MAX_PER_DAY,
    check: check,
    commit: commit,
    deriveGoal: deriveGoal,
    goalLine: goalLine,
    triggers: { followUp: checkFollowUp, emotionRevisit: checkEmotionRevisit, greeting: checkTimeGreeting, goalNudge: checkGoalNudge }
  };
})(typeof window !== 'undefined' ? window : globalThis);
