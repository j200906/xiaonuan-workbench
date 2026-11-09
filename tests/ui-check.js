/* 无头 Edge + CDP 端到端验收（无依赖） */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PASSWORD = 'xiaonuanai';
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

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = `
  (() => {
    var now = Date.now();
    localStorage.setItem('xn.notes.v1', JSON.stringify([
      {id:'n1',title:'含参导数：先比根，再分区',body:'临界点大小关系不确定时，分类标准是 a 的符号。',tag:'数学',ts:now-86400000,updated:now-3600000},
      {id:'n2',title:'英语阅读错因',body:'细节题错多半是选项偷换了主语，不是没读懂。',tag:'英语',ts:now-172800000,updated:now-7200000},
      {id:'n3',title:'港大面试：为什么是这座城市',body:'别答「国际化」。答一个只有这座城市能给的具体东西。',tag:'面试',ts:now-259200000,updated:now-10800000}
    ]));
    localStorage.setItem('xn.goals.v1', JSON.stringify({date:new Date().toISOString().slice(0,10),items:[
      {id:'g1',text:'数学：含参导数 20 道',done:true,ts:now},
      {id:'g2',text:'英语：精读一篇 + 圈主语',done:false,ts:now},
      {id:'g3',text:'把昨天那条错题写进笔记',done:false,ts:now}
    ]}));
    localStorage.setItem('xn.fb.v1', JSON.stringify([
      {id:'f1',type:'想法',body:'希望笔记能按科目分组。',contact:'',ts:now-5400000,status:'local'},
      {id:'f2',type:'故障',body:'手机上聊天框挡住最后一条消息。',contact:'wx: xiaonuan',ts:now-86400000,status:'local'}
    ]));
    localStorage.setItem('xn.timer.v1', JSON.stringify({min:25,left:1122,running:false,endsAt:0,done:2,date:new Date().toISOString().slice(0,10)}));
    return true;
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

  /* ---------- 1. 首屏 ---------- */
  await send('Page.navigate', { url: BASE + '/index.html' });
  await sleep(900);
  await evaluate(`localStorage.clear(); sessionStorage.clear();`);
  await send('Page.reload');
  await sleep(1300);

  const first = await evaluate(`(() => {
    const empty = document.querySelector('#messages .empty');
    const side = document.querySelector('#side').getBoundingClientRect();
    return {
      app: !!document.querySelector('#app'),
      empty: !!empty,
      emptyText: empty ? empty.querySelector('h2').textContent : '',
      keybarHidden: document.querySelector('#keyBar').hidden,
      conn: document.querySelector('#connText').textContent,
      sideW: Math.round(side.width),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      errs: window.__errs.slice()
    };
  })()`);
  check('首屏无门禁，直接是对话', first.app && first.empty, first.emptyText);
  check('首屏不露 Key 输入', first.keybarHidden);
  check('侧栏状态显示未配置', /未配置/.test(first.conn), first.conn);
  check('侧栏宽度正常且无横向溢出', first.sideW > 200 && !first.overflowX, `${first.sideW}px`);
  check('首屏无 JS 报错', first.errs.length === 0, first.errs.join(' | '));

  /* ---------- 2. 没 Key 时发送 ---------- */
  await evaluate(`(() => {
    const i = document.querySelector('#input');
    i.value = '测试一下链路';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composerForm').requestSubmit();
  })()`);
  await sleep(400);
  const noKey = await evaluate(`({
    keybar: !document.querySelector('#keyBar').hidden,
    msgs: document.querySelectorAll('#messages .msg').length,
    focus: document.activeElement && document.activeElement.id
  })`);
  check('没 Key 时弹出输入条', noKey.keybar);
  check('没 Key 时不发消息', noKey.msgs === 0, String(noKey.msgs));
  check('焦点落在 Key 输入框', noKey.focus === 'keyInput', noKey.focus || '(无)');

  /* ---------- 3. 填 Key 后自动补发 ---------- */
  await evaluate(`(() => {
    document.querySelector('#keyBase').value = '/api';
    document.querySelector('#keyModel').value = 'deepseek-chat';
    document.querySelector('#keyInput').value = 'browser-key';
    document.querySelector('#keySave').click();
  })()`);
  await sleep(2600);
  const sent = await evaluate(`(() => {
    const bots = [...document.querySelectorAll('#messages .msg.bot')];
    const last = bots[bots.length - 1];
    return {
      keybar: !document.querySelector('#keyBar').hidden,
      msgs: document.querySelectorAll('#messages .msg').length,
      text: last ? last.querySelector('.content').textContent.slice(0, 40) : '',
      err: !!(last && last.querySelector('.err')),
      sessions: document.querySelectorAll('.session').length,
      title: document.querySelector('#mainTitle').textContent,
      stored: !!localStorage.getItem('xn.key.v1'),
      conn: document.querySelector('#connText').textContent,
      errs: window.__errs.slice()
    };
  })()`);
  check('Key 收进本地', sent.stored);
  check('输入条自动收起', !sent.keybar);
  check('挂起的消息自动发出', sent.msgs === 2, `${sent.msgs} 条`);
  check('流式回复收到', /收到|假上游/.test(sent.text), sent.text.replace(/\s+/g, ' '));
  check('无错误提示', !sent.err);
  check('会话进入侧栏', sent.sessions === 1, `标题「${sent.title}」`);
  check('连接状态更新', !/未配置/.test(sent.conn), sent.conn);
  check('发送过程无报错', sent.errs.length === 0, sent.errs.join(' | '));

  /* ---------- 4. 新对话 / 切换 ---------- */
  await evaluate(`document.querySelector('#btnNew').click()`);
  await sleep(400);
  const fresh = await evaluate(`({
    empty: !!document.querySelector('#messages .empty'),
    sessions: document.querySelectorAll('.session').length
  })`);
  check('新对话回到空状态', fresh.empty);
  check('空对话不占侧栏', fresh.sessions === 1, String(fresh.sessions));

  await evaluate(`document.querySelector('.ses-main').click()`);
  await sleep(500);
  const back = await evaluate(`({
    msgs: document.querySelectorAll('#messages .msg').length,
    on: document.querySelector('.session').classList.contains('on')
  })`);
  check('切回旧会话恢复消息', back.msgs === 2, String(back.msgs));
  check('当前会话高亮', back.on);

  /* ---------- 5. 种子 + 刷新 ---------- */
  await evaluate(SEED);
  await send('Page.reload');
  await sleep(1500);
  const reloaded = await evaluate(`({
    msgs: document.querySelectorAll('#messages .msg').length,
    sessions: document.querySelectorAll('.session').length,
    key: !!localStorage.getItem('xn.key.v1'),
    errs: window.__errs.slice()
  })`);
  check('刷新后对话还在', reloaded.msgs === 2, String(reloaded.msgs));
  check('刷新后 Key 还在', reloaded.key);
  check('刷新无报错', reloaded.errs.length === 0, reloaded.errs.join(' | '));

  /* ---------- 6. 学习台 ---------- */
  await evaluate(`document.querySelector('.side-link[data-view="study"]').click()`);
  await sleep(500);
  const studyInfo = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#view-study .card')].map(c => Math.round(c.getBoundingClientRect().width));
    return {
      goals: document.querySelectorAll('.goal').length,
      notes: document.querySelectorAll('.note').length,
      meta: document.querySelector('#goalMeta').textContent,
      timer: document.querySelector('#timerNum').textContent,
      cards,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      title: document.querySelector('#mainTitle').textContent
    };
  })()`);
  check('学习台可见', studyInfo.title === '学习台', studyInfo.title);
  check('目标列表渲染', studyInfo.goals === 3, `${studyInfo.goals} 条 · ${studyInfo.meta}`);
  check('笔记卡片渲染', studyInfo.notes === 3);
  check('计时器读数正常', /^\d{2}:\d{2}$/.test(studyInfo.timer), studyInfo.timer);
  check('两栏等宽', Math.abs(studyInfo.cards[0] - studyInfo.cards[1]) <= 1, studyInfo.cards.join(' / '));
  check('学习台无横向溢出', !studyInfo.overflowX);

  await evaluate(`(() => {
    document.querySelector('#goalInput').value = '验收：加一条目标';
    document.querySelector('#goalForm').requestSubmit();
  })()`);
  await sleep(300);
  check('新增目标生效', (await evaluate(`document.querySelectorAll('.goal').length`)) === 4);

  /* ---------- 7. 反馈箱 ---------- */
  await evaluate(`document.querySelector('.side-link[data-view="feedback"]').click()`);
  await sleep(300);
  const fb0 = await evaluate(`document.querySelectorAll('.fb-item').length`);
  await evaluate(`(() => {
    const ta = document.querySelector('#fbBody');
    ta.value = '验收写的一条反馈';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#fbForm').requestSubmit();
  })()`);
  await sleep(700);
  const fb = await evaluate(`({
    count: document.querySelectorAll('.fb-item').length,
    stored: JSON.parse(localStorage.getItem('xn.fb.v1') || '[]').length,
    errs: window.__errs.slice()
  })`);
  check('原有反馈 2 条', fb0 === 2, String(fb0));
  check('新反馈入列并落盘', fb.count === 3 && fb.stored === 3);
  check('反馈页无报错', fb.errs.length === 0, fb.errs.join(' | '));

  /* ---------- 8. 设置 → 解锁管理 ---------- */
  await evaluate(`document.querySelector('.side-link[data-view="settings"]').click()`);
  await sleep(300);
  const locked = await evaluate(`({
    archHidden: document.querySelector('#navArch').hidden,
    state: document.querySelector('#adminState').textContent,
    rows: document.querySelectorAll('.kv-row').length
  })`);
  check('默认看不到架构入口', locked.archHidden);
  check('管理状态显示未解锁', locked.state === '未解锁', locked.state);
  check('数据统计渲染', locked.rows === 5, String(locked.rows));

  await evaluate(`(() => {
    document.querySelector('#adminPwd').value = 'wrong-one';
    document.querySelector('#adminForm').requestSubmit();
  })()`);
  await sleep(500);
  const wrong = await evaluate(`({
    archHidden: document.querySelector('#navArch').hidden,
    msg: document.querySelector('#adminMsg').textContent
  })`);
  check('错误密码不解锁', wrong.archHidden, wrong.msg);

  await evaluate(`(() => {
    document.querySelector('#adminPwd').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('#adminForm').requestSubmit();
  })()`);
  await sleep(800);
  const unlocked = await evaluate(`({
    archShown: !document.querySelector('#navArch').hidden,
    view: document.querySelector('.pane:not([hidden])').dataset.view,
    errs: window.__errs.slice()
  })`);
  check('正确密码解锁架构', unlocked.archShown);
  check('解锁后跳到架构页', unlocked.view === 'arch', unlocked.view);
  check('解锁无报错', unlocked.errs.length === 0, unlocked.errs.join(' | '));

  /* ---------- 9. 架构 ---------- */
  const archInfo = await evaluate(`({
    navRows: document.querySelectorAll('.nav-row').length,
    promptLen: document.querySelector('#ctlPrompt').value.length,
    preview: document.querySelector('#cfgPreview').textContent.length,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1
  })`);
  check('导航编辑器 4 行', archInfo.navRows === 4, String(archInfo.navRows));
  check('人设已载入', archInfo.promptLen > 400, `${archInfo.promptLen} 字`);
  check('配置预览已生成', archInfo.preview > 100);
  check('架构页无横向溢出', !archInfo.overflowX);

  await evaluate(`document.querySelector('#ctlAccent button[data-color="#2f6b5f"]').click()`);
  await sleep(300);
  const accent = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    const saved = JSON.parse(localStorage.getItem('xn.cfg.v1') || 'null');
    return { accent: root.getPropertyValue('--accent').trim(), saved: saved && saved.style.accent };
  })()`);
  check('主色切换并落盘', accent.accent === '#2f6b5f' && accent.saved === '#2f6b5f', accent.accent);

  await evaluate(`(() => {
    const input = document.querySelector('.nav-row[data-id="study"] input');
    input.value = '自习室';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);
  const renamed = await evaluate(`document.querySelector('.side-link[data-view="study"] span').textContent`);
  check('改名即时生效', renamed === '自习室', renamed);

  await evaluate(`(() => {
    document.querySelector('#aiPatchInput').value = '换成深色、静蓝、小圆角';
    document.querySelector('#aiPatchForm').requestSubmit();
  })()`);
  await sleep(2200);
  const patch = await evaluate(`(() => {
    const p = document.querySelector('#patchPreview');
    return { head: p.querySelector('h3') ? p.querySelector('h3').textContent : '', items: p.querySelectorAll('li').length };
  })()`);
  check('AI 改版出方案', /准备改这些/.test(patch.head), patch.head);
  check('方案列出多项', patch.items >= 3, `${patch.items} 条`);

  await evaluate(`document.querySelector('#patchPreview [data-arch="apply"]').click()`);
  await sleep(500);
  const applied = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      accent: root.getPropertyValue('--accent').trim(),
      label: document.querySelector('.side-link[data-view="study"] span').textContent,
      previewHidden: document.querySelector('#patchPreview').hidden
    };
  })()`);
  check('应用后变深色', applied.theme === 'dark', applied.theme);
  check('应用后主色生效', applied.accent === '#3d5a80', applied.accent);
  check('应用后改名保留', applied.label === '自习室', applied.label);
  check('应用后收起预览', applied.previewHidden);


  /* ---------- 9.5 更新日志 ---------- */
  await evaluate(`document.querySelector('.side-link[data-view="changelog"]').click()`);
  await sleep(500);
  const meta = await evaluate(`({ total: (window.XN_CHANGELOG||[]).length, cur: window.XN_VERSION })`);
  const cl = await evaluate(`({
    options: document.querySelectorAll('#clFrom option').length,
    items: document.querySelectorAll('.cl-item').length,
    sum: document.querySelector('#clSum').textContent,
    has144: document.querySelector('#clList').textContent.indexOf('1.1.0') >= 0,
    title: document.querySelector('#mainTitle').textContent,
    errs: window.__errs.slice()
  })`);
  check('更新日志页打开', cl.title === '更新日志', cl.title);
  check('版本下拉列出全部版本', cl.options === meta.total, `${cl.options} / ${meta.total}`);
  check('默认区间是「最早之后到最新」', cl.items === meta.total - 1, `${cl.items} 条 · ${cl.sum}`);
  check('区间统计写清范围', /之后 · \d+ 个版本.*修复 \d+ 项.*新增 \d+ 项/.test(cl.sum), cl.sum);

  await evaluate(`(() => {
    const from = document.querySelector('#clFrom');
    from.value = from.options[1].value;
    from.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const range = await evaluate(`({
    sum: document.querySelector('#clSum').textContent,
    items: document.querySelectorAll('.cl-item').length,
    first: document.querySelector('.cl-item strong').textContent
  })`);
  check('改区间后只显示区间内版本', range.items === 1 && range.first === 'v' + meta.cur, `${range.items} 条 · ${range.first}`);
  check('区间统计同步', /之后 · 1 个版本/.test(range.sum), range.sum);

  /* ---------- 9.6 自动迭代 ---------- */
  await evaluate(`document.querySelector('.side-link[data-view="iterate"]').click()`);
  await sleep(400);
  const itReady = await evaluate(`({
    title: document.querySelector('#mainTitle').textContent,
    steps: document.querySelectorAll('.it-step').length,
    start: !!document.querySelector('#itStart')
  })`);
  check('迭代页打开', itReady.title === '迭代', itReady.title);
  check('步骤条渲染 7 步', itReady.steps === 7, String(itReady.steps));

  await evaluate(`document.querySelector('#itTriage').click()`);
  await sleep(2500);
  const queue = await evaluate(`({
    tickets: document.querySelectorAll('.it-ticket').length,
    meta: document.querySelector('#itQueueMeta').textContent,
    log: document.querySelectorAll('.it-line').length
  })`);
  check('整理反馈产出工单', queue.tickets >= 1, `${queue.tickets} 条 · ${queue.meta}`);
  check('整理过程有日志', queue.log >= 2, `${queue.log} 行`);

  const nextV = await evaluate(`(() => {
    const p = (window.XN_VERSION || '1.0.0').split('.').map(Number);
    return p[0] + '.' + p[1] + '.' + (p[2] + 1);
  })()`);
  await evaluate(`document.querySelector('#itCycles').value = '1'; document.querySelector('#itStart').click()`);
  await sleep(22000);
  const itRun = await evaluate(`({
    result: document.querySelector('#itResult').textContent,
    version: document.querySelector('#verChip').textContent,
    steps: [...document.querySelectorAll('.it-step')].map(s => s.className.replace('it-step ','')),
    logLines: document.querySelectorAll('.it-line').length,
    prHidden: document.querySelector('#itPRLink').hidden,
    errs: window.__errs.slice()
  })`);
  check('迭代产出新版本号', itRun.version === 'v' + nextV, itRun.version + ' 期望 v' + nextV);
  check('预演与反证都跑过', /反证通过/.test(itRun.result), itRun.result.slice(0, 60).replace(/\s+/g, ' '));
  check('发布状态是草稿', /草稿/.test(itRun.result));
  check('步骤条走完关键步骤', itRun.steps.filter(s => s === 'ok').length >= 5, itRun.steps.join(','));
  check('跳过的步骤有标记', itRun.steps.filter(s => s === 'skip').length === 2, itRun.steps.join(','));
  check('日志记录了全过程', itRun.logLines >= 8, `${itRun.logLines} 行`);
  check('没配通道时不显示 PR 链接', itRun.prHidden);
  check('迭代无未捕获异常', itRun.errs.length === 0, itRun.errs.join(' | '));


  /* ---------- 9.7 大改的守门 ---------- */
  const guards = await evaluate(`(() => {
    const base = { 'assets/app.css': 'x'.repeat(4000), 'index.html': '<html></html>' };
    const out = {};
    try {
      const r = window.XN.IT.applyPlan(base, { mode: 'rewrite', rewrites: [{ file: 'assets/app.css', content: 'y'.repeat(4200) }] });
      out.accept = r.mode === 'rewrite' && r.touched.length === 1 && r.files['assets/app.css'].length === 4200;
    } catch (e) { out.accept = false; out.acceptErr = e.message; }
    try {
      window.XN.IT.applyPlan(base, { mode: 'rewrite', rewrites: [{ file: 'assets/app.css', content: 'y'.repeat(600) }] });
      out.shortBlocked = false;
    } catch (e) { out.shortBlocked = /短/.test(e.message); }
    try {
      window.XN.IT.applyPlan(base, { mode: 'rewrite', rewrites: [{ file: 'assets/app.css', content: 'y'.repeat(4200) }],
        creates: [{ file: 'assets/extra.js', content: 'window.X=1;' }] });
      out.createBlocked = false;
    } catch (e) { out.createBlocked = /没在 index.html 里引用/.test(e.message); }
    try {
      window.XN.IT.applyPlan(base, { mode: 'rewrite', rewrites: [{ file: 'assets/app.css', content: 'y'.repeat(4200) + '\\n…省略…' }] });
      out.ellipsisBlocked = false;
    } catch (e) { out.ellipsisBlocked = /省略/.test(e.message); }
    return out;
  })()`);
  check('整份重写能通过', guards.accept, guards.acceptErr || '');
  check('砍太短会被挡', guards.shortBlocked);
  check('新脚本没登记会被挡', guards.createBlocked);
  check('带省略号会被挡', guards.ellipsisBlocked);

  /* ---------- 10. 刷新保持 ---------- */
  await send('Page.reload');
  await sleep(1500);
  const after = await evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      accent: root.getPropertyValue('--accent').trim(),
      archShown: !document.querySelector('#navArch').hidden,
      msgs: document.querySelectorAll('#messages .msg').length,
      view: document.querySelector('.pane:not([hidden])').dataset.view,
      version: document.querySelector('#verChip').textContent,
      errs: window.__errs.slice()
    };
  })()`);
  check('刷新后仍是深色', after.theme === 'dark', after.theme);
  check('刷新后主色保持', after.accent === '#3d5a80', after.accent);
  check('刷新后管理模式保持', after.archShown);
  check('刷新后回到上次页面', after.view === 'iterate', after.view);
  check('草稿不改代码，刷新退回原版本', after.version === 'v' + meta.cur, after.version);
  check('刷新无报错', after.errs.length === 0, after.errs.join(' | '));

  /* ---------- 11. 窄屏抽屉 ---------- */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const mobile = await evaluate(`(() => {
    const side = document.querySelector('#side').getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      sideLeft: Math.round(side.left),
      openBtn: !!document.querySelector('#sideOpen')
    };
  })()`);
  check('窄屏无横向溢出', !mobile.overflowX);
  check('窄屏侧栏默认收起', mobile.sideLeft < 0, `left=${mobile.sideLeft}`);

  await evaluate(`document.querySelector('#sideOpen').click()`);
  await sleep(400);
  const drawer = await evaluate(`(() => {
    const side = document.querySelector('#side').getBoundingClientRect();
    return { left: Math.round(side.left), scrim: !document.querySelector('#scrim').hidden };
  })()`);
  check('点开侧栏滑出', drawer.left >= 0 && drawer.scrim, `left=${drawer.left}`);

  await evaluate(`document.querySelector('#scrim').click()`);
  await sleep(300);
  await send('Emulation.clearDeviceMetricsOverride');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync('tests/report.json', JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS 失败:', e.message); process.exit(2); });
