/* 无浏览器冒烟测试：起一个真后端 + 假模型，验证接口、鉴权、SSRF 与静态托管。
 * 用法：node tests/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'smoke-admin';
const MODEL_KEY = 'test-key';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务没起来：' + url);
}

const dataDir = await mkdtemp(join(tmpdir(), 'xn-smoke-'));
const mockPort = await freePort();
const appPort = await freePort();

const realMock = spawn('python', ['tests/mock_llm.py'], {
  cwd: root,
  stdio: 'ignore',
  windowsHide: true,
  env: Object.assign({}, process.env, { MOCK_PORT: String(mockPort), MOCK_KEY: MODEL_KEY })
});

const app = spawn('python', ['server/app.py', '--port', String(appPort)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, {
    XN_BASE: `http://127.0.0.1:${mockPort}/v1`,
    XN_API_KEY: MODEL_KEY,
    XN_ADMIN_PASSWORD: PASSWORD,
    XN_ADMIN_SECRET: 'smoke-secret',
    XN_DATA_DIR: dataDir,
    XN_GATEWAY_BASE: 'http://127.0.0.1:8790/v1',
    XN_GATEWAY_MODEL: 'smoke-model'
  })
});

let appLog = '';
app.stderr.on('data', (d) => { appLog += String(d); });
app.stdout.on('data', (d) => { appLog += String(d); });

const base = `http://127.0.0.1:${appPort}`;
let failed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log('PASS  ' + name),
    (e) => { failed++; console.error('FAIL  ' + name + '\n      ' + (e.message || e)); }
  );
}

try {
  await waitFor(base + '/api/health');
  await new Promise((r) => setTimeout(r, 400));

  await check('首页 200 且带 CSP', async () => {
    const res = await fetch(base + '/index.html');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(await res.text(), /<title>小暖<\/title>/);
  });

  await check('静态目录不允许穿越', async () => {
    const res = await fetch(base + '/../server/app.py');
    assert.ok([403, 404].includes(res.status), 'status=' + res.status);
  });

  await check('非 assets 路径不暴露源码', async () => {
    const res = await fetch(base + '/server/app.py');
    assert.equal(res.status, 404);
  });

  await check('配置接口可用', async () => {
    const j = await (await fetch(base + '/api/config')).json();
    assert.equal(j.proxy, true);
    assert.equal(j.gateway.base, 'http://127.0.0.1:8790/v1');
    assert.equal(j.gateway.model, 'smoke-model');
  });

  await check('普通对话可用（非流式）', async () => {
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }] })
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.match(j.choices[0].message.content, /假上游/);
  });

  await check('流式对话返回 SSE', async () => {
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: '流式' }] })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /^data: /m);
    assert.match(text, /\[DONE\]/);
  });

  await check('管理密码错误 401', async () => {
    const res = await fetch(base + '/api/admin/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    });
    assert.equal(res.status, 401);
  });

  let token = '';
  await check('管理密码正确换到令牌', async () => {
    const res = await fetch(base + '/api/admin/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.token && j.token.includes('.'));
    token = j.token;
  });

  await check('反馈读取必须带令牌', async () => {
    const res = await fetch(base + '/api/feedback');
    assert.equal(res.status, 401);
  });

  await check('反馈写入与读取', async () => {
    const post = await fetch(base + '/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: '想法', body: '冒烟测试反馈', contact: 'test' })
    });
    assert.equal(post.status, 200);
    const res = await fetch(base + '/api/feedback', { headers: { 'X-Admin-Token': token } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.items.some((x) => x.body === '冒烟测试反馈'));
  });

  await check('SSRF：127.0.0.1 被拒', async () => {
    const res = await fetch(base + '/api/fetch?url=' + encodeURIComponent('http://127.0.0.1:' + appPort + '/api/health'));
    assert.equal(res.status, 403);
  });

  await check('SSRF：十六进制 IP 被拒', async () => {
    const res = await fetch(base + '/api/fetch?url=' + encodeURIComponent('http://0x7f.0.0.1/'));
    assert.equal(res.status, 403);
  });

  await check('SSRF：云元数据地址被拒', async () => {
    const res = await fetch(base + '/api/fetch?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'));
    assert.equal(res.status, 403);
  });

  await check('迭代接口必须带令牌', async () => {
    const res = await fetch(base + '/api/iterate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(res.status, 401);
  });

  await check('迭代试运行可用', async () => {
    const res = await fetch(base + '/api/iterate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ dryRun: true })
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.dryRun, true);
    assert.match(j.version, /^1\.\d+\.\d+$/);
  });

  await check('请求体过大返回 413', async () => {
    const res = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(300000) }] })
    });
    assert.equal(res.status, 413);
  });

  await check('JSON 接口没有通配 CORS', async () => {
    const res = await fetch(base + '/api/config', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  if (failed) {
    console.error('\n后端日志：\n' + appLog.slice(-2000));
    process.exitCode = 1;
  } else {
    console.log('\n全部冒烟检查通过');
  }
} finally {
  app.kill();
  realMock.kill();
  await new Promise((r) => setTimeout(r, 200));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
