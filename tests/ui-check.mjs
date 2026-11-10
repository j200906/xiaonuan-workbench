/* 端到端 UI 检查：自动起后端 + 假模型 + 无头 Edge/Chrome，点完五个视图并发一条消息。
 * 用法：node tests/ui-check.mjs
 * 依赖：本机有 Edge 或 Chrome；Node 20+（内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ui-admin';
const PKG = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function exists(p) {
  try { await access(p); return true; } catch (e) { return false; }
}

async function waitHttp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function findBrowser() {
  for (const p of BROWSERS) if (await exists(p)) return p;
  throw new Error('找不到 Edge/Chrome，装一个再跑 UI 检查');
}

const dataDir = await mkdtemp(join(tmpdir(), 'xn-ui-'));
const profile = await mkdtemp(join(tmpdir(), 'xn-edge-'));
const appPort = await freePort();
const mockPort = await freePort();
const cdpPort = await freePort();

const mock = spawn('python', ['tests/mock_llm.py'], {
  cwd: root, stdio: 'ignore', windowsHide: true,
  env: Object.assign({}, process.env, { MOCK_PORT: String(mockPort), MOCK_KEY: 'ui-key' })
});

let appLog = '';
const app = spawn('python', ['server/app.py', '--port', String(appPort)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: Object.assign({}, process.env, {
    XN_BASE: `http://127.0.0.1:${mockPort}/v1`,
    XN_API_KEY: 'ui-key',
    XN_ADMIN_PASSWORD: PASSWORD,
    XN_ADMIN_SECRET: 'ui-secret',
    XN_DATA_DIR: dataDir
  })
});

app.stdout.on('data', (d) => { appLog += String(d); });
app.stderr.on('data', (d) => { appLog += String(d); });

const browser = spawn(await findBrowser(), [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

let ws;
let msgId = 0;
const pending = new Map();
const events = [];
const results = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); }
    }, 20000);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const appReady = await waitHttp(`http://127.0.0.1:${appPort}/api/health`);
  if (!appReady) throw new Error('后端没起来\n' + appLog.slice(-1200));

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* retry */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('浏览器 CDP 没起来');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];localStorage.clear();sessionStorage.clear();
      addEventListener('error',e=>__errs.push(String(e.message||e)));
      addEventListener('unhandledrejection',e=>__errs.push('reject:'+String(e.reason)));`
  });

  const base = `http://127.0.0.1:${appPort}/index.html`;
  await send('Page.navigate', { url: base });
  await sleep(2200);

  const boot = await evaluate(`({
    ready: !!window.XN.ready,
    version: window.XN_VERSION,
    proxy: window.XN.api.isProxy(),
    views: Object.keys(window.XN.views || {}).length,
    side: document.querySelectorAll('.side-link').length,
    chat: !document.querySelector('#view-chat').hidden
  })`);
  check('页面启动', boot.ready && boot.version === PKG.version, 'version=' + boot.version);
  check('代理模式自动识别', boot.proxy === true);
  check('五个视图注册 + 侧栏 6 个入口', boot.views === 5 && boot.side === 6, `${boot.views}/${boot.side}`);
  check('对话页默认可见', boot.chat);
  check('迭代入口不需要解锁', await evaluate(`(() => { const b = document.querySelector('#navIterate'); return !!b && !b.hidden; })()`));
  const views = {};
  for (const v of ['study', 'feedback', 'changelog', 'settings', 'chat']) {
    await evaluate(`window.XN.switchView(${JSON.stringify(v)})`);
    await sleep(160);
    views[v] = await evaluate(`!document.querySelector('#view-${v}').hidden`);
  }
  check('五个视图都能进入', Object.values(views).every(Boolean), JSON.stringify(views));

  await evaluate(`window.XN.switchView('settings')`);
  await sleep(150);
  const settings = await evaluate(`({
    rows: document.querySelectorAll('#navEditor .nav-row').length,
    providers: document.querySelectorAll('#setProvider option').length,
    locales: document.querySelectorAll('#setLocale option').length,
    admin: document.querySelector('#adminState').textContent
  })`);
  check('设置页控件齐全', settings.rows === 4 && settings.providers >= 7 && settings.locales === 2,
    JSON.stringify(settings));
  const persona = await evaluate(`({ len: document.querySelector('#ctlPrompt').value.length, has: document.querySelector('#ctlPrompt').value.includes('小暖'), meta: document.querySelector('#promptMeta').textContent })`);
  check('人格可见', persona.len > 500 && persona.has && persona.meta.includes('动态'),
    JSON.stringify(persona));

  await evaluate(`window.XN.switchView('chat')`);
  await evaluate(`document.querySelector('#modelPickTrigger').click()`);
  await sleep(120);
  const menu = await evaluate(`({ open: document.querySelector('#modelPickWrap').classList.contains('is-open'), opts: document.querySelectorAll('.mp-opt').length })`);
  check('模型菜单可打开且有条目', menu.open && menu.opts >= 1, JSON.stringify(menu));
  await evaluate(`document.querySelector('#modelPickTrigger').click()`);

  await evaluate(`document.querySelector('#input').value='你好，UI 测试'; document.querySelector('#composerForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    if (await evaluate(`!document.querySelector('#btnSend').disabled && document.querySelectorAll('.msg.bot').length > 0`)) break;
  }
  const chat = await evaluate(`({
    user: document.querySelectorAll('.msg.user').length,
    text: (document.querySelector('.msg.bot .content')||{}).textContent || '',
    table: !!document.querySelector('.msg.bot .content table'),
    err: (document.querySelector('.msg.bot .err')||{}).textContent || ''
  })`);
  check('消息能发出去并收到回复', chat.user === 1 && chat.text.includes('假上游'), JSON.stringify(chat).slice(0, 160));
  check('Markdown 表格渲染', chat.table === true);
  check('对话无错误标记', !chat.err, chat.err);

  const unlock = await evaluate(`window.XN.unlockAdmin(${JSON.stringify(PASSWORD)})`);
  await sleep(200);
  check('管理密码换令牌', unlock.ok === true && (await evaluate('!!window.XN.adminToken()')));
  check('迭代入口解锁后仍可见', await evaluate(`!document.querySelector('#navIterate').hidden`));

  await evaluate(`window.XN.switchView('feedback')`);
  await sleep(150);
  await evaluate(`document.querySelector('#fbBody').value='UI 测试反馈'; document.querySelector('#fbForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
  await sleep(300);
  const fb1 = await evaluate(`({ count: document.querySelectorAll('#fbList .fb-item').length, text: document.querySelector('#fbList').textContent })`);
  check('反馈能提交', fb1.count >= 1 && fb1.text.includes('UI 测试反馈'), JSON.stringify(fb1).slice(0, 120));

  await evaluate(`fetch('api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'其他',body:'云端独有反馈',contact:''})})`);
  await sleep(250);
  await evaluate(`document.querySelector('#fbPull').click()`);
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (await evaluate(`document.querySelectorAll('#fbList .fb-item.cloud').length > 0`)) break;
  }
  const fb2 = await evaluate(`({ cloud: document.querySelectorAll('#fbList .fb-item.cloud').length, total: document.querySelectorAll('#fbList .fb-item').length, text: document.querySelector('#fbList').textContent })`);
  check('能从云端拉回反馈且本地那条不重复', fb2.cloud >= 1 && fb2.total === fb2.cloud + 1, JSON.stringify(fb2).slice(0, 160));

  await evaluate(`window.XN.switchView('chat')`);
  await evaluate(`document.querySelector('#btnNew').click()`);
  await sleep(150);
  const fresh = await evaluate(`({ empty: !!document.querySelector('#chatEmpty'), sessions: window.XN.state.sessions.length })`);
  check('新对话按钮有反应', fresh.empty && fresh.sessions >= 2, JSON.stringify(fresh));

  const pageErrors = await evaluate('window.__errs || []');
  const consoleErrors = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value || a.description || '').join(' '));
  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);

  check('页面无 JS 异常', pageErrors.length === 0 && exceptions.length === 0,
    [...pageErrors, ...exceptions].slice(0, 2).join(' | '));
  check('控制台无 error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  if (results.some((r) => !r.ok)) process.exitCode = 1;
  else console.log('\n全部 UI 检查通过');
} finally {
  try { ws && ws.close(); } catch (e) {}
  app.kill();
  mock.kill();
  browser.kill();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
