/* app.core.js：接入目标推导 / 主动引擎 / 衰减 / 撤回遗忘 */
const fs = require('fs');
const root = process.argv[2];
const p = root + '/assets/app.core.js';
let lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let n = 0;

function insertAfter(pred, block) {
  const i = lines.findIndex(pred);
  if (i < 0) { console.log('  找不到锚点'); return false; }
  lines.splice(i + 1, 0, ...block);
  n++;
  return true;
}

/* ---------- 1. 目标推导：拼进 system prompt ---------- */
const gi = lines.findIndex((l) => /\}\);\s*$/.test(l) && lines.slice(Math.max(0, lines.indexOf(l) - 14), lines.indexOf(l)).some((x) => /capabilities:/.test(x)));
if (gi > 0 && !lines.slice(gi, gi + 8).some((l) => /XN\.proactive\.goalLine/.test(l))) {
  lines.splice(gi + 1, 0,
    '',
    '    /* 这一轮该拿什么姿态：安慰 / 正常聊 / 推一把（v5.8 的 derive_goal） */',
    '    if (root.XN && XN.proactive && XN.proactive.deriveGoal) {',
    '      try {',
    '        var goal = XN.proactive.deriveGoal(state.lastEmo);',
    '        var goalLine = XN.proactive.goalLine(goal);',
    '        if (goalLine) prompt += \'\\n\' + goalLine;',
    '      } catch (e) {}',
    '    }');
  n++;
}

/* ---------- 2. 维护 lastUserAt / turnCount（主动引擎靠它判断静默期） ---------- */
const ui = lines.findIndex((l) => /XN\.context\.rememberDialog\('user', text\)/.test(l));
if (ui > 0 && !lines.slice(ui, ui + 3).some((l) => /lastUserAt/.test(l))) {
  lines.splice(ui + 1, 0,
    "    state.lastUserAt = Date.now();",
    "    state.turnCount = (state.turnCount || 0) + 1;");
  n++;
}

/* ---------- 3. 「忘掉」先留快照，支持撤回 ---------- */
const fi = lines.findIndex((l) => /root\.XN_MEM\.forget\(topic\)/.test(l));
if (fi > 0 && !lines.slice(Math.max(0, fi - 4), fi).some((l) => /snapshotForget/.test(l))) {
  lines.splice(fi, 0,
    "      /* 先拍个快照：说错了能撤回（v5.8 的 detect_revive） */",
    "      if (root.XN && XN.memPlus && XN.memPlus.snapshotForget) XN.memPlus.snapshotForget(topic);");
  n++;
}

/* ---------- 4. 「撤回/恢复」指令 ---------- */
const ri = lines.findIndex((l) => /var mForget = text\.match/.test(l));
if (ri > 0 && !lines.slice(ri, ri + 3).some((l) => /mRevive/.test(l))) {
  lines.splice(ri + 1, 0,
    "    var mRevive = text.match(/^(?:撤回|恢复|undo|取消遗忘)[，,：:\\s]*(.*)$/i);");
  n++;
}

/* 在 forget 的 else if 之后加 revive 分支 */
const ei = lines.findIndex((l) => /var removed = root\.XN_MEM \? root\.XN_MEM\.forget\(topic\) : 0;/.test(l));
if (ei > 0) {
  const end = lines.findIndex((l, k) => k > ei && /U\.toast\(removed/.test(l));
  if (end > 0 && !lines.slice(end, end + 3).some((l) => /mRevive/.test(l))) {
    lines.splice(end + 1, 0,
      "    } else if (mRevive) {",
      "      var back = (root.XN && XN.memPlus && XN.memPlus.revive) ? XN.memPlus.revive() : 0;",
      "      U.toast(back ? ('恢复了 ' + back + ' 条记忆') : '没有可撤回的遗忘（超过 10 分钟就找不回了）');");
    n++;
  }
}

/* ---------- 5. 启动时跑一次衰减 + 主动引擎定时器 ---------- */
const booti = lines.findIndex((l) => /XN\.on\('plugin:mounted'/.test(l));
if (booti > 0 && !lines.slice(booti, booti + 12).some((l) => /startProactive/.test(l))) {
  lines.splice(booti + 2, 0,
    '',
    '    /* 记忆衰减：旧事淡出、重要的留住（v5.8 的 _maybe_decay） */',
    '    if (root.XN && XN.memPlus && XN.memPlus.decay) {',
    '      try { XN.memPlus.decay(); } catch (e) {}',
    '    }',
    '',
    '    /* 主动引擎：每 5 分钟看一眼该不该主动开口 */',
    '    startProactive();');
  n++;
}

/* ---------- 6. startProactive 函数本体 ---------- */
const si = lines.findIndex((l) => /function setSending\(/.test(l));
if (si > 0 && !lines.slice(Math.max(0, si - 40), si + 40).some((l) => /function startProactive/.test(l))) {
  lines.splice(si, 0,
    '  /* 主动引擎：它自己会想起你。',
    '     门槛全在 proactive.check 里（间隔 / 每日配额 / 用户刚说完话不打扰）。',
    '     这里只负责定时问一句「该不该开口」，以及把话说出去。 */',
    '  var proactiveTimer = null;',
    '  function fireProactive() {',
    '    if (!root.XN || !XN.proactive || !XN.proactive.check) return;',
    '    if (state.sending) return;            /* 正在聊就不插嘴 */',
    '    var hit = null;',
    '    try { hit = XN.proactive.check(); } catch (e) { return; }',
    '    if (!hit || !hit.text) return;',
    '',
    '    var s = currentSession();',
    '    if (!s) return;',
    '    var msg = { id: U.uid(\'m\'), role: \'assistant\', content: hit.text, ts: Date.now(), proactive: hit.kind };',
    '    s.messages.push(msg);',
    '    s.ts = Date.now();',
    '    if (state.view === \'chat\') renderThread();',
    '    saveSessions();',
    '    renderSessions();',
    '    try { XN.proactive.commit(hit); } catch (e) {}',
    '  }',
    '',
    '  function startProactive() {',
    '    if (proactiveTimer) return;',
    '    /* 首次延迟 1 分钟再开始，避免刚打开就插一句 */',
    '    setTimeout(fireProactive, 60 * 1000);',
    '    proactiveTimer = setInterval(fireProactive, 5 * 60 * 1000);',
    '  }',
    '',
    '  function setSending(');
  n++;
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('app.core.js 改动 ' + n + ' 处');
