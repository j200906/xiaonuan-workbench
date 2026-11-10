/* Cloudflare Pages 一条命令部署（页面 + Functions 一体）
 *
 * 为什么不用 Workers：workers.dev 在国内被 DNS 污染（解析到 65.49.x / Facebook 段），
 * pages.dev 解析正常，所以走 Pages。
 *
 * 重要：这是 Direct Upload（不是 Git 集成）——push main 不会更新 pages.dev，
 * 必须本机跑这个脚本。GitHub Pages（github.io）走的是另一条线（纯静态，无 /api）。
 *
 * 用法：
 *   node cloudflare/deploy_pages.mjs [项目名]                 # 默认 dry-run：只组装不部署
 *   node cloudflare/deploy_pages.mjs [项目名] --apply         # 真部署（只发文件，不动环境变量）
 *   node cloudflare/deploy_pages.mjs [项目名] --apply --env --yes
 *                                                            # 连环境变量一起写（危险，见下）
 *
 * 为什么默认 dry-run：真部署会改线上，先让人看一眼产物和计划。
 * 为什么 --env 还要 --yes：环境变量是整表 PATCH，secret_text 读不回来——少带一个
 * secret 就会把线上那个清空。没带 --yes 一律拒绝，避免误触。
 *
 * 环境变量（.env 或命令行）：
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / XN_ADMIN_PASSWORD / XN_ADMIN_SECRET
 *   XN_KV_ID（可选）/ XN_REPO_OWNER / XN_REPO_NAME ...
 *
 * Q86：产物里的 _worker.js 有 `import './iterate.js'` 等相对导入。`wrangler pages deploy`
 * 默认会用 esbuild 打包 _worker.js（不要加 --no-bundle；也不要用控制台拖拽，拖拽不打包）。
 * 本脚本先用 scripts/build-pages.mjs 统一组装，它会校验每个相对 import 都能找到文件。
 */
import { writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* .env 是最容易漏传环境变量的地方：能读就读，读不到再用命令行。 */
try {
  const envText = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] == null) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch (e) { /* 没有 .env 就跳过 */ }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, '.pages');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const projectArg = argv.find((a) => !a.startsWith('--'));
const project = projectArg || process.env.XN_PAGES_PROJECT || 'xiaonuan-app';
const apply = flags.has('--apply');
const dryRun = !apply;
const envMode = flags.has('--env');
const yes = flags.has('--yes');

if (envMode && apply && !yes) {
  console.error('拒绝执行：--env 会整表 PATCH 环境变量，secret_text 读不回来，漏一个就清空一个。');
  console.error('确认 secret 都带齐了，再加 --yes（例如：--apply --env --yes）。');
  process.exit(2);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const modelKey = process.env.XN_API_KEY || '';
const base = process.env.XN_BASE || 'https://api.deepseek.com/v1';
const model = process.env.XN_MODEL || 'deepseek-chat';

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

console.log(`1/4 组装静态文件${dryRun ? '（dry-run）' : ''}`);
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-pages.mjs')], { stdio: 'inherit', cwd: root });
if (build.status !== 0) { console.error('组装失败'); process.exit(1); }

console.log('2/4 环境变量');
const envVars = {
  XN_BASE: { type: 'plain_text', value: base },
  XN_MODEL: { type: 'plain_text', value: model }
};
if (process.env.XN_ADMIN_PASSWORD) envVars.XN_ADMIN_PASSWORD = { type: 'secret_text', value: process.env.XN_ADMIN_PASSWORD };
if (process.env.XN_REPO_OWNER) envVars.XN_REPO_OWNER = { type: 'plain_text', value: process.env.XN_REPO_OWNER };
if (process.env.XN_REPO_NAME) envVars.XN_REPO_NAME = { type: 'plain_text', value: process.env.XN_REPO_NAME };
if (process.env.XN_GH_TOKEN) envVars.XN_GH_TOKEN = { type: 'secret_text', value: process.env.XN_GH_TOKEN };
if (process.env.XN_EXTRA_HOSTS) envVars.XN_EXTRA_HOSTS = { type: 'plain_text', value: process.env.XN_EXTRA_HOSTS };
if (process.env.XN_ALLOWED_ORIGINS) envVars.XN_ALLOWED_ORIGINS = { type: 'plain_text', value: process.env.XN_ALLOWED_ORIGINS };
if (process.env.XN_ALLOWED_MODELS) envVars.XN_ALLOWED_MODELS = { type: 'plain_text', value: process.env.XN_ALLOWED_MODELS };
if (process.env.XN_GATEWAY_BASE) envVars.XN_GATEWAY_BASE = { type: 'plain_text', value: process.env.XN_GATEWAY_BASE };
if (process.env.XN_GATEWAY_MODEL) envVars.XN_GATEWAY_MODEL = { type: 'plain_text', value: process.env.XN_GATEWAY_MODEL };
if (process.env.XN_ITER_MODEL) envVars.XN_ITER_MODEL = { type: 'plain_text', value: process.env.XN_ITER_MODEL };
if (process.env.XN_ADMIN_SECRET) envVars.XN_ADMIN_SECRET = { type: 'secret_text', value: process.env.XN_ADMIN_SECRET };
if (modelKey) envVars.XN_API_KEY = { type: 'secret_text', value: modelKey };

if (!envMode) {
  console.log('   跳过：默认不改线上变量（确实要改就加 --env --yes）');
} else {
  console.log('   计划写入：' + Object.keys(envVars).join(' / ') + (modelKey ? '（含 Key）' : '（没给 Key）'));
  if (token && account) {
    /* 只读 GET，dry-run 也安全：把“这次没带、会被清空”的 secret 先说出来。 */
    const current = await api(`/accounts/${account}/pages/projects/${project}`);
    const prod = (current.data && current.data.result &&
      current.data.result.deployment_configs &&
      current.data.result.deployment_configs.production) || {};
    const existingVars = prod.env_vars || {};
    const dropped = Object.keys(existingVars)
      .filter((k) => existingVars[k].type === 'secret_text' && !(k in envVars));
    if (dropped.length) console.log('   ⚠ 这次没带、将被清空：' + dropped.join(', '));
    else console.log('   线上现有 secret 都已带上（没发现会被清空的键）');
  } else {
    console.log('   未联网核对线上 secret（缺 token/account，或 dry-run 不想联网）');
  }
}

if (dryRun) {
  console.log('3/4 上传：跳过（dry-run）');
  console.log('4/4 完成');
  console.log(`\nDryRun：产物在 cloudflare/.pages，未上传、未改环境变量。`);
  console.log(`确认要发布到 https://${project}.pages.dev：node cloudflare/deploy_pages.mjs ${project} --apply`);
  process.exit(0);
}

if (!token) { console.error('缺 CLOUDFLARE_API_TOKEN'); process.exit(2); }
if (!account) { console.error('缺 CLOUDFLARE_ACCOUNT_ID'); process.exit(2); }

console.log('3/4 建项目 ' + project);
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

if (envMode) {
  const current = await api(`/accounts/${account}/pages/projects/${project}`);
  const prod = (current.data && current.data.result &&
    current.data.result.deployment_configs &&
    current.data.result.deployment_configs.production) || {};
  const kvId = process.env.XN_KV_ID || '';
  r = await api(`/accounts/${account}/pages/projects/${project}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deployment_configs: {
        production: {
          env_vars: envVars,
          ai_bindings: { AI: {} },
          kv_namespaces: kvId ? { XN_KV: { namespace_id: kvId } } : (prod.kv_namespaces || {})
        }
      }
    })
  });
  if (r.status === 200 && r.data.success) {
    console.log('   已写入 ' + Object.keys(envVars).join(' / '));
  } else {
    console.log('   写变量失败', r.status, JSON.stringify(r.data).slice(0, 240));
    process.exit(1);
  }
}

console.log('4/4 上传（wrangler 默认打包 _worker.js）');
const wr = spawnSync('npx', ['--yes', 'wrangler', 'pages', 'deploy', '.pages',
  '--project-name=' + project, '--branch=main', '--commit-dirty=true'], {
  stdio: 'inherit', cwd: here, env: process.env, shell: true
});
if (wr.status !== 0) { console.error('上传失败'); process.exit(1); }

const site = `https://${project}.pages.dev`;
await writeFile(join(root, '.deploy-url.txt'), site + '\n', 'utf8');
console.log('   线上地址：' + site);
console.log('   健康检查：' + site + '/api/health');
console.log('   注意：push main 不会自动更新这里，下次改动仍要重跑本脚本。');
