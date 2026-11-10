/* 从仓库根生成 Cloudflare Pages 的直传目录 cloudflare/.pages。
 *
 * 真源只有两份：
 *   - 页面：根目录 index.html + assets/
 *   - 边缘代码：cloudflare/{worker,iterate,rules,shared,lessons}.js
 * cloudflare/public/ 与 cloudflare/.pages/ 都是产物，已进 .gitignore，别手改、别入库。
 *
 * 用法：
 *   node scripts/build-pages.mjs            # 生成/覆盖 cloudflare/.pages
 *   node scripts/build-pages.mjs --check    # 只比对源码，不写盘；有漂移退出码 1
 *
 * Q86：Pages 高级模式的 _worker.js 里有 `import './iterate.js'` 这类相对导入。
 * `wrangler pages deploy` 默认会打包（esbuild），所以同目录多文件是支持的；
 * 不要加 --no-bundle，也不要用控制台拖拽（拖拽不打包相对 import）。
 * 本脚本生成后会把每个相对 import 解析一遍，缺文件当场失败。
 */
import { cp, mkdir, rm, copyFile, readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'cloudflare', '.pages');
const checkOnly = process.argv.includes('--check');

/* 源文件 → .pages 里的文件名。worker.js 在 Pages 里必须叫 _worker.js。 */
const EDGE_FILES = [
  ['cloudflare/worker.js', '_worker.js'],
  ['cloudflare/iterate.js', 'iterate.js'],
  ['cloudflare/rules.js', 'rules.js'],
  ['cloudflare/shared.js', 'shared.js'],
  ['cloudflare/lessons.js', 'lessons.js']
];

async function walk(dir, prefix = '') {
  const outFiles = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) outFiles.push(...await walk(p, prefix + name + '/'));
    else outFiles.push(prefix + name);
  }
  return outFiles;
}

function normLineEndings(text) {
  return text.replace(/\r\n/g, '\n');
}

function stripStamp(html) {
  return normLineEndings(html).replace(/\?v=[0-9a-f]+/g, '');
}

async function readTextOrNull(path) {
  try { return normLineEndings(await readFile(path, 'utf8')); } catch (e) { return null; }
}

/* 校验 .pages 里 _worker.js 及其相对 import 是否都落盘。 */
async function missingImports(dir) {
  const missing = [];
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.js')); } catch (e) { return missing; }
  const re = /(?:from\s*|import\s*)(['"])(\.\/[^'"]+)\1/g;
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    for (const m of text.matchAll(re)) {
      const target = m[2].replace(/^\.\//, '').split('?')[0];
      try { await stat(join(dir, target)); } catch (e) { missing.push(`${name} → ${m[2]}`); }
    }
  }
  return missing;
}

if (checkOnly) {
  let exists = true;
  try { await stat(out); } catch (e) { exists = false; }
  if (!exists) {
    console.log('Pages 产物：cloudflare/.pages 还没生成，跳过比对（部署前跑 npm run build）');
    process.exit(0);
  }

  const drift = [];

  const localIndex = await readTextOrNull(join(root, 'index.html'));
  const builtIndex = await readTextOrNull(join(out, 'index.html'));
  if (builtIndex == null) drift.push('index.html 缺失');
  else if (stripStamp(localIndex || '') !== stripStamp(builtIndex)) drift.push('index.html 内容不同（已忽略 ?v= 哈希）');

  let localAssets = [];
  try { localAssets = (await walk(join(root, 'assets'))).sort(); } catch (e) { localAssets = []; }
  let builtAssets = [];
  try { builtAssets = (await walk(join(out, 'assets'))).sort(); } catch (e) { builtAssets = []; }
  for (const rel of localAssets) {
    try {
      const [a, b] = await Promise.all([readFile(join(root, 'assets', rel)), readFile(join(out, 'assets', rel))]);
      if (!a.equals(b)) drift.push(`assets/${rel} 内容不同`);
    } catch (e) { drift.push(`assets/${rel} 缺失`); }
  }
  for (const rel of builtAssets) {
    if (!localAssets.includes(rel)) drift.push(`assets/${rel} 是旧产物（源码已删）`);
  }

  for (const [src, name] of EDGE_FILES) {
    try {
      const [a, b] = await Promise.all([readFile(join(root, src)), readFile(join(out, name))]);
      if (!a.equals(b)) drift.push(`${name} 内容不同（源 ${src}）`);
    } catch (e) { drift.push(`${name} 缺失（源 ${src}）`); }
  }

  if (!drift.length) {
    console.log('Pages 产物：cloudflare/.pages 与源码一致');
    process.exit(0);
  }
  console.error('Pages 产物已漂移（cloudflare/.pages 是构建产物，先跑 npm run build）：');
  for (const line of drift) console.error('  ' + line);
  process.exit(1);
}

console.log('组装 cloudflare/.pages ← index.html + assets/ + cloudflare/*.js');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(join(root, 'index.html'), join(out, 'index.html'));
await cp(join(root, 'assets'), join(out, 'assets'), { recursive: true });
for (const [src, name] of EDGE_FILES) await copyFile(join(root, src), join(out, name));

const stamp = spawnSync(process.execPath, [join(root, 'scripts', 'stamp.mjs'), out], { stdio: 'inherit' });
if (stamp.status !== 0) { console.error('stamp.mjs 失败'); process.exit(1); }

const missing = await missingImports(out);
if (missing.length) {
  console.error('_worker.js 的相对 import 找不到目标（部署会失败）：');
  for (const line of missing) console.error('  ' + line);
  process.exit(1);
}

const files = await walk(out);
const assetFiles = await walk(join(out, 'assets'));
console.log(`已生成 cloudflare/.pages（${files.length} 个文件）`);
console.log(`  index.html（已打内容哈希）+ assets/（${assetFiles.length} 个文件）`);
console.log('  ' + EDGE_FILES.map(([, name]) => name).join(' / '));
console.log('  相对 import 均可解析：wrangler pages deploy 默认会打包 _worker.js');
