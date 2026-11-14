/* 工具层回归：地点缺失导致的「多城市混答」、以及工具触发过宽。
 *
 * 背景（用户报的问题）：
 *   1. 问「今天天气怎么样」，回答里把北京、杭州好几个城市的天气混在一起说。
 *      根因：system prompt 说「有定位能力」但其实只给了时间；now 工具也不返回地点；
 *            降级搜索直接用用户原话当关键词，里面没有城市，搜回来一堆城市。
 *   2. 每条消息下面都弹两条一样的提示，看着像「一次发了两个问题」。
 *      根因：一次回答里连续调多个工具，每次 onTool 都弹一条 toast。
 *   3. 发送慢。
 *      根因：needsTools 把「现在」「最新」也算需要实时信息，闲聊也走工具循环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSandbox() {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Intl,
    String,
    Number,
    Object,
    Array,
    RegExp,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['assets/persona.js', 'assets/tools.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

/* ---------- now 工具必须给时区 ---------- */
test('now 工具返回设备时区，并明确「时区≠城市」', async () => {
  const w = loadSandbox();
  const r = await w.XN_TOOLS.run('now', {});
  assert.equal(r.ok, true);
  assert.match(r.text, /设备时区：\S+/, '必须带时区，否则模型不知道用户在哪一片');
  assert.match(r.text, /不等于精确城市/, '必须说清时区不等于城市，否则模型会当事实用');
  assert.match(r.text, /必须让用户说出城市/, '必须要求模型问城市');
});

/* ---------- persona 硬约束 ---------- */
test('人设里要有「不许把多个城市混在一起」的硬约束', () => {
  const w = loadSandbox();
  const prompt = w.XN_PERSONA.build({ query: '今天天气怎么样' });
  assert.match(prompt, /关于地点 · 硬约束/, '缺地点硬约束');
  assert.match(prompt, /问完就停/, '缺「先问城市再停」的指令');
  assert.match(prompt, /绝对不许把多个城市的数据揉成一段说/, '缺禁止多城市混答');
});

/* ---------- 降级路线：没城市就只问城市，不搜索 ---------- */
test('问天气但没说城市 → 不发搜索请求，只让模型问城市', async () => {
  const w = loadSandbox();
  const pushed = [];
  let searched = 0;
  const origRun = w.XN_TOOLS.run;
  const out = await w.XN_TOOLS.loopWithFallback({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    chat: () => {
      throw new Error('服务商不支持 tools');
    },
    textChat: (msgs) => {
      pushed.push(...msgs);
      return '你在哪个城市呀';
    },
    onTool: () => {
      searched++;
    }
  });
  assert.equal(searched, 0, '没城市时不该调 web_search（会搜回多城市结果）');
  const asked = pushed.filter((m) => m.role === 'system' && /城市/.test(m.content));
  assert.ok(asked.length > 0, '应当注入「先问城市」的指令');
  assert.match(asked[0].content, /绝对不要猜城市/);
  assert.equal(out.content, '你在哪个城市呀');
});

/* ---------- 说了城市就正常搜 ---------- */
test('说了城市 → 正常联网检索', async () => {
  const w = loadSandbox();
  let searched = 0;
  await w.XN_TOOLS.loopWithFallback({
    messages: [{ role: 'user', content: '杭州今天天气怎么样' }],
    chat: () => {
      throw new Error('no tools');
    },
    textChat: () => '杭州多云',
    onTool: (name) => {
      if (name === 'web_search') searched++;
    }
  });
  assert.equal(searched, 1, '用户给了城市就该真的去搜');
});

/* ---------- needsTools 不能把闲聊拖进工具循环 ---------- */
test('闲聊不触发工具循环，真需要实时信息才触发', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.core.js'), 'utf8');
  /* 直接读函数体做静态断言：它依赖 state/web，不便在 vm 里单测 */
  const m = src.match(/function needsTools\(text\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, '找不到 needsTools');
  const body = m[1];
  assert.ok(!/今天\|现在\|几点\|几号/.test(body), '旧的宽词表（含「现在」）应该已经被收窄');
  assert.match(body, /几点了\|几点\|现在时间/, '要保留真正的时间问句');
  assert.match(body, /天气\|气温/, '天气要触发');
  assert.match(body, /新闻\|热搜/, '新闻要触发');
});

/* ---------- 工具提示不能叠两条 ---------- */
test('一次回答里多个工具只提示一次', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.core.js'), 'utf8');
  const m = src.match(/onTool: function \(name, args, result\)\s*\{([\s\S]*?)\n          \}/);
  assert.ok(m, '找不到 onTool');
  const body = m[1];
  assert.match(body, /bot\.toolsToasted/, '应当用一次性标记去重');
  assert.match(body, /if \(!bot\.toolsToasted\)/, '第二次起不再弹提示');
});
