/* 无浏览器冒烟测试：起一个真后端 + 假模型，验证接口、鉴权、SSRF 与静态托管。
 * 用法：node tests/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'smoke-admin';
const MODEL_KEY = 'test-key';

/* 续读测试的假上游页面：30000 字长文。第二个后端实例用下面的包装脚本把它塞进 safe_fetch，
 * 所以整条链路不联网（DoH 和真实 HTTP 都不会发生），但走的还是真后端、真路由、真的分页逻辑。 */
const FAKE_PAGE_CHARS = 30000;
const FAKE_FETCH_APP = [
  '# 由 tests/smoke.mjs 生成：起一个跟 server/app.py 一样的后端，只把抓网页的出口换成假页面。',
  'import os, sys',
  'sys.path.insert(0, os.getcwd())',
  'import server.app as app',
  '',
  "PAGE = ('<html><head><title>长页面</title></head><body><p>' + ('甲' * " + FAKE_PAGE_CHARS + ") + '</p></body></html>')",
  'PAGE_BYTES = PAGE.encode("utf-8")',
  '',
  'class FakeResp:',
  '    status = 200',
  '    def __init__(self):',
  '        self.headers = {"Content-Type": "text/html; charset=utf-8"}',
  '    def read(self, n=None):',
  '        return PAGE_BYTES[:n] if n else PAGE_BYTES',
  '    def __enter__(self):',
  '        return self',
  '    def __exit__(self, *a):',
  '        return False',
  '',
  'real_safe_fetch = app.safe_fetch',
  '',
  'def fake_safe_fetch(raw, timeout=15):',
  '    url = str(raw)',
  '    if "fake.test" in url:',
  '        return FakeResp(), url',
  '    return real_safe_fetch(raw, timeout)',
  '',
  'app.safe_fetch = fake_safe_fetch',
  '',
  "if __name__ == '__main__':",
  '    app.main()',
  ''
].join('\n');

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
  env: Object.assign({}, process.env, {
    MOCK_PORT: String(mockPort), MOCK_KEY: MODEL_KEY,
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
  })
});

const appEnv = Object.assign({}, process.env, {
  XN_BASE: `http://127.0.0.1:${mockPort}/v1`,
  XN_API_KEY: MODEL_KEY,
  XN_ADMIN_PASSWORD: PASSWORD,
  XN_ADMIN_SECRET: 'smoke-secret',
  XN_DATA_DIR: dataDir,
  XN_GATEWAY_BASE: 'http://127.0.0.1:8790/v1',
  XN_GATEWAY_MODEL: 'smoke-model',
  PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
});

const app = spawn('python', ['server/app.py', '--port', String(appPort)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: appEnv
});

/* 第二个后端实例：出口换成假页面，只用来验 /api/fetch 的续读（不联网）。 */
const fakePort = await freePort();
const fakeAppPath = join(dataDir, 'fake_fetch_app.py');
await writeFile(fakeAppPath, FAKE_FETCH_APP, 'utf8');
const fakePageApp = spawn('python', [fakeAppPath, '--port', String(fakePort)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: appEnv
});
let fakeLog = '';
fakePageApp.stdout.on('data', (d) => { fakeLog += String(d); });
fakePageApp.stderr.on('data', (d) => { fakeLog += String(d); });

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

  await check('反馈删除：没令牌 401', async () => {
    const res = await fetch(base + '/api/feedback?all=1', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

  await check('反馈删除：管理员可以清空', async () => {
    const del = await fetch(base + '/api/feedback?all=1', {
      method: 'DELETE', headers: { 'X-Admin-Token': token }
    });
    assert.equal(del.status, 200);
    const dj = await del.json();
    assert.equal(dj.ok, true);
    assert.ok(dj.deleted >= 1, '至少删掉刚才那条');
    const res = await fetch(base + '/api/feedback', { headers: { 'X-Admin-Token': token } });
    const j = await res.json();
    assert.equal(j.items.filter((x) => x.body === '冒烟测试反馈').length, 0, '删完不该再读出来');
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

  /* 续读（AUDIT #47）：本地后端跑同一套 offset 契约。第二个后端实例把出口换成了 30000 字的假页面，
     所以这里不联网；但请求走的是真路由、真分页逻辑。两条都要等 K2 落地后才会绿。 */
  const fakeBase = `http://127.0.0.1:${fakePort}`;
  await waitFor(fakeBase + '/api/health');
  const fakeUrl = encodeURIComponent('https://fake.test/long');
  let pagingTotal = null;

  await check('续读：offset=12000 的正文从第 12000 字开始', async () => {
    const get = async (qs) => {
      const res = await fetch(`${fakeBase}/api/fetch?url=${fakeUrl}${qs}`);
      return { status: res.status, body: await res.json() };
    };
    const head = await get('');
    const mid = await get('&offset=6000');
    const tail = await get('&offset=12000');
    assert.equal(tail.status, 200, 'HTTP ' + tail.status);
    assert.equal(tail.body.ok, true, JSON.stringify(tail.body).slice(0, 160));
    assert.equal(head.body.ok, true, '不带 offset 的基线请求也要正常');
    const headText = String(head.body.text || '');
    const midText = String(mid.body.text || '');
    const tailText = String(tail.body.text || '');
    const total = Number(tail.body.total);
    pagingTotal = total;
    assert.ok(headText.length > 0, '基线正文不能是空的');
    assert.ok(total > 12000, 'total=' + total + '（后端要回 total，且假页面够长）');
    /* 不假设窗口多大：用 offset=6000 的窗口做重叠对齐。 */
    assert.ok(midText.length > 6000, 'offset=6000 的窗口太短：' + midText.length);
    assert.ok(tailText.length > 0, 'offset=12000 应该有正文');
    assert.ok(tailText.startsWith(midText.slice(6000)), '正文对不上：不是从第 12000 字开始');
    const next = tail.body.nextOffset;
    assert.equal(typeof next, 'number', '响应要带 nextOffset');
    const more = 12000 + tailText.length < total;
    assert.ok(more ? next === 12000 + tailText.length : (next === 0 || next >= total),
      'nextOffset=' + next + ' total=' + total + ' tailLen=' + tailText.length);
  });

  await check('续读：offset 超长返回空文本且不 500', async () => {
    const res = await fetch(`${fakeBase}/api/fetch?url=${fakeUrl}&offset=999999`);
    assert.equal(res.status, 200, 'HTTP ' + res.status);
    const j = await res.json();
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 160));
    const overText = String(j.text || '');
    assert.equal(overText.length, 0, '超长 offset 应该回空正文，实际 ' + overText.length + ' 字：' + overText.slice(0, 40));
    assert.equal(typeof j.total, 'number', '响应要带 total');
    if (pagingTotal != null) assert.equal(j.total, pagingTotal, 'total 不该随 offset 变');
  });

  await check('迭代接口未解锁时只给试运行', async () => {
    const res = await fetch(base + '/api/iterate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.publicMode, true);
    assert.equal(j.dryRun, true);
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
    if (fakeLog.trim()) console.error('\n假页面后端日志：\n' + fakeLog.slice(-1000));
    process.exitCode = 1;
  } else {
    console.log('\n全部冒烟检查通过');
  }
} finally {
  app.kill();
  fakePageApp.kill();
  realMock.kill();
  await new Promise((r) => setTimeout(r, 200));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
