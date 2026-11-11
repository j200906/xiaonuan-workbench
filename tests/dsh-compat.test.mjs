/* DSH 兼容层契约测试：ctx 垫片的行为 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/lib/dsh-compat.js'), 'utf8'), sandbox, { filename: 'dsh-compat.js' });
  return sandbox;
}

test('DSH 兼容：ctx.command 注册后能列出并执行', async () => {
  const w = load();
  const ctx = w.XN.dsh.createContext('p1', {});
  let called = 0;
  ctx.command('hello', '打招呼').action((x) => { called += 1; return x; });

  const list = w.XN.dsh.commands();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'hello');
  assert.equal(list[0].desc, '打招呼');

  const r = await w.XN.dsh.runCommand('hello', 42);
  assert.equal(r, 42);
  assert.equal(called, 1);
});

test('DSH 兼容：ctx.effect 的清理函数在 dispose 时逆序执行', () => {
  const w = load();
  const ctx = w.XN.dsh.createContext('p2', {});
  const order = [];
  ctx.effect(() => () => order.push('first'));
  ctx.effect(() => () => order.push('second'));

  ctx.dispose();
  assert.equal(order.join(','), 'second,first', '应当逆序清理');
});

test('DSH 兼容：ctx.on 转发到宿主事件并随 dispose 解绑', () => {
  const w = load();
  const handlers = [];
  let offCalled = 0;
  w.XN.on = (evt, fn) => { handlers.push({ evt, fn }); return () => { offCalled += 1; }; };
  w.XN.emit = (evt, payload) => handlers.filter((h) => h.evt === evt).forEach((h) => h.fn(payload));

  const ctx = w.XN.dsh.createContext('p3', {});
  let got = null;
  ctx.on('demo', (p) => { got = p; });
  ctx.emit('demo', { a: 1 });
  assert.deepEqual(got, { a: 1 });

  ctx.dispose();
  assert.equal(offCalled, 1, 'dispose 应解绑事件');
});

test('DSH 兼容：ctx.set 已知服务会桥接到 XN.services', () => {
  const w = load();
  const registered = [];
  w.XN.services = {
    register: (name, impl) => registered.push([name, impl]),
    use: (name) => ({ name })
  };
  const ctx = w.XN.dsh.createContext('p4', {});
  const impl = { get: async () => ({ ok: true }) };
  ctx.set('fetch', impl);

  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], 'fetch');
  assert.equal(registered[0][1], impl);
  assert.deepEqual(ctx.get('storage'), { name: 'storage' }, '未覆盖的服务取默认实现');

  ctx.set('custom', 123);
  assert.equal(ctx.get('custom'), 123, '自定义服务进 shared 表');
});

test('DSH 兼容：ctx.view 会桥接到小暖插件宿主', () => {
  const w = load();
  const regs = [];
  w.XN.plugin = { register: (def) => { regs.push(def); return def; } };
  const ctx = w.XN.dsh.createContext('p5', {});
  ctx.view({ id: 'dsh-demo', title: 'DSH 示例', onShow() {} });

  assert.equal(regs.length, 1);
  assert.equal(regs[0].id, 'view-dsh-demo');
  assert.equal(regs[0].name, 'DSH 示例');
  assert.equal(typeof regs[0].view.onShow, 'function');
});

test('DSH 兼容：没有 apply 的模块会被拒绝', async () => {
  const w = load();
  const r = await w.XN.dsh.runModule({ x: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /apply|activate|default/);
});

test('DSH 兼容：apply(ctx) 跑通并桥接命令与视图', async () => {
  const w = load();
  const regs = [];
  w.XN.plugin = { register: (def) => { regs.push(def); return def; } };
  const mod = { apply(ctx) { ctx.command('hi').action(() => 'ok'); ctx.view({ id: 'dshtest', title: 'T' }); } };
  const r = await w.XN.dsh.runModule(mod, { id: 'demo' });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(w.XN.dsh.commands().some((c) => c.name === 'hi'), true);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].id, 'view-dshtest');
});

test('DSH 兼容：apply 抛错会返回 ok:false 而不是炸掉', async () => {
  const w = load();
  const r = await w.XN.dsh.runModule({ apply() { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});
