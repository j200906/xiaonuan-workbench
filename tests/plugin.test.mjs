/* 插件宿主 v2 契约测试（不依赖 DOM：视图用假对象，window 用 vm 沙箱）
 *
 * 本文件就是「宿主 v2」的规范。宿主要在 assets/lib/plugin.js 里满足这些约定：
 *
 *   XN.plugin.register(spec)     spec.id 必填；重复 id 直接忽略（只保留第一个）
 *   XN.plugin.boot()             挂载所有已登记且启用的插件（幂等，可重复调用）
 *   XN.plugin.setEnabled(id,on)  开关；关掉时调 unmount() 并执行全部 onDispose
 *   XN.plugin.mounted()          返回已挂载的 id 数组
 *   XN.plugin.view(viewId)       取视图对象（view 传入后的登记结果）
 *   XN.plugin.list()             插件清单（含 id / enabled / mounted）
 *
 * 事件（都用 XN.emit(name, payload) 发）：
 *   plugin:skip   { id, missing: ['x', ...] }      requires 缺依赖时
 *   plugin:error  { id, error }                    mount 抛错时（宿主不能崩）
 *
 * 视图别名：插件 id 形如 'view-study' 时，
 *   XN.plugin.view('view-study')、XN.views['view-study']、XN.views.study 指向同一个视图对象
 *   —— 最后一个是给老的 app.core 路由（XN.views[state.view]）用的兼容别名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_FILE = path.join(root, 'assets/lib/plugin.js');

/* 造一个假 window：只需要 XN.state.cfg、XN.emit、XN.views、XN.saveConfig、XN.toast。
   plugin.js 里 `root.XN = root.XN || {}`，所以预置的 XN 会被沿用。 */
function makeHost() {
  const events = [];
  const state = { cfg: {} };
  const saved = { count: 0 };
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.XN = {
    state,
    views: {},
    toast() {},
    emit(name, payload) { events.push([name, payload]); },
    saveConfig() { saved.count += 1; }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HOST_FILE, 'utf8'), sandbox, { filename: 'assets/lib/plugin.js' });
  return { host: sandbox.XN, XN: sandbox.XN, events, state, saved };
}

/* 视图对象：不碰 DOM，只要是被同一个引用取回来就算对 */
function fakeView(name) {
  return { name, init() {}, onShow() {} };
}

test('1) 重复 id 注册被忽略，只保留第一个', () => {
  const { host, XN } = makeHost();
  let mountCount = 0;
  host.plugin.register({ id: 'dup', name: '第一个', mount() { mountCount += 1; } });
  host.plugin.register({ id: 'dup', name: '第二个', mount() { mountCount += 1; } });
  host.plugin.boot();

  const rows = host.plugin.list().filter((p) => p.id === 'dup');
  assert.equal(rows.length, 1, '同一个 id 只能有一条登记');
  assert.equal(rows[0].name, '第一个', '保留的应该是先注册的那个');
  assert.equal(mountCount, 1, '被忽略的重复注册不能再挂一次');
  assert.deepEqual(Array.from(host.plugin.mounted()), ['dup']);
  // 事件里也不该出现第二个插件的东西
  assert.equal(XN.state.cfg.plugins && XN.state.cfg.plugins.dup, undefined);
});

test('2) requires 缺失 → 不挂载，且 plugin:skip 带 missing 列表', () => {
  const { host, events } = makeHost();
  let mounted = false;
  host.plugin.register({
    id: 'needs-host',
    name: '缺依赖的插件',
    requires: ['plugin-host', 'view-study'],
    mount() { mounted = true; }
  });
  host.plugin.boot();

  assert.equal(mounted, false, '缺依赖时不能 mount');
  assert.ok(!host.plugin.mounted().includes('needs-host'));

  const skip = events.filter((e) => e[0] === 'plugin:skip');
  /* 宿主可能在 register 与 boot 各判定一次，所以只要求「至少一次」且载荷正确 */
  assert.ok(skip.length >= 1, '应该发 plugin:skip');
  assert.equal(skip[0][1].id, 'needs-host');
  assert.deepEqual(Array.from(skip[0][1].missing).sort(), ['plugin-host', 'view-study']);
  skip.forEach((e) => assert.deepEqual(Array.from(e[1].missing).sort(), ['plugin-host', 'view-study'], '每次 skip 的 missing 都要完整'));
});

test('3) mount 抛错 → 宿主不崩，plugin:error 有记录，其它插件照常挂载', () => {
  const { host, events } = makeHost();
  let goodMounted = false;
  host.plugin.register({
    id: 'boom',
    name: '会炸的插件',
    mount() { throw new Error('boom'); }
  });
  host.plugin.register({
    id: 'good',
    name: '正常插件',
    mount() { goodMounted = true; }
  });

  assert.doesNotThrow(() => host.plugin.boot(), '一个插件 mount 抛错不能把宿主带崩');
  assert.equal(goodMounted, true, '其它插件要照常挂载');
  assert.ok(host.plugin.mounted().includes('good'));
  assert.ok(!host.plugin.mounted().includes('boom'));

  const errs = events.filter((e) => e[0] === 'plugin:error');
  /* 同样只要求「至少一次」：register 自动挂 + boot 再挂，会各记一次 */
  assert.ok(errs.length >= 1, '应该发 plugin:error');
  assert.equal(errs[0][1].id, 'boom');
  assert.ok(errs[0][1].error instanceof Error || String(errs[0][1].error).includes('boom'));
  errs.forEach((e) => assert.equal(e[1].id, 'boom', 'error 事件要指到出错的那个插件'));
});

test('4) setEnabled(false) → unmount + 全部 onDispose；再 setEnabled(true) 挂回来', () => {
  const { host } = makeHost();
  const calls = [];
  host.plugin.register({
    id: 'toggle',
    name: '可开关的插件',
    mount(ctx) {
      calls.push('mount');
      ctx.onDispose(() => calls.push('dispose-1'));
      ctx.onDispose(() => calls.push('dispose-2'));
    },
    unmount() { calls.push('unmount'); }
  });
  host.plugin.boot();
  assert.deepEqual(calls, ['mount']);
  assert.ok(host.plugin.mounted().includes('toggle'));

  assert.equal(host.plugin.setEnabled('toggle', false), true);
  assert.equal(calls.filter((c) => c === 'unmount').length, 1, '关掉要调 unmount');
  assert.deepEqual(calls.filter((c) => c.indexOf('dispose') === 0), ['dispose-1', 'dispose-2'], '两个 onDispose 都要执行');
  assert.ok(!host.plugin.mounted().includes('toggle'), '关掉后 mounted() 不能含该 id');

  assert.equal(host.plugin.setEnabled('toggle', true), true);
  assert.equal(calls.filter((c) => c === 'mount').length, 2, '重新打开要再 mount 一次');
  assert.ok(host.plugin.mounted().includes('toggle'), '打开后 mounted() 应该回来');
});

test('5) 视图注册：plugin.view 能取到，XN.views 同步（含去掉 view- 前缀的兼容别名）', () => {
  const { host, XN } = makeHost();
  const study = fakeView('study');
  host.plugin.register({ id: 'view-study', name: '学习台', version: '2.0.0', view: study, nav: { order: 20 } });
  host.plugin.boot();

  /* 视图 id = view.id（有就用）或者插件 id 去掉 view- 前缀，所以 'view-study' 登记成 'study' */
  assert.equal(host.plugin.view('study'), study, 'plugin.view 要能取到视图对象');
  assert.equal(XN.views.study, study, 'XN.views 要同步一份给老路由用');
});

test('5b) 视图自带 id 时以 view.id 为准', () => {
  const { host, XN } = makeHost();
  const board = Object.assign(fakeView('board'), { id: 'study-board' });
  host.plugin.register({ id: 'view-board-plugin', name: '看板', view: board });
  host.plugin.boot();

  assert.equal(host.plugin.view('study-board'), board);
  assert.equal(XN.views['study-board'], board);
});

test('6) view 重复注册：第二个被拒绝，第一个保住', () => {
  const { host, XN } = makeHost();
  const first = Object.assign(fakeView('first'), { id: 'dup' });
  const second = Object.assign(fakeView('second'), { id: 'dup' });
  host.plugin.register({ id: 'view-dup', name: '先来的', view: first });
  /* 两个插件抢同一个 view id（view.id 都是 'dup'）：后到的不能覆盖 */
  host.plugin.register({ id: 'view-dup-2', name: '来抢的', view: second });
  host.plugin.boot();

  assert.equal(host.plugin.view('dup'), first, '同一个 view id 不能被覆盖');
  assert.equal(XN.views.dup, first);
  assert.notEqual(XN.views.dup, second);
  assert.ok(!Object.values(XN.views).includes(second), '被拒绝的视图不能挂进 XN.views');
});
