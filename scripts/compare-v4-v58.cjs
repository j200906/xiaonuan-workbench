/* v4 -> v5.8 的继承度：v4 有多少东西被 v5.8 保留下来
 * 三个粒度：函数名 / 代码行逐字 / 中文文本
 */
const fs = require('fs');

const v4 = fs.readFileSync(process.argv[2], 'utf8');
const v58 = fs.readFileSync(process.argv[3], 'utf8');

const lines = (t) => t.split(/\r?\n/);
const norm = (s) => s.replace(/\s+/g, '').replace(/["'`]/g, '"').replace(/[，。、；：]/g, ',');
const body = (t) => t.replace(/^\s*#.*$/gm, '');

/* ---------- A. 函数/类名 ---------- */
function defs(t) {
  const out = [];
  for (const l of lines(t)) {
    const m = l.match(/^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) out.push(m[1]);
  }
  return out;
}
const d4 = defs(v4);
const d58 = new Set(defs(v58));
const d4keep = d4.filter((n) => d58.has(n));
const d4lost = d4.filter((n) => !d58.has(n));

/* ---------- B. 代码行逐字 ---------- */
function codeLines(t) {
  return lines(body(t))
    .map((l) => l.trim())
    .filter((l) => l.length >= 10 && !l.startsWith('#') && !l.startsWith('"""') && !/^\s*$/.test(l));
}
const c4 = [...new Set(codeLines(v4))];
const c58 = new Set(codeLines(v58));
const cKeep = c4.filter((l) => c58.has(l));
const cLost = c4.filter((l) => !c58.has(l));

/* ---------- C. 中文文本 ---------- */
function zh(t) {
  const out = [];
  for (const l of lines(body(t))) {
    const hits = l.match(/[\u4e00-\u9fa5][\u4e00-\u9fa5，。、；：""''！？（）…\-\s]{6,}/g) || [];
    for (const h of hits) {
      const s = h.trim();
      if (s.length >= 8) out.push(s);
    }
  }
  return [...new Set(out)];
}
const z4 = zh(v4);
const z58n = norm(body(v58));
const zKeep = z4.filter((s) => z58n.includes(norm(s)));
const zLost = z4.filter((s) => !z58n.includes(norm(s)));

/* ---------- 输出 ---------- */
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0');

console.log('═'.repeat(60));
console.log('  v4 (1,266 行) → v5.8 (3,999 行) 的继承度');
console.log('═'.repeat(60));

console.log('\n──── A. 函数/类名 ────');
console.log('  v4 定义 ' + d4.length + ' 个，v5.8 里同名还在 ' + d4keep.length + ' 个 → ' + pct(d4keep.length, d4.length) + '%');
if (d4lost.length) {
  console.log('  消失的：' + d4lost.join('、'));
}

console.log('\n──── B. 代码行（逐字相同） ────');
console.log(`  v4 有效代码行 ${c4.length} 行，v5.8 里逐字还在 ${cKeep.length} 行 → ${pct(cKeep.length, c4.length)}%`);
console.log('  （低是正常的：v5.8 把很多函数重写了，逻辑扩了但字变了）');

console.log('\n──── C. 中文文本 ────');
console.log(`  v4 中文句子 ${z4.length} 句，v5.8 里还能找到 ${zKeep.length} 句 → ${pct(zKeep.length, z4.length)}%`);
if (zLost.length) {
  console.log('\n  没被 v5.8 继承的（前 10 条）：');
  zLost.slice(0, 10).forEach((s) => console.log('   · ' + s.slice(0, 56)));
}

console.log('\n──── 合计 ────');
const a = d4.length ? d4keep.length / d4.length * 100 : 0;
const b = c4.length ? cKeep.length / c4.length * 100 : 0;
const c = z4.length ? zKeep.length / z4.length * 100 : 0;
console.log(`  函数名 ${a.toFixed(1)}% · 代码行 ${b.toFixed(1)}% · 中文文本 ${c.toFixed(1)}%`);
console.log(`  加权（函数 0.4 / 文本 0.4 / 代码 0.2）：${(a * 0.4 + c * 0.4 + b * 0.2).toFixed(1)}%`);
