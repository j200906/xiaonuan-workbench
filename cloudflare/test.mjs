/* 用假的 ASSETS 和本机假上游，验证 worker 的三条路由 */
import worker from './worker.js';

const env = {
  XN_API_KEY: 'test-key',
  XN_BASE: 'http://127.0.0.1:8098/v1',
  XN_MODEL: 'deepseek-chat',
  ASSETS: {
    fetch: async (req) => new Response('<html>INDEX</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let r = await worker.fetch(new Request('https://x/api/health'), env);
let j = await r.json();
check('健康检查', j.ok === true && j.hasKey === true, JSON.stringify(j));

r = await worker.fetch(new Request('https://x/api/config'), env);
j = await r.json();
check('配置接口报告可用代理', j.proxy === true, JSON.stringify(j));

r = await worker.fetch(new Request('https://x/', {}), env);
const html = await r.text();
check('静态资源走 ASSETS', html.includes('INDEX'), html.slice(0, 20));

r = await worker.fetch(new Request('https://x/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: false })
}), env);
const chat = await r.json();
check('非流式代理', r.status === 200 && !!chat.choices, 'status=' + r.status);

r = await worker.fetch(new Request('https://x/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '流式' }], stream: true })
}), env);
const sse = await r.text();
check('流式代理', r.headers.get('content-type').includes('event-stream') && sse.includes('data:'), sse.slice(0, 40).replace(/\n/g, ' '));

r = await worker.fetch(new Request('https://x/api/chat', { method: 'POST', body: '{}' }), env);
check('缺 messages 被挡', r.status === 400);

r = await worker.fetch(new Request('https://x/api/feedback', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: '想法', body: '测试' })
}), env);
j = await r.json();
check('反馈接口', j.ok === true, JSON.stringify(j));

const offEnv = { ...env, XN_API_KEY: '' };
r = await worker.fetch(new Request('https://x/api/config'), offEnv);
j = await r.json();
check('没 Key 时不谎报代理', j.proxy === false);

const failed = results.filter(x => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
