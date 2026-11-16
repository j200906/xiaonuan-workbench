/* 把新文件补进三处清单：紧跟在 location.js 那行之后 */
const fs = require('fs');
const root = process.argv[2];
const NEWS = ['assets/lib/memory-ext.js', 'assets/lib/proactive.js'];

const TARGETS = [
  { p: 'cloudflare/iterate.js', q: "'", ind: '  ' },
  { p: 'tests/iterate.test.mjs', q: "'", ind: '  ' },
  { p: 'server/app.py', q: '"', ind: '    ' }
];

for (const t of TARGETS) {
  const abs = root + '/' + t.p;
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].indexOf('assets/lib/location.js') >= 0) { i = k; break; }
  }
  if (i < 0) { console.log(t.p + ': 找不到 location.js 那行'); continue; }

  let added = 0;
  let at = i + 1;
  for (const nf of NEWS) {
    if (lines.some((l) => l.indexOf(nf) >= 0)) continue;
    lines.splice(at, 0, t.ind + t.q + nf + t.q + ',');
    at++;
    added++;
  }
  if (added) fs.writeFileSync(abs, lines.join('\n'), 'utf8');
  console.log(t.p + ': 加 ' + added + ' 个');
}
