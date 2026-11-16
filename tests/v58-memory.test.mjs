/* v5.8 移植期回归（第二批）：记忆增强 + 主动引擎 + 目标推导
 *
 * 这批补的是「让它活着」的部分：
 *   - 记忆会衰减：旧事淡去，重要和常被提起的留住
 *   - 说错「忘掉」能撤回
 *   - 会自己攒观点（特质），互斥的会互相削弱
 *   - 会主动开口：跟进、情绪回访、时间问候，但有配额和间隔
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 造一个最小可用的 XN_MEM：load 返回引用、save 记录次数 */
function makeMem(seed) {
  let data = Object.assign({
    name: '',
    explicit: [],
    implicit: [],
    relation: { stage: 0, warmth: 0, interactions: 0 },
    goals: [],
    promises: [],
    seen: {},
    msgCount: 0,
    lastConsolidate: 0
  }, seed || {});
  return {
    load: () => data,
    save: () => { if (this) this.saves = (this.saves || 0) + 1; return true; },
    saves: 0,
    _data: () => data
  };
}

function load(seed, extra) {
  const sandbox = Object.assign({
    console, Date, Math, JSON, String, Number, Object, Array, RegExp, Promise, Error,
    setTimeout, clearTimeout
  }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const mem = makeMem(seed);
  sandbox.XN = { state: { lastEmo: { emo: 'neutral', intensity: 0.3 }, lastUserAt: 0, turnCount: 0 } };
  sandbox.XN_MEM = mem;
  for (const f of ['assets/lib/memory-ext.js', 'assets/lib/proactive.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, mem, mp: sandbox.XN.memPlus, pro: sandbox.XN.proactive };
}

const DAY = 86400000;

/* ---------------- 衰减 ---------------- */
test('衰减：越旧分数越低，重要的事忘得慢', () => {
  const { mp } = load();
  const now = Date.now();
  const fresh = mp.retention({ importance: 6, ts: now, accessCount: 0 }, now);
  const old = mp.retention({ importance: 6, ts: now - 30 * DAY, accessCount: 0 }, now);
  assert.ok(old < fresh, '30 天前的应当比刚记得的低');

  const important = mp.retention({ importance: 10, ts: now - 30 * DAY, accessCount: 0 }, now);
  assert.ok(important > old, '同样 30 天，重要性 10 的应当高于 6');
});

test('衰减：显式记忆有加成，常被提到的分数更高', () => {
  const { mp } = load();
  const now = Date.now();
  const implicit = mp.retention({ importance: 6, ts: now, accessCount: 0, source: 'implicit' }, now);
  const explicit = mp.retention({ importance: 6, ts: now, accessCount: 0, source: 'explicit' }, now);
  assert.ok(explicit > implicit, '显式记忆应当有加成');

  const touched = mp.retention({ importance: 6, ts: now, accessCount: 5, source: 'implicit' }, now);
  assert.ok(touched > implicit, '被提到 5 次的应当高于 0 次');
});

test('衰减：低分隐式记忆被标 faded，显式记忆不会被淡出', () => {
  const { mp, mem } = load({
    explicit: [{ id: 'e1', content: '用户叫阿杰', ts: Date.now() - 400 * DAY, source: 'explicit' }],
    implicit: [{ id: 'i1', content: '随便提过一句', ts: Date.now() - 400 * DAY, importance: 1 }]
  });
  mp.decay(true);
  const d = mem._data();
  assert.equal(d.explicit[0].status === 'faded', false, '显式记忆不该淡出');
  assert.equal(d.implicit[0].status, 'faded', '很久没提的低重要度隐式记忆应当淡出');
});

/* ---------------- 复活 ---------------- */
test('复活：忘掉之后能撤回，且只恢复被忘的那些', () => {
  const { mp, mem } = load({
    explicit: [
      { id: 'e1', content: '喜欢喝美式', ts: Date.now() },
      { id: 'e2', content: '在准备考研', ts: Date.now() }
    ]
  });
  const d = mem._data();
  /* 模拟 forget：删掉第一条，同时留快照 */
  mp.snapshotForget('美式');
  d.explicit = d.explicit.filter((x) => x.id !== 'e1');
  assert.equal(d.explicit.length, 1);

  const n = mp.revive();
  assert.equal(n, 1, '应当恢复 1 条');
  assert.equal(mem._data().explicit.length, 2, '恢复后应当回到 2 条');
  assert.ok(mem._data().explicit.some((x) => x.id === 'e1'));
});

test('复活：超过 10 分钟就不能撤回', () => {
  const { mp } = load({ explicit: [{ id: 'e1', content: 'x', ts: Date.now() }] });
  mp.snapshotForget('x');
  /* 手动把快照时间拨回 20 分钟前 */
  const realNow = Date.now;
  Date.now = () => realNow() + 20 * 60 * 1000;
  try {
    assert.equal(mp.revive(), 0, '过期不该恢复');
  } finally {
    Date.now = realNow;
  }
});

/* ---------------- 人格特质 ---------------- */
test('特质：同类累积加分，达到阈值才生效', () => {
  const { mp } = load();
  mp.addTrait('喜欢用比喻');
  assert.equal(mp.activeTraits().length, 0, '强度 1 还不该生效');

  mp.addTrait('喜欢用比喻');
  mp.addTrait('喜欢用比喻');
  const act = mp.activeTraits();
  assert.equal(act.length, 1, '强度 3 才生效');
  assert.equal(act[0], '喜欢用比喻');
});

test('特质：互斥的会互相削弱，不会同时「话多」又「沉默」', () => {
  const { mp } = load();
  for (let i = 0; i < 3; i++) mp.addTrait('话多');
  assert.ok(mp.activeTraits().includes('话多'));

  mp.addTrait('沉默');
  mp.addTrait('沉默');
  const active = mp.activeTraits();
  assert.ok(!(active.includes('话多') && active.includes('沉默')), '互斥特质不能同时生效');
});

test('特质：isOpposite 认得出对立面', () => {
  const { mp } = load();
  assert.equal(mp.isOpposite('话多', '沉默'), true);
  assert.equal(mp.isOpposite('直接', '委婉'), true);
  assert.equal(mp.isOpposite('话多', '喜欢比喻'), false);
});

/* ---------------- 跟进事项 ---------------- */
test('跟进：没到期不返回，到期才返回，做完就消失', () => {
  const { mp, mem } = load();
  const f = mp.addFollowup('考试', 24);
  assert.ok(f && f.id);
  assert.equal(mp.dueFollowups().length, 0, '刚建的不该到期');

  /* 把到期时间拨到过去 */
  mem._data().followups[0].due = Date.now() - 1000;
  assert.equal(mp.dueFollowups().length, 1);

  mp.finishFollowup(f.id);
  assert.equal(mp.dueFollowups().length, 0, '做完就不该再提醒');
});

/* ---------------- 主动引擎 ---------------- */
test('主动引擎：用户刚说完话时不打扰', () => {
  const { sandbox, pro, mem } = load();
  mem._data().followups = [{ id: 'f1', topic: '考试', due: Date.now() - 1000, done: false }];
  sandbox.XN.state.lastUserAt = Date.now() - 60 * 1000; /* 1 分钟前说过话 */
  assert.equal(pro.check(), null, '刚聊完不该插嘴');
});

test('主动引擎：每日配额用完就不再开口', () => {
  const { sandbox, pro, mem } = load();
  mem._data().followups = [{ id: 'f1', topic: '考试', due: Date.now() - 1000, done: false }];
  sandbox.XN.state.lastUserAt = Date.now() - 60 * 60 * 1000;
  mem._data().proactive = { lastAt: Date.now() - 8 * 3600 * 1000, dayKey: new Date().toISOString().slice(0, 10), count: 3 };
  assert.equal(pro.check(), null, '今天已经主动 3 次了，不该再说了');
});

test('主动引擎：到期跟进会被选中，commit 之后不再重复', () => {
  const { sandbox, pro, mem } = load();
  mem._data().followups = [{ id: 'f1', topic: '考试', due: Date.now() - 1000, done: false }];
  sandbox.XN.state.lastUserAt = Date.now() - 30 * 3600 * 1000;

  const hit = pro.check();
  assert.ok(hit, '应该开口');
  assert.equal(hit.kind, 'followup');
  assert.match(hit.text, /考试/);

  pro.commit(hit);
  assert.equal(pro.check(), null, '刚说完要进入间隔期');
});

test('主动引擎：情绪低落 6–48 小时后回访', () => {
  const { sandbox, pro } = load();
  sandbox.XN.state.lastEmo = { emo: 'sad', intensity: 0.8 };
  sandbox.XN.state.lastUserAt = Date.now() - 20 * 3600 * 1000;
  const hit = pro.check();
  assert.ok(hit, '应当回访');
  assert.equal(hit.kind, 'revisit');
});

/* ---------------- 目标推导 ---------------- */
test('目标推导：负面情绪强 → 只做安慰', () => {
  const { pro } = load();
  const g = pro.deriveGoal({ emo: 'sad', intensity: 0.9 });
  assert.equal(g.mode, 'comfort');
  assert.match(g.why, /好受一点/);
});

test('目标推导：有未兑现承诺 → 主动推进', () => {
  const { pro, mem } = load();
  mem._data().promises = [{ id: 'p1', text: '帮你找资料', kept: false }];
  mem.promises = () => mem._data().promises;
  const g = pro.deriveGoal({ emo: 'neutral', intensity: 0.3 });
  assert.equal(g.mode, 'push');
  assert.match(g.action, /找资料/);
});

test('目标推导：正常状态 → 正常聊', () => {
  const { pro } = load();
  const g = pro.deriveGoal({ emo: 'neutral', intensity: 0.3 });
  assert.equal(g.mode, 'chat');
});

test('goalLine：安慰和推进会给出一句话，正常聊不给', () => {
  const { pro } = load();
  assert.match(pro.goalLine({ mode: 'comfort', why: 'x' }), /只做一件事/);
  assert.match(pro.goalLine({ mode: 'push', action: '做两题', why: 'y' }), /动作/);
  assert.equal(pro.goalLine({ mode: 'chat', why: 'z' }), '');
});

/* ---------------- 接线 ---------------- */
test('新模块都在 index.html 里，且在三处可编辑清单里', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = ['assets/lib/memory-ext.js', 'assets/lib/proactive.js'];
  for (const f of files) {
    assert.ok(html.includes(f), 'index.html 没加载 ' + f);
    for (const list of ['cloudflare/iterate.js', 'tests/iterate.test.mjs', 'server/app.py']) {
      const body = fs.readFileSync(path.join(root, list), 'utf8');
      assert.ok(body.includes(f), list + ' 里缺 ' + f);
    }
  }
});

test('tools 里有 recall_memory，且 IIFE 定义了 root（否则 ReferenceError）', () => {
  const src = fs.readFileSync(path.join(root, 'assets/tools.js'), 'utf8');
  assert.match(src, /name: 'recall_memory'/, '缺 recall_memory 工具');
  assert.match(src, /var root = typeof window/, 'tools.js 的 IIFE 没定义 root，新工具会 ReferenceError');
});
