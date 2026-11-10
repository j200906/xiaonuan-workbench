/* Worker 路由与安全边界检查（不需要联网、不需要模型）。
 * 用法：node cloudflare/test.mjs
 */
import worker from './worker.js';

const ASSETS = {
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname.endsWith('.js')) {
      return new Response('window.x=1', { headers: { 'Content-Type': 'application/javascript' } });
    }
    return new Response('<html><title>小暖</title></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

const env = {
  ASSETS,
  XN_REPO_OWNER: 'j200906',
  XN_REPO_NAME: 'xiaonuan-workbench',
  XN_ADMIN_PASSWORD: 'test-admin',
  XN_ADMIN_SECRET: 'test-secret',
  XN_GATEWAY_BASE: 'https://gw.example.com/v1',
  XN_GATEWAY_MODEL: 'gw-model',
  XN_EXTRA_HOSTS: 'gw.example.com'
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const req = (path, init) => new Request('https://x.test' + path, init);

let r = await worker.fetch(req('/api/health'), env);
let j = await r.json();
check('健康检查', j.ok === true && j.hasKey === false, JSON.stringify(j));

r = await worker.fetch(req('/api/config'), env);
j = await r.json();
check('配置接口下发网关与仓库锁', j.gateway.base === 'https://gw.example.com/v1' && j.repo.locked === true, JSON.stringify(j));
check('配置接口没有通配 CORS', r.headers.get('access-control-allow-origin') === null);

r = await worker.fetch(req('/'), env);
const html = await r.text();
check('静态资源走 ASSETS', html.includes('小暖'), html.slice(0, 20));
check('HTML 带 CSP 与 X-Frame-Options', !!r.headers.get('content-security-policy') && r.headers.get('x-frame-options') === 'DENY');

r = await worker.fetch(req('/api/admin/verify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'wrong' })
}), env);
check('管理密码错误 401', r.status === 401);

r = await worker.fetch(req('/api/admin/verify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'test-admin' })
}), env);
j = await r.json();
check('管理密码正确换令牌', r.status === 200 && typeof j.token === 'string' && j.token.includes('.'));
const token = j.token;

r = await worker.fetch(req('/api/iterate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
}), env);
let itBody = await r.json();
check('迭代不再要求密码（无令牌进公开模式）', r.status !== 401 && itBody.publicMode === true);

r = await worker.fetch(req('/api/iterate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'fake.token' },
  body: '{}'
}), env);
itBody = await r.json();
check('迭代假令牌同样进公开模式', r.status !== 401 && itBody.publicMode === true);

r = await worker.fetch(req('/api/search?q=test', {
  headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }
}), env);
check('搜索跨站被拒', r.status === 403);

r = await worker.fetch(req('/api/fetch?url=' + encodeURIComponent('http://127.0.0.1/')), env);
check('抓网页拒绝内网', r.status === 403);

r = await worker.fetch(req('/api/feedback', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: '想法', body: '测试' })
}), env);
j = await r.json();
check('反馈可提交（无 KV 时只回执）', r.status === 200 && j.ok === true);

r = await worker.fetch(req('/api/feedback'), env);
check('反馈读取无令牌 401', r.status === 401);

r = await worker.fetch(req('/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
}), env);
j = await r.json();
check('没配模型时 503 且不假装成功', r.status === 503 && j.ok === false);

r = await worker.fetch(req('/api/chat', { method: 'POST', body: '{}' }), env);
check('缺 messages 被挡', r.status === 400);

r = await worker.fetch(req('/api/nope'), env);
check('未知接口 404', r.status === 404);

/* ---------- 公开迭代与网关下发（3 条，各用独立 env 副本，不影响上面 16 条） ---------- */

/* 1) 不带管理令牌的 POST /api/iterate 仍返回 200，且响应标了 publicMode 与公开试跑分支。
 *    测试不联网：dryRun + triageOnly 在没有 KV 时直接回 200 空工单（真实 dryRun 会去读
 *    GitHub 仓库与模型），正好覆盖 worker 给公开模式补 { publicMode, branch } 的那段逻辑。
 *    分支期望：默认 iterate/public；env 配了 XN_PUBLIC_ITERATE_BRANCH 就用它。 */
const envPublicDefault = { ...env };
delete envPublicDefault.XN_PUBLIC_ITERATE_BRANCH;
const envPublicCanary = { ...env, XN_PUBLIC_ITERATE_BRANCH: 'iterate/public-canary' };
const publicProbe = (e) => worker.fetch(req('/api/iterate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dryRun: true, triageOnly: true })
}), e);
const pubDefault = await publicProbe(envPublicDefault);
const pubDefaultBody = await pubDefault.json();
const pubCanary = await publicProbe(envPublicCanary);
const pubCanaryBody = await pubCanary.json();
check('公开迭代：无令牌 200 + publicMode + 公开分支（默认 / XN_PUBLIC_ITERATE_BRANCH）',
  pubDefault.status === 200 && pubDefaultBody.publicMode === true && pubDefaultBody.branch === 'iterate/public' &&
  pubCanary.status === 200 && pubCanaryBody.publicMode === true && pubCanaryBody.branch === 'iterate/public-canary',
  `默认 status=${pubDefault.status} branch=${pubDefaultBody.branch}；自定义 status=${pubCanary.status} branch=${pubCanaryBody.branch}`);

/* 2) XN_GATEWAY_BASE 为空时不能下发出「可用」的网关：应该干脆不带 gateway 字段，
 *    或者至少 base 为空（b85 改成整体省略；两种都算过，其余一律不认）。 */
const envNoGateway = { ...env, XN_GATEWAY_BASE: '', XN_GATEWAY_MODEL: '' };
r = await worker.fetch(req('/api/config'), envNoGateway);
j = await r.json();
check('配置：网关地址为空时不下发可用网关（无 gateway 或 base 为空）',
  !j.gateway || !String(j.gateway.base || '').trim(),
  JSON.stringify(j.gateway || null));

/* 3) 运维没显式验证过（XN_GATEWAY_VERIFIED 未设）就不能声称网关可用：
 *    reachableHint 只能是 false 或干脆没有；值为 true 一律算错。 */
const envUnverifiedGateway = { ...env };
delete envUnverifiedGateway.XN_GATEWAY_VERIFIED;
r = await worker.fetch(req('/api/config'), envUnverifiedGateway);
j = await r.json();
check('配置：未设 XN_GATEWAY_VERIFIED 时不声称网关可用',
  !j.gateway || j.gateway.reachableHint !== true,
  JSON.stringify(j.gateway || null));

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
