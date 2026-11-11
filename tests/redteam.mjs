/* 小暖 · 红队演练脚本（打自己的本地后端）
 *
 * 覆盖：SSRF、路径穿越、鉴权/令牌、CORS-CSRF、请求体、限流、配置泄漏、
 *       自迭代越权写入。
 * 用法：node tests/redteam.mjs
 * 退出码：0 = 全部防住；1 = 有缺口（会打印明细）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 6200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'redteam-admin';
const results = [];

function record(area, name, pass, detail) {
  results.push({ area, name, pass, detail: detail == null ? '' : String(detail).slice(0, 160) });
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ Origin: BASE, 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch (e) { return null; } })() };
}

const MOCK_PORT = PORT + 1;
const mock = spawn('python', ['tests/mock_llm.py'], {
  cwd: process.cwd(),
  env: Object.assign({}, process.env, { MOCK_PORT: String(MOCK_PORT), MOCK_KEY: 'redteam-key', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
  stdio: 'ignore',
  windowsHide: true
});
await new Promise((r) => setTimeout(r, 1500));

const dataDir = await mkdtemp(join(tmpdir(), 'xn-redteam-'));
const server = spawn('python', ['server/app.py', '--port', String(PORT)], {
  cwd: process.cwd(),
  env: Object.assign({}, process.env, {
    XN_ADMIN_PASSWORD: PASSWORD,
    XN_BASE: 'http://127.0.0.1:' + MOCK_PORT + '/v1',
    XN_API_KEY: 'redteam-key',
    XN_ADMIN_SECRET: 'redteam-secret',
    XN_DATA_DIR: dataDir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }),
  stdio: 'ignore',
  windowsHide: true
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const up = await waitUp();
record('环境', '后端起来', up, up ? BASE : 'timeout');

try {
  /* ---------- 1. SSRF ---------- */
  const ssrfTargets = [
    ['本机回环', 'http://127.0.0.1:' + PORT + '/api/health'],
    ['localhost 域名', 'http://localhost/'],
    ['十进制 IP', 'http://2130706433/'],
    ['十六进制 IP', 'http://0x7f000001/'],
    ['八进制 IP', 'http://0177.0.0.1/'],
    ['IPv6 回环', 'http://[::1]/'],
    ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
    ['内网段', 'http://10.0.0.1/'],
    ['file 协议', 'file:///etc/passwd'],
    ['gopher 协议', 'gopher://127.0.0.1:6379/_INFO']
  ];
  for (const [label, url] of ssrfTargets) {
    const r = await req('/api/fetch?url=' + encodeURIComponent(url));
    const blocked = r.status === 403 || r.status === 400 || r.status === 415 || (r.json && r.json.ok === false);
    record('SSRF', label, blocked, r.status + ' ' + (r.json && r.json.error ? r.json.error : ''));
  }

  /* ---------- 2. 路径穿越 / 静态托管 ---------- */
  const traversal = [
    '/assets/../../server/app.py',
    '/assets/..%2f..%2fserver%2fapp.py',
    '/assets/%2e%2e%2f%2e%2e%2fserver/app.py',
    '/server/app.py',
    '/assets/....//server/app.py'
  ];
  for (const p of traversal) {
    const r = await req(p);
    const blocked = r.status === 403 || r.status === 404;
    record('路径穿越', p, blocked, r.status);
  }

  /* ---------- 3. 鉴权 / 令牌 ---------- */
  const noAuth = await req('/api/iterate', { method: 'POST', body: '{}' });
  record('自迭代越权', '未登录只能试运行', noAuth.status === 200 && noAuth.json && noAuth.json.dryRun === true, noAuth.status + ' ' + (noAuth.json && noAuth.json.dryRun));

  const forged = await req('/api/iterate', {
    method: 'POST',
    headers: { 'X-Admin-Token': 'forged.token.value' },
    body: JSON.stringify({ dryRun: false })
  });
  record('自迭代越权', '伪造令牌不能真跑', forged.status === 200 && forged.json && forged.json.dryRun === true, forged.status);

  const adminInAuth = await req('/api/chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-admin' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  record('鉴权', '/api/chat 拒绝把令牌当模型 Key', adminInAuth.status === 400 || adminInAuth.status === 401 || adminInAuth.status === 403, adminInAuth.status);

  const verify = await req('/api/admin/verify', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  record('鉴权', '错误管理密码被拒', verify.status === 401, verify.status);

  /* ---------- 4. CORS / CSRF ---------- */
  const crossSite = await req('/api/fetch?url=' + encodeURIComponent('https://example.com'), {
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }
  });
  record('CSRF', '跨站 Origin 被拒', crossSite.status === 403, crossSite.status);

  const noOrigin = await fetch(BASE + '/api/health');
  record('CSRF', '健康检查不需要 Origin（只读）', noOrigin.status === 200, noOrigin.status);

  const preflight = await fetch(BASE + '/api/feedback', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
  });
  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  record('CORS', '预检不回通配 *', allowOrigin !== '*', allowOrigin || '(none)');

  /* ---------- 5. 请求体 / 解析 ---------- */
  const huge = await req('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(300000) }] }) });
  record('请求体', '超大请求体 413', huge.status === 413, huge.status);

  const badJson = await fetch(BASE + '/api/feedback', {
    method: 'POST',
    headers: { Origin: BASE, 'Content-Type': 'application/json' },
    body: '{"body":'
  });
  record('请求体', '坏 JSON 400', badJson.status === 400, badJson.status);

  /* ---------- 6. 限流 ---------- */
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await req('/api/feedback', { method: 'POST', body: JSON.stringify({ body: 'redteam spam ' + i }) });
    if (r.status === 429) { limited = true; break; }
  }
  record('限流', '反馈提交会触发 429', limited);

  /* ---------- 7. 配置泄漏 ---------- */
  const cfg = await req('/api/config');
  const raw = (cfg.text || '').toLowerCase();
  const leak = ['xn_gh_token', 'secret', 'password', 'bearer ', 'sk-'].filter((k) => raw.includes(k));
  record('配置泄漏', '/api/config 不吐密钥', leak.length === 0, leak.join(',') || 'clean');

  /* ---------- 8. XSS 存储 ---------- */
  await req('/api/feedback', { method: 'POST', body: JSON.stringify({ body: '<img src=x onerror=alert(1)>', type: '想法' }) });
  const stored = await req('/api/config');
  record('XSS', '反馈入库不影响配置', stored.status === 200, stored.status);
} finally {
  server.kill();
  mock.kill();
}

const failed = results.filter((r) => !r.pass);
console.log('\n=== 红队演练结果 ===');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.area}] ${r.name}  ${r.detail}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
