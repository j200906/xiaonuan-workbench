/* v5.8 移植期回归：兜底回复 / 上下文消解 / 天气与定位
 *
 * 这一批是「用户天天会碰到」的卡点：
 *   1. 模型挂了只留红字 → 现在按情绪接一句
 *   2. 「那明天呢」接不上上文 → 现在能还原成「杭州 明天 天气」
 *   3. 问天气没给城市只能反问 → 现在 IP 猜一个并说明是推测
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(files, extra) {
  const sandbox = Object.assign({
    console,
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    fetch: null
  }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

/* ---------------- 兜底回复 ---------------- */
test('兜底：七种情绪都有文案，且不是空话（能接住话）', () => {
  const w = load(['assets/lib/fallback.js']);
  const table = w.XN.fallback.table;
  for (const emo of ['joy', 'sad', 'anger', 'anxiety', 'lonely', 'tired', 'neutral']) {
    assert.ok(Array.isArray(table[emo]) && table[emo].length >= 2, emo + ' 至少要有两句');
    table[emo].forEach((t) => {
      assert.ok(t.length >= 6, emo + ' 的文案太短：' + t);
    });
  }
});

test('兜底：未知情绪退回 neutral，不会返回 undefined', () => {
  const w = load(['assets/lib/fallback.js']);
  const t = w.XN.fallback.pick('不存在的情绪');
  assert.equal(typeof t, 'string');
  assert.ok(t.length > 0);
});

test('兜底：同一情绪连续调用要换一句，不能复读', () => {
  const w = load(['assets/lib/fallback.js']);
  const a = w.XN.fallback.pick('sad');
  const b = w.XN.fallback.pick('sad');
  assert.notEqual(a, b, '连着两次应当换一句');
});

test('兜底：真实失败会说明原因，用户主动中止不啰嗦', () => {
  const w = load(['assets/lib/fallback.js']);
  const net = w.XN.fallback.reply('neutral', null, { reason: 'network' });
  assert.match(net, /网有点抖|再说一遍/, '网络失败应当说明');
  const abort = w.XN.fallback.reply('neutral', null, { reason: 'abort' });
  assert.ok(!/网有点抖/.test(abort), '用户自己点停不该甩锅给网络');
});

/* ---------------- 上下文消解 ---------------- */
test('上下文：代词能被解析成上文对象', () => {
  const w = load(['assets/lib/context.js']);
  const c = w.XN.context;
  c.reset();
  c.rememberDialog('user', '杭州天气怎么样');
  c.rememberFocus('杭州天气怎么样');

  const r = c.resolve('那明天呢', '');
  assert.equal(r.blocked, false);
  assert.ok(/杭州/.test(r.query), '应当接回杭州，实际：' + r.query);
  assert.ok(/明天/.test(r.query), '时间词要保留');
});

test('上下文：聊天气时追问时间，会自动补回「天气」', () => {
  const w = load(['assets/lib/context.js']);
  const c = w.XN.context;
  c.reset();
  c.rememberFocus('杭州');
  c.markIntent('weather');

  const r = c.resolve('明天呢', '');
  assert.ok(/天气/.test(r.query), '应当补回天气意图，实际：' + r.query);
});

test('上下文：只有代词、上文也没有对象 → blocked，不许硬搜', () => {
  const w = load(['assets/lib/context.js']);
  const c = w.XN.context;
  c.reset();
  const r = c.resolve('它呢', '');
  assert.equal(r.blocked, true, '没有可指代对象时必须 blocked');
});

test('上下文：正常句子不会被改写', () => {
  const w = load(['assets/lib/context.js']);
  const c = w.XN.context;
  c.reset();
  const r = c.resolve('Node.js 最新 LTS 版本', '');
  assert.equal(r.resolved, false);
  assert.equal(r.query, 'Node.js 最新 LTS 版本');
});

test('上下文：城市抽取会剥掉「帮我查一下」「今天」「天气」', () => {
  const w = load(['assets/lib/context.js']);
  const city = w.XN.context.extractCity('帮我查一下杭州明天的天气');
  assert.equal(city, '杭州', '实际抽到：' + city);
});

/* ---------------- 天气与定位 ---------------- */
test('天气：英文字段能翻成中文', () => {
  const w = load(['assets/lib/location.js']);
  const cn = w.XN.location.weatherCn;
  assert.equal(cn('Sunny'), '晴');
  assert.equal(cn('light rain'), '小雨');
  assert.equal(cn('heavy snow'), '大雪');
  /* 表里没有的原样返回，不要丢 */
  assert.equal(cn('沙尘暴'), '沙尘暴');
});

test('天气：没有城市时返回 null，不抛错', async () => {
  const w = load(['assets/lib/location.js']);
  const r = await w.XN.location.weather('');
  assert.equal(r, null);
});

test('定位：网络全挂时返回空城市，绝不抛（否则一条消息都发不出去）', async () => {
  const w = load(['assets/lib/location.js'], {
    fetch: () => Promise.reject(new Error('offline'))
  });
  w.XN.services = { use: () => null };
  const r = await w.XN.location.locate(true);
  assert.equal(r.city, '', '拿不到就该是空字符串');
});

/* ---------------- tools 接线 ---------------- */
test('tools：注册了 weather 工具，且带 city 参数说明', () => {
  const src = fs.readFileSync(path.join(root, 'assets/tools.js'), 'utf8');
  assert.match(src, /name:\s*'weather'/, '缺 weather 工具');
  assert.match(src, /function toolWeather/, '缺实现');
  assert.match(src, /name === 'weather'\) return await toolWeather/, 'run() 里没分派');
});

test('tools：搜索前会做上下文消解，blocked 时不硬搜', () => {
  const src = fs.readFileSync(path.join(root, 'assets/tools.js'), 'utf8');
  assert.match(src, /XN\.context\.resolve/, '搜索没有接上下文消解');
  assert.match(src, /r\.blocked/, '没有处理消解失败');
});

test('index.html 按依赖顺序加载三个新模块', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const order = ['assets/lib/services.js', 'assets/lib/fallback.js', 'assets/lib/context.js', 'assets/lib/location.js'];
  const idx = order.map((f) => html.indexOf(f));
  idx.forEach((i, k) => assert.ok(i > 0, order[k] + ' 没被加载'));
  assert.ok(idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3], '加载顺序不对（要 services → fallback → context → location）');
});

test('三个新文件都在可编辑清单里（否则自迭代会自检失败）', () => {
  for (const list of ['cloudflare/iterate.js', 'tests/iterate.test.mjs', 'server/app.py']) {
    const body = fs.readFileSync(path.join(root, list), 'utf8');
    for (const f of ['assets/lib/fallback.js', 'assets/lib/context.js', 'assets/lib/location.js']) {
      assert.ok(body.includes(f), list + ' 里缺 ' + f);
    }
  }
});
