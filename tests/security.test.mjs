/* 安全边界回归：管理令牌版本、同源判定、反馈保留期/删除、Key 不串用。
 * 这些是 AUDIT-100-questions.md 里 Q89–Q94 的可执行版本。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../cloudflare/worker.js';
import { issueToken, verifyToken, sameOrigin } from '../cloudflare/shared.js';

const REPO_ENV = {
  XN_KV: null,
  XN_REPO_OWNER: 'j200906',
  XN_REPO_NAME: 'xiaonuan-workbench',
  XN_ADMIN_PASSWORD: 'test-admin',
  XN_ADMIN_SECRET: 'test-secret'
};

class MockKV {
  constructor() { this.map = new Map(); this.puts = []; }
  async get(key, type) {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key, value, opts) {
    this.puts.push({ key, opts: opts || {} });
    this.map.set(key, String(value));
  }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const names = [...this.map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

const req = (path, init) => new Request('https://x.test' + path, init);

test('管理令牌：版本号一改，旧会话立即失效', async () => {
  const t1 = await issueToken(REPO_ENV, 600);
  assert.equal(await verifyToken(REPO_ENV, t1), true);
  assert.equal(await verifyToken({ ...REPO_ENV, XN_ADMIN_TOKEN_VERSION: '2' }, t1), false, 'bump 版本应吊销旧令牌');
  assert.equal(await verifyToken(REPO_ENV, t1.slice(0, -2) + 'xx'), false, '签名被改要拒绝');
  const expired = await issueToken(REPO_ENV, -5);
  assert.equal(await verifyToken(REPO_ENV, expired), false, '过期令牌要拒绝');
});

test('同源：跨站一律拒，缺 Origin 看 XN_REQUIRE_ORIGIN', () => {
  const same = req('/api/feedback', { headers: { Origin: 'https://x.test' } });
  assert.equal(sameOrigin(same, REPO_ENV), true);

  const cross = req('/api/feedback', { headers: { Origin: 'https://evil.example' } });
  assert.equal(sameOrigin(cross, REPO_ENV), false);

  const crossSite = req('/api/feedback', { headers: { Origin: 'https://x.test', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(sameOrigin(crossSite, REPO_ENV), false, 'Sec-Fetch-Site: cross-site 必须拒');

  const noOrigin = req('/api/feedback');
  assert.equal(sameOrigin(noOrigin, REPO_ENV), true, '默认兼容非浏览器客户端');
  assert.equal(sameOrigin(noOrigin, { ...REPO_ENV, XN_REQUIRE_ORIGIN: '1' }), false, '严格模式缺 Origin 要拒');
});

test('反馈：保留期可配，默认 180 天', async () => {
  const kv = new MockKV();
  const env = { ...REPO_ENV, XN_KV: kv, XN_FEEDBACK_TTL_DAYS: '30' };
  const r = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test' },
    body: JSON.stringify({ type: '想法', body: '希望有夜间模式' })
  }), env);
  assert.equal(r.status, 200);
  const rec = [...kv.map.values()].map((s) => JSON.parse(s))[0];
  assert.equal(rec.retentionDays, 30);
  assert.equal(kv.puts[0].opts.expirationTtl, 30 * 86400);
  assert.ok(rec.ipHash && rec.ipHash !== '0.0.0.0', 'IP 只存哈希');
});

test('反馈：DELETE 要令牌，支持 all / id / before', async () => {
  const kv = new MockKV();
  const env = { ...REPO_ENV, XN_KV: kv };
  const post = () => worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test' },
    body: JSON.stringify({ type: '想法', body: '测试' })
  }), env);
  await post();
  await post();

  const noToken = await worker.fetch(req('/api/feedback?all=1', {
    method: 'DELETE', headers: { Origin: 'https://x.test' }
  }), env);
  assert.equal(noToken.status, 401);

  const token = await issueToken(env, 600);
  const noSelector = await worker.fetch(req('/api/feedback', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': token }
  }), env);
  const noSelBody = await noSelector.json();
  assert.equal(noSelBody.ok, false);

  const del = await worker.fetch(req('/api/feedback?all=1', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': token }
  }), env);
  const delBody = await del.json();
  assert.equal(delBody.ok, true);
  assert.equal(delBody.deleted, 2);
  assert.equal(kv.map.size, 0);
});

test('/api/chat：管理令牌不会被当模型 Key 转发，Key 也不回显', async () => {
  const env = { ...REPO_ENV, XN_API_KEY: 'server-key', XN_KV: null };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const r = await worker.fetch(req('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', 'X-Admin-Token': 'admin-token-value' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
    }), env);
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, 'Bearer server-key', '应使用服务端 Key，而不是 X-Admin-Token');
    assert.ok(!String(await r.clone().text()).includes('admin-token-value'));
  } finally {
    globalThis.fetch = original;
  }

  const original2 = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };
  try {
    const r = await worker.fetch(req('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', Authorization: 'Bearer sk-user-secret' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] })
    }), env);
    const body = await r.text();
    assert.equal(r.status, 502);
    assert.ok(!body.includes('sk-user-secret'), '错误信息不能回显用户 Key');
  } finally {
    globalThis.fetch = original2;
  }
});

test('跨站提交反馈被挡（Sec-Fetch-Site）', async () => {
  const env = { ...REPO_ENV, XN_KV: new MockKV() };
  const r = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ body: 'spam' })
  }), env);
  assert.equal(r.status, 403);
});

test('试运行单独计数：打满试运行不会吃掉真跑额度', async () => {
  const env = { ...REPO_ENV, XN_KV: new MockKV(), XN_GH_TOKEN: '' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const call = (dryRun) => worker.fetch(req('/api/iterate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test' },
    body: JSON.stringify({ dryRun })
  }), env);
  try {
    for (let i = 0; i < 8; i++) {
      const r = await call(true);
      assert.notEqual(r.status, 429, '第 ' + (i + 1) + ' 次试运行不该被限流');
    }
    const ninth = await call(true);
    assert.equal(ninth.status, 429, '公开模式试运行上限 8 次/小时');

    const realRun = await call(false);
    assert.notEqual(realRun.status, 429, '真跑额度不应被试运行消耗');
  } finally {
    globalThis.fetch = original;
  }
});
