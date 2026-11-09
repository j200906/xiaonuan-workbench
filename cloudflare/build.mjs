/* 把根目录的页面拷进 cloudflare/public，供 Worker 的 ASSETS 用 */
import { cp, mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'public');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(join(root, 'index.html'), join(out, 'index.html'));
await cp(join(root, 'assets'), join(out, 'assets'), { recursive: true });

const files = [];
async function walk(dir, prefix = '') {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p, prefix + name + '/');
    else files.push(prefix + name);
  }
}
await walk(out);
console.log('public →', files.length, '个文件');
for (const f of files) console.log('  ' + f);
