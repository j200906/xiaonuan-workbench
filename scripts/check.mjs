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
const changelogVersion = (changelog.match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
const versionJs = await readFile(join(root, 'assets/version.js'), 'utf8');
const versionFallback = (versionJs.match(/\|\|\s*"([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];

const versions = [
  ['package.json', pkg.version],
  ['assets/changelog.js 首条', changelogVersion],
  ['assets/version.js 兜底值', versionFallback]
];
const versionMismatch = versions.filter(([, v]) => v !== pkg.version);
if (versionMismatch.length) {
  failed++;
  console.error('FAIL 版本不一致：' + versions.map(([k, v]) => `${k}=${v}`).join(' / '));
} else {
  console.log(`版本：v${pkg.version}（package.json / changelog 首条 / version.js 一致）`);
}

/* git tag 只在 HEAD 正好打了 tag 时校验；日常提交不该因为“还没打 tag”失败。 */
const headTag = spawnSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (headTag.status === 0) {
  const tag = headTag.stdout.trim();
  if (tag !== 'v' + pkg.version) {
    failed++;
    console.error(`FAIL git tag 与版本不一致：HEAD=${tag} package.json=v${pkg.version}`);
  } else {
    console.log(`tag：${tag} 与版本一致`);
  }
} else {
  console.log('tag：HEAD 未打 tag（发版时再核对 v 版本号）');
}

/* .pages 是构建产物（.gitignore）。CI 里通常不存在，本地并发改源码时也不该误报：
 * 默认只警告；发布前跑 node scripts/check.mjs --strict（或 npm run check:pages）算失败。 */
const strict = process.argv.includes('--strict');
const pages = spawnSync(process.execPath, [join(root, 'scripts', 'build-pages.mjs'), '--check'], { encoding: 'utf8' });
const pagesErr = (pages.stderr || '').trim();
if (pages.status === 0) {
  console.log((pages.stdout || 'Pages 产物：与源码一致').trim().split('\n')[0]);
} else if (strict) {
  failed++;
  console.error(pagesErr || 'FAIL cloudflare/.pages 与源码不一致');
} else {
  console.warn('WARN cloudflare/.pages 与源码不一致（构建产物，先跑 npm run build；--strict 时算失败）');
  if (pagesErr) console.warn(pagesErr);
}

const required = ['setProvider', 'setLocale', 'fbPull', 'navEditor', 'ctlPrompt', 'noteMore', 'keyRemember'];
const missingIds = required.filter((id) => !html.includes(`id="${id}"`));
if (missingIds.length) {
  failed++;
  console.error('FAIL 缺少控件：' + missingIds.join('、'));
} else {
  console.log('控件：关键 id 齐全');
}

if (failed) process.exit(1);
console.log('\n自检通过');
