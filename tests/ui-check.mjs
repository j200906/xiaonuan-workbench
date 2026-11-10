/* 端到端 UI 检查：自动起后端 + 假模型 + 无头 Chromium，点完五个视图并发一条消息。
 *
 * 用法（本地）：
 *   node tests/ui-check.mjs                  # 自动找本机 Edge/Chrome，跑完整检查
 *   node tests/ui-check.mjs --dry            # 不起浏览器：真后端 + 页面资源/HTTP 检查
 *   node tests/ui-check.mjs --dry --static   # 连 python 都不用：node 内置静态服务器 + 资源检查
 *   node tests/ui-check.mjs --browser=...    # 指定浏览器可执行文件
 *   node tests/ui-check.mjs --shot-dir=...   # 失败截图/日志目录
 *
 * CI 入口是 tests/ui-ci.mjs：同一套检查，浏览器路径从环境变量 / Playwright 缓存里解析。
 * 环境变量：XN_CHROME / CHROME_PATH / CHROME_BIN 指定浏览器；XN_SHOT_DIR 失败截图目录。
 *
 * 依赖：本机有 Chromium 内核浏览器（Edge/Chrome/Chromium）；Node 22+（内置全局 WebSocket）。
 * 不 import playwright 之类的包，浏览器用 CDP（DevTools 协议）直连。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, access, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'ui-admin';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 本机常见安装位置。Linux 上 runner/发行版路径都列上，CI 里找不到再看 XN_CHROME。 */
const LOCAL_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

async function exists(p) {
  try { await access(p); return true; } catch (e) { return false; }
}

async function waitHttp(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (e) { /* 还没起来，继续等 */ }
    await sleep(120);
  }
  return false;
}

function pythonBin() {
  if (process.env.XN_PYTHON) return process.env.XN_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/* 兜底候选：Playwright 下载缓存 → 系统常见路径。
 * Playwright 的 chromium 由 CI 用 `npx playwright install chromium` 装，不进 package.json；
 * 这里只按目录名找，不 import playwright 包。 */
async function browserCandidates() {
  const list = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const key = String(p);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(key);
  };

  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : null
  ];
  const perBuild = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
    ['chrome-mac', join('Chromium.app', 'Contents', 'MacOS', 'Chromium')],
    ['chrome-win', 'chrome.exe'],
    ['chrome-win64', 'chrome.exe']
  ];
  for (const dir of cacheRoots) {
    if (!dir) continue;
    let names = [];
    try { names = await readdir(dir); } catch (e) { continue; }
    for (const name of names) {
      if (!/^chromium-\d+$/.test(name)) continue;
      for (const parts of perBuild) add(join(dir, name, ...parts));
    }
  }

  for (const p of LOCAL_BROWSERS) add(p);
  return list;
}

/* 解析顺序：显式 --browser / XN_CHROME 等（给了就必须存在，免得 CI 配错路径被静默兜底）
 * → Playwright 下载缓存 → 系统常见路径。 */
export async function resolveBrowser(explicit) {
  const required = [explicit, process.env.XN_CHROME, process.env.CHROME_PATH, process.env.CHROME_BIN]
    .filter((p) => p && String(p).trim());
  for (const p of required) {
    if (await exists(p)) return p;
  }
  if (required.length) {
    throw new Error('指定的浏览器不存在：\n  ' + required.join('\n  ') +
      '\n（去掉 --browser / XN_CHROME 让脚本自动找，或检查这个路径）');
  }
  const candidates = await browserCandidates();
  for (const p of candidates) {
    if (await exists(p)) return p;
  }
  throw new Error('找不到可用的 Chromium 内核浏览器。候选路径：\n  ' + candidates.join('\n  '));
}

/* 极简 CDP 客户端：只用到 Runtime/Page/Log/Emulation，够 UI 检查用。 */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
    this.ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    };
    return this;
  }

  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, timeoutMs);
    });
  }

  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async waitFor(expr, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await this.evaluate(expr)) return true;
      } catch (e) { /* 页面还没加载完 */ }
      await sleep(120);
    }
    return false;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async close() {
    try { await this.send('Browser.close', {}, 3000); } catch (e) { /* 已退出 */ }
    try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* --dry --static 用：不依赖 python，只用 node 内置 http 把仓库当静态站发出来。
 * 只放行 index.html 和 assets/，和真后端的静态服务范围保持一致。 */
async function startStaticServer() {
  const port = await freePort();
  const server = createHttpServer(async (req, res) => {
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(body));
    };
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (e) { return sendJson(400, { ok: false }); }
    if (rel === '/') rel = '/index.html';
    if (!(rel === '/index.html' || rel.startsWith('/assets/'))) return sendJson(404, { ok: false, error: '没有这个文件' });

    const target = resolve(root, rel.slice(1));
    if (target !== resolve(root, 'index.html') && !target.startsWith(resolve(root, 'assets') + sep)) {
      return sendJson(403, { ok: false, error: '越界' });
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    } catch (e) {
      sendJson(404, { ok: false, error: '没有这个文件' });
    }
  });
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', res);
  });
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

async function startBrowser(browserPath, cdpPort, profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ];
  /* CI 容器里以 root 跑必须关沙箱；GitHub 的 ubuntu runner 不是 root，正常带沙箱。
   * 本地/特殊镜像可以 XN_NO_SANDBOX=1 强制关掉。 */
  if (process.env.XN_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    args.unshift('--no-sandbox');
  }
  return spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
}

/* ---------------- 检查项 ---------------- */

/* 无浏览器也能证明的东西：服务器起来了、页面和它引用的资源都能取到、版本没漂。
 * 这是 --dry 的全部内容，也是 CI 里失败时最好定位的一段。 */
async function runHttpChecks(check, baseUrl, opts) {
  if (!opts.staticOnly) {
    let health = null;
    try { health = await (await fetch(`${baseUrl}/api/health`)).json(); } catch (e) { /* 下面统一报 */ }
    check('后端健康检查 /api/health', !!health && health.ok === true,
      health ? `model=${health.model} hasKey=${health.hasKey}` : '请求失败');
  }

  const pageRes = await fetch(`${baseUrl}/index.html`);
  const html = await pageRes.text();
  const ctype = pageRes.headers.get('content-type') || '';
  check('index.html 能取到（text/html）',
    pageRes.ok && /text\/html/.test(ctype) && html.length > 5000,
    `status=${pageRes.status} type=${ctype} ${html.length} 字节`);

  const refs = [...new Set([...html.matchAll(/(?:src|href)="(assets\/[^"?]+\.(?:js|css))"/g)].map((m) => m[1]))];
  const broken = [];
  for (const ref of refs) {
    try {
      const r = await fetch(`${baseUrl}/${ref}`);
      const body = await r.text();
      if (!r.ok || body.length === 0) broken.push(`${ref}=${r.status}/${body.length}B`);
    } catch (e) {
      broken.push(`${ref}=ERR`);
    }
  }
  check(`页面引用的 ${refs.length} 个 assets 都能取到`, refs.length > 0 && broken.length === 0,
    broken.slice(0, 6).join(', '));

  const viewIds = [...new Set([...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]))];
  const expectedViews = ['chat', 'study', 'feedback', 'settings', 'changelog'];
  const missingViews = expectedViews.filter((v) => !viewIds.includes(v));
  check('页面含五个视图容器', missingViews.length === 0, missingViews.length ? '缺 ' + missingViews.join(',') : viewIds.join(','));

  const sideLinks = (html.match(/class="side-link"/g) || []).length;
  check('侧栏 6 个入口', sideLinks === 6, String(sideLinks));

  const versionJs = await (await fetch(`${baseUrl}/assets/version.js`)).text();
  const version = (versionJs.match(/\|\|\s*"([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];
  check('版本号与 package.json 一致', version === opts.version, `version.js=${version} package.json=${opts.version}`);
}

/* 完整浏览器检查：和改造前 tests/ui-check.mjs 的 18 项一一对应，只是启动等待改成轮询。
 * 主页改造后又补了 5 条：空态无问候标题 / 空态无建议条 / 无免责声明 /
 * 模型条在输入框底栏 / 模型条显示当前模型名。
 * 第二件（友好名 + 背景水印）又补了 5 条：模型条不显示原始 @cf/ id /
 * 云端原始 id 渲染成友好名 / 模型下拉显示友好名 /
 * 背景水印存在且 pointer-events:none / 水印不与输入框矩形相交。 */
async function runBrowserChecks(check, cdp, baseUrl, packageVersion) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];localStorage.clear();sessionStorage.clear();
      addEventListener('error',e=>__errs.push(String(e.message||e)));
      addEventListener('unhandledrejection',e=>__errs.push('reject:'+String(e.reason)));`
  });

  const base = `${baseUrl}/index.html`;
  await cdp.send('Page.navigate', { url: base });
  /* 慢机器/冷启动下 2.2s 可能不够，等 XN.ready 出现再往下走。 */
  await cdp.waitFor('!!(window.XN && window.XN.ready)', 20000);
  await sleep(300);

  const boot = await cdp.evaluate(`({
    ready: !!window.XN.ready,
    version: window.XN_VERSION,
    proxy: window.XN.api.isProxy(),
    views: Object.keys(window.XN.views || {}).length,
    side: document.querySelectorAll('.side-link').length,
    chat: !document.querySelector('#view-chat').hidden
  })`);
  check('页面启动', boot.ready && boot.version === packageVersion, 'version=' + boot.version);
  check('代理模式自动识别', boot.proxy === true);
  check('五个视图注册 + 侧栏 6 个入口', boot.views === 5 && boot.side === 6, `${boot.views}/${boot.side}`);
  check('对话页默认可见', boot.chat);
  check('迭代入口不需要解锁', await cdp.evaluate(`(() => { const b = document.querySelector('#navIterate'); return !!b && !b.hidden; })()`));

  /* 主页改造：那条「小暖会犯错」的免责声明已经删了，DOM 里不该再有 .disclaimer，
     也不该有任何地方把那句话渲染出来（i18n 字典里留不留键不管，只看真实页面）。 */
  const disclaimer = await cdp.evaluate(`(() => {
    const els = document.querySelectorAll('.disclaimer');
    const body = document.body.textContent || '';
    return {
      count: els.length,
      text: els.length ? els[0].textContent.trim() : '',
      sentence: body.includes('自己再核一遍'),
      phrase: body.includes('小暖会犯错')
    };
  })()`);
  check('免责声明已删除', disclaimer.count === 0 && disclaimer.sentence === false && disclaimer.phrase === false,
    JSON.stringify(disclaimer).slice(0, 160));

  const views = {};
  for (const v of ['study', 'feedback', 'changelog', 'settings', 'chat']) {
    await cdp.evaluate(`window.XN.switchView(${JSON.stringify(v)})`);
    await sleep(160);
    views[v] = await cdp.evaluate(`!document.querySelector('#view-${v}').hidden`);
  }
  check('五个视图都能进入', Object.values(views).every(Boolean), JSON.stringify(views));

  await cdp.evaluate(`window.XN.switchView('settings')`);
  await sleep(150);
  const settings = await cdp.evaluate(`({
    rows: document.querySelectorAll('#navEditor .nav-row').length,
    providers: document.querySelectorAll('#setProvider option').length,
    locales: document.querySelectorAll('#setLocale option').length,
    passwordCard: !!document.querySelector('#adminForm')
  })`);
  check('设置页控件齐全 + 密码栏已移除', settings.rows === 4 && settings.providers >= 7 && settings.locales === 2 && settings.passwordCard === false,
    JSON.stringify(settings));
  const persona = await cdp.evaluate(`({ len: document.querySelector('#ctlPrompt').value.length, has: document.querySelector('#ctlPrompt').value.includes('小暖'), meta: document.querySelector('#promptMeta').textContent })`);
  check('人格可见', persona.len > 500 && persona.has && persona.meta.includes('动态'),
    JSON.stringify(persona));

  await cdp.evaluate(`window.XN.switchView('chat')`);

  /* 主页改造：模型条从页头挪进了输入框底栏（.composer-foot），文案要跟着当前模型走。 */
  const pill = await cdp.evaluate(`(() => {
    const el = document.querySelector('#modelPill');
    if (!el) return { exists: false };
    const parent = el.parentElement;
    const cfg = (window.XN.state && window.XN.state.cfg) || {};
    const trigger = document.querySelector('#modelPickText');
    return {
      exists: true,
      parent: parent ? String(parent.className || parent.tagName) : '',
      inFoot: !!el.closest('.composer-foot'),
      text: (el.textContent || '').trim(),
      model: String((cfg.tutor && cfg.tutor.model) || '').trim(),
      trigger: trigger ? (trigger.textContent || '').trim() : ''
    };
  })()`);
  check('模型条在输入框底栏', pill.exists === true && pill.inFoot === true && /(^|\s)composer-foot(\s|$)/.test(pill.parent),
    JSON.stringify(pill).slice(0, 160));
  check('模型条显示当前模型名',
    pill.exists === true && pill.text.length > 0 && (pill.text === pill.model || (!!pill.trigger && pill.text === pill.trigger)),
    JSON.stringify(pill).slice(0, 160));
  /* 云端模型的原始 id 长成 @cf/zai-org/glm-4.7-flash 这样，界面上要给友好名。 */
  check('模型条不显示原始云端 id',
    pill.exists === true && pill.text.length > 0 && !pill.text.includes('@cf/'),
    JSON.stringify(pill).slice(0, 160));

  /* 本地假上游不是云端模式，模型条一直是 deepseek-chat，光看它测不出「云端 id 泄漏」。
     这里临时把当前模型改成云端原始 id 逼一次真实渲染，断言完立刻还原，不改任何配置。 */
  const cloudPill = await cdp.evaluate(`(() => {
    const raw = '@cf/zai-org/glm-4.7-flash';
    const prev = window.XN.state.cfg.tutor.model;
    let text = '';
    let threw = '';
    try {
      window.XN.state.cfg.tutor.model = raw;
      if (typeof window.XN.refreshModelPill === 'function') window.XN.refreshModelPill();
      else window.XN.switchView('chat');
      const el = document.querySelector('#modelPill');
      text = el ? (el.textContent || '').trim() : '';
    } catch (e) {
      threw = String((e && e.message) || e);
    } finally {
      window.XN.state.cfg.tutor.model = prev;
      try { if (typeof window.XN.refreshModelPill === 'function') window.XN.refreshModelPill(); } catch (e) {}
    }
    return { raw, text, threw, restored: window.XN.state.cfg.tutor.model === prev };
  })()`);
  check('云端原始 id 渲染成友好名',
    cloudPill.threw === '' && cloudPill.restored === true &&
    cloudPill.text.length > 0 && !cloudPill.text.includes('@cf/'),
    JSON.stringify(cloudPill).slice(0, 180));

  /* 模型下拉：原生 select 的显示文本、自定义菜单的项名都要是友好名；value/data-id 保留原始 id 没关系。 */
  const modelOptions = await cdp.evaluate(`(() => {
    const native = [...document.querySelectorAll('#modelPick option')].map((o) => ({ value: o.value, text: (o.textContent || '').trim() }));
    const menu = [...document.querySelectorAll('#modelMenu .mp-opt')].map((o) => ({
      value: o.dataset.id || '',
      text: ((o.querySelector('.mp-name') || o).textContent || '').trim()
    }));
    const all = native.concat(menu);
    return {
      native: native.length,
      menu: menu.length,
      bad: all.filter((o) => o.text.includes('@cf/')),
      empty: all.filter((o) => !o.text).length,
      sample: native.slice(0, 3)
    };
  })()`);
  check('模型下拉显示友好名（不出现原始 @cf/ id）',
    modelOptions.native >= 1 && modelOptions.menu >= 1 && modelOptions.bad.length === 0,
    JSON.stringify(modelOptions).slice(0, 220));

  /* 背景水印：只许有一个，且必须 pointer-events:none，不能把输入框的点击吃掉。 */
  const watermark = await cdp.evaluate(`(() => {
    const els = document.querySelectorAll('.xn-watermark');
    const el = els[0];
    const composer = document.querySelector('.composer');
    if (!el) return { count: els.length, exists: false };
    const cs = getComputedStyle(el);
    const wr = el.getBoundingClientRect();
    const cr = composer ? composer.getBoundingClientRect() : null;
    const box = (r) => r ? { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) } : null;
    const overlap = !!(wr.width && wr.height && cr && cr.width && cr.height &&
      !(wr.right <= cr.left || wr.left >= cr.right || wr.bottom <= cr.top || wr.top >= cr.bottom));
    return {
      count: els.length,
      exists: true,
      pointerEvents: cs.pointerEvents,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      rect: box(wr),
      composerRect: box(cr),
      overlap
    };
  })()`);
  check('背景水印存在且不吃鼠标',
    watermark.count === 1 && watermark.exists === true && watermark.pointerEvents === 'none',
    JSON.stringify(watermark).slice(0, 200));
  check('水印不与输入框矩形相交',
    watermark.exists === true && watermark.overlap === false,
    JSON.stringify(watermark).slice(0, 200));

  await cdp.evaluate(`document.querySelector('#modelPickTrigger').click()`);
  await sleep(120);
  const menu = await cdp.evaluate(`({ open: document.querySelector('#modelPickWrap').classList.contains('is-open'), opts: document.querySelectorAll('.mp-opt').length })`);
  check('模型菜单可打开且有条目', menu.open && menu.opts >= 1, JSON.stringify(menu));
  await cdp.evaluate(`document.querySelector('#modelPickTrigger').click()`);

  await cdp.evaluate(`document.querySelector('#input').value='你好，UI 测试'; document.querySelector('#composerForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    if (await cdp.evaluate(`!document.querySelector('#btnSend').disabled && document.querySelectorAll('.msg.bot').length > 0`)) break;
  }
  const chat = await cdp.evaluate(`({
    user: document.querySelectorAll('.msg.user').length,
    text: (document.querySelector('.msg.bot .content')||{}).textContent || '',
    table: !!document.querySelector('.msg.bot .content table'),
    err: (document.querySelector('.msg.bot .err')||{}).textContent || ''
  })`);
  check('消息能发出去并收到回复', chat.user === 1 && chat.text.includes('假上游'), JSON.stringify(chat).slice(0, 160));
  check('Markdown 表格渲染', chat.table === true);
  check('对话无错误标记', !chat.err, chat.err);

  const unlock = await cdp.evaluate(`window.XN.unlockAdmin(${JSON.stringify(PASSWORD)})`);
  await sleep(200);
  check('管理密码换令牌', unlock.ok === true && (await cdp.evaluate('!!window.XN.adminToken()')));
  check('迭代入口解锁后仍可见', await cdp.evaluate(`!document.querySelector('#navIterate').hidden`));

  await cdp.evaluate(`window.XN.switchView('feedback')`);
  await sleep(150);
  await cdp.evaluate(`document.querySelector('#fbBody').value='UI 测试反馈'; document.querySelector('#fbForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
  await sleep(300);
  const fb1 = await cdp.evaluate(`({ count: document.querySelectorAll('#fbList .fb-item').length, text: document.querySelector('#fbList').textContent })`);
  check('反馈能提交', fb1.count >= 1 && fb1.text.includes('UI 测试反馈'), JSON.stringify(fb1).slice(0, 120));

  await cdp.evaluate(`fetch('api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'其他',body:'云端独有反馈',contact:''})})`);
  await sleep(250);
  await cdp.evaluate(`document.querySelector('#fbPull').click()`);
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    if (await cdp.evaluate(`document.querySelectorAll('#fbList .fb-item.cloud').length > 0`)) break;
  }
  const fb2 = await cdp.evaluate(`({ cloud: document.querySelectorAll('#fbList .fb-item.cloud').length, total: document.querySelectorAll('#fbList .fb-item').length, text: document.querySelector('#fbList').textContent })`);
  check('能从云端拉回反馈且本地那条不重复', fb2.cloud >= 1 && fb2.total === fb2.cloud + 1, JSON.stringify(fb2).slice(0, 160));

  await cdp.evaluate(`window.XN.switchView('chat')`);
  await cdp.evaluate(`document.querySelector('#btnNew').click()`);
  await sleep(150);
  const fresh = await cdp.evaluate(`({ empty: !!document.querySelector('#chatEmpty'), sessions: window.XN.state.sessions.length })`);
  check('新对话按钮有反应', fresh.empty && fresh.sessions >= 2, JSON.stringify(fresh));

  /* 主页改造：空态只留一句说明，不再有「早上好」这类问候标题，也不再有建议条按钮。 */
  const emptyBox = await cdp.evaluate(`(() => {
    const box = document.querySelector('#chatEmpty');
    if (!box) return { exists: false };
    return {
      exists: true,
      h2: box.querySelectorAll('h2').length,
      chips: box.querySelectorAll('.chip').length,
      text: (box.textContent || '').trim().slice(0, 60)
    };
  })()`);
  check('空态不再有问候标题', emptyBox.exists === true && emptyBox.h2 === 0, JSON.stringify(emptyBox).slice(0, 160));
  check('空态不再有建议条', emptyBox.exists === true && emptyBox.chips === 0, JSON.stringify(emptyBox).slice(0, 160));

  const pageErrors = await cdp.evaluate('window.__errs || []');
  const consoleErrors = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value || a.description || '').join(' '));
  const exceptions = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);

  check('页面无 JS 异常', pageErrors.length === 0 && exceptions.length === 0,
    [...pageErrors, ...exceptions].slice(0, 2).join(' | '));
  check('控制台无 error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

/* ---------------- 主入口 ---------------- */

/**
 * 跑一遍 UI 检查。
 * @param {object} opts
 * @param {string} [opts.browserPath] Chromium 内核浏览器路径；不传就按环境变量/常见路径找
 * @param {boolean} [opts.dry] 不起浏览器，只做 HTTP/资源检查
 * @param {boolean} [opts.staticOnly] 用 node 内置静态服务器代替 python 后端（需配合 dry）
 * @param {string} [opts.shotDir] 失败截图/后端日志目录
 * @param {boolean} [opts.quiet] 不逐条打印（ui-ci 用）
 * @returns {Promise<{ok:boolean, results:Array, error:Error|null, shots:string[], log:string, mode:string}>}
 */
export async function runUiCheck(opts = {}) {
  const options = {
    browserPath: opts.browserPath || null,
    dry: !!opts.dry,
    staticOnly: !!opts.staticOnly,
    shotDir: opts.shotDir || null,
    quiet: !!opts.quiet
  };
  if (options.staticOnly && !options.dry) throw new Error('--static 只能配合 --dry 用（静态服务器没有 /api，跑不了浏览器检查）');

  const results = [];
  const shots = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail || '' });
    if (!options.quiet) {
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
    }
  };

  let appLog = '';
  let app = null;
  let mock = null;
  let browserProc = null;
  let staticServer = null;
  let cdp = null;
  let dataDir = null;
  let profile = null;
  let failure = null;
  let mode = options.dry ? (options.staticOnly ? 'dry+static' : 'dry') : 'browser';

  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    dataDir = await mkdtemp(join(tmpdir(), 'xn-ui-'));
    const appPort = await freePort();

    if (options.staticOnly) {
      staticServer = await startStaticServer();
      mode += ` (node 静态服务器:${staticServer.port})`;
    } else {
      const mockPort = await freePort();
      mock = spawn(pythonBin(), ['-u', 'tests/mock_llm.py'], {
        cwd: root, stdio: 'ignore', windowsHide: true,
        env: Object.assign({}, process.env, {
          MOCK_PORT: String(mockPort), MOCK_KEY: 'ui-key',
          PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
        })
      });
      mock.on('error', (e) => { appLog += '\n[mock spawn] ' + e.message; });

      app = spawn(pythonBin(), ['-u', 'server/app.py', '--port', String(appPort)], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: Object.assign({}, process.env, {
          XN_BASE: `http://127.0.0.1:${mockPort}/v1`,
          XN_API_KEY: 'ui-key',
          XN_ADMIN_PASSWORD: PASSWORD,
          XN_ADMIN_SECRET: 'ui-secret',
          XN_DATA_DIR: dataDir,
          PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
        })
      });
      app.stdout.on('data', (d) => { appLog += String(d); });
      app.stderr.on('data', (d) => { appLog += String(d); });
      app.on('error', (e) => { appLog += '\n[app spawn] ' + e.message; });

      if (!(await waitHttp(`http://127.0.0.1:${appPort}/api/health`))) {
        throw new Error('后端没起来\n' + appLog.slice(-1500));
      }
    }

    const baseUrl = `http://127.0.0.1:${staticServer ? staticServer.port : appPort}`;
    let browserPath = '';
    if (!options.dry) {
      if (typeof WebSocket === 'undefined') {
        throw new Error(`当前 Node ${process.version} 没有全局 WebSocket；用 Node 22+ 跑（Node 20 需要 --experimental-websocket）`);
      }
      browserPath = await resolveBrowser(options.browserPath);
      const cdpPort = await freePort();
      profile = await mkdtemp(join(tmpdir(), 'xn-chrome-'));
      browserProc = await startBrowser(browserPath, cdpPort, profile);

      let target = null;
      for (let i = 0; i < 100 && !target; i++) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
          target = list.find((t) => t.type === 'page');
        } catch (e) { /* 浏览器还没开始听 */ }
        if (!target) await sleep(200);
      }
      if (!target) throw new Error('浏览器 CDP 没起来：' + browserPath);

      cdp = await new Cdp(target.webSocketDebuggerUrl).open();
    }

    if (options.dry) {
      await runHttpChecks(check, baseUrl, { staticOnly: options.staticOnly, version: pkg.version });
    } else {
      await runBrowserChecks(check, cdp, baseUrl, pkg.version);
      /* 断言失败也要留现场（不只是抛异常时）：CI 里 artifact 就是这张图。 */
      if (results.some((r) => !r.ok) && options.shotDir) {
        try {
          await mkdir(options.shotDir, { recursive: true });
          shots.push(await cdp.screenshot(join(options.shotDir, 'ui-fail.png')));
        } catch (e) { /* 截图失败不影响判定 */ }
      }
    }
  } catch (e) {
    failure = e;
    process.stderr.write('\nERROR  ' + (e && e.stack || e) + '\n');
    /* 浏览器已经连上就留一张现场截图，CI 里 artifact 直接看。 */
    if (cdp && options.shotDir) {
      try {
        await mkdir(options.shotDir, { recursive: true });
        shots.push(await cdp.screenshot(join(options.shotDir, 'ui-error.png')));
      } catch (e2) { /* 截图失败不掩盖原始错误 */ }
    }
  } finally {
    try { cdp && (await cdp.close()); } catch (e) { /* ignore */ }
    try { browserProc && browserProc.kill(); } catch (e) { /* ignore */ }
    try { app && app.kill(); } catch (e) { /* ignore */ }
    try { mock && mock.kill(); } catch (e) { /* ignore */ }
    try { staticServer && (await staticServer.close()); } catch (e) { /* ignore */ }
    await sleep(250);
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const ok = !failure && results.length > 0 && results.every((r) => r.ok);
  if (ok && !options.quiet) process.stdout.write('\n全部 UI 检查通过\n');
  return { ok, results, error: failure, shots, log: appLog, mode };
}

/** 新接口/旧接口都认：`node tests/ui-check.mjs [--dry] [--static] [--browser=...]` */
export function parseUiArgs(argv = []) {
  const opts = { dry: false, staticOnly: false, browserPath: null, shotDir: process.env.XN_SHOT_DIR || null, help: false };
  for (const raw of argv) {
    if (raw === '--dry') opts.dry = true;
    else if (raw === '--static') opts.staticOnly = true;
    else if (raw === '-h' || raw === '--help') opts.help = true;
    else if (raw.startsWith('--browser=')) opts.browserPath = raw.slice('--browser='.length);
    else if (raw.startsWith('--shot-dir=')) opts.shotDir = raw.slice('--shot-dir='.length);
    else throw new Error('不认识的参数：' + raw + '（可用 --dry / --static / --browser=... / --shot-dir=...）');
  }
  if (opts.staticOnly && !opts.dry) throw new Error('--static 只能配合 --dry 用');
  return opts;
}

const USAGE = `用法：node tests/ui-check.mjs [--dry] [--static] [--browser=<路径>] [--shot-dir=<目录>]

  --dry            不起浏览器，只验证后端 + index.html + 所有 assets 能取到
  --static         （配合 --dry）用 node 内置静态服务器代替 python 后端，不需要 python
  --browser=...    指定 Chromium 内核浏览器（默认自动找 Edge/Chrome/Chromium）
  --shot-dir=...   失败截图和后端日志输出目录（也可用 XN_SHOT_DIR）`;

async function main(argv) {
  const opts = parseUiArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const r = await runUiCheck(opts);
  if (r.log && r.log.trim()) {
    const tail = r.log.trim().split('\n').slice(-30).join('\n');
    process.stdout.write(`\n--- 后端日志（末尾 30 行）---\n${tail}\n`);
  }
  if (!r.ok) {
    const failed = r.results.filter((x) => !x.ok).length;
    process.stderr.write(`\nUI 检查失败：${failed} 项（模式 ${r.mode}）\n`);
  }
  return r.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write((e && e.stack || String(e)) + '\n');
      process.exitCode = 1;
    });
}

/* 给 tests/ui-ci.mjs 复用的小工具：python 解释器名、随机空闲端口、HTTP 就绪探测。 */
export { pythonBin, freePort, waitHttp };
