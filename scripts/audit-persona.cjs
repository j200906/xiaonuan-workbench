/* 人设诚实性审计：把 CORE 里每一条「能力声明」抽出来，对着代码验证真伪。
 * 输出一张表：声明 / 实际 / 结论。发现问题就退出码 1。
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const persona = rd('assets/persona.js');
const tools = rd('assets/tools.js');
const core = rd('assets/app.core.js');
const memory = rd('assets/memory.js');
const emotion = rd('assets/emotion.js');

/* 人设里所有「你有/你能/你会」型声明 */
const CLAIMS = [
  {
    name: '联网搜索',
    text: /能不能联网由 abilityBlock 现算/,
    verify: () => {
      /* 现在人设不再写死：能力块按 capabilities 生成。这里验两件事：
         1) 占位符机制存在；2) 关掉联网时确实改口说「没有联网」。 */
      const hasBlock = /function abilityBlock/.test(persona);
      const placeholder = /\{\{ABILITY\}\}/.test(persona);
      const saysOff = /现在没有联网/.test(persona);
      const saysOn = /能联网搜索/.test(persona);
      return {
        ok: hasBlock && placeholder && saysOff && saysOn,
        detail: '动态能力块=' + hasBlock + '，占位符=' + placeholder + '，关时改口=' + saysOff + '，开时声明=' + saysOn,
        problem: !hasBlock ? '能力声明还是写死的' : (!saysOff ? '联网关闭时没有改口' : '')
      };
    }
  },
  {
    name: '查看系统时间',
    text: /查看系统时间/,
    verify: () => {
      const hasNow = /name: 'now'/.test(tools);
      /* specsFor(false) 只保留 now → 永远可用 */
      const always = /specs\.filter\(function \(s\) \{ return s\.function && s\.function\.name === 'now'; \}\)/.test(tools);
      return {
        ok: hasNow && always,
        detail: 'now 工具=' + hasNow + '，任何时候都下发=' + always,
        problem: !hasNow ? '工具根本没实现' : (!always ? '被开关错误地关掉了' : '')
      };
    }
  },
  {
    name: '记忆（只用记忆里有的）',
    text: /只用记忆里有的/,
    verify: () => {
      const getActive = /getActiveMemories/.test(memory) && /getActiveMemories/.test(core);
      const injected = /explicit/.test(core) && /memories: memories/.test(core);
      return {
        ok: getActive && injected,
        detail: '记忆模块=' + /XN_MEM|function/.test(memory) + '，注入 prompt=' + injected,
        problem: !injected ? '记忆没有真的进 prompt' : ''
      };
    }
  },
  {
    name: '情绪识别',
    text: /当前用户情绪|情绪应对提示/,
    verify: () => {
      const detect = /detectEmotion/.test(persona);
      const analyze = /analyze/.test(emotion);
      const used = /XN_EMO\.analyze|state\.lastEmo/.test(core);
      return {
        ok: detect && analyze && used,
        detail: '本地词表=' + detect + '，情绪模块=' + analyze + '，发送时调用=' + used,
        problem: !used ? '情绪算了但没用上' : ''
      };
    }
  },
  {
    name: '关系熟悉度',
    text: /关系越熟|你们的关系/,
    verify: () => {
      const rel = /relation\s*[:=]/.test(memory) && /mem\.relation/.test(core);
      const touch = /XN_MEM\.touch/.test(core);
      return {
        ok: rel && touch,
        detail: 'relation 字段=' + rel + '，每次发消息计数=' + touch,
        problem: !touch ? '关系等级不会增长' : ''
      };
    }
  },
  {
    name: '答应过的事',
    text: /你答应过、还没做到的事/,
    verify: () => {
      const p = /promises/.test(memory) && /mem\.promises/.test(core);
      return { ok: p, detail: 'promises 数据与注入=', problem: !p ? '承诺追踪没接' : '' };
    }
  },
  {
    name: '今天的目标',
    text: /今天的目标/,
    verify: () => {
      const g = /state\.goals/.test(core) && /goals:/.test(core);
      /* goals 是否有 UI 维护入口 */
      const ui = /goals/.test(core);
      return { ok: g, detail: '状态与注入=' + g, problem: !g ? '目标没有注入' : '' };
    }
  }
];

console.log('=== 人设能力声明 vs 实际实现 ===\n');
let bad = 0;
const rows = [];
for (const c of CLAIMS) {
  const declared = c.text.test(persona);
  const r = c.verify();
  const verdict = !declared ? '人设未声明' : (r.ok && !r.problem ? 'OK' : '不一致');
  if (verdict === '不一致') bad++;
  rows.push({ 声明: c.name, 在人设里: declared ? '有' : '无', 实现: r.ok ? '有' : '缺', 实际: r.detail, 结论: verdict, 问题: r.problem });
}
for (const r of rows) {
  console.log('【' + r.声明 + '】人设:' + r.在人设里 + ' 实现:' + r.实现 + ' → ' + r.结论);
  console.log('   ' + r.实际);
  if (r.问题) console.log('   ⚠ ' + r.问题);
}

console.log('\n=== 人设里提到但可能不存在的其它断言 ===');
const EXTRA = [
  ['"不要每句都用感叹号"', /不要每句都用感叹号/.test(persona)],
  ['"你在学习工作台的对话框里"', /学习工作台/.test(persona)],
  ['"禁止只说「我查一下」不动手"', /不要先空口说「我查一下」/.test(persona)]
];
for (const [t, present] of EXTRA) console.log('  ' + t + ' → ' + (present ? '有人设' : '无人设'));

console.log('\n不一致条数：' + bad);
process.exit(bad ? 1 : 0);
