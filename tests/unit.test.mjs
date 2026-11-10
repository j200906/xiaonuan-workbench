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

test('存储键统一到 xn.v2 且带迁移表', () => {
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js']);
  const keys = Object.values(w.XN.store.KEYS);
  assert.ok(keys.every((k) => k.startsWith('xn.v2.')), '所有键都应是 xn.v2.*');
  assert.ok(Object.keys(w.XN.store.LEGACY).length >= 10, '旧键迁移表不能为空');
});

test('存储用量统计：小样本能算对总字节', () => {
  /* usage() 按 xn.v2.* 逐键算 UTF-8 字节数；旧 xn.* 与无关键都不该算进去。
     样本里放一个 3 字节的汉字，确保不是按「字符数」糊弄过去的。 */
  const seeded = {
    'xn.v2.sessions': '[{"id":"a","body":"暖"}]',
    'xn.v2.notes': 'hello',
    'xn.somethingOld': '{"legacy":true}',
    'other.thing': 'nope'
  };
  const w = loadClassic(['assets/lib/util.js', 'assets/lib/store.js'], seeded);
  const used = w.XN.store.usage();

  /* 注意：vm 沙箱里的数组有自己的 Array.prototype，先摊开成本机数组再比，
     否则 deepEqual 会因为「结构相同但原型不同」报错。 */
  assert.deepEqual([...used.keys.map((k) => k.key)].sort(), ['xn.v2.notes', 'xn.v2.sessions']);
  const enc = new TextEncoder();
  const expectedNotes = enc.encode(seeded['xn.v2.notes']).length;
  const expectedSessions = enc.encode(seeded['xn.v2.sessions']).length;
  const byKey = Object.fromEntries(used.keys.map((k) => [k.key, k.bytes]));
  assert.equal(byKey['xn.v2.notes'], expectedNotes);
  assert.equal(byKey['xn.v2.sessions'], expectedSessions);
  assert.equal(used.totalBytes, expectedNotes + expectedSessions);
  assert.equal(used.bytes, used.totalBytes, '兼容字段 bytes 要等于 totalBytes');
  assert.equal(used.quotaHint.assumedQuotaBytes, 5 * 1024 * 1024);
  assert.equal(used.quotaHint.level, 'ok');
  assert.ok(used.quotaHint.usedRatio >= 0 && used.quotaHint.usedRatio < 0.7);
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
