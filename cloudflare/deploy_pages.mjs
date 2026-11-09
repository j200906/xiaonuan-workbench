/* Cloudflare Pages 一条命令部署（页面 + Functions 一体）
 *
 * 为什么不用 Workers：workers.dev 在国内被 DNS 污染（解析到 65.49.x / Facebook 段），
 * pages.dev 解析正常，所以走 Pages。
 *
 * 用法：
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx \
 *   XN_API_KEY=sk-xxx node deploy_pages.mjs [项目名]
 *
 * 不给 XN_API_KEY 也能部署，只是聊天会提示未配置；之后补上再跑一次即可。
 */
import { mkdir, rm, cp, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, '.pages');

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const modelKey = process.env.XN_API_KEY || '';
const base = process.env.XN_BASE || 'https://api.deepseek.com/v1';
const model = process.env.XN_MODEL || 'deepseek-chat';
const project = process.argv[2] || process.env.XN_PAGES_PROJECT || 'xiaonuan-app';

if (!token) { console.error('缺 CLOUDFLARE_API_TOKEN'); process.exit(2); }
if (!account) { console.error('缺 CLOUDFLARE_ACCOUNT_ID'); process.exit(2); }

const api = async (path, init = {}) => {
  const res = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
};

console.log('1/5 组装静态文件');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(join(root, 'index.html'), join(out, 'index.html'));
await cp(join(root, 'assets'), join(out, 'assets'), { recursive: true });
await copyFile(join(here, 'worker.js'), join(out, '_worker.js')); // Pages 用 _worker.js 走高级模式
await copyFile(join(here, 'iterate.js'), join(out, 'iterate.js')); // 云端迭代模块

let count = 0;
async function walk(dir) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p);
    else count++;
  }
}
await walk(out);
console.log('   ' + count + ' 个文件');

console.log('2/5 建项目 ' + project);
let r = await api(`/accounts/${account}/pages/projects`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: project, production_branch: 'main' })
});
if (r.status === 200 || r.status === 201) console.log('   已创建');
else if (JSON.stringify(r.data).includes('already exists')) console.log('   已存在，复用');
else if (r.status !== 409) {
  console.log('   建项目返回', r.status, JSON.stringify(r.data).slice(0, 240));
  process.exit(1);
}

console.log('3/5 写环境变量');
const adminPwd = process.env.XN_ADMIN_PASSWORD || '';
const kvId = process.env.XN_KV_ID || '';

const envVars = {
  XN_BASE: { type: 'plain_text', value: base },
  XN_MODEL: { type: 'plain_text', value: model }
};
if (adminPwd) envVars.XN_ADMIN_PASSWORD = { type: 'secret_text', value: adminPwd };
if (process.env.XN_REPO_OWNER) envVars.XN_REPO_OWNER = { type: 'plain_text', value: process.env.XN_REPO_OWNER };
if (process.env.XN_REPO_NAME) envVars.XN_REPO_NAME = { type: 'plain_text', value: process.env.XN_REPO_NAME };
if (process.env.XN_GH_TOKEN) envVars.XN_GH_TOKEN = { type: 'secret_text', value: process.env.XN_GH_TOKEN };
if (process.env.XN_EXTRA_HOSTS) envVars.XN_EXTRA_HOSTS = { type: 'plain_text', value: process.env.XN_EXTRA_HOSTS };
if (modelKey) envVars.XN_API_KEY = { type: 'secret_text', value: modelKey };

r = await api(`/accounts/${account}/pages/projects/${project}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deployment_configs: {
      production: {
        env_vars: envVars,
        ai_bindings: { AI: {} },
        ...(kvId ? { kv_namespaces: { XN_KV: { namespace_id: kvId } } } : {})
      }
    }
  })
});
if (r.status === 200 && r.data.success) {
  console.log('   ' + Object.keys(envVars).join(' / ') + (modelKey ? '（含 Key）' : '（没给 Key）'));
} else {
  console.log('   写变量失败', r.status, JSON.stringify(r.data).slice(0, 240));
}

console.log('4/5 上传');
const wr = spawnSync('npx', ['--yes', 'wrangler', 'pages', 'deploy', '.pages',
  '--project-name=' + project, '--branch=main', '--commit-dirty=true'], {
  stdio: 'inherit', cwd: here, env: process.env, shell: true
});
if (wr.status !== 0) { console.error('上传失败'); process.exit(1); }

console.log('5/5 收尾');
const site = `https://${project}.pages.dev`;
await writeFile(join(root, '.deploy-url.txt'), site + '\n', 'utf8');
console.log('   线上地址：' + site);
console.log('   健康检查：' + site + '/api/health');
