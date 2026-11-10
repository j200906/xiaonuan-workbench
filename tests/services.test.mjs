/* 能力接口层（P3）契约测试 */
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
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, text: 'x' }) }),
    document: {
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, key() { return null; }, get length() { return 0; } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['assets/lib/util.js', 'assets/lib/store.js', 'assets/lib/services.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

test('能力接口：默认实现齐全且 ready 可查询', () => {
  const w = load();
  const s = w.XN.services;
  /* 跨 vm realm 的数组原型不同，deepEqual 会假失败，这里比字符串 */
  assert.equal(s.names().sort().join(','), 'fetch,llm,search,storage');
  const list = s.list();
  assert.equal(list.length, 4);
  for (const item of list) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.ready, 'boolean');
    assert.ok(Array.isArray(item.methods) && item.methods.length > 0, item.name + ' 要有方法');
  }
  const st = s.use('storage');
  assert.equal(typeof st.get, 'function');
  assert.equal(typeof st.set, 'function');
});

test('能力接口：注册的实现会覆盖默认，reset 能还原', () => {
  const w = load();
  const s = w.XN.services;
  const fake = {
    get: async () => ({ ok: true, text: 'FAKE', total: 4, truncated: false }),
    ready: () => true
  };
  s.register('fetch', fake);
  assert.equal(s.use('fetch'), fake, 'register 后 use 应返回同一个实现');
  assert.equal(s.list().find((x) => x.name === 'fetch').builtin, false);

  assert.equal(s.reset('fetch'), true);
  assert.notEqual(s.use('fetch'), fake, 'reset 后应回到默认实现');
  assert.equal(s.list().find((x) => x.name === 'fetch').builtin, true);
});

test('能力接口：未知服务报错，注册缺参报错', () => {
  const w = load();
  const s = w.XN.services;
  assert.throws(() => s.use('nope'), /未知服务/);
  assert.throws(() => s.register('x'), /需要/);
  assert.throws(() => s.register(), /需要/);
});

test('能力接口：fetch 服务默认实现会带上 offset', async () => {
  const w = load();
  const calls = [];
  w.fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ ok: true, text: 'abc', total: 3, truncated: false }) };
  };
  const r = await w.XN.services.use('fetch').get('https://example.com/x', 12000);
  assert.equal(r.ok, true);
  assert.match(calls[0], /offset=12000/);
  assert.match(calls[0], /url=https%3A%2F%2Fexample\.com%2Fx/);
});
