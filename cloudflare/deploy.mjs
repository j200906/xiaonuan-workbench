/* 一条命令部署到 Cloudflare Workers
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

const token = process.env.CLOUDFLARE_API_TOKEN;
const apiKey = process.env.XN_API_KEY;

if (!token) { console.error('缺 CLOUDFLARE_API_TOKEN'); process.exit(2); }
if (!apiKey) { console.error('缺 XN_API_KEY（模型 Key）'); process.exit(2); }

const run = (args, input) => {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    input,
    env: process.env,
    shell: true
  });
  if (r.status !== 0) process.exit(r.status || 1);
};

console.log('1/3 打包静态文件');
run(['--version']);
spawnSync('node', ['build.mjs'], { stdio: 'inherit' });

console.log('2/3 写入 secret');
run(['secret', 'put', 'XN_API_KEY'], apiKey + '\n');

console.log('3/3 部署');
run(['deploy']);
