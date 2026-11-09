/* 用 CDP 驱动无头 Edge 做交互验收：量几何、抓报错、模拟点击与提交 */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
let msgId = 0;
const pending = new Map();
let ws;

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

async function evaluate(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise, userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = `
  (() => {
    var now = Date.now();
    localStorage.setItem('xn.notes.v1', JSON.stringify([
      {id:'n1',title:'含参导数：先比根，再分区',body:'临界点大小关系不确定时，分类标准是 a 的符号，不是 x 的范围。写完三类再画表格。',tag:'数学',ts:now-86400000,updated:now-3600000},
      {id:'n2',title:'英语阅读错因',body:'细节题错多半是选项偷换了主语，不是没读懂。做题时把主语圈出来。',tag:'英语',ts:now-172800000,updated:now-7200000},
      {id:'n3',title:'港大面试：为什么是这座城市',body:'别答「国际化」。答一个只有香港能给的具体东西。',tag:'面试',ts:now-259200000,updated:now-10800000}
    ]));
    localStorage.setItem('xn.goals.v1', JSON.stringify({date:new Date().toISOString().slice(0,10),items:[
      {id:'g1',text:'数学：含参导数 20 道（只写分类条件）',done:true,ts:now},
      {id:'g2',text:'英语：精读一篇 + 圈主语',done:false,ts:now},
      {id:'g3',text:'把昨天那条错题用自己的话写进笔记',done:false,ts:now}
    ]}));
    localStorage.setItem('xn.fb.v1', JSON.stringify([
      {id:'f1',type:'想法',body:'希望学习台能按科目分组。',contact:'',ts:now-5400000,status:'local'},
      {id:'f2',type:'故障',body:'手机上聊天框挡住最后一条消息。',contact:'wx: xiaonuan',ts:now-86400000,status:'local'}
    ]));
    localStorage.setItem('xn.timer.v1', JSON.stringify({min:25,left:1122,running:false,endsAt:0,done:2,date:new Date().toISOString().slice(0,10)}));
    return Object.keys(localStorage).filter(k=>k.indexOf('xn.')===0);
  })()`;

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];window.addEventListener('error',e=>__errs.push(String(e.message)));
             window.addEventListener('unhandledrejection',e=>__errs.push('reject:'+String(e.reason)));
             (function(){const c=console.error;console.error=function(){__errs.push([...arguments].join(' '));c.apply(console,arguments)};})();`
  });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  // ---------- 1. 门禁 ----------
  await send('Page.navigate', { url: BASE + '/index.html' });
  await sleep(1000);
  await evaluate(`localStorage.clear(); sessionStorage.clear();`);
  await send('Page.reload');
  await sleep(1200);

  const gate = await evaluate(`(() => {
    const card = document.querySelector('.gate-card').getBoundingClientRect();
    const btn = document.querySelector('#gateGo').getBoundingClientRect();
    return {
      w: innerWidth, h: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      cardW: Math.round(card.width), cardH: Math.round(card.height),
      centered: Math.abs((card.left + card.right) / 2 - innerWidth / 2) < 3,
      btnVisible: btn.top > 0 && btn.bottom <= innerHeight,
      errs: window.__errs.slice()
    };
  })()`);
  check('门禁页无横向溢出', !gate.overflowX, `viewport ${gate.w}x${gate.h}`);
  check('门禁卡片居中', gate.centered, `宽 ${gate.cardW} 高 ${gate.cardH}`);
  check('进入按钮在首屏内', gate.btnVisible);
  check('门禁页无 JS 报错', gate.errs.length === 0, gate.errs.join(' | '));

  // ---------- 2. 错误密码 ----------
  await evaluate(`(() => {
    document.querySelector('#gateKey').value = 'any-key';
    document.querySelector('#gatePwd').value = 'wrong';
    document.querySelector('#gateForm').requestSubmit();
  })()`);
  await sleep(300);
  const wrongPwdMsg = await evaluate(`document.querySelector('#gateMsg').textContent`);
  check('错误密码被拦下', /不对/.test(wrongPwdMsg), wrongPwdMsg);

  // ---------- 3. 正确进入（走 /api 代理） ----------
  await evaluate(`(() => {
    document.querySelector('#gateBase').value = '/api';
    document.querySelector('#gatePwd').value = 'xiaonuanai';
    document.querySelector('#gateKey').value = 'browser-key';
    document.querySelector('#gateForm').requestSubmit();
  })()`);
  await sleep(1800);
  const entered = await evaluate(`(() => ({
    shell: !document.querySelector('#shell').hidden,
    nav: [...document.querySelectorAll('#nav button')].map(b => b.textContent.trim()),
    badge: document.querySelector('#modeBadge').textContent,
    keys: Object.keys(localStorage).filter(k => k.indexOf('xn.') === 0),
    cfg: (localStorage.getItem('xn.cfg.v1') || '').slice(0, 40),
    errs: window.__errs.slice()
  }))()`);
  check('进入主界面', entered.shell);
  check('管理员看到 5 个导航', entered.nav.length === 5, entered.nav.join(' / '));
  check('模式标记为架构模式', entered.badge === '架构模式', entered.badge);
  check('配置已落盘', entered.keys.includes('xn.cfg.v1'), entered.cfg || '(空)');
  check('进入后无 JS 报错', entered.errs.length === 0, entered.errs.join(' | '));

  // ---------- 4. 种子数据 + 刷新 ----------
  const keys = await evaluate(SEED);
  check('种子数据写入', keys.length >= 5, keys.join(','));
  await send('Page.reload');
  await sleep(1500);
  const reloaded = await evaluate(`(() => ({
    shell: !document.querySelector('#shell').hidden,
    gate: !document.querySelector('#gate').hidden,
    nav: [...document.querySelectorAll('#nav button')].map(b=>b.textContent.trim()),
    view: document.querySelector('.view:not([hidden])').dataset.view,
    errs: window.__errs.slice()
  }))()`);
  check('刷新后免登录', reloaded.shell && !reloaded.gate);
  check('刷新后仍是架构模式', reloaded.nav.includes('架构'), reloaded.nav.join(' / '));

  // ---------- 5. 对话（真走 /api → 假上游，流式） ----------
  await evaluate(`(() => {
    const i = document.querySelector('#input');
    i.value = '测试一下链路';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btnSend').click();
  })()`);
  await sleep(2600);
  const chat = await evaluate(`(() => {
    const bots = [...document.querySelectorAll('.msg.bot')];
    const last = bots[bots.length - 1];
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return {
      count: document.querySelectorAll('.msg').length,
      text: last ? last.querySelector('.content').textContent.slice(0, 50) : '',
      hasErr: !!(last && last.querySelector('.err')),
      composerBottom: Math.round(innerHeight - composer.bottom),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      scrollOverflow: document.querySelector('#messages').scrollWidth > document.querySelector('#messages').clientWidth + 2,
      saved: JSON.parse(localStorage.getItem('xn.chat.v1') || '[]').length,
      errs: window.__errs.slice()
    };
  })()`);
  check('消息已渲染', chat.count === 2, `共 ${chat.count} 条`);
  check('流式内容收到', /假上游|收到/.test(chat.text), chat.text.replace(/\s+/g, ' '));
  check('无错误提示', !chat.hasErr);
  check('对话已落盘', chat.saved === 2, `${chat.saved} 条`);
  check('输入框贴底', chat.composerBottom >= 0 && chat.composerBottom < 40, `距底 ${chat.composerBottom}px`);
  check('对话区无横向溢出', !chat.overflowX && !chat.scrollOverflow);
  check('对话过程无报错', chat.errs.length === 0, chat.errs.join(' | '));

  // ---------- 6. 学习台 ----------
  await evaluate(`document.querySelector('#nav button[data-view="study"]').click()`);
  await sleep(500);
  const study = await evaluate(`(() => {
    const rect = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const cards = [...document.querySelectorAll('#view-study .card')].map(c => Math.round(c.getBoundingClientRect().width));
    return {
      goals: document.querySelectorAll('.goal').length,
      notes: document.querySelectorAll('.note').length,
      meta: document.querySelector('#goalMeta').textContent,
      timer: document.querySelector('#timerNum').textContent,
      cards,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      viewHidden: document.querySelector('#view-study').hidden,
      errs: window.__errs.slice()
    };
  })()`);
  check('学习台可见', !study.viewHidden);
  check('目标列表渲染', study.goals === 3, `${study.goals} 条，计数 ${study.meta}`);
  check('笔记卡片渲染', study.notes === 3);
  check('计时器读数正常', /^\d{2}:\d{2}$/.test(study.timer), study.timer);
  check('两栏卡片等宽', study.cards.length >= 2 && Math.abs(study.cards[0] - study.cards[1]) <= 1, study.cards.join(' / '));
  check('学习台无横向溢出', !study.overflowX);
  check('学习台无报错', study.errs.length === 0, study.errs.join(' | '));

  await evaluate(`(() => {
    document.querySelector('#goalInput').value = '自动化验收：加一条目标';
    document.querySelector('#goalForm').requestSubmit();
  })()`);
  await sleep(250);
  const goalAdded = await evaluate(`({
    dom: document.querySelectorAll('.goal').length,
    stored: JSON.parse(localStorage.getItem('xn.goals.v1')).items.length
  })`);
  check('新增目标生效并存盘', goalAdded.dom === 4 && goalAdded.stored === 4, `DOM ${goalAdded.dom} / 存储 ${goalAdded.stored}`);

  // 计时器启动
  await evaluate(`document.querySelector('#timerStart').click()`);
  await sleep(900);
  const timer = await evaluate(`({
    text: document.querySelector('#timerNum').textContent,
    phase: document.querySelector('#timerPhase').textContent,
    running: JSON.parse(localStorage.getItem('xn.timer.v1')).running
  })`);
  check('计时器能跑', timer.running && timer.phase === '专注中', `${timer.text} ${timer.phase}`);
  await evaluate(`document.querySelector('#timerStart').click()`);

  // ---------- 7. 反馈箱 ----------
  await evaluate(`document.querySelector('#nav button[data-view="feedback"]').click()`);
  await sleep(300);
  const fb0 = await evaluate(`document.querySelectorAll('.fb-item').length`);
  await evaluate(`(() => {
    const ta = document.querySelector('#fbBody');
    ta.value = '自动化验收写的一条反馈';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#fbForm').requestSubmit();
  })()`);
  await sleep(900);
  const fb = await evaluate(`({
    count: document.querySelectorAll('.fb-item').length,
    meta: document.querySelector('#fbMeta').textContent,
    stored: JSON.parse(localStorage.getItem('xn.fb.v1') || '[]').length,
    errs: window.__errs.slice()
  })`);
  check('反馈列表原有 2 条', fb0 === 2, String(fb0));
  check('新反馈进入列表并存盘', fb.count === 3 && fb.stored === 3, fb.meta);
  check('反馈页无报错', fb.errs.length === 0, fb.errs.join(' | '));

  // ---------- 8. 架构 ----------
  await evaluate(`document.querySelector('#nav button[data-view="arch"]').click()`);
  await sleep(400);
  const archInfo = await evaluate(`({
    navRows: document.querySelectorAll('.nav-row').length,
    promptLen: document.querySelector('#ctlPrompt').value.length,
    cfgPreview: document.querySelector('#cfgPreview').textContent.length,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1
  })`);
  check('导航编辑器渲染 5 行', archInfo.navRows === 5, String(archInfo.navRows));
  check('人设文本已载入', archInfo.promptLen > 400, `${archInfo.promptLen} 字`);
  check('配置预览已生成', archInfo.cfgPreview > 100, `${archInfo.cfgPreview} 字节`);
  check('架构页无横向溢出', !archInfo.overflowX);

  await evaluate(`document.querySelector('#ctlAccent button[data-color="#2f6b5f"]').click()`);
  await sleep(300);
  const accent = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('xn.cfg.v1') || 'null'); } catch (e) {}
    return {
      accent: root.getPropertyValue('--accent').trim(),
      soft: root.getPropertyValue('--accent-soft').trim(),
      saved: saved && saved.style ? saved.style.accent : '(缺)'
    };
  })()`);
  check('主色切换生效', accent.accent === '#2f6b5f', accent.accent);
  check('派生色跟随', /^#[0-9a-f]{6}$/.test(accent.soft), accent.soft);
  check('主色已持久化', accent.saved === '#2f6b5f', String(accent.saved));

  await evaluate(`(() => {
    const input = document.querySelector('.nav-row[data-id="study"] input');
    input.value = '自习室';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  const renamed = await evaluate(`[...document.querySelectorAll('#nav button')].map(b=>b.textContent.trim())`);
  check('导航改名即时生效', renamed.includes('自习室'), renamed.join(' / '));

  // 排序
  await evaluate(`document.querySelector('.nav-row[data-id="feedback"] button[data-act="up"]').click()`);
  await sleep(250);
  const order = await evaluate(`JSON.parse(localStorage.getItem('xn.cfg.v1')).nav.map(n=>n.id)`);
  check('导航排序生效', order[1] === 'feedback', order.join(','));

  // AI 改版：模型返回配置补丁 → 预览 → 应用
  await evaluate(`(() => {
    document.querySelector('#aiPatchInput').value = '换成深色、静蓝、小圆角，学习台改名自习室';
    document.querySelector('#aiPatchForm').requestSubmit();
  })()`);
  await sleep(2200);
  const patch = await evaluate(`(() => {
    const p = document.querySelector('#patchPreview');
    return {
      hidden: p.hidden,
      head: p.querySelector('h4') ? p.querySelector('h4').textContent : '',
      items: p.querySelectorAll('li').length,
      errs: window.__errs.slice()
    };
  })()`);
  check('AI 改版生成预览', !patch.hidden && /准备改这些/.test(patch.head), patch.head);
  check('预览列出多条改动', patch.items >= 3, `${patch.items} 条`);
  check('AI 改版无未捕获异常', patch.errs.length === 0, patch.errs.join(' | '));

  await evaluate(`document.querySelector('#patchPreview [data-arch="apply"]').click()`);
  await sleep(500);
  const applied = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    const nav = [...document.querySelectorAll('#nav button')].map(b => b.textContent.trim());
    const saved = JSON.parse(localStorage.getItem('xn.cfg.v1'));
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      accent: root.getPropertyValue('--accent').trim(),
      radius: root.getPropertyValue('--radius').trim(),
      nav,
      savedAccent: saved.style.accent,
      previewHidden: document.querySelector('#patchPreview').hidden,
      errs: window.__errs.slice()
    };
  })()`);
  check('应用后切到深色', applied.theme === 'dark', applied.theme);
  check('应用后主色与圆角按方案改', applied.accent === '#3d5a80' && applied.radius === '8px', `${applied.accent} / ${applied.radius}`);
  check('应用后导航按建议重排', applied.nav[2] === '架构' && applied.nav.includes('自习室'), applied.nav.join(' / '));
  check('应用后落盘并收起预览', applied.savedAccent === '#3d5a80' && applied.previewHidden, `accent=${applied.savedAccent} hidden=${applied.previewHidden} errs=${applied.errs.join('|')}`);

  // ---------- 9. 设置 ----------
  await evaluate(`document.querySelector('#nav button[data-view="settings"]').click()`);
  await sleep(300);
  const settings = await evaluate(`({
    rows: document.querySelectorAll('.kv-row').length,
    meta: document.querySelector('#storageMeta').textContent,
    keyMeta: document.querySelector('#setKeyMeta').textContent
  })`);
  check('设置页统计已渲染', settings.rows === 5, `${settings.rows} 行，占用 ${settings.meta}`);
  check('Key 状态显示正确', /已配置/.test(settings.keyMeta), settings.keyMeta);

  // ---------- 10. 刷新保持 ----------
  await send('Page.reload');
  await sleep(1500);
  const after = await evaluate(`({
    shell: !document.querySelector('#shell').hidden,
    nav: [...document.querySelectorAll('#nav button')].map(b=>b.textContent.trim()),
    view: document.querySelector('.view:not([hidden])').dataset.view,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    errs: window.__errs.slice()
  })`);
  check('刷新后免登录', after.shell);
  check('刷新后配置保持', after.accent === '#3d5a80' && after.nav.includes('自习室'), after.nav.join(' / '));
  check('刷新回到上次页面', after.view === 'settings', after.view);
  check('刷新后无报错', after.errs.length === 0, after.errs.join(' | '));

  // ---------- 11. 窄屏 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const mobile = await evaluate(`(() => {
    const nav = document.querySelector('#nav').getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      docW: document.documentElement.scrollWidth,
      navH: Math.round(nav.height),
      railDir: getComputedStyle(document.querySelector('.rail')).flexDirection
    };
  })()`);
  check('窄屏无横向溢出', !mobile.overflowX, `文档宽 ${mobile.docW}px`);
  check('窄屏导航横排', mobile.railDir === 'row', mobile.railDir);
  await send('Emulation.clearDeviceMetricsOverride');

  // ---------- 12. 只带 Key（不填密码）→ 访客模式 ----------
  await evaluate(`document.querySelector('#btnLock').click()`);
  await sleep(500);
  const locked = await evaluate(`({
    gate: !document.querySelector('#gate').hidden,
    shell: document.querySelector('#shell').hidden,
    msg: document.querySelector('#gateMsg').textContent
  })`);
  check('锁定后回到门禁', locked.gate && locked.shell);

  await evaluate(`(() => {
    document.querySelector('#gateBase').value = '/api';
    document.querySelector('#gateKey').value = 'browser-key';
    document.querySelector('#gatePwd').value = '';
    document.querySelector('#gateForm').requestSubmit();
  })()`);
  await sleep(1800);
  const guest = await evaluate(`({
    shell: !document.querySelector('#shell').hidden,
    nav: [...document.querySelectorAll('#nav button')].map(b => b.textContent.trim()),
    badge: document.querySelector('#modeBadge').textContent,
    adminFlag: sessionStorage.getItem('xn.admin'),
    errs: window.__errs.slice()
  })`);
  check('只填 Key 也能进', guest.shell);
  check('访客只有 4 个导航', guest.nav.length === 4, guest.nav.join(' / '));
  check('访客没有架构入口', !guest.nav.includes('架构'));
  check('标记为访客', guest.badge === '访客', guest.badge);
  check('访客模式无报错', guest.errs.length === 0, guest.errs.join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync('tests/report.json', JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS 失败:', e.message); process.exit(2); });
