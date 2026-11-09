/* 给 index.html 里的静态资源加内容哈希：改一次文件就换一次 URL，不会再被缓存坑。
 * 用法：node scripts/stamp.mjs [站点目录，默认仓库根目录]
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? process.argv[2] : join(here, '..');
const indexPath = join(root, 'index.html');

const html = await readFile(indexPath, 'utf8');
const seen = new Map();
const missing = [];

const re = /(href|src)="(assets\/[^"?]+\.(?:js|css))(?:\?v=[^"]*)?"/g;
let out = html;

for (const m of html.matchAll(re)) {
  const path = m[2];
  if (seen.has(path)) continue;
  const file = join(root, path);
  try {
    const data = await readFile(file);
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
    seen.set(path, hash);
  } catch (e) {
    missing.push(path);
  }
}

if (missing.length) {
  console.error('index.html 引用了不存在的文件：\n  ' + missing.join('\n  '));
  process.exit(1);
}

out = out.replace(re, (all, attr, path) => {
  const hash = seen.get(path);
  return `${attr}="${path}?v=${hash}"`;
});

if (out !== html) {
  await writeFile(indexPath, out);
  console.log(`已给 ${seen.size} 个资源写入内容哈希`);
} else {
  console.log('资源引用没有变化');
}

for (const [path, hash] of seen) {
  const s = await stat(join(root, path));
  console.log(`  ${path}?v=${hash}  ${s.size} B`);
}
