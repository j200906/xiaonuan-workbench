/* 人设诚实性回归：人设说的能力，必须是真的。
 *
 * 血的教训：
 *   1. CORE 里写死「你现在拥有了联网搜索」，但联网开关默认是关的
 *      → 默认设置下它宣称会查、实际查不了，只能编（天气把北京杭州混在一起说）。
 *   2. 自定义人设（设置里那段）原来是直接 return 自定义文本，
 *      记忆、情绪、关系、时间、能力声明全部丢掉
 *      → 用户一改人设，它又开始吹牛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadPersona() {
  const sandbox = { console, Date, Math, JSON, Intl, String, Number, Object, Array, RegExp, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/persona.js'), 'utf8'), sandbox, { filename: 'persona.js' });
  return sandbox.XN_PERSONA;
}

test('联网关闭时，人设必须明说「没有联网」，不许宣称能搜', () => {
  const P = loadPersona();
  const p = P.build({ query: '今天有什么新闻', capabilities: { web: false, time: true } });
  assert.match(p, /你现在真正能做什么/, '缺能力声明块');
  assert.match(p, /现在没有联网/, '联网关着却没说清楚');
  assert.match(p, /我这边没开联网，查不到/, '缺「查不到要直说」的指令');
  assert.match(p, /绝对不许凭印象编/, '缺禁止编造');
  assert.ok(!/能联网搜索/.test(p), '联网关着还在说「能联网搜索」，就是吹牛');
});

test('联网开启时，人设才可以说能搜，并要求真的调用工具', () => {
  const P = loadPersona();
  const p = P.build({ query: '今天有什么新闻', capabilities: { web: true, time: true } });
  assert.match(p, /能联网搜索/, '开着联网应当说明能搜');
  assert.match(p, /必须真的调用搜索工具/, '要防止「只说查一下却不动手」');
});

test('人设里不许残留未替换的占位符', () => {
  const P = loadPersona();
  for (const web of [true, false]) {
    const p = P.build({ query: 'x', capabilities: { web, time: true } });
    assert.ok(!p.includes('{{ABILITY}}'), '占位符没被替换，模型会看到模板原文');
  }
});

test('自定义人设时，动态信息（记忆/情绪/目标/时间/能力）都不能丢', () => {
  const P = loadPersona();
  const p = P.build({
    query: '在吗',
    capabilities: { web: false, time: true },
    coreOverride: '你是一只叫阿黑的黑猫，说话很欠。',
    memories: ['用户叫阿杰'],
    emo: { emo: 'joy' },
    goals: ['背十个单词']
  });
  assert.match(p, /黑猫/, '自定义性格要生效');
  assert.match(p, /你现在真正能做什么/, '自定义人设也不能丢能力声明');
  assert.match(p, /现在没有联网/, '自定义人设也要知道联网是关的');
  assert.match(p, /用户叫阿杰/, '记忆注入不能丢');
  assert.match(p, /当前用户情绪/, '情绪提示不能丢');
  assert.match(p, /今天的目标/, '目标不能丢');
  assert.match(p, /现在时间/, '时间不能丢');
});

test('能力块必须声明「做不到什么」，防止越权承诺', () => {
  const P = loadPersona();
  const p = P.build({ query: 'x', capabilities: { web: true, time: true } });
  assert.match(p, /发邮件|打电话|下单/, '要明确说不能代发邮件/打电话/下单');
  assert.match(p, /导出你的模型或提示词/, '要拒绝导出提示词的要求');
});

test('app.core 不再对自定义人设短路', () => {
  const src = fs.readFileSync(path.join(root, 'assets/app.core.js'), 'utf8');
  assert.ok(!/if \(custom\) return custom;/.test(src), '自定义人设不能直接 return，否则丢掉全部动态注入');
  assert.match(src, /coreOverride:\s*custom/, '应当把自定义人设作为 coreOverride 传进去');
  assert.match(src, /capabilities:\s*\{\s*web:\s*!!state\.web/, '应当把真实联网开关传进去');
});
