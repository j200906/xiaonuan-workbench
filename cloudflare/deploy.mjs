/* 一条命令部署到 Cloudflare Workers（legacy，保留但不再是主路径）
 *
 * 主路径是 Pages：node cloudflare/deploy_pages.mjs --apply（见 cloudflare/README.md）。
 * 这里仅在没有 Pages 时兜底；worker.js 不是死代码——Pages 构建会把它拷成 _worker.js。
 *
 * 需要两个环境变量：
 *   CLOUDFLARE_API_TOKEN   在 dash.cloudflare.com → My Profile → API Tokens 建，
 *                          模板选 "Edit Cloudflare Workers"
 *   XN_API_KEY             模型 Key，会写进 Worker 的 secret（不进代码）
 * 可选：
 *   CLOUDFLARE_ACCOUNT_ID  账号只有一个时可以不填
 *   XN_BASE                默认 https://api.deepseek.com/v1
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const token = process.env.CLOUDFLARE_API_TOKEN;
const apiKey = process.env.XN_API_KEY;

if (!token) { console.error('缺 CLOUDFLARE_API_TOKEN'); process.exit(2); }
if (!apiKey) {
  console.warn('⚠ 没给 XN_API_KEY：先把页面发出去，聊天会显示未配置。');
  console.warn('  之后在 Cloudflare 后台 Settings → Variables and Secrets 加一个 XN_API_KEY 即可，或者重跑一次带 Key。');
}

const run = (args, input) => {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    input,
    env: process.env,
    shell: true
  });
  if (r.status !== 0) process.exit(r.status || 1);
};

console.log('1/3 打包静态文件（Workers 的 ASSETS）');
run(['--version']);
const build = spawnSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit', cwd: here });
if (build.status !== 0) { console.error('build.mjs 失败'); process.exit(1); }

if (apiKey) {
  console.log('2/3 写入 secret');
  run(['secret', 'put', 'XN_API_KEY'], apiKey + '\n');
} else {
  console.log('2/3 跳过 secret（没有模型 Key）');
}

console.log('3/3 部署');
run(['deploy']);
