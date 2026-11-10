/* 把根目录的页面拷进 cloudflare/public，供 Worker 的 ASSETS 用（legacy 路径）。
 * 主路径是 scripts/build-pages.mjs → cloudflare/.pages（Pages Direct Upload）。
 * 真源永远是根目录的 index.html + assets/ 和 cloudflare/*.js；public/ 是产物，已 gitignore。
 */
import { cp, mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
const stamp = spawnSync(process.execPath, [join(root, 'scripts', 'stamp.mjs'), out], { stdio: 'inherit' });
if (stamp.status !== 0) process.exit(1);
console.log('public →', files.length, '个文件');
for (const f of files) console.log('  ' + f);
