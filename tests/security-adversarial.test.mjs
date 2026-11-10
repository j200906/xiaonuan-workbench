/* 对抗性安全复核 · Q89–Q94
 *
 * tests/security.test.mjs 证明「该守的守住了」，本文件反过来找「怎么绕过去」。
 *
 * 约定：
 *   - 标 [洞] 的用例断言的是**当前代码真实（有问题）的行为**，用来把洞钉死。
 *     修好之后这些用例会变红，那时把它改成 [应拒] 的写法即可 —— 这是有意的。
 *   - 标 [应拒] 的 test.skip 是对应的期望行为，修好后去掉 skip。
 *   - 本文件不改任何生产代码；只跑 mock KV + stub global.fetch，不连真实网络。
 *
 * 运行：node --test tests/security-adversarial.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import worker from '../cloudflare/worker.js';
import {
  issueToken, verifyToken, sameOrigin, corsHeaders,
  isPrivateHost, assertPublicUrl, rateLimit, safeBase, extraHosts
} from '../cloudflare/shared.js';

/* ---------- 夹具 ---------- */

const ADMIN_PASSWORD = 'test-admin';
const ADMIN_SECRET = 'test-secret';

const BASE_ENV = {
  XN_KV: null,
  XN_REPO_OWNER: 'j200906',
  XN_REPO_NAME: 'xiaonuan-workbench',
  XN_ADMIN_PASSWORD: ADMIN_PASSWORD,
  XN_ADMIN_SECRET: ADMIN_SECRET
};

/* 模拟 KV：带游标分页、读写计数，贴近真实 list/list_complete/cursor 语义。 */
class MockKV {
  constructor(seed) {
    this.map = new Map(seed || []);
    this.puts = [];
    this.gets = 0;
    this.deletes = 0;
  }
  async get(key, type) {
    this.gets++;
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }
  async put(key, value, opts) {
    this.puts.push({ key, opts: opts || {} });
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.deletes++;
    this.map.delete(key);
  }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const names = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const keys = names.slice(from, from + limit).map((name) => ({ name }));
    const done = from + keys.length >= names.length;
    return { keys, list_complete: done, cursor: done ? undefined : String(from + keys.length) };
  }
}

let ipSeq = 0;
/* 每个请求默认换一个来源 IP：这些接口都有 5–30 次/分钟的限流，
 * 用固定 IP 会让用例互相污染；要测限流的地方显式传 ip。 */
function req(path, { ip, headers, ...init } = {}) {
  const h = Object.assign(
    { 'CF-Connecting-IP': ip || '203.0.113.' + (++ipSeq % 240) },
    headers || {}
  );
  return new Request('https://x.test' + path, Object.assign({}, init, { headers: h }));
}

/* stub 掉 global.fetch，记录每一次调用；handler 决定返回什么。 */
async function stubFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: (init && init.body) || '' });
    return handler(String(url), init || {}, calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const okJson = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200, headers: { 'Content-Type': 'application/json' }
});
const okHtml = (body) => new Response(body || '<html><title>内网页面</title><body>secret</body></html>', {
  status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
});

const b64u = (buf) => Buffer.from(buf).toString('base64url');
/* 与 cloudflare/shared.js 的 hmac() 同算法：HMAC-SHA256(payload) → base64url（无 padding）。 */
function forge(secret, payload) {
  const p = b64u(JSON.stringify(payload));
  return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url');
}
const now = () => Math.floor(Date.now() / 1000);

const postJson = (path, body, { headers: extraHeaders, ...rest } = {}) => req(path, Object.assign({
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'https://x.test' }, extraHeaders || {}),
  body: JSON.stringify(body)
}, rest));

/* =====================================================================
 * 1. 管理令牌：能不能伪造 / 复用 / 绕过吊销
 * ===================================================================== */

test('令牌：payload 一改就废（exp / scope / ver 三个字段都试）', async () => {
  const env = BASE_ENV;
  const token = await issueToken(env, 600);
  const [p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());

  for (const patch of [{ exp: payload.exp + 99999 }, { exp: 4102444800 }, { scope: 'root' }, { ver: '2' }]) {
    const forged = b64u(JSON.stringify(Object.assign({}, payload, patch))) + '.' + s;
    assert.equal(await verifyToken(env, forged), false, '改 ' + Object.keys(patch)[0] + ' 还能过 = 签名没覆盖它');
  }
});

test('令牌：签名截断 / 加长 / 改一位都拒（constant-time 比较按长度先分胜负）', async () => {
  const env = BASE_ENV;
  const token = await issueToken(env, 600);
  const [p, s] = token.split('.');
  assert.equal(await verifyToken(env, p + '.' + s.slice(0, -1)), false, '截断一位');
  assert.equal(await verifyToken(env, p + '.' + s.slice(0, 12)), false, '只剩前缀');
  assert.equal(await verifyToken(env, p + '.' + s + 'A'), false, '尾部加长');
  assert.equal(await verifyToken(env, p + '.' + s.slice(0, -1) + (s.slice(-1) === 'A' ? 'B' : 'A')), false, '换最后一位');
});

test('令牌：结构不对的输入一律 false，不抛异常', async () => {
  const env = BASE_ENV;
  const token = await issueToken(env, 600);
  assert.equal(await verifyToken(env, token + '.extra'), false, '三段式');
  assert.equal(await verifyToken(env, ''), false);
  assert.equal(await verifyToken(env, null), false);
  assert.equal(await verifyToken(env, 'not-a-token'), false);
  assert.equal(await verifyToken(env, token.split('.')[0]), false, '只有 payload');
  assert.equal(await verifyToken({}, token), false, '服务端没 secret 时必须 false');
});

test('令牌：scope 不是 admin 的「签名正确」令牌也拒（越权令牌防线）', async () => {
  const env = BASE_ENV;
  const baseline = { exp: now() + 300, ver: '1' };
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...baseline, scope: 'user' })), false, 'scope=user 不能过');
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...baseline, scope: 'ADMIN' })), false, '大小写不同不算');
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...baseline })), false, '缺 scope 不算');
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...baseline, scope: 'admin' })), true, '对照组：正牌 admin 令牌能过');
});

test('令牌：exp 边界是「严格大于现在」，等于当前秒即过期', async () => {
  const env = BASE_ENV;
  const base = { scope: 'admin', ver: '1' };
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, exp: now() })), false, 'exp=now 应过期');
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, exp: now() - 1 })), false);
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, exp: now() + 2 })), true);
  const expired = await issueToken(env, -5);
  assert.equal(await verifyToken(env, expired), false, 'issueToken 负 TTL 也过期');
});

test('令牌：无 ver 的旧令牌无效；改版本号即全端下线（端到端走 /api/admin/check）', async () => {
  const env = BASE_ENV;
  const token = await issueToken(env, 600);
  assert.equal((await worker.fetch(req('/api/admin/check', { headers: { 'X-Admin-Token': token } }), env)).status, 200);
  assert.equal((await worker.fetch(req('/api/admin/check', { headers: { Authorization: 'Bearer ' + token } }), env)).status, 200, 'bearer() 也认 Authorization');

  const oldStyle = forge(ADMIN_SECRET, { exp: now() + 600, iat: now(), scope: 'admin' }); // 没有 ver
  assert.equal(await verifyToken(env, oldStyle), false, '老令牌（无 ver）必须失效');
  assert.equal((await worker.fetch(req('/api/admin/check', { headers: { 'X-Admin-Token': oldStyle } }), env)).status, 401);

  const bumped = { ...env, XN_ADMIN_TOKEN_VERSION: '2' };
  assert.equal((await worker.fetch(req('/api/admin/check', { headers: { 'X-Admin-Token': token } }), bumped)).status, 401, 'bump ver 后旧会话立即失效');
  assert.equal((await worker.fetch(req('/api/admin/check', { headers: { 'X-Admin-Token': await issueToken(bumped, 600) } }), bumped)).status, 200, '新版本可签发');
});

test('令牌：[洞-信息] jti 只生成不校验 —— 没有单会话吊销能力', async () => {
  const env = BASE_ENV;
  /* 三枚「签名正确」的令牌，jti 分别是空、重复、随机：verifyToken 全通过。
     也就是说 jti 目前是装饰品：管理员无法只踢掉某一个会话，
     只能改 XN_ADMIN_TOKEN_VERSION 把所有人一起下线（或等 exp）。 */
  const base = { exp: now() + 300, scope: 'admin', ver: '1', iat: now() };
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, jti: '' })), true);
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, jti: 'same' })), true);
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base, jti: 'same' })), true, '重复 jti 不去重');
  assert.equal(await verifyToken(env, forge(ADMIN_SECRET, { ...base })), true, '完全没有 jti 也过');

  /* 同时记录：issueToken 用 Math.random() 生成 jti，不是密码学随机。
     当前不影响安全（没人读它），但一旦拿来做撤销表就会踩坑。 */
  const issued = JSON.parse(Buffer.from((await issueToken(env, 60)).split('.')[0], 'base64url').toString());
  assert.equal(typeof issued.jti, 'string');
  assert.ok(issued.jti.length > 0);
});

test('令牌：[洞-信息] 只配密码不配 XN_ADMIN_SECRET 时，HMAC 密钥退化成明文密码', async () => {
  const passwordOnly = { XN_ADMIN_PASSWORD: 'weak-password-123' };
  /* 任何拿到过密码的人（或离线撞库成功的人）都能本地签发一张 12 小时的 admin 会话，
     根本不需要过 /api/admin/verify 的限流。建议把 XN_ADMIN_SECRET 设为必填。 */
  assert.equal(await verifyToken(passwordOnly, forge('weak-password-123', { exp: now() + 43200, scope: 'admin', ver: '1' })), true);
  assert.equal(await verifyToken(passwordOnly, forge('other-password', { exp: now() + 43200, scope: 'admin', ver: '1' })), false);
});

/* =====================================================================
 * 2. 同源判定：缺 Origin / 伪造 Sec-Fetch-Site / 白名单注入
 * ===================================================================== */

test('同源：缺 Origin 默认放行（为兼容 curl / 桌面壳），严格模式才拒', () => {
  const noOrigin = req('/api/feedback');
  assert.equal(sameOrigin(noOrigin, BASE_ENV), true, '默认放行：非浏览器客户端不带 Origin');
  assert.equal(sameOrigin(noOrigin, { ...BASE_ENV, XN_REQUIRE_ORIGIN: '1' }), false, 'XN_REQUIRE_ORIGIN=1 才变严格');
  /* 顺带证明：这条默认放行等价于「任何能自己发请求的客户端都不用装同源」——
     它不是 CSRF 防线，真正的 CSRF 防线是浏览器一定会带 Origin/Sec-Fetch-Site。 */
});

test('同源：[已修] XN_REQUIRE_ORIGIN 认 true/yes/on，缺 Origin 就拒', async () => {
  const noOrigin = req('/api/feedback');
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(sameOrigin(noOrigin, { ...BASE_ENV, XN_REQUIRE_ORIGIN: v }), false, 'XN_REQUIRE_ORIGIN=' + JSON.stringify(v) + ' 应开严格模式');
  }
  for (const v of ['', '0', 'false', 'off']) {
    assert.equal(sameOrigin(noOrigin, { ...BASE_ENV, XN_REQUIRE_ORIGIN: v }), true, 'XN_REQUIRE_ORIGIN=' + JSON.stringify(v) + ' 不该误开');
  }

  /* 端到端：写着 true 的部署，不带 Origin 的匿名 curl 会被 403 挡住 */
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv, XN_REQUIRE_ORIGIN: 'true' };
  const r = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '严格模式生效' })
  }), env);
  assert.equal(r.status, 403);
  assert.equal(kv.map.size, 0, '严格模式下缺 Origin 不该写进 KV');
});

test('同源：Sec-Fetch-Site: cross-site 一律拒（哪怕 Origin 说是同源）', () => {
  assert.equal(sameOrigin(req('/api/feedback', { headers: { Origin: 'https://x.test', 'Sec-Fetch-Site': 'cross-site' } }), BASE_ENV), false);
  assert.equal(sameOrigin(req('/api/feedback', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), BASE_ENV), false, '无 Origin 也拦');
  assert.equal(sameOrigin(req('/api/feedback', { headers: { Origin: 'https://x.test', 'Sec-Fetch-Site': 'same-origin' } }), BASE_ENV), true);
});

test('同源：[已修] Sec-Fetch-Site 大小写不敏感，CROSS-SITE 也拒', async () => {
  for (const v of ['CROSS-SITE', 'Cross-Site', 'cross-site']) {
    const sneaky = req('/api/feedback', { headers: { 'Sec-Fetch-Site': v } });
    assert.equal(sameOrigin(sneaky, BASE_ENV), false, v + ' 应被当成 cross-site');
  }
  const r = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'CROSS-SITE' },
    body: JSON.stringify({ body: 'spam' })
  }), { ...BASE_ENV, XN_KV: new MockKV() });
  assert.equal(r.status, 403, '大写 cross-site 的 POST 不能被放进来');
});

test('同源：Origin 白名单是精确匹配，通配符 / 尾斜杠 / 子域都不算', () => {
  const mk = (origin) => req('/api/feedback', { headers: { Origin: origin } });
  assert.equal(sameOrigin(mk('*'), BASE_ENV), false, 'Origin: * 不能过');
  assert.equal(sameOrigin(mk('https://evil.example'), { ...BASE_ENV, XN_ALLOWED_ORIGINS: 'https://ok.example, https://evil.example ' }), true, '白名单里的才过（带空格也能 trim）');
  assert.equal(sameOrigin(mk('https://evil.example/'), { ...BASE_ENV, XN_ALLOWED_ORIGINS: 'https://ok.example' }), false, '尾斜杠不是同一个 origin');
  assert.equal(sameOrigin(mk('https://sub.evil.example'), { ...BASE_ENV, XN_ALLOWED_ORIGINS: 'https://evil.example' }), false, '子域不自动继承');
  assert.equal(sameOrigin(mk('https://evil.example'), { ...BASE_ENV, XN_ALLOWED_ORIGINS: 'https://evil.example.evil2.example' }), false, '前缀相同不算');
});

test('同源：端口差、大小写差、scheme 差都算不同源', () => {
  const port = new Request('https://x.test:8443/api/feedback', { headers: { Origin: 'https://x.test' } });
  assert.equal(sameOrigin(port, BASE_ENV), false, '端口不同');
  const upper = req('/api/feedback', { headers: { Origin: 'https://X.TEST' } });
  assert.equal(sameOrigin(upper, BASE_ENV), false, 'Origin 大写（浏览器会小写，这里宁拒勿放）');
  const http = req('/api/feedback', { headers: { Origin: 'http://x.test' } });
  assert.equal(sameOrigin(http, BASE_ENV), false, 'scheme 不同');
});

test('CORS：[已修] 预检放行 DELETE，跨源管理页也能删反馈', async () => {
  const h = corsHeaders(req('/api/feedback', { headers: { Origin: 'https://x.test' } }), BASE_ENV);
  assert.equal(h['Access-Control-Allow-Origin'], 'https://x.test');
  assert.ok(h['Access-Control-Allow-Methods'].includes('DELETE'), 'DELETE 要进预检白名单');

  const env = { ...BASE_ENV, XN_KV: new MockKV(), XN_ALLOWED_ORIGINS: 'https://admin.example' };
  const pre = await worker.fetch(req('/api/feedback?all=1', {
    method: 'OPTIONS', headers: { Origin: 'https://admin.example' }
  }), env);
  assert.equal(pre.status, 204);
  assert.ok(pre.headers.get('Access-Control-Allow-Methods').includes('DELETE'));
});

/* =====================================================================
 * 3. 反馈：保留期夹紧、DELETE 选择器、分页、误删
 * ===================================================================== */

const postFeedback = (env, item) => worker.fetch(postJson('/api/feedback', item), env);

test('反馈：保留期 0/999/负数/乱填/小数 都被夹到 1–365 天', async () => {
  const cases = [
    [undefined, 180], ['30', 30], ['1', 1], ['365', 365],
    ['0', 1], ['-5', 1], ['999', 365], ['abc', 180], ['', 180], ['Infinity', 180], ['1.5', 2], ['365.6', 365]
  ];
  for (const [raw, days] of cases) {
    const kv = new MockKV();
    const env = Object.assign({}, BASE_ENV, { XN_KV: kv }, raw === undefined ? {} : { XN_FEEDBACK_TTL_DAYS: raw });
    const r = await postFeedback(env, { body: '测试 TTL' });
    assert.equal(r.status, 200, 'XN_FEEDBACK_TTL_DAYS=' + JSON.stringify(raw));
    const rec = JSON.parse([...kv.map.values()][0]);
    assert.equal(rec.retentionDays, days, 'XN_FEEDBACK_TTL_DAYS=' + JSON.stringify(raw) + ' → ' + days + ' 天');
    assert.equal(kv.puts[0].opts.expirationTtl, days * 86400, 'KV 过期时间要跟记录一致');
    assert.ok(kv.puts[0].opts.expirationTtl >= 60, 'KV 的 expirationTtl 下限是 60 秒，别写更小的值');
  }
});

test('反馈：写入时洗掉标签、IP 只存哈希、回显 retentionDays', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv, XN_FEEDBACK_TTL_DAYS: '30' };
  const r = await postFeedback(env, {
    id: 'a<script>alert(1)</script>',
    type: '<img onerror=x>想法',
    body: '希望夜间模式 <b>谢谢</b>',
    contact: '<a href=x>@me</a>'
  });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.retentionDays, 30);
  const rec = JSON.parse([...kv.map.values()][0]);
  for (const field of ['type', 'contact']) {
    assert.ok(!/[<>"']/.test(rec[field]), field + ' 里的尖括号/引号要洗掉');
  }
  assert.ok(!/[<>]/.test(rec.id), 'id 只允许 \\w.-');
  assert.equal(rec.body, '希望夜间模式 <b>谢谢</b>', '正文按纯文本存，不在这里洗（渲染端负责转义）');
  /* 小瑕疵：ipHash() 先把随机字节转成 Latin-1 字符串，b64encode() 又按 UTF-8 编码一次，
     所以长度在 12–24 之间浮动（8 字节 → 12 字符，高位置位时会变长）。
     不影响隐私（仍是 64 位、不可逆、按天加盐），但同一份字节换来换去没必要。 */
  assert.match(rec.ipHash, /^[A-Za-z0-9+/=]{12,24}$/, 'ipHash 是 base64 短哈希');
  assert.ok(!rec.ipHash.includes('203.0.113'), 'IP 明文不落库');
  assert.ok(!('ip' in rec), '不要存原始 IP 字段');
  assert.ok(!JSON.stringify(rec).includes('203.0.113.'), '整条记录里都不能出现明文 IP');
});

test('反馈：[已修] 写入失败透出 413/400，不再一律 200', async () => {
  const env = { ...BASE_ENV, XN_KV: new MockKV() };
  const empty = await postFeedback(env, { body: '   ' });
  assert.equal(empty.status, 400, '空内容 400');
  assert.equal((await empty.json()).ok, false);

  const big = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test' },
    body: JSON.stringify({ body: 'x'.repeat(20000) })
  }), env);
  assert.equal(big.status, 413, '超长请求体 413');
  assert.equal((await big.json()).ok, false);

  const bad = await worker.fetch(req('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test' },
    body: '{不是 json'
  }), env);
  assert.equal(bad.status, 400, '坏 JSON 400');
  assert.equal((await bad.json()).ok, false);

  assert.equal(env.XN_KV.map.size, 0, '三条都没落库');
});

test('反馈 DELETE：无令牌 401、错令牌 401、跨站 403、严格模式缺 Origin 403', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv };
  await postFeedback(env, { body: '留着' });
  const before = kv.map.size;
  assert.ok(before > 0);

  assert.equal((await worker.fetch(req('/api/feedback?all=1', { method: 'DELETE', headers: { Origin: 'https://x.test' } }), env)).status, 401, '无令牌');
  assert.equal((await worker.fetch(req('/api/feedback?all=1', { method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': 'a.b' } }), env)).status, 401, '假令牌');
  assert.equal((await worker.fetch(req('/api/feedback?all=1', { method: 'DELETE', headers: { Origin: 'https://evil.example', 'X-Admin-Token': await issueToken(env, 600) } }), env)).status, 403, '跨站');
  assert.equal((await worker.fetch(req('/api/feedback?all=1', {
    method: 'DELETE', headers: { 'X-Admin-Token': await issueToken(env, 600) }
  }), { ...env, XN_REQUIRE_ORIGIN: '1' })).status, 403, '严格模式缺 Origin');

  assert.equal(kv.map.size, before, '被拒的请求一条都不能删掉');
});

test('反馈 DELETE：没有选择器 / 选择器格式不对都要拒绝', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv };
  await postFeedback(env, { body: '留着' });
  const token = await issueToken(env, 600);
  const del = (qs) => worker.fetch(req('/api/feedback' + qs, {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': token }
  }), env);

  for (const qs of ['', '?all=0', '?all=true', '?before=2026/01/01', '?before=20260101', '?id=%20', '?before=2026-1-1']) {
    const body = await (await del(qs)).json();
    assert.equal(body.ok, false, qs + ' 应该被拒绝');
    assert.ok(/指定|YYYY-MM-DD/.test(body.error), qs + ' 要给出明确提示');
  }
  assert.equal(kv.map.size, 1, '这些请求都不该删数据');
});

test('反馈 DELETE：[已修] before 必须是真实日期且不能是未来；全删只能 ?all=1', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv };
  for (const ts of ['2024-03-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']) {
    kv.map.set('fb:' + ts + ':a', JSON.stringify({ id: 'x' + ts, ts, body: '重要反馈' }));
  }
  const token = await issueToken(env, 600);
  const del = (qs) => worker.fetch(req('/api/feedback' + qs, {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': token }
  }), env);

  for (const qs of ['?before=9999-99-99', '?before=2026-13-45', '?before=2026-02-31', '?before=2099-01-01']) {
    const body = await (await del(qs)).json();
    assert.equal(body.ok, false, qs + ' 必须被拒（格式像日期不算数）');
  }
  assert.equal(kv.map.size, 3, '非法/未来日期一条都不能删');

  const ok = await (await del('?before=2025-06-01')).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.deleted, 1, '只删更早的那条');
  assert.equal(kv.map.size, 2);
});

test('反馈 DELETE：[洞-低] 用 ?id= 精确删，也会顺手删掉「值为空」的其它记录', async () => {
  const kv = new MockKV();
  kv.map.set('fb:live', JSON.stringify({ id: 'keep', ts: '2026-06-01T00:00:00.000Z' }));
  kv.map.set('fb:empty', ''); /* 写坏的 / 手动清理剩下的空值键 */
  const env = { ...BASE_ENV, XN_KV: kv };
  const r = await worker.fetch(req('/api/feedback?id=完全不存在', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env);
  const body = await r.json();
  /* deleteFeedback() 里 `if (!raw) { doomed.push(name); continue; }` 在选择器分支也执行，
     所以任何一次「精确删除一条」都会顺带清掉所有空值键 —— 选择器被无视了。 */
  assert.equal(body.deleted, 1, '删掉的不是 id 命中项，而是空值键');
  assert.ok(kv.map.has('fb:live'), '真实记录还在');
  assert.ok(!kv.map.has('fb:empty'), '空值键被无关的 ?id= 请求删了');
});

test('反馈 DELETE：?all=1 优先于 id/before，全删并返回计数', async () => {
  const kv = new MockKV();
  for (let i = 0; i < 5; i++) kv.map.set('fb:k' + i, JSON.stringify({ id: 'i' + i, ts: '2026-01-0' + (i + 1) + 'T00:00:00.000Z' }));
  const env = { ...BASE_ENV, XN_KV: kv };
  const body = await (await worker.fetch(req('/api/feedback?all=1&id=i0&before=2026-01-09', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env)).json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted, 5);
  assert.equal(body.scanned, 5);
  assert.equal(kv.map.size, 0);
});

test('反馈 DELETE：?before= 是严格小于，等于当天的不删', async () => {
  const kv = new MockKV();
  kv.map.set('fb:eq', JSON.stringify({ id: 'eq', ts: '2026-02-01T00:00:00.000Z' }));
  kv.map.set('fb:lt', JSON.stringify({ id: 'lt', ts: '2026-01-31T23:59:59.999Z' }));
  const env = { ...BASE_ENV, XN_KV: kv };
  const body = await (await worker.fetch(req('/api/feedback?before=2026-02-01', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env)).json();
  assert.equal(body.deleted, 1);
  assert.ok(kv.map.has('fb:eq'), '等于 before 的那天要保留');
  assert.ok(!kv.map.has('fb:lt'));
});

test('反馈 DELETE：超过 1000 条要翻页删干净（2503 条）', async () => {
  const kv = new MockKV();
  for (let i = 0; i < 2503; i++) {
    kv.map.set('fb:' + String(i).padStart(5, '0'), JSON.stringify({ id: 'i' + i, ts: '2025-01-01T00:00:00.000Z' }));
  }
  const env = { ...BASE_ENV, XN_KV: kv };
  const body = await (await worker.fetch(req('/api/feedback?all=1', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env)).json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted, 2503, '单页最多 1000，必须用 cursor 翻页');
  assert.equal(body.scanned, 2503);
  assert.equal(kv.map.size, 0);
});

test('反馈 DELETE：[洞-低] 按 id/before 删是 O(n) 次 KV 读，上千条就要逐条 get', async () => {
  const kv = new MockKV();
  for (let i = 0; i < 1200; i++) {
    kv.map.set('fb:' + String(i).padStart(5, '0'), JSON.stringify({ id: 'i' + i, ts: '2025-01-01T00:00:00.000Z' }));
  }
  const env = { ...BASE_ENV, XN_KV: kv };
  await worker.fetch(req('/api/feedback?before=2026-01-01', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env);
  /* 键名里已经带了 ISO 时间（fb:<ts>:<rand>），before 完全可以直接比键名、不需要 get 值。
     现在的写法在记录变多时会撞 Worker 的子请求/CPU 上限，删一半就 500。 */
  assert.equal(kv.gets, 1200, '1200 条 = 1200 次读');
  assert.equal(kv.deletes, 1200, '再 1200 次删');
});

/* =====================================================================
 * 4. 限流：桶隔离、并发超发、键的来源
 * ===================================================================== */

const iterateCall = (env, { ip, token, body } = {}) => worker.fetch(new Request('https://x.test/api/iterate', {
  method: 'POST',
  headers: Object.assign(
    { 'Content-Type': 'application/json', Origin: 'https://x.test', 'CF-Connecting-IP': ip || '198.51.100.' + (++ipSeq % 240) },
    token ? { 'X-Admin-Token': token } : {}
  ),
  body: JSON.stringify(body || {})
}), env);

test('限流：公开试运行 8/h、真跑 4/h，各自独立计数', async () => {
  const env = { ...BASE_ENV, XN_KV: new MockKV(), XN_GH_TOKEN: '' };
  await stubFetch(() => { throw new Error('offline'); }, async () => {
    const ip = '198.51.100.11';
    for (let i = 0; i < 8; i++) {
      assert.notEqual((await iterateCall(env, { ip, body: { dryRun: true } })).status, 429, '第 ' + (i + 1) + ' 次试运行不该限流');
    }
    assert.equal((await iterateCall(env, { ip, body: { dryRun: true } })).status, 429, '第 9 次试运行 429');

    for (let i = 0; i < 4; i++) {
      assert.notEqual((await iterateCall(env, { ip, body: { dryRun: false } })).status, 429, '第 ' + (i + 1) + ' 次真跑不该限流');
    }
    assert.equal((await iterateCall(env, { ip, body: { dryRun: false } })).status, 429, '第 5 次真跑 429');
  });
});

test('限流：公开桶打满不占管理员额度（反之亦然）', async () => {
  const env = { ...BASE_ENV, XN_KV: new MockKV(), XN_GH_TOKEN: '' };
  const token = await issueToken(env, 600);
  await stubFetch(() => { throw new Error('offline'); }, async () => {
    const ip = '198.51.100.12';
    for (let i = 0; i < 4; i++) await iterateCall(env, { ip, body: { dryRun: false } });
    assert.equal((await iterateCall(env, { ip, body: { dryRun: false } })).status, 429, '公开真跑已打满');

    const admin = await iterateCall(env, { ip, token, body: { dryRun: false } });
    assert.notEqual(admin.status, 429, 'admin 桶不受公开桶影响');
    assert.notEqual(admin.status, 429);

    for (let i = 0; i < 10; i++) await iterateCall(env, { ip, body: { dryRun: true } });
    const adminDry = await iterateCall(env, { ip, token, body: { dryRun: true } });
    assert.notEqual(adminDry.status, 429, 'admin 试运行桶也独立');
  });
});

test('限流：四个桶的 KV 键名互不重叠', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv, XN_GH_TOKEN: '' };
  const token = await issueToken(env, 600);
  await stubFetch(() => { throw new Error('offline'); }, async () => {
    const ip = '198.51.100.13';
    await iterateCall(env, { ip, body: { dryRun: true } });
    await iterateCall(env, { ip, body: { dryRun: false } });
    await iterateCall(env, { ip, token, body: { dryRun: true } });
    await iterateCall(env, { ip, token, body: { dryRun: false } });
  });
  const buckets = new Set([...kv.map.keys()].filter((k) => k.startsWith('rl:')).map((k) => k.split(':')[1]));
  for (const b of ['iterate', 'iterate-dry', 'iterate-pub', 'iterate-pub-dry']) {
    assert.ok(buckets.has(b), '缺桶 ' + b + '（现有：' + [...buckets].join(',') + '）');
  }
  assert.equal(buckets.size, 4);
});

test('限流：[已修] 迭代路由并发只放一个（KV 计数本身仍是读-改-写）', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv };
  /* rateLimit() 本身仍是读-改-写（KV 不保证读到别人的 put），这段记录它的现状。 */
  const results = await Promise.all(Array.from({ length: 5 }, () => rateLimit(env, 'burst', 'ip', 4, 3600, true)));
  assert.equal(results.filter((r) => r.ok).length, 5, 'rateLimit() 本身仍会被并发骗过');

  /* 但 /api/iterate 路由加了 in-flight 排他：同一 IP 同一时刻只跑一个，
     并发的其余请求直接 429，额度不会被放大多倍。 */
  await stubFetch(() => { throw new Error('offline'); }, async () => {
    const env2 = { ...BASE_ENV, XN_KV: new MockKV(), XN_GH_TOKEN: '' };
    const ip = '198.51.100.14';
    const calls = await Promise.all(Array.from({ length: 8 }, () => iterateCall(env2, { ip, body: { dryRun: false } })));
    assert.equal(calls.filter((r) => r.status !== 429).length, 1, '同一 IP 并发只能有一个在跑');
    assert.equal(calls.filter((r) => r.status === 429).length, 7);
  });
});

test('限流：[洞-中] 内存计数是「每 isolate 一份」，多实例 = 多份额度', async () => {
  /* 这不是 mock 出来的：rateLimit 的 memRate 是模块级 Map，Workers 每个 isolate 各有一份，
     同一个 IP 的 5 次/分钟 会变成 5 × isolate 数。chat / fetch / feedback / admin 全走这条路。 */
  const a = await import('../cloudflare/shared.js');
  const b = await import('../cloudflare/shared.js?isolate=2');
  let okA = 0;
  let okB = 0;
  for (let i = 0; i < 6; i++) if ((await a.rateLimit({}, 'adm-iso', '1.2.3.4', 5, 60, false)).ok) okA++;
  for (let i = 0; i < 6; i++) if ((await b.rateLimit({}, 'adm-iso', '1.2.3.4', 5, 60, false)).ok) okB++;
  assert.equal(okA, 5, '实例 A 用满 5 次');
  assert.equal(okB, 5, '实例 B（等价于另一个 isolate）又从 5 次开始');
});

test('限流：[洞-中] 限流键取自客户端可伪造的 CF-Connecting-IP，轮换就绕过密码防爆破', async () => {
  /* clientIp() = request.headers.get('CF-Connecting-IP') || '0.0.0.0'。
     Cloudflare 边缘会覆盖这个头，所以线上 CF 部署问题不大；
     但 wrangler dev / 自建反代 / 本机后端（server/app.py 直接信 X-Forwarded-For）里它就是客户端说了算。
     同一个 /api/admin/verify 的 5 次/分钟 是**管理密码唯一的防爆破闸门**。 */
  const env = { ...BASE_ENV };
  let unauthorized = 0;
  for (let i = 0; i < 8; i++) {
    const r = await worker.fetch(new Request('https://x.test/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', 'CF-Connecting-IP': '10.20.30.' + i },
      body: JSON.stringify({ password: 'guess-' + i })
    }), env);
    if (r.status === 401) unauthorized++;
    else assert.notEqual(r.status, 429, '换 IP 后第 ' + (i + 1) + ' 次就被拦了？');
  }
  assert.equal(unauthorized, 8, '8 次不同 IP 的错误密码全部进入校验流程');
});

test('限流：同一个 IP 的密码爆破第 6 次会 429', async () => {
  const env = { ...BASE_ENV };
  const ip = '198.51.100.77';
  const call = () => worker.fetch(new Request('https://x.test/api/admin/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password: 'nope' })
  }), env);
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await call()).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429, '第 6 次必须限流');
  assert.equal(statuses[6], 429);
});

test('限流：[洞-低] /api/admin/check 无限流也无同源，可当日令牌有效性探测', async () => {
  const env = { ...BASE_ENV };
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    const r = await worker.fetch(new Request('https://x.test/api/admin/check', {
      headers: { 'X-Admin-Token': 'probe-' + i, 'CF-Connecting-IP': '198.51.100.88' }
    }), env);
    statuses.push(r.status);
  }
  assert.ok(statuses.every((s) => s === 401), '10 次全 401，没有 429');
  /* 每次都要算一次 HMAC，未鉴权接口没有频控 → 可被用来空转 CPU。
     令牌本身不可猜，所以只是低危；但把 admin 桶复用过来是一行的事。 */
});

/* =====================================================================
 * 5. /api/chat：管理令牌与模型 Key 的 header 语义冲突
 * ===================================================================== */

const chatEnv = { ...BASE_ENV, XN_API_KEY: 'server-key', XN_MODEL: 'deepseek-chat' };
const chat = (env, headers, body) => worker.fetch(postJson('/api/chat', body || { messages: [{ role: 'user', content: '你好' }] }, { headers }), env);

test('chat：X-Admin-Token 不会被当成模型 Key 转发', async () => {
  const token = await issueToken(chatEnv, 600);
  await stubFetch(() => okJson({ choices: [{ message: { role: 'assistant', content: '好' } }] }), async (calls) => {
    const r = await chat(chatEnv, { 'X-Admin-Token': token });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, 'Bearer server-key', '只有 X-Admin-Token 时用服务端 Key');
    assert.ok(!JSON.stringify(calls[0].headers).includes(token), '管理令牌不能出现在上游请求头里');
  });
});

test('chat：两个 header 同时出现 → 用户自己的 Key 优先，管理令牌不外泄', async () => {
  const token = await issueToken(chatEnv, 600);
  await stubFetch(() => okJson({ choices: [{ message: { content: '好' } }] }), async (calls) => {
    const r = await chat(chatEnv, { Authorization: 'Bearer sk-user', 'X-Admin-Token': token });
    assert.equal(r.status, 200);
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-user');
    assert.ok(!JSON.stringify(calls[0].headers).includes(token));
    assert.ok(!String(calls[0].body).includes('admin'), '正文里也不该出现令牌');
  });
});

test('chat：[已修] Authorization 里塞管理令牌 → 400，绝不转发给上游', async () => {
  const token = await issueToken(chatEnv, 600);
  await stubFetch(() => okJson({ choices: [{ message: { content: '好' } }] }), async (calls) => {
    /* bearer() 明确支持用 Authorization 承载管理令牌（/api/admin/check 就这么用），
       但 /api/chat 把 Authorization 一律当"用户自己的模型 Key"转给上游。
       结果是：脚本按文档写 -H "Authorization: Bearer <管理令牌>" 调 /api/chat，
       12 小时有效的管理会话令牌就被送给第三方模型服务商了。 */
    const r = await chat(chatEnv, { Authorization: 'Bearer ' + token });
    assert.equal(r.status, 400, '管理令牌不能当模型 Key');
    assert.equal(calls.length, 0, '被拒后不能发上游');
  });
});

test('chat：超长/超多 messages 被挡在转发之前', async () => {
  await stubFetch(() => okJson({ choices: [{ message: { content: '不该到这里' } }] }), async (calls) => {
    const many = await chat(chatEnv, {}, { messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'a' })) });
    assert.equal(many.status, 400);
    assert.equal((await many.json()).error, '消息太多了');

    const huge = await chat(chatEnv, {}, { messages: [{ role: 'user', content: 'x'.repeat(300000) }] });
    assert.equal(huge.status, 413);

    const notArray = await chat(chatEnv, {}, { messages: 'nope' });
    assert.equal(notArray.status, 400);

    assert.equal(calls.length, 0, '坏请求一次都不该打到上游');
  });
});

test('chat：providerBase 只认 https + 白名单，各种花招都回落', async () => {
  await stubFetch(() => okJson({ choices: [{ message: { content: '好' } }] }), async (calls) => {
    const cases = [
      'https://evil.example/v1',
      'https://api.deepseek.com@evil.example/v1',
      'https://api.deepseek.com.evil.example/v1',
      'http://api.deepseek.com/v1',
      'file:///etc/passwd',
      'not a url'
    ];
    for (const pb of cases) {
      calls.length = 0;
      await chat(chatEnv, {}, { providerBase: pb, messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(calls[0].url.startsWith('https://api.deepseek.com/'), pb + ' 应回落到服务端 base，实际 ' + calls[0].url);
    }
    /* 大小写 / 尾斜杠 / 路径穿越都在白名单主机内被规范化，出不去 */
    calls.length = 0;
    await chat(chatEnv, {}, { providerBase: 'https://API.DEEPSEEK.COM/v1/', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    calls.length = 0;
    await chat(chatEnv, {}, { providerBase: 'https://api.deepseek.com/v1/../evil', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(calls[0].url.startsWith('https://api.deepseek.com/'), '路径穿越不能换主机');
    assert.equal(new URL(calls[0].url).hostname, 'api.deepseek.com');
  });
});

test('safeBase / extraHosts：白名单外的 base 一律回落，XN_EXTRA_HOSTS 只认合法域名', () => {
  const fb = 'https://api.deepseek.com/v1';
  assert.equal(safeBase('https://evil.example/v1', fb, {}), fb);
  assert.equal(safeBase('https://API.DEEPSEEK.COM/v1/', fb, {}), fb, '归一化成小写 host + 去尾斜杠');
  assert.equal(safeBase('https://api.deepseek.com@evil.example/v1', fb, {}), fb, 'userinfo 骗不了 hostname');
  assert.equal(safeBase('https://api.deepseek.com.evil.example/v1', fb, {}), fb, '后缀欺骗');
  assert.equal(safeBase('http://api.deepseek.com/v1', fb, {}), fb, '非 https 回落');
  assert.equal(safeBase('https://api.openai.com/v1', fb, {}), 'https://api.openai.com/v1', '白名单内的可以使用');
  assert.equal(safeBase('', fb, {}), fb, '空值回落');

  /* XN_EXTRA_HOSTS 注入面：只接受合法域名形态、内网形态被过滤、最多 8 个 */
  assert.deepEqual(extraHosts({ XN_EXTRA_HOSTS: 'localhost,127.0.0.1,10.0.0.1,[::1],bad_host!' }), []);
  assert.deepEqual(extraHosts({ XN_EXTRA_HOSTS: ' My.Example , ,' }), ['my.example']);
  assert.equal(extraHosts({ XN_EXTRA_HOSTS: Array.from({ length: 12 }, (_, i) => 'h' + i + '.example').join(',') }).length, 8);
  /* 记录一条：字符串判断挡不住「公网域名解析到内网」，但已知的通配 DNS 服务要挡 */
  assert.deepEqual(extraHosts({ XN_EXTRA_HOSTS: '127.0.0.1.nip.io,foo.xip.io,bar.sslip.io' }), []);
});

test('chat：上游 302 不跟随，直接 502', async () => {
  await stubFetch(() => new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }), async () => {
    const r = await chat(chatEnv, {});
    assert.equal(r.status, 502);
    assert.ok(!/evil\.example/.test(await r.text()), '错误信息里不要回显跳转目标');
  });
});

test('chat：服务端 Key 只管白名单模型；自带 Key 随便用（但也不是管理令牌）', async () => {
  await stubFetch(() => okJson({ choices: [{ message: { content: '好' } }] }), async (calls) => {
    const denied = await chat(chatEnv, {}, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(denied.status, 403, '服务端 Key 模式下非白名单模型要拒');

    calls.length = 0;
    const allowed = await chat(chatEnv, { Authorization: 'Bearer sk-user' }, { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(allowed.status, 200, '自带 Key 时不占用服务端额度，模型由用户自选');
    assert.equal(JSON.parse(calls[0].body).model, 'gpt-4o');
  });
});

test('chat：没配 Key 又没带 Key → 503，且错误信息不含密钥', async () => {
  const env = { ...BASE_ENV };
  const r = await chat(env, {});
  assert.equal(r.status, 503);
  assert.ok(!/server-key|{{SECRET_/i.test(await r.text()));
});

/* =====================================================================
 * 6. /api/fetch：SSRF（重定向、IPv4-mapped IPv6、DNS 重绑定、体积）
 * ===================================================================== */

const grab = async (target, handler, ip) => {
  const env = { ...BASE_ENV };
  return stubFetch(handler, async (calls) => {
    const r = await worker.fetch(req('/api/fetch?url=' + encodeURIComponent(target), {
      headers: { Origin: 'https://x.test' },
      ip: ip || undefined
    }), env);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: r.status, body, calls };
  });
};

test('fetch：内网 / localhost / 非 http(s) / 带账号密码 一律 403，且根本不发请求', async () => {
  const blocked = ['http://127.0.0.1/admin', 'http://127.0.0.1:8080/', 'https://localhost/', 'https://LOCALHOST./',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://[::1]/', 'file:///etc/passwd',
    'ftp://example.com/x', 'https://user:pass@93.184.216.34/'];
  for (const target of blocked) {
    const r = await grab(target, () => okHtml());
    assert.equal(r.status, 403, target + ' 应该被拒');
    assert.equal(r.calls.length, 0, target + ' 不该真的发出去');
  }
});

test('fetch：302 到 127.0.0.1 会被逐跳校验拦住', async () => {
  const r = await grab('https://93.184.216.34/a', () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }));
  assert.equal(r.status, 403);
  assert.equal(r.calls.length, 1, '只发了第一跳，回环地址没被请求');
  assert.ok(!r.calls.some((c) => c.url.includes('127.0.0.1')));
});

test('fetch：[已修] IPv4-mapped IPv6 十六进制写法被当内网拒', async () => {
  for (const host of ['::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe']) {
    assert.equal(isPrivateHost(host), true, host + ' 应判定为内网');
  }
  await assert.rejects(() => assertPublicUrl('http://[::ffff:7f00:1]:8080/'));
  await assert.rejects(() => assertPublicUrl('https://[::ffff:a9fe:a9fe]/'));

  /* 端到端：请求直接 403，而且根本不该去连 */
  const r = await grab('http://[::ffff:7f00:1]:8080/admin', () => okHtml('<html><title>内网管理台</title></html>'));
  assert.equal(r.status, 403);
  assert.equal(r.calls.length, 0, '不该真的去连内网');

  /* 302 到同一个地址也要拒 */
  const viaRedirect = await grab('https://93.184.216.34/a', (url) => (url.includes('93.184.216.34')
    ? new Response('', { status: 302, headers: { Location: 'http://[::ffff:7f00:1]:8080/admin' } })
    : okHtml()));
  assert.equal(viaRedirect.status, 403, '302 到映射地址必须拒');
});

test('fetch：域名解析到内网 / DoH 不可用 → 一律拒绝（fail closed）', async () => {
  const privateDns = await grab('https://dns-private.example/x', (url) => (url.includes('cloudflare-dns.com')
    ? okJson({ Answer: [{ type: 1, data: '10.0.0.5' }] })
    : okHtml()));
  assert.equal(privateDns.status, 403);
  assert.equal(privateDns.calls.length, 1, '只查了 DNS，没有真的去抓');

  const dnsDown = await grab('https://dns-down.example/x', (url) => (url.includes('cloudflare-dns.com')
    ? new Response('boom', { status: 500 })
    : okHtml()));
  assert.equal(dnsDown.status, 403, 'DoH 挂了也不能放行');

  const goodDns = await grab('https://dns-ok.example/x', (url) => (url.includes('cloudflare-dns.com')
    ? okJson({ Answer: [{ type: 1, data: '93.184.216.34' }] })
    : okHtml('<html><title>ok</title>正文</html>')));
  assert.equal(goodDns.status, 200, '解析到公网才放行');
});

test('fetch：非文本 415、无限重定向 403、页面太大 413', async () => {
  const img = await grab('https://93.184.216.34/a.png', () => new Response('bin', { status: 200, headers: { 'Content-Type': 'image/png' } }));
  assert.equal(img.status, 415);

  const loop = await grab('https://93.184.216.34/loop', () => new Response('', { status: 302, headers: { Location: 'https://93.184.216.34/again' } }));
  assert.equal(loop.status, 403);
  assert.equal(loop.calls.length, 4, '最多跟 4 跳');
});

test('fetch：[洞-低] 没有 Content-Length 时分块响应被整份读进内存，才有 413', async () => {
  let sent = 0;
  const body = () => new ReadableStream({
    pull(c) {
      if (sent >= 64) { c.close(); return; }
      sent++;
      c.enqueue(new TextEncoder().encode('<p>' + 'x'.repeat(65535) + '</p>'));
    }
  });
  const r = await grab('https://93.184.216.34/big', () => new Response(body(), { status: 200, headers: { 'Content-Type': 'text/html' } }));
  assert.equal(r.status, 413, '最后确实拒了');
  /* 但是 64 × 64KB ≈ 4MB 全被读完了：Content-Length 缺失时没有任何流式上限，
     对方只要一直吐（chunked）就能把 isolate 内存打爆。应该边读边累加，超 2MB 立刻 cancel。 */
  assert.equal(sent, 64, '4MB 全部读入');
});

test('fetch：明文 http 是允许的（记录这个取舍，逐跳校验仍在）', async () => {
  const r = await grab('http://93.184.216.34/plain', () => okHtml('<html><title>plain</title>x</html>'));
  assert.equal(r.status, 200);
  assert.equal(r.calls[0].url, 'http://93.184.216.34/plain');
});

/* =====================================================================
 * 7. /api/iterate：公开触发的能力边界
 * ===================================================================== */

test('iterate：公开调用不能选分支，payload.branch=main 也被改到公开分支', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv, XN_GH_TOKEN: 'ghp_fake', XN_PUBLIC_ITERATE_BRANCH: 'iterate/public' };
  await stubFetch(() => okJson({ message: 'Not Found' }, 404), async (calls) => {
    const r = await iterateCall(env, { ip: '198.51.100.21', body: { dryRun: true, branch: 'main' } });
    const body = await r.json();
    assert.equal(calls[0].url, 'https://api.github.com/repos/j200906/xiaonuan-workbench', '仓库锁在服务端');
    assert.equal(body.branch, 'iterate/public', 'branch 被强制成公开分支');
    assert.equal(body.publicMode, true, '响应要标明是公开模式');
    assert.notEqual(body.branch, 'main');
  });
});

test('iterate：公开请求不能换仓库、也不能把服务端 token 换掉', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv, XN_GH_TOKEN: 'ghp_server_side' };
  await stubFetch(() => okJson({ message: 'Not Found' }, 404), async (calls) => {
    await iterateCall(env, { ip: '198.51.100.22', body: { dryRun: true, owner: 'attacker', repo: 'pwn', branch: 'main' } });
    assert.equal(calls[0].url, 'https://api.github.com/repos/j200906/xiaonuan-workbench', 'owner/repo 取自环境变量');
    assert.equal(calls[0].headers.Authorization, 'Bearer ghp_server_side');
  });
});

/* =====================================================================
 * 8. 其它路由 / 静态资源：别的地方漏出来的东西
 * ===================================================================== */

test('config / health：只暴露布尔，不吐任何密钥原文', async () => {
  const env = { ...BASE_ENV, XN_KV: new MockKV(), XN_API_KEY: 'server-secret-key', XN_GH_TOKEN: 'ghp_should_not_leak', XN_ADMIN_PASSWORD: 'pw-should-not-leak' };
  for (const path of ['/api/config', '/api/health']) {
    const text = await (await worker.fetch(req(path), env)).text();
    for (const secret of ['server-secret-key', 'ghp_should_not_leak', 'pw-should-not-leak']) {
      assert.ok(!text.includes(secret), path + ' 泄露了 ' + secret);
    }
  }
  const cfg = await (await worker.fetch(req('/api/config'), env)).json();
  assert.equal(cfg.repo.serverToken, true, '只要有布尔值就够了');
  assert.equal(cfg.repo.locked, true);
});

test('路由：未知 /api/* 404；跨站预检 403；PUT 405；安全响应头齐全', async () => {
  const env = { ...BASE_ENV, XN_KV: new MockKV() };
  assert.equal((await worker.fetch(req('/api/nope'), env)).status, 404);
  assert.equal((await worker.fetch(req('/api/feedback', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/feedback', { method: 'PUT', headers: { Origin: 'https://x.test' } }), env)).status, 405);

  const h = (await worker.fetch(req('/api/health'), env)).headers;
  for (const [k, v] of Object.entries({
    'content-security-policy': /frame-ancestors 'none'/,
    'x-frame-options': /DENY/,
    'x-content-type-options': /nosniff/,
    'referrer-policy': /no-referrer/,
    'cross-origin-opener-policy': /same-origin/
  })) {
    assert.match(h.get(k) || '', v, '缺安全头 ' + k);
  }
  assert.equal(h.get('access-control-allow-origin'), null, '没有 Origin 时不带 ACAO');
});

test('静态资源：index.html 不再有 #ciToken，浏览器侧没有 GitHub token 落点', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!/ciToken/.test(html), 'index.html 里不该再出现 ciToken');
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(html), 'index.html 里不该有 GitHub token 字面量');
  assert.ok(!/github_pat_/.test(html), 'index.html 里不该有 fine-grained token 字面量');

  const iter = readFileSync(new URL('../assets/iterate.js', import.meta.url), 'utf8');
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(iter), 'assets/iterate.js 里不该有 GitHub token 字面量');
  assert.ok(!/github_pat_/.test(iter), '同上');
  assert.ok(!/GH_TOKEN\s*[:=]\s*['"]/.test(iter), 'assets/iterate.js 不该给 GH_TOKEN 赋值');
  assert.ok(!/localStorage|sessionStorage/.test(iter), 'iterate.js 不该把任何 token 写进浏览器存储');
});

test('静态资源：管理令牌只走 sessionStorage（关标签页即失效），不进 localStorage', () => {
  const store = readFileSync(new URL('../assets/lib/store.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../assets/lib/api.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../assets/app.core.js', import.meta.url), 'utf8');

  assert.match(core, /function adminToken\(\)\s*\{[\s\S]{0,120}sessionGet\(S\.KEYS\.admin/, 'adminToken() 只读 sessionStorage');
  assert.match(core, /S\.sessionSet\(S\.KEYS\.admin/, '解锁后写 sessionStorage');
  assert.match(core, /S\.sessionRemove\(S\.KEYS\.admin/, '退出登录清 sessionStorage');
  assert.match(api, /sessionGet\(XN\.KEYS\.admin/, '请求带令牌时也从 sessionStorage 取');
  assert.match(api, /headers\['X-Admin-Token'\] = token/, '管理令牌走独立 header，不塞进 Authorization');
  assert.match(store, /function sessionGet[\s\S]{0,200}sessionStorage\.getItem/);

  for (const [name, src] of [['store.js', store], ['api.js', api], ['app.core.js', core]]) {
    for (const line of src.split('\n')) {
      if (/localStorage/.test(line)) {
        assert.ok(!/admin/i.test(line), name + ' 的 localStorage 那行不该碰管理令牌：' + line.trim());
      }
    }
  }
});

test('静态资源：[洞-低] 旧版的 xn.admin 会被 migrate() 搬进 localStorage，之后再也清不掉', () => {
  const store = readFileSync(new URL('../assets/lib/store.js', import.meta.url), 'utf8');
  /* LEGACY.admin = ['xn.admin']：老版本把管理令牌放在 localStorage。
     migrate() 用 rawSet()（写 localStorage）把它搬到 xn.v2.adminToken，
     但读取只走 sessionStorage、退出登录也只删 sessionStorage ——
     结果是一份管理会话令牌长期留在 localStorage 里，关浏览器也不消失，
     只有等它自己 exp（12 小时）失效。任何 XSS 都能在升级后的窗口期把它捞走。 */
  assert.match(store, /admin:\s*\['xn\.admin'\]/, 'LEGACY 表里还留着 admin');
  assert.match(store, /function rawSet[\s\S]{0,220}localStorage\)\.setItem/, '迁移写的是 localStorage');
  assert.match(store, /function rawGet[\s\S]{0,220}localStorage\)\.getItem/, '迁移读的也是 localStorage');
  assert.match(store, /function sessionRemove[\s\S]{0,120}sessionStorage\.removeItem/, '但清理只清 sessionStorage');
  assert.ok(!/localStorage\.removeItem\((?:[^)]*admin[^)]*)\)/i.test(store), '全文件没有一处清 localStorage 里的旧管理令牌');
});

/* =====================================================================
 * 9. 期望行为（已修的都转正成普通用例；仍未修的保留 skip 并在标题里写「已知」）
 * ===================================================================== */

test('fetch：IPv4-mapped IPv6 十六进制形式要当内网拒', async () => {
  for (const host of ['::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe']) {
    assert.equal(isPrivateHost(host), true, host + ' 应判定为内网');
  }
  await assert.rejects(() => assertPublicUrl('http://[::ffff:7f00:1]:8080/'));
  await assert.rejects(() => assertPublicUrl('https://[::ffff:a9fe:a9fe]/'));
});

test('令牌：管理令牌不该被 /api/chat 当模型 Key 转发', async () => {
  const token = await issueToken(chatEnv, 600);
  await stubFetch(() => okJson({ choices: [{ message: { content: '好' } }] }), async (calls) => {
    const r = await chat(chatEnv, { Authorization: 'Bearer ' + token });
    assert.notEqual(r.status, 200, '带管理令牌调 /api/chat 应被拒或忽略该 header');
    assert.ok(!calls.length || !JSON.stringify(calls[0].headers).includes(token));
  });
});

test.skip('限流：[已知] rateLimit() 本身的 KV 读-改-写仍可被并发骗过（路由层已用 in-flight 兜住）', async () => {
  const kv = new MockKV();
  const env = { ...BASE_ENV, XN_KV: kv };
  const results = await Promise.all(Array.from({ length: 5 }, () => rateLimit(env, 'burst', 'ip', 4, 3600, true)));
  assert.equal(results.filter((r) => r.ok).length, 4, '限额 4 就只能放 4 个');
});

test('反馈：before 必须是真实日期，且不能删光全部记录', async () => {
  const kv = new MockKV();
  kv.map.set('fb:a', JSON.stringify({ id: 'a', ts: '2026-01-01T00:00:00.000Z' }));
  const env = { ...BASE_ENV, XN_KV: kv };
  const r = await worker.fetch(req('/api/feedback?before=9999-99-99', {
    method: 'DELETE', headers: { Origin: 'https://x.test', 'X-Admin-Token': await issueToken(env, 600) }
  }), env);
  const body = await r.json();
  assert.equal(body.ok, false, '非法日期应 400');
  assert.equal(kv.map.size, 1, '一条都不能删');
});

test('同源：XN_REQUIRE_ORIGIN=true 等同于开启严格模式', () => {
  assert.equal(sameOrigin(req('/api/feedback'), { ...BASE_ENV, XN_REQUIRE_ORIGIN: 'true' }), false);
});

test('CORS：预检要放行 DELETE（反馈删除接口需要）', () => {
  const h = corsHeaders(req('/api/feedback', { headers: { Origin: 'https://x.test' } }), BASE_ENV);
  assert.ok(h['Access-Control-Allow-Methods'].includes('DELETE'));
});

test('本地实现：server/app.py 用 XN_TRUST_PROXY 才信 XFF，令牌带 ver，且有 DELETE /api/feedback', () => {
  const py = readFileSync(new URL('../server/app.py', import.meta.url), 'utf8');
  assert.match(py, /XN_TRUST_PROXY/, 'X-Forwarded-For 必须由 XN_TRUST_PROXY 控制');
  assert.match(py, /def token_version\(\)/, '要有令牌版本函数');
  assert.match(py, /"ver": token_version\(\)/, 'issue_token 要带 ver');
  assert.match(py, /str\(payload\.get\("ver"\) or ""\) == token_version\(\)/, 'verify_token 要核对 ver');
  assert.match(py, /def do_DELETE\(self\)/, 'DELETE /api/feedback');
  assert.match(py, /def _feedback_delete/, '删除实现');
});
