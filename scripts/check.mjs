/* 本地一键自检：语法 + 引用 + 版本一致性。CI 里也跑同一套（见 guard.yml）。 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['assets', 'assets/lib', 'cloudflare', 'scripts', 'tests'];
const files = [];

for (const dir of dirs) {
  let names = [];
  try { names = await readdir(join(root, dir)); } catch (e) { continue; }
  for (const name of names) {
    if (['.js', '.mjs'].includes(extname(name))) files.push(join(dir, name));
  }
}

let failed = 0;
for (const rel of files) {
  const r = spawnSync(process.execPath, ['--check', join(root, rel)], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error('FAIL 语法 ' + rel + '\n' + (r.stderr || '').slice(0, 500));
  }
}
console.log(`语法：${files.length - failed}/${files.length} 通过`);

const html = await readFile(join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="(assets\/[^"?]+\.(?:js|css))"/g)].map((m) => m[1]);
const missing = [];
for (const ref of new Set(refs)) {
  try { await stat(join(root, ref)); } catch (e) { missing.push(ref); }
}
if (missing.length) {
  failed++;
  console.error('FAIL index.html 引用了不存在的文件：\n  ' + missing.join('\n  '));
} else {
  console.log(`引用：${new Set(refs).size} 个资源都存在`);
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const changelog = await readFile(join(root, 'assets/changelog.js'), 'utf8');
const first = (changelog.match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
if (first !== pkg.version) {
  failed++;
  console.error(`FAIL 版本不一致：package.json=${pkg.version} changelog=${first}`);
} else {
  console.log(`版本：v${first}`);
}

const required = ['setProvider', 'setLocale', 'fbPull', 'cloudIterCard', 'navEditor', 'ctlPrompt', 'noteMore', 'keyRemember'];
const missingIds = required.filter((id) => !html.includes(`id="${id}"`));
if (missingIds.length) {
  failed++;
  console.error('FAIL 缺少控件：' + missingIds.join('、'));
} else {
  console.log('控件：关键 id 齐全');
}

if (failed) process.exit(1);
console.log('\n自检通过');
