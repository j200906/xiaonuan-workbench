/* 更新三方比对矩阵里「网页版」那一列：把新实现的标识符补进去 */
const fs = require('fs');
const p = process.argv[2] + '/scripts/compare-three.cjs';
let t = fs.readFileSync(p, 'utf8');

const MAP = [
  ['记忆：复活/撤回遗忘', [/reviveMemory|detectRevive|__revive/], [/snapshotForget|memPlus\.revive/]],
  ['记忆：衰减与重要性', [/retention\s*\(|accessCount|memoryDecay/], [/retention:|memPlus\.decay|accessStamps/]],
  ['记忆：冲突判定', [/judgeConflict|conflictCheck|conflictBudget/], [/judgeConflict/]],
  ['记忆：冲突预算', [/conflictBudget|proactiveBudget/], [/conflictBudget|CONFLICT_WINDOW/]],
  ['人格：特质演化', [/personaTraits|addTrait|reviewTraits/], [/addTrait|activeTraits/]],
  ['人格：特质互斥判定', [/traitOpposite/], [/isOpposite|OPPOSITE_PAIRS/]],
  ['主动：引擎', [/ProactiveEngine|proactiveEngine|proactiveTick/], [/XN\.proactive|proactive\.check/]],
  ['主动：跟进事项', [/followup|followUp/], [/addFollowup|dueFollowups/]],
  ['主动：情绪回访', [/emotionRevisit/], [/checkEmotionRevisit|lastRevisitAt/]],
  ['主动：时间问候', [/timeGreeting|checkGreeting/], [/checkTimeGreeting|lastGreetingKey/]],
  ['主动：配额与间隔', [/MAX_PROACTIVE|proactiveQuota/], [/MAX_PER_DAY|MIN_GAP_HOURS/]],
  ['目标：推导', [/deriveGoal/], [/deriveGoal/]],
  ['位置：IP 定位', [/pconline|getUserLocation/], [/XN\.location|ipapi\.co|locate:/]],
  ['天气：专用接口', [/vvhan|fetchWeather/], [/wttr\.in|location\.weather/]],
  ['搜索：中文引擎（搜狗/360/百度）', [/sogou\.com|baidu\.com|so\.com\/s/], [/bingSearch|bing_search|cn\.bing\.com/]],
  ['搜索：限流与封禁检测', [/_guardEngine|markBlocked|guardEngine/], [/b_algo.*验证|captcha|looksBlocked/]],
  ['搜索：结果缓存', [/searchCache|cachePut|cacheGet/], [/_search_cache|XN_KV\.put\(cacheKey/]],
  ['上下文：指代消解', [/resolveContext/], [/XN\.context\.resolve|resolveContext|focusStack/]],
  ['工具：记忆回溯 recall', [/recallMemory|recall_memory_tool/], [/recall_memory|toolRecall/]],
  ['兜底：规则回复', [/ruleReply/], [/XN\.fallback\.reply|fallback\.reply/]],
  ['兜底：情绪文案表', [/FALLBACK\s*=\s*\{/], [/FALLBACK\s*=\s*\{/]]
];

let changed = 0;
for (const [name, olds, news] of MAP) {
  for (const old of olds) {
    const lit = old.source + '/]';
    if (t.includes(lit)) {
      t = t.split(lit).join(news[0].source + '/]');
      changed++;
      break;
    }
  }
}
fs.writeFileSync(p, t, 'utf8');
console.log('矩阵更新 ' + changed + ' 项');

/* 仪表盘/快照同步：云端 Pages 没有常驻进程，标记为不适用而不是缺失 */
let t2 = fs.readFileSync(p, 'utf8');
if (!t2.includes('不适用：Pages 无常驻进程')) {
  t2 = t2.replace(
    `  ['运维：仪表盘/看板', null, /def dashboard_server/, /dashboardServer|dashboard_server/],`,
    `  ['运维：仪表盘/看板（Pages 无进程，不适用）', null, /def dashboard_server/, /dashboardServer|dashboard_server/],`
  );
  t2 = t2.replace(
    `  ['运维：快照同步', null, /def _sync_snapshot/, /syncSnapshot/]`,
    `  ['运维：快照同步（Pages 无进程，不适用）', null, /def _sync_snapshot/, /syncSnapshot/]`
  );
  fs.writeFileSync(p, t2, 'utf8');
}
