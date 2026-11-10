import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function loadClassic(files, seed = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    TextDecoder,
    TextEncoder,
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    localStorage: {
      _data: {},
      getItem(k) { return this._data[k] ?? null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      key(i) { return Object.keys(this._data)[i] ?? null; },
      get length() { return Object.keys(this._data).length; }
    },
    sessionStorage: {
      _data: {},
      getItem(k) { return this._data[k] ?? null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; }
    },
    navigator: {},
    location: { protocol: 'https:', hostname: 'example.com' },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    crypto: { getRandomValues: (a) => a },
    DOMException: class extends Error {}
  };
  sandbox.XN = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  for (const [k, v] of Object.entries(seed)) sandbox.localStorage._data[k] = String(v);
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read(f), sandbox, { filename: f });
  return sandbox;
}

test('Markdown：表格 / 嵌套列表 / 代码块 / XSS', () => {
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/md.js']);
  const md = w.XN.md.render;

  const table = md('| 项目 | 状态 |\n| --- | :---: |\n| 流式 | 通过 |');
  assert.match(table, /<table>/);
  assert.match(table, /<th>项目<\/th>/);
  assert.match(table, /class="ta-center"/);
  assert.match(table, /流式/);

  const nested = md('- 第一层\n  - 第二层\n  - 第二层 b\n- 回到第一层');
  assert.match(nested, /<ul><li>第一层<ul><li>第二层<\/li>/);

  const code = md('```html\n<script>alert(1)</script>\n```');
  assert.match(code, /class="language-html"/);
  assert.ok(code.includes('&lt;script&gt;'), '代码块里的 HTML 必须转义');
  assert.ok(!code.includes('<script>alert'));

  const xss = md('[点我](javascript:alert(1)) ![x](data:text/html,hi) <img src=x onerror=alert(1)>');
  assert.ok(!xss.includes('href="javascript:'), 'javascript: 链接要被拒绝');
  assert.ok(!xss.includes('src="data:text/html'), 'data: 图片要被拒绝');
  assert.ok(xss.includes('&lt;img'), '原始 HTML 必须转义');

  const inline = md('`a * b` 和 **粗体** 和 ~~删除~~');
  assert.match(inline, /<code>a \* b<\/code>/);
  assert.match(inline, /<strong>粗体<\/strong>/);
  assert.match(inline, /<del>删除<\/del>/);
});

test('补丁规则：括号扫描忽略字符串和注释', () => {
  const w = loadClassic(['assets/lib/patch.js']);
  const P = w.XN.patch;
  assert.equal(P.balance('function a(){ return "}"; }').ok, true);
  assert.equal(P.balance('const s = `x ${ {a:1}.a } y`;').ok, true);
  assert.equal(P.balance('// }\nconst a = 1;').ok, true);
  assert.equal(P.balance('/* } */ function a(){}').ok, true);
  assert.equal(P.balance("var re = /[a-z0-9_']+/g; function a(){}").ok, true, '正则里的单引号不能被当成字符串');
  assert.equal(P.balance('function a(){').ok, false);
  assert.equal(P.balance('function a(){ return 1; }}').ok, false);
});

test('补丁规则：唯一命中 / 重复定义 / 禁止写法', () => {
  const w = loadClassic(['assets/lib/patch.js']);
  const P = w.XN.patch;
  const files = { 'a.js': 'function hello(){ return 1; }\nconst x = 1;\n' };

  assert.throws(() => P.applyPatches({ ...files }, [{ file: 'a.js', find: 'nope-nope', replace: 'x' }], ['a.js']), /找不到/);
  assert.throws(() => P.applyPatches({ ...files }, [{ file: 'a.js', find: 'const x = 1;', replace: 'function hello(){ return 2; }' }], ['a.js']), /重复定义/);
  assert.throws(() => P.applyPatches({ ...files }, [{ file: 'a.js', find: 'const x = 1;', replace: 'eval("x")' }], ['a.js']), /禁止/);
  assert.throws(() => P.applyPatches({ ...files }, [{ file: 'a.js', find: 'const x = 1;', replace: 'const x = {' }], ['a.js']), /括号/);

  const ok = P.applyPatches({ ...files }, [{ file: 'a.js', find: 'const x = 1;', replace: 'const x = 2;' }], ['a.js']);
  assert.equal(ok.length, 1);
  assert.equal(ok[0], 'a.js');
});

test('补丁规则：整份重写与版本号', () => {
  const w = loadClassic(['assets/lib/patch.js']);
  const P = w.XN.patch;
  const files = { 'a.js': 'x'.repeat(2000) };
  assert.throws(() => P.validatePlan(files, { mode: 'rewrite', rewrites: [{ file: 'a.js', content: 'short' }] }, ['a.js']), /太短/);

  assert.equal(P.bumpVersion('1.5.0', 'patch'), '1.5.1');
  assert.equal(P.bumpVersion('1.5.0', 'minor'), '1.6.0');
  assert.equal(P.bumpVersion('1.5.0', 'major'), '2.0.0');
  assert.equal(P.nextVersion('1.5.0', '1.5.2', 'patch'), '1.5.2');
  assert.equal(P.nextVersion('1.5.0', '9.9.9', 'patch'), '1.5.1');
});

test('云端共享层：内网地址识别', async () => {
  const S = await import('../cloudflare/shared.js');
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0x7f.0.0.1', '2130706433', '127.1', '::1', 'fc00::1', 'fe80::1', 'localhost', 'a.local']) {
    assert.equal(S.isPrivateHost(host), true, host + ' 应该被拦');
  }
  for (const host of ['example.com', 'api.deepseek.com', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(S.isPrivateHost(host), false, host + ' 不应该被拦');
  }
  assert.equal(S.safeBase('http://api.deepseek.com/v1', 'fallback', {}), 'fallback');
  assert.equal(S.safeBase('https://evil.example/v1', 'fallback', {}), 'fallback');
  assert.equal(S.safeBase('https://api.deepseek.com/v1', 'fallback', {}), 'https://api.deepseek.com/v1');
});

test('云端补丁规则与浏览器版一致', async () => {
  const R = await import('../cloudflare/rules.js');
  assert.equal(R.balance('const s = "}"; function a(){}').ok, true);
  assert.equal(R.balance('function a(){').ok, false);
  assert.equal(R.balance("var re = /[a-z0-9_']+/g; function a(){}").ok, true, '云端也要识别正则字面量');
  const files = { 'a.js': 'function hello(){ return 1; }\nconst x = 1;\n' };
  assert.throws(() => R.applyPatches({ ...files }, [{ file: 'a.js', find: 'const x = 1;', replace: 'function hello(){ return 1; }' }], ['a.js']), /重复定义/);
});

test('版本号与更新日志首条一致', () => {
  const changelog = read('assets/changelog.js');
  const pkg = JSON.parse(read('package.json'));
  const m = changelog.match(/"version"\s*:\s*"([^"]+)"/);
  assert.ok(m, 'changelog 里要能找到第一个版本号');
  assert.equal(m[1], pkg.version, 'package.json 与 changelog 首条必须一致');
  assert.match(read('assets/version.js'), new RegExp('\\|\\|\\s*"' + pkg.version.replace(/\./g, '\\.') + '"'));
});

test('中英文文案键一致', () => {
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js', 'assets/lib/i18n.js']);
  const dict = w.XN.i18n.dict;
  const zh = Object.keys(dict['zh-CN']).sort();
  const en = Object.keys(dict.en).sort();
  assert.deepEqual(en, zh, '两种语言的键必须一一对应');
});

test('繁体中文（zh-TW）文案键与 zh-CN 一致', () => {
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js', 'assets/lib/i18n.js']);
  const dict = w.XN.i18n.dict;
  const zh = Object.keys(dict['zh-CN']).sort();
  assert.ok(dict['zh-TW'], 'DICT 里必须有 zh-TW');
  assert.deepEqual(Object.keys(dict['zh-TW']).sort(), zh, 'zh-TW 的键必须和 zh-CN 一一对应');
  assert.deepEqual(Array.from(w.XN.i18n.locales), ['zh-CN', 'zh-TW', 'en'], '语言下拉的顺序：简中 → 繁中 → English');
  assert.equal(w.XN.i18n.name('zh-TW'), '繁體中文', '语言下拉要显示「繁體中文」');
  /* 繁体里不该混进简体专用字（人工粗筛，命中基本就是漏翻） */
  const simplified = '设认视频络软这个说开关问题错误试换删记载权复时间与应该现让对话请读写听见电脑网数据险银员团队输帮务统钟简单杂确逻辑响缓检测转传调断闭长击择张贴们样过经没谁么'.split('');
  const bad = Object.entries(dict['zh-TW'])
    .map(([key, text]) => ({ key, chars: simplified.filter((ch) => String(text).includes(ch)).join('') }))
    .filter((x) => x.chars);
  assert.deepEqual(bad, [], 'zh-TW 混进了简体字：' + JSON.stringify(bad));
});

test('存储键统一到 xn.v2 且带迁移表', () => {
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js']);
  const keys = Object.values(w.XN.store.KEYS);
  assert.ok(keys.every((k) => k.startsWith('xn.v2.')), '所有键都应是 xn.v2.*');
  assert.ok(Object.keys(w.XN.store.LEGACY).length >= 10, '旧键迁移表不能为空');
});

test('迁移不会把旧管理令牌搬进 localStorage', () => {
  /* store.js 装载时会自动跑一次 migrate()。旧版把管理令牌放在 xn.admin（localStorage），
     v1.5.5 起令牌只认 sessionStorage，所以迁移必须「删旧键」而不是「搬新键」——
     否则令牌会以 xn.v2.adminToken 永久落盘（Q94 复核 L6）。 */
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js'], {
    'xn.admin': 'LEGACY-TOKEN-ABCD',
    'xn.cfg.v1': '{"a":1}'
  });
  const data = w.localStorage._data;
  assert.equal(data['xn.v2.adminToken'], undefined, '旧管理令牌不许写进 localStorage');
  assert.equal(data['xn.admin'], undefined, '旧管理令牌要删掉，不能留在本机存储');
  assert.equal(data['xn.v2.cfg'], '{"a":1}', '普通旧键照常迁移');
  assert.equal(data['xn.cfg.v1'], undefined, '普通旧键迁移后要删掉');
});

test('记忆管理：list / update / remove / dedupe', () => {
  const now = Date.now();
  const day = 86400000;
  const seed = {
    name: '测试',
    explicit: [
      { id: 'e1', content: '我喜欢喝美式咖啡', ts: now - day * 3 },
      { id: 'e2', content: '我喜欢喝美式咖啡', ts: now - day },          // 和 e1 重复，但更新
      { id: 'e3', content: '每周三晚上有吉他课', ts: now - day * 2 }
    ],
    implicit: [
      { id: 'i1', content: '用户在准备考研，想每天背单词', ts: now - 3600000, source: 'dialog' },
      { id: 'i2', content: '用户在准备考研，想每天背单词！', ts: now - 1800000, source: 'note' }
    ]
  };
  const w = loadClassic(['assets/memory.js'], { 'xn.v2.mem': JSON.stringify(seed) });
  const M = w.XN_MEM;

  /* list：两组都给，每条带 id/content/ts/相对时间，组内新的在前 */
  const all = M.list();
  assert.equal(all.explicit.length, 3);
  assert.equal(all.implicit.length, 2);
  assert.equal(all.total, 5);
  for (const it of all.explicit.concat(all.implicit)) {
    assert.equal(typeof it.id, 'string');
    assert.ok(it.id.length > 0);
    assert.equal(typeof it.content, 'string');
    assert.ok(it.content.length > 0);
    assert.equal(typeof it.ts, 'number');
    assert.equal(typeof it.ago, 'string');
    assert.ok(it.ago.length > 0, '每条都要有相对时间');
  }
  /* 数组来自 vm 沙箱，跨 realm 的 deepEqual 会因原型不同而假失败，这里比字符串。 */
  assert.equal(all.explicit.map((x) => x.id).join(','), 'e2,e3,e1', '组内按时间倒序');
  assert.equal(all.implicit[0].source, 'note', '隐式记忆带来源');

  /* list({ kind }) 只给一组 */
  const onlyImplicit = M.list({ kind: 'implicit' });
  assert.equal(onlyImplicit.explicit.length, 0);
  assert.equal(onlyImplicit.implicit.length, 2);
  const onlyExplicit = M.list({ kind: 'explicit' });
  assert.equal(onlyExplicit.implicit.length, 0);

  /* update：能改文案、保留原 ts；空内容 / 超 200 字 / 不存在的 id 都要拒 */
  const before = all.explicit.find((x) => x.id === 'e3');
  assert.equal(M.update('e3', '  改成了每周四晚上有吉他课  '), true);
  const updated = M.list({ kind: 'explicit' }).explicit.find((x) => x.id === 'e3');
  assert.equal(updated.content, '改成了每周四晚上有吉他课', '首尾空白要剪掉');
  assert.equal(updated.ts, before.ts, '改文案不动时间戳');
  assert.equal(M.update('e3', '   '), false, '空内容拒绝');
  assert.equal(M.update('e3', 'x'.repeat(201)), false, '超过 200 字拒绝');
  assert.equal(M.update('e3', 'x'.repeat(200)), true, '刚好 200 字允许');
  assert.equal(M.update('没有这个 id', '随便'), false);

  /* remove：删一条返回 true，再删同一条返回 false；显式隐式都能删 */
  assert.equal(M.remove('e1'), true);
  assert.equal(M.remove('e1'), false);
  assert.equal(M.list({ kind: 'explicit' }).explicit.length, 2);
  assert.equal(M.remove('i2'), true);
  assert.equal(M.list({ kind: 'implicit' }).implicit.length, 1);
  assert.equal(M.remove(''), false, '空 id 直接拒');

  /* dedupe：另起一份干净数据，验证「相似合并、保留较新的 ts」 */
  const w2 = loadClassic(['assets/memory.js'], { 'xn.v2.mem': JSON.stringify(seed) });
  const M2 = w2.XN_MEM;
  assert.equal(M2.dedupe(), 2, 'e1/e2 合并 1 条 + i1/i2 合并 1 条');
  const after = M2.list();
  const cafe = after.explicit.filter((x) => x.content.indexOf('美式咖啡') >= 0);
  assert.equal(cafe.length, 1, '重复的显式记忆只留一条');
  assert.equal(cafe[0].ts, now - day, '保留较新的那条时间戳');
  const study = after.implicit.filter((x) => x.content.indexOf('考研') >= 0);
  assert.equal(study.length, 1, '重复的隐式记忆只留一条');
  assert.equal(study[0].ts, now - 1800000, '保留较新的那条时间戳');
  assert.equal(study[0].source, 'note', '保留较新那条的来源');
  assert.equal(M2.dedupe(), 0, '再跑一次没有可合并的');
});
