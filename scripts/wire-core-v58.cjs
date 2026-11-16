/* app.core.js：接入兜底回复 + 对话记忆（给上下文消解用） */
const fs = require('fs');
const root = process.argv[2];
const p = root + '/assets/app.core.js';
let lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let n = 0;

/* ---------- 1. 失败时用兜底文案接住 ---------- */
const ci = lines.findIndex((l) => /bot\.error = \(e && e\.message\) \|\| t\('common\.failed'\);/.test(l));
if (ci > 0 && !lines.slice(ci, ci + 12).some((l) => /XN\.fallback/.test(l))) {
  /* 找到这一整段 catch 的分支，替换成「兜底为主、错误为辅」 */
  const block = [
    '        /* 模型挂了不要只丢一条红字：按这轮情绪挑一句本地文案接住，',
    '           用户几乎感觉不到失败，还能接着说（v5.8 的 rule_reply 就是这个用意）。 */',
    '        var fb = (root.XN && XN.fallback && XN.fallback.reply)',
    '          ? XN.fallback.reply(state.lastEmo && state.lastEmo.emo, root.XN_MEM, { reason: \'network\' })',
    '          : t(\'common.failed\');',
    '        bot.content = bot.content || fb;',
    '        bot.error = (e && e.message) || t(\'common.failed\');',
    '        bot.errorFriendly = true;',
    '        contentEl.innerHTML = MD.render(bot.content);'
  ];
  /* 原来后面还有三行（innerHTML / pe 创建 / 401 处理），把 innerHTML 那行挤掉 */
  let end = ci;
  while (end < lines.length && !/^\s*if \(e && \(e\.status === 401/.test(lines[end])) end++;
  if (end < lines.length) end++;
  lines.splice(ci, end - ci, ...block);
  n++;
}

/* ---------- 2. 用户消息进对话尾巴 ---------- */
const ui = lines.findIndex((l) => /s\.messages\.push\(userMsg\);/.test(l));
if (ui > 0 && !lines.slice(ui, ui + 4).some((l) => /rememberDialog/.test(l))) {
  lines.splice(ui + 1, 0,
    '    /* 记进对话尾巴：上下文消解靠它把「那明天呢」接回「杭州天气」 */',
    '    if (root.XN && XN.context && XN.context.rememberDialog) XN.context.rememberDialog(\'user\', text);');
  n++;
}

/* ---------- 3. 助手回复进对话尾巴 ---------- */
const ai = lines.findIndex((l) => /root\.XN_MEM\.pushBuffer\('小暖：'/.test(l));
if (ai > 0 && !lines.slice(Math.max(0, ai - 6), ai).some((l) => /rememberDialog\(.assistant/.test(l))) {
  lines.splice(ai, 0,
    '      if (root.XN && XN.context && XN.context.rememberDialog) XN.context.rememberDialog(\'assistant\', bot.content);');
  n++;
}

/* ---------- 4. 空回复也走兜底 ---------- */
const ei = lines.findIndex((l) => /bot\.error = t\('chat\.emptyReply'\);/.test(l));
if (ei > 0 && !lines.slice(ei, ei + 4).some((l) => /XN\.fallback/.test(l))) {
  lines.splice(ei, 1,
    '      /* 模型一个字都没吐出来：别显示"空回复"，用兜底文案接一句 */',
    '      if (root.XN && XN.fallback && XN.fallback.reply) {',
    '        bot.content = XN.fallback.reply(state.lastEmo && state.lastEmo.emo, root.XN_MEM, { reason: \'empty\' });',
    '        bot.error = t(\'chat.emptyReply\');',
    '      } else {',
    '        bot.error = t(\'chat.emptyReply\');',
    '      }');
  n++;
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('app.core.js 改动 ' + n + ' 处');
