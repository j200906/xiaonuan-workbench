/* 三方比对：v4 原版 / v5.8 完整版 / 现在网页版
 *
 * 用法：node scripts/compare-three.cjs <v4.py> <v5.8.py> [仓库目录]
 *
 * 输出：
 *   1. 三份代码的规模
 *   2. 能力矩阵（每项在 v4 / v5.8 / 网页 各有没有）
 *   3. v5.8 相对 v4 新增了什么
 *   4. 网页相对 v5.8 还差什么
 */
const fs = require('fs');
const path = require('path');

const v4Path = process.argv[2];
const v58Path = process.argv[3];
const root = process.argv[4] || process.cwd();

const v4 = fs.readFileSync(v4Path, 'utf8');
const v58 = fs.readFileSync(v58Path, 'utf8');

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (['.git', 'node_modules', 'data', '.pages'].includes(f)) continue;
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (/\.(js|mjs|py)$/.test(f)) out.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), text: fs.readFileSync(abs, 'utf8') });
  }
  return out;
}
const files = walk(root, []);
const allWeb = files.map((f) => f.text).join('\n');

/* 能力清单：以 v5.8 为全集（它最完整），逐项测三方 */
const MATRIX = [
  // [名称, v4 正则, v5.8 正则, 网页 正则]
  ['情绪：本地词表打分', /def analyze_emotion/, /def analyze_emotion/, /detectEmotion/],
  ['情绪：LLM 二次判定', null, /def analyze_emotion_llm|def judge_emotion/, /emotion\.js|XN_EMO\.analyze|analyze\s*[:=]/],
  ['情绪：标签与提示文案', /EMO_HINT\s*=/, /def emo_hint_text/, /EMO_HINT/],
  ['记忆：显式记忆', /def detect_explicit_memory/, /def detect_explicit_memory/, /addExplicit/],
  ['记忆：遗忘', /def detect_forget/, /def detect_forget/, /forget\s*[:=]|function forget/],
  ['记忆：复活/撤回遗忘', null, /def detect_revive/, /reviveMemory|detectRevive|__revive/],
  ['记忆：衰减与重要性', null, /def _retention|access_count/, /retention\s*\(|accessCount|memoryDecay/],
  ['记忆：巩固合并', null, /def consolidate_memory/, /consolidate/],
  ['记忆：冲突判定', /def judge_conflict/, /def judge_conflict/, /judgeConflict|conflictCheck|conflictBudget/],
  ['记忆：冲突预算', null, /def _conflict_budget/, /conflictBudget|proactiveBudget/],
  ['人格：特质演化', /def review_traits_batch/, /def review_traits_batch/, /personaTraits|addTrait|reviewTraits/],
  ['人格：特质互斥判定', null, /def _trait_opposite/, /traitOpposite/],
  ['提取：一次调用多产出', /def extract_all/, /def extract_all/, /consolidate|extract/],
  ['主动：引擎', /class ProactiveEngine/, /class ProactiveEngine/, /ProactiveEngine|proactiveEngine|proactiveTick/],
  ['主动：跟进事项', /get_due_followups/, /get_due_followups|followup/, /followup|followUp/],
  ['主动：情绪回访', /_check_emotion_revisit/, /_check_emotion_revisit/, /emotionRevisit/],
  ['主动：时间问候', /_check_time_greeting/, /_check_time_greeting/, /timeGreeting|checkGreeting/],
  ['主动：配额与间隔', /MAX_PROACTIVE_PER_DAY/, /MAX_PROACTIVE_PER_DAY/, /MAX_PROACTIVE|proactiveQuota/],
  ['目标：推导', null, /def derive_goal/, /deriveGoal/],
  ['关系：简报', null, /def rel_brief/, /relation\(\)|rel_brief/],
  ['承诺：简报', null, /def promise_brief/, /promises\(\)/],
  ['位置：IP 定位', /def get_user_location/, /def get_user_location/, /pconline|getUserLocation/],
  ['天气：专用接口', /api\.vvhan\.com/, /def _fetch_weather/, /vvhan|fetchWeather/],
  ['搜索：多引擎', /def search_web/, /def _search_all/, /bing|duckduckgo/i],
  ['搜索：中文引擎（搜狗/360/百度）', null, /_parse_sogou|_parse_360|_parse_baidu/, /sogou\.com|baidu\.com|so\.com\/s/],
  ['搜索：限流与封禁检测', null, /_guard_engine|_looks_blocked/, /_guardEngine|markBlocked|guardEngine/],
  ['搜索：结果缓存', null, /def _cache_put/, /searchCache|cachePut|cacheGet/],
  ['上下文：指代消解', null, /def resolve_context/, /resolveContext/],
  ['工具：记忆回溯 recall', null, /def recall_memory_tool/, /recallMemory|recall_memory_tool/],
  ['LLM：工具循环', /tool_depth/, /tool_depth/, /loopWithFallback|loopCore/],
  ['兜底：规则回复', /def rule_reply/, /def rule_reply/, /ruleReply/],
  ['兜底：情绪文案表', /FALLBACK\s*=/, /FALLBACK\s*=/, /FALLBACK\s*=\s*\{/],
  ['运维：后台守护线程', /def start_daemon/, /def start_memory_daemon/, /daemon/],
  ['运维：仪表盘/看板', null, /def dashboard_server/, /dashboardServer|dashboard_server/],
  ['运维：快照同步', null, /def _sync_snapshot/, /sync_snapshot|syncSnapshot/]
];

function has(text, re) {
  if (!re) return false;
  return re.test(text);
}

console.log('═'.repeat(74));
console.log('  三方比对：v4 原版  /  v5.8 完整版  /  现在的网页版');
console.log('═'.repeat(74));

const v4Lines = v4.split(/\r?\n/).length;
const v58Lines = v58.split(/\r?\n/).length;
let webLines = 0;
for (const f of files) webLines += f.text.split(/\r?\n/).length;

console.log('v4 原版    : ' + v4Lines + ' 行');
console.log('v5.8 完整版: ' + v58Lines + ' 行   （比 v4 多 ' + (v58Lines - v4Lines) + ' 行，+' + ((v58Lines / v4Lines - 1) * 100).toFixed(0) + '%）');
console.log('网页版     : ' + webLines + ' 行（' + files.length + ' 个文件，多端）\n');

console.log('──── 能力矩阵 ────');
console.log('  ' + '能力'.padEnd(30) + 'v4   v5.8  网页');
console.log('  ' + '─'.repeat(46));

const stats = { v4: 0, v58: 0, web: 0 };
const missingInWeb = [];
const newInV58 = [];
for (const [name, r4, r5, rw] of MATRIX) {
  const a = has(v4, r4);
  const b = has(v58, r5);
  const c = has(allWeb, rw);
  if (a) stats.v4++;
  if (b) stats.v58++;
  if (c) stats.web++;
  console.log('  ' + name.padEnd(30) + (a ? ' ✓  ' : ' ·  ') + '  ' + (b ? '✓  ' : '·  ') + '  ' + (c ? '✓' : '·'));
  if (b && !c) missingInWeb.push(name);
  if (b && !a) newInV58.push(name);
}

const total = MATRIX.length;
console.log('\n  覆盖：v4 ' + stats.v4 + '/' + total + '  ·  v5.8 ' + stats.v58 + '/' + total + '  ·  网页 ' + stats.web + '/' + total);

console.log('\n──── v5.8 相对 v4 新增（' + newInV58.length + ' 项）────');
newInV58.forEach((n) => console.log('  + ' + n));

console.log('\n──── 网页相对 v5.8 仍缺（' + missingInWeb.length + ' 项）────');
missingInWeb.forEach((n) => console.log('  ✗ ' + n));

console.log('\n──── 重合度 ────');
const v4ToV58 = stats.v4 ? (MATRIX.filter(function (r) { return r[1] && r[2]; }).length / stats.v4 * 100) : 0;
const webToV58 = stats.v58 ? (stats.web / stats.v58 * 100) : 0;
console.log('  v4 的 ' + stats.v4 + ' 项能力，v5.8 保留 ' + MATRIX.filter(function (r) { return r[1] && r[2]; }).length + ' 项');
console.log('  v5.8 的 ' + stats.v58 + ' 项能力，网页版实现 ' + stats.web + ' 项 → ' + webToV58.toFixed(1) + '%');

