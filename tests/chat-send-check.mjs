/* 浏览器里验聊天发送链路：闲聊不该走工具、问天气没说城市不该搜、提示不叠 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const ROOT = process.argv[2];
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const httpPort = await freePort();
const cdpPort = await freePort();
const srv = spawn('python', ['-m', 'http.server', String(httpPort), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
await new Promise((r) => setTimeout(r, 1200));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${process.env.TEMP}\\edge-chatcheck`, `http://127.0.0.1:${httpPort}/index.html`], { stdio: 'ignore', windowsHide: true });

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('CDP 没起来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return 'EXC:' + String(r.exceptionDetails.exception?.description || '').slice(0, 200);
  return r && r.result ? r.result.value : undefined;
};
await send('Runtime.enable');

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 400));
  if ((await ev('typeof (window.XN && XN.sendMessage)')) === 'function') break;
}

/* 注入可观测的假 LLM，统计调用次数与工具使用 */
await ev(`
  window.__calls = { chat: 0, tool: 0, lastMsgs: null };
  var realLLM = XN.api;
  window.__fakeLLM = function () {
    return {
      chatRaw: function (m, o) {
        window.__calls.chat++;
        window.__calls.lastMsgs = m;
        var sys = (m[0] && m[0].content) || '';
        // 有「先问城市」指令就照做；否则给个通用回答
        if (/只回一句|问清「你在哪个城市」/.test(sys) || /你在哪个城市/.test(sys)) {
          return Promise.resolve({ content: '你在哪个城市呀', reasoning: '', toolCalls: null });
        }
        return Promise.resolve({ content: '嗯嗯，我在听', reasoning: '', toolCalls: null });
      },
      streamChat: function (m, o) {
        window.__calls.chat++;
        return Promise.resolve({ text: '嗯嗯，我在听', aborted: false });
      },
      chatText: function () { window.__calls.chat++; return Promise.resolve('neutral'); },
      isProxy: function () { return true; },
      fitMessages: function (x) { return x; }
    };
  };
`);

/* 用假 LLM 覆盖：直接改 XN.api 上被调用的方法 */
const patchOk = await ev(`
  (function(){
    var fake = window.__fakeLLM();
    ['chatRaw','streamChat','chatText','fitMessages','isProxy'].forEach(function(k){
      if (window.XN.api[k]) { window.__orig = window.__orig || {}; window.__orig[k] = window.XN.api[k]; window.XN.api[k] = fake[k]; }
    });
    return typeof window.XN.api.chatRaw;
  })()
`);

async function probe(text) {
  await ev(`window.__calls = { chat: 0, tool: 0, lastMsgs: null };`);
  await ev(`XN.sendMessage(${JSON.stringify(text)})`);
  await new Promise((r) => setTimeout(r, 2500));
  return {
    text,
    chatCalls: await ev('window.__calls.chat'),
    toolNodes: await ev(`document.querySelectorAll('.msg-tools').length`),
    toastCount: await ev(`document.querySelectorAll('.toast.show, .toast-item.show').length`),
    lastReply: await ev(`(function(){var ns=document.querySelectorAll('#messages .msg.bot .content'); return ns.length? ns[ns.length-1].innerText.slice(0,40) : ''})()`)
  };
}

const out = {};
out.补丁生效 = patchOk;
out.闲聊 = await probe('我今天有点累');
out.天气无城市 = await probe('今天天气怎么样');
out.天气有城市 = await probe('杭州今天天气怎么样');

console.log(JSON.stringify(out, null, 2));
ws.close(); edge.kill(); srv.kill();
