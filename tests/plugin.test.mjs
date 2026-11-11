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
 *   plugin:failed { id, error, fallback }          mount 抛错且能给出回滚版本时（P4）
 *   plugin:manifest / plugin:pin / plugin:rollback { id, version, url, status }
 *
 * P4（安装式扩展）契约：
 *   XN.plugin.loadManifest(url?)   有 url → fetch(url).json()；无 url → window.XN_PLUGIN_MANIFEST。
 *                                  校验 version（数值）/ plugins（数组）/ 每项 id+url；
 *                                  对 enabled !== false 且未注册的插件 install(url)；
 *                                  已注册且清单版本不同 → pendingUpdate（不热替换）；
 *                                  返回 { ok, loaded, skipped, errors, pending }，永不 reject。
 *   XN.plugin.pin(id, { version, url })   写 XN.state.cfg.pluginManifests[id]，旧记录进 history
 *   XN.plugin.rollback(id)                回滚到上一个 status === 'ok' 的 history 记录并清掉 pin
 *   XN.plugin.status(id)                  { enabled, mounted, version, pinned, history, ... }
 *   history 新的在前，最多 5 条；mount 失败会把该条 status 记成 'failed' 并提示可回滚版本。
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
const MANIFEST_FILE = path.join(root, 'assets/plugins/manifest.js');

/* 造一个假 window：只需要 XN.state.cfg、XN.emit、XN.views、XN.saveConfig、XN.toast。
   plugin.js 里 `root.XN = root.XN || {}`，所以预置的 XN 会被沿用。
   opts（P4 用，都可选）：document / fetch / manifest / plugins */
function makeHost(opts = {}) {
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
  if (opts.document) sandbox.document = opts.document;
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if (opts.manifest) sandbox.XN_PLUGIN_MANIFEST = opts.manifest;
  if (opts.plugins) sandbox.XN_PLUGINS = opts.plugins;
  sandbox.XN = {
    state,
    views: {},
    toast() {},
    emit(name, payload) { events.push([name, payload]); },
    saveConfig() { saved.count += 1; }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HOST_FILE, 'utf8'), sandbox, { filename: 'assets/lib/plugin.js' });
  return { host: sandbox.XN, XN: sandbox.XN, events, state, saved, sandbox };
}

/* 假 document：install() 只用到 createElement('script') + head.appendChild。
   doc.scripts[url] 模拟「这个地址的脚本执行了」；doc.failUrls 里的地址模拟加载失败。 */
function fakeDoc() {
  const doc = {
    scripts: {},
    failUrls: new Set(),
    injected: [],
    createElement(tag) {
      return { tagName: tag, src: '', async: false, onload: null, onerror: null };
    },
    head: {
      appendChild(el) {
        doc.injected.push(el.src);
        if (doc.failUrls.has(el.src)) {
          if (el.onerror) el.onerror();
          return;
        }
        const run = doc.scripts[el.src];
        if (typeof run === 'function') run(el);
        if (el.onload) el.onload();
      }
    }
  };
  return doc;
}

/* 假的 fetch：table[url] = { body } | { http: 500 } | Error */
function fakeFetch(table) {
  return function (url) {
    const item = table[url];
    if (!item) return Promise.reject(new Error('ENOENT ' + url));
    if (item instanceof Error) return Promise.reject(item);
    if (item.http) return Promise.resolve({ ok: false, status: item.http, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(item.body) });
  };
}

function loadDefaultManifest(sandbox) {
  vm.runInContext(fs.readFileSync(MANIFEST_FILE, 'utf8'), sandbox, { filename: 'assets/plugins/manifest.js' });
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

/* ---------------- P4：安装式扩展 ---------------- */

test('7) 清单校验/拉取失败：返回清楚错误，已加载插件不受影响', async () => {
  const doc = fakeDoc();
  const { host, sandbox } = makeHost({ document: doc });
  let keeperMounted = false;
  host.plugin.register({
    id: 'keeper',
    name: '老插件',
    version: '1.0.0',
    mount() { keeperMounted = true; }
  });
  host.plugin.boot();
  assert.equal(keeperMounted, true);

  /* a) 结构不合法：version 不是数值 */
  sandbox.fetch = fakeFetch({ 'bad.json': { body: { version: 'one', plugins: [] } } });
  const bad = await host.plugin.loadManifest('bad.json');
  assert.equal(bad.ok, false, '结构不合法时 ok 必须是 false');
  assert.ok(bad.errors.length >= 1, '要给出错误');
  assert.match(bad.errors[0].reason, /version/, '错误要说清楚是 version 的问题');
  assert.deepEqual(Array.from(bad.loaded), []);
  assert.deepEqual(Array.from(bad.skipped), []);

  /* b) 拉取失败（断网/HTTP 500/非法 JSON）也不能影响已有插件 */
  sandbox.fetch = fakeFetch({ 'down.json': new Error('网断了') });
  const down = await host.plugin.loadManifest('down.json');
  assert.equal(down.ok, false);
  assert.match(down.errors[0].reason, /读取清单失败/);
  assert.match(down.errors[0].reason, /网断了/);

  /* c) 单项缺 url：整体清单可用，该项进 errors、不注入 */
  sandbox.fetch = fakeFetch({
    'half.json': { body: { version: 1, plugins: [{ id: 'half' }, { id: 'no-url', version: '1.0.0' }] } }
  });
  const half = await host.plugin.loadManifest('half.json');
  assert.equal(half.ok, true, '清单整体结构合法就算 ok，坏项只进 errors');
  assert.equal(half.errors.length, 2);
  assert.equal(half.errors[0].id, 'half');
  assert.match(half.errors[0].reason, /id 或 url/);
  assert.deepEqual(Array.from(half.loaded), []);

  /* d) 没有本地清单、也没给 url：同样只是返回错误，不抛 */
  const bare = makeHost();
  const local = await bare.host.plugin.loadManifest();
  assert.equal(local.ok, false);
  assert.match(local.errors[0].reason, /XN_PLUGIN_MANIFEST/);

  /* 全程：老插件还挂着，一个脚本都没注入 */
  assert.equal(doc.injected.length, 0, '失败的清单不能注入任何脚本');
  assert.equal(host.plugin.status('keeper').mounted, true);
  assert.ok(Array.from(host.plugin.mounted()).includes('keeper'), '已有插件不能被清单失败带下来');
  assert.equal(host.plugin.list().filter((p) => p.id === 'keeper').length, 1);
});

test('8) 清单里 enabled:false 跳过，启用的才注入', async () => {
  const doc = fakeDoc();
  const manifest = {
    version: 1,
    plugins: [
      { id: 'on-one', url: 'on-one.js', version: '1.0.0', description: '启用的' },
      { id: 'off-one', url: 'off-one.js', version: '1.0.0', enabled: false },
      { id: 'off-two', url: 'off-two.js', version: '1.0.0', enabled: false }
    ]
  };
  const { host, state } = makeHost({ document: doc, manifest });
  doc.scripts['on-one.js'] = () => host.plugin.register({ id: 'on-one', version: '1.0.0', mount() {} });

  const res = await host.plugin.loadManifest();
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.loaded), ['on-one']);
  assert.deepEqual(Array.from(res.skipped), ['off-one', 'off-two']);
  assert.deepEqual(Array.from(doc.injected), ['on-one.js'], 'enabled:false 的去注入脚本一步都不该走');

  assert.ok(Array.from(host.plugin.mounted()).includes('on-one'));
  assert.equal(host.plugin.list().filter((p) => p.id === 'off-one').length, 0, '跳过的插件不注册');

  const rec = state.cfg.pluginManifests['on-one'];
  assert.equal(rec.status, 'ok');
  assert.equal(rec.version, '1.0.0');
  assert.equal(rec.url, 'on-one.js');
  assert.ok(rec.installedAt > 0, '安装记录要有时间戳');
});

test('9) 重复 id 不重复注入（第二次 loadManifest 只 skip）', async () => {
  const doc = fakeDoc();
  const manifest = { version: 1, plugins: [{ id: 'dup-one', url: 'dup-one.js', version: '1.0.0' }] };
  const { host } = makeHost({ document: doc, manifest });
  let mounts = 0;
  doc.scripts['dup-one.js'] = () => host.plugin.register({ id: 'dup-one', version: '1.0.0', mount() { mounts += 1; } });

  const first = await host.plugin.loadManifest();
  assert.deepEqual(Array.from(first.loaded), ['dup-one']);

  const second = await host.plugin.loadManifest();
  assert.deepEqual(Array.from(second.loaded), [], '第二次不该再装');
  assert.deepEqual(Array.from(second.skipped), ['dup-one'], '已注册且版本一致 → skip');
  assert.equal(mounts, 1, '不能挂两次');
  assert.deepEqual(Array.from(doc.injected), ['dup-one.js'], '同一个脚本地址只注入一次');
  assert.equal(host.plugin.list().filter((p) => p.id === 'dup-one').length, 1);
});

test('10) 清单版本不同只记 pendingUpdate，不热替换已注册插件', async () => {
  const doc = fakeDoc();
  const manifest = { version: 1, plugins: [{ id: 'ver-plugin', url: 'ver-plugin-2.js', version: '2.0.0' }] };
  const { host } = makeHost({ document: doc, manifest });
  host.plugin.register({ id: 'ver-plugin', name: '版本插件', version: '1.0.0', mount() {} });
  host.plugin.boot();

  const res = await host.plugin.loadManifest();
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.loaded), [], '不能热替换');
  assert.deepEqual(Array.from(res.skipped), []);
  assert.deepEqual(Array.from(res.pending), ['ver-plugin']);
  assert.equal(doc.injected.length, 0, '有更新也不能偷偷注入新脚本');

  const pending = host.plugin.pendingUpdates();
  assert.equal(pending['ver-plugin'].version, '2.0.0');
  assert.equal(pending['ver-plugin'].from, '1.0.0');
  assert.equal(pending['ver-plugin'].url, 'ver-plugin-2.js');

  const st = host.plugin.status('ver-plugin');
  assert.equal(st.version, '1.0.0', '还在跑的是老版本');
  assert.equal(st.pendingUpdate.version, '2.0.0');
  assert.equal(st.status, 'ok');
});

test('11) pin 切换 url/version，rollback 回到上一个 ok 记录，history 最多 5 条', () => {
  const { host, state } = makeHost();
  host.plugin.register({ id: 'ver', name: '版本插件', version: '1.0.0', mount() {} });
  host.plugin.boot();

  /* 没记录的 id：status 不能炸 */
  const none = host.plugin.status('nope');
  assert.equal(none.status, 'unknown');
  assert.equal(none.version, '');
  assert.equal(none.pinned, null);
  assert.deepEqual(Array.from(none.history), []);
  assert.equal(none.canRollback, false);

  const pin1 = host.plugin.pin('ver', { version: '1.0.0', url: 'ver-1.js' });
  assert.equal(pin1.ok, true);
  let st = host.plugin.status('ver');
  assert.equal(st.version, '1.0.0');
  assert.equal(st.url, 'ver-1.js');
  assert.equal(st.pinned.version, '1.0.0');
  assert.equal(st.history.length, 0, '第一次 pin 没有旧版本可记');
  assert.equal(st.canRollback, false);

  host.plugin.pin('ver', { version: '2.0.0', url: 'ver-2.js' });
  st = host.plugin.status('ver');
  assert.equal(st.version, '2.0.0', 'pin 后版本要切');
  assert.equal(st.url, 'ver-2.js', 'pin 后 url 要切');
  assert.equal(st.history.length, 1);
  assert.equal(st.history[0].version, '1.0.0', '被换下来的 ok 版本进历史');
  assert.equal(st.history[0].url, 'ver-1.js');
  assert.equal(st.canRollback, true);
  assert.equal(st.rollbackVersion, '1.0.0');
  assert.equal(state.cfg.pluginManifests.ver.url, 'ver-2.js', '记录要落到 cfg.pluginManifests');

  const back = host.plugin.rollback('ver');
  assert.equal(back.ok, true);
  assert.equal(back.version, '1.0.0');
  st = host.plugin.status('ver');
  assert.equal(st.version, '1.0.0', 'rollback 后版本回到 ok 记录');
  assert.equal(st.url, 'ver-1.js', 'rollback 后 url 也跟着回去');
  assert.equal(st.status, 'ok');
  assert.equal(st.pinned, null, '显式回滚要解开 pin');
  assert.equal(state.cfg.pluginManifests.ver.url, 'ver-1.js');

  /* history 上限 5：连续 pin 到 9.0.0，只留最近 5 条 */
  for (let i = 3; i <= 9; i++) host.plugin.pin('ver', { version: i + '.0.0', url: 'ver-' + i + '.js' });
  st = host.plugin.status('ver');
  assert.equal(st.version, '9.0.0');
  assert.equal(st.history.length, 5, '历史最多 5 条');
  assert.equal(st.history[0].version, '8.0.0', '历史新的在前');

  /* 没有历史可回时给清楚失败 */
  const nope = makeHost();
  nope.host.plugin.pin('only', { version: '1.0.0', url: 'only.js' });
  const fail = nope.host.plugin.rollback('only');
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /没有可回滚的 ok 版本/);
});

test('12) mount 失败记 failed 并提示可回滚，rollback 能回到 ok 版本', () => {
  const { host, events } = makeHost();
  let fail = false;
  host.plugin.register({
    id: 'flaky',
    name: '脆弱插件',
    version: '1.0.0',
    mount() { if (fail) throw new Error('mount boom'); },
    unmount() {}
  });
  host.plugin.boot();

  host.plugin.pin('flaky', { version: '1.0.0', url: 'flaky-1.js' });
  host.plugin.pin('flaky', { version: '2.0.0', url: 'flaky-2.js' });
  assert.equal(host.plugin.status('flaky').history.length, 1);

  fail = true;
  host.plugin.setEnabled('flaky', false);
  host.plugin.setEnabled('flaky', true);  /* 这次 mount 会抛错 */

  const st = host.plugin.status('flaky');
  assert.equal(st.status, 'failed', 'mount 失败要把该条记成 failed');
  assert.equal(st.mounted, false);
  assert.equal(st.version, '2.0.0');
  assert.equal(st.canRollback, true, '有 ok 历史就能回滚');
  assert.equal(st.rollbackVersion, '1.0.0');
  assert.equal(host.plugin.rollbackAvailable('flaky'), true);

  const failed = events.filter((e) => e[0] === 'plugin:failed').pop();
  assert.ok(failed, 'mount 失败要发 plugin:failed（UI 拿它提示）');
  assert.equal(failed[1].id, 'flaky');
  assert.equal(failed[1].fallback.version, '1.0.0', '提示里要带可回滚的版本');

  const back = host.plugin.rollback('flaky');
  assert.equal(back.ok, true);
  const after = host.plugin.status('flaky');
  assert.equal(after.status, 'ok', '回滚后记录恢复 ok');
  assert.equal(after.version, '1.0.0');
  assert.equal(after.url, 'flaky-1.js');
  assert.equal(after.pinned, null);

  /* 记录里不存在的 id：回滚给清楚错误，不抛 */
  const missing = host.plugin.rollback('never-installed');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没有 never-installed 的安装记录/);
});

test('13) 本地默认清单 manifest.js → loadManifest() 装上 export-session', async () => {
  const doc = fakeDoc();
  const { host, sandbox } = makeHost({ document: doc });
  loadDefaultManifest(sandbox);

  assert.equal(sandbox.XN_PLUGIN_MANIFEST.version, 1, '清单格式版本是 1');
  assert.equal(sandbox.XN_PLUGIN_MANIFEST.plugins.length, 1, '本地默认清单先放 export-session 一项');
  const entry = sandbox.XN_PLUGIN_MANIFEST.plugins[0];
  assert.equal(entry.id, 'export-session');
  assert.equal(entry.url, 'assets/plugins/export-session.js');
  assert.equal(entry.enabled, true);

  doc.scripts['assets/plugins/export-session.js'] = () => {
    host.plugin.register({ id: 'export-session', name: '导出当前会话', version: '1.0.0', mount() {} });
  };

  const res = await host.plugin.loadManifest();
  assert.equal(res.ok, true, '本地清单也要走同一套校验');
  assert.deepEqual(Array.from(res.loaded), ['export-session']);
  assert.equal(res.errors.length, 0);

  const st = host.plugin.status('export-session');
  assert.equal(st.enabled, true);
  assert.equal(st.mounted, true);
  assert.equal(st.version, '1.0.0');
  assert.equal(st.url, 'assets/plugins/export-session.js');
  assert.equal(st.status, 'ok');
});
