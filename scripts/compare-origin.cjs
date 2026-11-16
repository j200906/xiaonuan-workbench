/* 比对「小暖 v4 原版 .py」与现在这套代码的重合度。
 *
 * 三个维度：
 *   A. 文本重合：原版里的中文句子/提示词，有多少还能在现仓库里找到
 *   B. 能力覆盖：原版的函数/机制，在现仓库里有没有对应实现
 *   C. 代码行重复：完全相同的代码行有多少
 *
 * 用法：node scripts/compare-origin.cjs <原版.py路径>
 */
const fs = require('fs');
const path = require('path');

const originPath = process.argv[2];
const root = process.argv[3] || process.cwd();

const origin = fs.readFileSync(originPath, 'utf8');

/* ---------- 收集现仓库所有源码 ---------- */
function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (['.git', 'node_modules', 'cloudflare/.pages', 'data'].includes(f)) continue;
    const abs = path.join(dir, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (/\.(js|mjs|py|css|html|json|md)$/.test(f)) out.push({ rel: path.relative(root, abs), text: fs.readFileSync(abs, 'utf8') });
  }
  return out;
}
const files = walk(root, []);
const allText = files.map((f) => f.text).join('\n');
const norm = (s) => s.replace(/\s+/g, '').replace(/["'`]/g, '"');

/* ================= A. 文本重合 ================= */
/* 抽原版里的中文句子（>=8 个汉字，去掉代码里的普通打印） */
const originLines = origin.split(/\r?\n/);
const sentences = [];
for (const line of originLines) {
  const noComment = line.replace(/^\s*#.*$/, '');
  const hits = noComment.match(/[\u4e00-\u9fa5][\u4e00-\u9fa5，。、；：""''！？（）…\-\s]{7,}/g) || [];
  for (let h of hits) {
    h = h.trim();
    if (h.length < 8) continue;
    if (/^(打印|系统：|系统提示|系统信息)/.test(h)) continue;
    sentences.push(h);
  }
}
const uniq = [...new Set(sentences)];
const matched = [];
const missed = [];
for (const s of uniq) {
  if (norm(allText).includes(norm(s))) matched.push(s);
  else missed.push(s);
}

/* ================= B. 能力覆盖 ================= */
const CAPS = [
  ['情绪识别 analyze_emotion', /def analyze_emotion/, ['assets/persona.js', /detectEmotion/], ['assets/emotion.js', /analyze/]],
  ['显式记忆 detect_explicit_memory', /def detect_explicit_memory/, ['assets/memory.js', /addExplicit|detectExplicit/], ['assets/app.core.js', /记住/]],
  ['遗忘 detect_forget', /def detect_forget/, ['assets/memory.js', /forget/], ['assets/app.core.js', /忘/]],
  ['记忆库 Memory 类', /class Memory/, ['assets/memory.js', /function/], []],
  ['IP 定位 get_user_location', /def get_user_location/, ['assets/tools.js', /whois\.pconline|ip-api|geolocation/], []],
  ['天气接口（专用）', /api\.vvhan\.com\/api\/weather/, ['assets/tools.js', /vvhan|weather/], []],
  ['多引擎搜索 search_web', /def search_web/, ['assets/tools.js', /bing|duckduckgo/i], []],
  ['当前时间 get_current_time', /def get_current_time/, ['assets/tools.js', /name: 'now'/], []],
  ['LLM 调用 call_llm', /def call_llm/, ['assets/lib/api.js', /chatRaw|streamChat/], []],
  ['冲突判定 judge_conflict', /def judge_conflict/, ['assets/memory.js', /conflict/], []],
  ['人格特质演化 review_traits_batch', /def review_traits_batch/, ['assets/memory.js', /trait/], []],
  ['综合提取 extract_all', /def extract_all/, ['assets/memory.js', /extract|consolidate/], []],
  ['主动引擎 ProactiveEngine', /class ProactiveEngine/, ['assets/*', /proactive|主动/], []],
  ['人设核心 PERSONA_CORE', /PERSONA_CORE\s*=/, ['assets/persona.js', /CORE/], []],
  ['情绪应对表 EMO_HINT', /EMO_HINT\s*=/, ['assets/persona.js', /EMO_HINT/], []],
  ['兜底回复 FALLBACK', /FALLBACK\s*=/, ['assets/*', /fallback|兜底/], []],
  ['system prompt 拼装', /def build_system_prompt/, ['assets/persona.js', /function build/], []],
  ['规则回复 rule_reply', /def rule_reply/, ['assets/*', /ruleReply|rule_reply/], []],
  ['SQLite 持久化', /sqlite3/, ['server/app.py', /json|sqlite|save/], ['assets/lib/store.js', /setItem/]],
  ['后台线程 daemon', /def start_daemon/, ['cloudflare/iterate.js', /schedule|cron/], []]
];

const capRows = CAPS.map(([name, inOrigin, ...checks]) => {
  const declared = inOrigin.test(origin);
  let found = null;
  for (const pair of checks) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [fileGlob, re] = pair;
    const targets = files.filter((f) => {
      if (fileGlob === 'assets/*') return f.rel.startsWith('assets/');
      if (fileGlob.includes('*')) return true;
      return f.rel.replace(/\\/g, '/') === fileGlob;
    });
    if (targets.some((t) => re.test(t.text))) { found = fileGlob; break; }
  }
  return { name, declared, found };
});

/* ================= C. 代码行重复 ================= */
const originCode = originLines
  .map((l) => l.trim())
  .filter((l) => l.length >= 12 && !l.startsWith('#') && !l.startsWith('"""'));
const nowLines = new Set();
for (const f of files) {
  if (!/\.(js|py|mjs)$/.test(f.rel)) continue;
  for (const l of f.text.split(/\r?\n/)) {
    const t = l.trim();
    if (t.length >= 12) nowLines.add(t);
  }
}
const dup = originCode.filter((l) => nowLines.has(l));
const dupUniq = [...new Set(dup)];

/* ================= 输出 ================= */
console.log('═'.repeat(66));
console.log('  小暖 v4 原版  VS  现在的代码   重合度比对');
console.log('═'.repeat(66));
console.log('原版：' + path.basename(originPath) + '  ' + origin.split(/\r?\n/).length + ' 行');
console.log('现仓：' + files.length + ' 个源码/文档文件\n');

console.log('──── A. 文本重合（中文句子/提示词） ────');
const pctA = uniq.length ? (matched.length / uniq.length * 100) : 0;
console.log(`原版中文句子 ${uniq.length} 句，现仓库仍能找到 ${matched.length} 句 → 重合 ${pctA.toFixed(1)}%`);
if (missed.length) {
  console.log('\n  已丢失的句子（前 12 条）：');
  missed.slice(0, 12).forEach((s) => console.log('   ✗ ' + s.slice(0, 60)));
}

console.log('\n──── B. 能力覆盖 ────');
let covered = 0;
for (const r of capRows) {
  const mark = r.found ? '✓' : '✗';
  if (r.found) covered++;
  console.log(`  ${mark} ${r.name.padEnd(34)} ${r.found ? '→ ' + r.found : '【缺失】'}`);
}
const pctB = covered / capRows.length * 100;
console.log(`\n  ${covered}/${capRows.length} 项有对应实现 → 覆盖 ${pctB.toFixed(1)}%`);

console.log('\n──── C. 代码行直接重复 ────');
const pctC = originCode.length ? (dup.length / originCode.length * 100) : 0;
console.log(`原版有效代码行 ${originCode.length} 行，现仓库逐字相同 ${dupUniq.length} 行（${dup.length} 次）→ ${pctC.toFixed(1)}%`);

console.log('\n──── 合计 ────');
const overall = (pctA * 0.4 + pctB * 0.4 + pctC * 0.2);
console.log(`  文本 ${pctA.toFixed(1)}% · 能力 ${pctB.toFixed(1)}% · 代码行 ${pctC.toFixed(1)}%`);
console.log(`  加权重合度：${overall.toFixed(1)}%`);
console.log('  （代码行重合低是预期的：原版是 Python 单文件，现在是 JS+多端架构）');
