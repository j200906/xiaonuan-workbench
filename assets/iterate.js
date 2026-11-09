/* 小暖 · 自动迭代：整理反馈 → 自检 → 自问自答 → 出补丁 → 沙箱预演 → 反证 → 提 PR
   借鉴 magpie 的工程习惯：分支隔离、跑过再说、故意改坏证明检查有效、写明没验过什么。 */
(function (N) {
  'use strict';

  const { $, $$, state } = N;
  const esc = N.esc, toast = N.toast;

  const EDITABLE = ['index.html', 'assets/app.css', 'assets/app.core.js', 'assets/app.views.js', 'assets/persona.js'];
  const READABLE = EDITABLE.concat(['assets/theme.css']);
  const MAX_PATCHES = 6;
  const MAX_FILE_CHARS = 18000;
  const GH_TOKEN_KEY = 'xn.gh.token';

  const IT = {
    running: false,
    stopped: false,
    queue: [],
    log: [],
    result: null,
    sources: null,
    steps: [
      ['triage', '整理反馈'],
      ['critique', '自检'],
      ['grill', '自问自答'],
      ['plan', '出方案'],
      ['verify', '预演'],
      ['publish', '发布'],
      ['record', '记账']
    ],
    stepState: {}
  };
  N.IT = IT;

  function log(msg, kind) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    IT.log.push({ t: hh, msg: String(msg), kind: kind || '' });
    renderLog();
  }

  function renderLog() {
    const el = $('#itLog');
    if (!el) return;
    el.innerHTML = IT.log.map((l) => `<span class="it-line ${l.kind}"><span class="it-time">${l.t}</span>${esc(l.msg)}</span>`).join('');
    el.scrollTop = el.scrollHeight;
    const meta = $('#itLogMeta');
    if (meta) meta.textContent = IT.log.length ? IT.log.length + ' 行' : '—';
  }

  function setStep(key, status) {
    IT.stepState[key] = status;
    const box = $('#itSteps');
    if (!box) return;
    box.innerHTML = IT.steps.map(([k, label]) => {
      const st = IT.stepState[k] || 'idle';
      return `<span class="it-step ${st}" data-step="${k}"><i></i>${esc(label)}</span>`;
    }).join('');
  }

  function setMeta(text) {
    const el = $('#itMeta');
    if (el) el.textContent = text;
  }

  /* ---------- 来源 ---------- */
  async function loadSources() {
    if (IT.sources) return IT.sources;
    const out = {};
    for (const path of READABLE) {
      const res = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('读不到 ' + path);
      out[path] = await res.text();
    }
    IT.sources = out;
    return out;
  }

  async function gatherFeedback() {
    const items = (state.feedback || []).slice(0, 40).map((f) => ({
      type: f.type, body: f.body, contact: f.contact, at: N.fmtDate(f.ts), status: f.status
    }));
    // 配了后端就把服务器上的也拉下来（需要管理员密码）
    if (state.cfg.tutor.baseUrl.charAt(0) === '/' && state.adminPwd) {
      try {
        const res = await fetch('/api/feedback', { headers: { 'X-Admin-Password': state.adminPwd } });
        if (res.ok) {
          const data = await res.json();
          (data.items || []).slice(0, 60).forEach((x) => {
            items.push({ type: x.type, body: x.body, contact: x.contact, at: x.ts, status: 'server' });
          });
        }
      } catch (e) { /* 服务器没配就当没有 */ }
    }
    return items;
  }

  /* ---------- 模型调用 ---------- */
  function parseJSON(raw) {
    if (!raw) return null;
    let text = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(text); } catch (e) {}
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, escd = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (escd) escd = false;
        else if (ch === '\\') escd = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  async function ask(system, user, maxTokens) {
    const res = await N.apiChat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { stream: false, temperature: 0.3, maxTokens: maxTokens || 1600 }
    );
    return parseJSON(res.text);
  }

  function manifest() {
    const files = Object.keys(IT.sources || {}).map((p) => {
      const text = IT.sources[p];
      return { path: p, lines: text.split('\n').length, head: text.split('\n').slice(0, 3).join(' / ').slice(0, 120) };
    });
    return {
      version: window.XN_VERSION || '1.0.0',
      files,
      views: ['chat', 'study', 'feedback', 'settings', 'arch', 'changelog'],
      stores: ['xn.cfg.v1', 'xn.sessions.v1', 'xn.notes.v1', 'xn.goals.v1', 'xn.fb.v1', 'xn.timer.v1', 'xn.key.v1'],
      recent: (window.XN_CHANGELOG || []).slice(0, 3).map((c) => ({ v: c.version, title: c.title, fixes: c.fixes.length, features: c.features.length })),
      rules: [
        '纯静态页面，不能加构建步骤',
        '不能改 server/、tests/、.github/',
        '不能引入外部脚本、eval、远程字体',
        'localStorage 键名保持兼容',
        '不要动管理密码与安全边界'
      ]
    };
  }

  async function triage(feedback) {
    if (!feedback.length) return [];
    log('把 ' + feedback.length + ' 条反馈丢给模型拆工单…');
    const sys = '你是工单拆解器。把用户反馈拆成可执行的工单，合并重复项，别发明用户没说过的问题。只输出 JSON。';
    const user = `反馈列表（JSON）：\n${JSON.stringify(feedback).slice(0, 9000)}\n\n` +
      `当前版本 ${window.XN_VERSION}，最近更新：${JSON.stringify((window.XN_CHANGELOG || []).slice(0, 2).map((c) => c.title))}\n\n` +
      `输出格式：{"tickets":[{"title":"不超过 16 字","kind":"bug|feature|content","severity":1,"why":"用户原话或推断依据","scope":"涉及哪个页面/文件"}]}\n` +
      `最多 5 条，按严重度降序。没有可做的就返回 {"tickets":[]}。`;
    const data = await ask(sys, user, 900);
    return normalizeTickets(data && data.tickets, 'feedback');
  }

  async function selfCritique() {
    log('队列空了，开始一轮自检：找自己的毛病…');
    const sys = '你是这个项目的自己人，任务是挑毛病。只报你能在给定代码里指出来的问题，不要泛泛而谈，不要提已经写在规则里的事。只输出 JSON。';
    const user = `项目清单：${JSON.stringify(manifest())}\n\n` +
      `看这份清单，指出 1-3 个真实存在的小毛病（交互、可访问性、边界情况、错误提示）。` +
      `每条必须能落到具体页面或文件。输出 {"tickets":[{"title":"","kind":"bug","severity":2,"why":"为什么算问题","scope":"文件或页面"}]}`;
    const data = await ask(sys, user, 700);
    return normalizeTickets(data && data.tickets, 'critique');
  }

  async function grill() {
    log('用 grill-me 的方法审问自己：先列决策分支，再逐条自答…');
    const sys = '你在用 grill-me 方法审自己。规则：先列 3-6 个决策分支；每个分支先给出你的推荐答案再自问；能靠读代码回答的不要问；最后把结论变成可做的小功能。只输出 JSON。';
    const user = `项目：一个纯静态的学习工作台（对话/学习台/反馈箱/设置/架构）。当前 ${window.XN_VERSION}。\n` +
      `清单：${JSON.stringify(manifest())}\n\n` +
      `审问方向：用户第一次打开会卡在哪？哪个功能点了没反馈？哪里的文案在骗人？\n` +
      `输出 {"qa":[{"q":"","a":""}],"tickets":[{"title":"","kind":"feature","severity":2,"why":"由哪条自答推出来","scope":"页面"}]}\n` +
      `qa 3-4 组，tickets 1-2 条。功能必须小到一次改动能做完，不许加后端、不许加新依赖。`;
    const data = await ask(sys, user, 1200);
    if (data && Array.isArray(data.qa)) {
      data.qa.slice(0, 4).forEach((p) => log('自问：' + trim(p.q, 60) + ' → ' + trim(p.a, 70), 'qa'));
    }
    return normalizeTickets(data && data.tickets, 'grill');
  }

  function trim(s, n) {
    s = String(s || '').replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function normalizeTickets(list, source) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 5).map((t) => ({
      id: N.uid(),
      title: trim(t.title || t.name || '未命名工单', 24),
      kind: ['bug', 'feature', 'content'].includes(t.kind) ? t.kind : 'feature',
      severity: Math.min(3, Math.max(1, Number(t.severity) || 2)),
      why: trim(t.why || '', 160),
      scope: trim(t.scope || '', 60),
      source,
      status: 'todo'
    })).filter((t) => t.title);
  }

  /* ---------- 选文件 + 出方案 ---------- */
  const FILE_HINTS = {
    'assets/app.css': ['样式', '颜色', '布局', '间距', '暗色', '圆角', '字体', '手机', '窄屏', '按钮', '对齐', '滚动'],
    'assets/app.core.js': ['对话', '消息', '会话', '流式', 'key', '存储', 'markdown', '接口', '错误', '发送', '快捷键'],
    'assets/app.views.js': ['学习台', '笔记', '目标', '计时', '反馈', '设置', '架构', '导航', '日志'],
    'assets/persona.js': ['人设', '语气', '说话', 'prompt', '小暖'],
    'index.html': ['结构', '页面', '入口', '文案', '标题', '按钮位置']
  };

  function pickFiles(ticket) {
    const text = (ticket.title + ' ' + ticket.why + ' ' + ticket.scope).toLowerCase();
    const scored = Object.keys(FILE_HINTS).map((file) => {
      const hits = FILE_HINTS[file].filter((k) => text.includes(k.toLowerCase())).length;
      return { file, score: hits };
    }).sort((a, b) => b.score - a.score);
    const picked = scored.filter((x) => x.score > 0).slice(0, 2).map((x) => x.file);
    if (!picked.length) picked.push('assets/app.views.js', 'assets/app.css');
    return picked.slice(0, 2);
  }

  async function planPatch(ticket) {
    const files = pickFiles(ticket);
    log('读文件：' + files.join('、'));
    const payload = files.map((p) => `<<<FILE ${p}\n${IT.sources[p].slice(0, MAX_FILE_CHARS)}\nFILE>>>`).join('\n\n');

    const sys = '你是代码修改计划器。输出可直接执行的补丁，不要重写整个文件。只输出 JSON。';
    const user = `工单：${JSON.stringify(ticket)}\n\n` +
      `版本 ${window.XN_VERSION}。只允许改这些文件：${EDITABLE.join(', ')}。\n` +
      `硬规则：find 必须与原文逐字一致且在文件里只出现一次；单处 replace 不超过 40 行；不改 server/tests/.github；不引入外部脚本、eval、远程资源；保持 localStorage 键名不变；改完页面必须还能正常启动。\n\n` +
      `输出格式：{"version":"1.2.1","title":"不超过 18 字","fixes":["..."],"features":["..."],"run":"你打算怎么验证","notTried":"你没法验证什么","patches":[{"file":"","find":"","replace":""}]}\n` +
      `patches 最多 ${MAX_PATCHES} 条。宁可只改一处对的，也不要改五处猜的。\n\n${payload}`;

    const plan = await ask(sys, user, 2200);
    if (!plan || !Array.isArray(plan.patches) || !plan.patches.length) throw new Error('模型没给出可用补丁');
    return Object.assign({ ticketId: ticket.id, ticketTitle: ticket.title, files }, plan);
  }

  /* ---------- 应用补丁 ---------- */
  function applyPatches(sources, patches) {
    const out = Object.assign({}, sources);
    const touched = [];
    if (patches.length > MAX_PATCHES) throw new Error('补丁条数超过上限');
    patches.forEach((p, i) => {
      const file = p.file;
      if (!EDITABLE.includes(file)) throw new Error('不允许改 ' + file);
      if (!out[file]) out[file] = IT.sources[file];
      const find = String(p.find || '');
      const replace = String(p.replace || '');
      if (find.length < 8) throw new Error('第 ' + (i + 1) + ' 处 find 太短，容易误伤');
      if (replace.length > 6000) throw new Error('第 ' + (i + 1) + ' 处改动过大');
      if (/(eval\s*\(|document\.write|<script[^>]*src=|import\s*\()/i.test(replace)) {
        throw new Error('第 ' + (i + 1) + ' 处含被禁止的写法');
      }
      const first = out[file].indexOf(find);
      if (first < 0) throw new Error('第 ' + (i + 1) + ' 处在 ' + file + ' 里找不到原文');
      if (out[file].indexOf(find, first + 1) >= 0) throw new Error('第 ' + (i + 1) + ' 处原文不唯一');
      out[file] = out[file].slice(0, first) + replace + out[file].slice(first + find.length);
      if (!touched.includes(file)) touched.push(file);
    });
    return { files: out, touched };
  }

  /* ---------- 验证 ---------- */
  function bundle(files) {
    const order = ['assets/version.js', 'assets/changelog.js', 'assets/persona.js',
      'assets/app.core.js', 'assets/app.views.js', 'assets/iterate.js'];
    return order.map((p) => files[p] || '').join('\n;\n');
  }

  async function previewCheck(files, label) {
    return new Promise((resolve) => {
      const nonce = 'p' + Math.random().toString(36).slice(2);
      let html = files['index.html'];
      const css = files['assets/theme.css'] + '\n' + files['assets/app.css'];
      html = html.replace(/<link rel="stylesheet" href="assets\/theme\.css[^"]*">\s*/g, '')
                 .replace(/<link rel="stylesheet" href="assets\/app\.css[^"]*">/, () => '<style>' + css + '</style>');
      html = html.replace(/<script src="assets\/[^"]+"><\/script>\s*/g, '');

      const core = files['assets/app.core.js'] || '';
      const shim = `
(function(){
  var mem={};
  function mk(){return {getItem:function(k){return mem.hasOwnProperty(k)?mem[k]:null},
    setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},
    clear:function(){mem={}},key:function(i){return Object.keys(mem)[i]||null},
    get length(){return Object.keys(mem).length}};}
  var ls=mk(), ss=mk();
  try{Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return ls}});}catch(e){}
  try{Object.defineProperty(window,'sessionStorage',{configurable:true,get:function(){return ss}});}catch(e){}
  window.__errs=[];
  addEventListener('error',function(e){window.__errs.push(String(e.message||e))});
  addEventListener('unhandledrejection',function(e){window.__errs.push('reject:'+String(e.reason))});
  setTimeout(function(){
    var box=document.querySelector('#messages');
    var chip=document.querySelector('#verChip');
    parent.postMessage({xnPreview:{
      nonce:'${nonce}',
      mounted: !!document.querySelector('#app') && !!box && box.children.length>0,
      version: chip?chip.textContent:'',
      links: document.querySelectorAll('.side-link').length,
      errs: window.__errs
    }},'*');
  }, 1500);
})();`;

      html = html.replace('</head>', () => '<script>' + shim + '<\/script></head>');
      html = html.replace('</body>', () => '<script>' + bundle(files) + '<\/script></body>');

      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:800px;border:0;';
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        frame.remove();
        resolve(r);
      };
      const onMsg = (ev) => {
        const d = ev.data && ev.data.xnPreview;
        if (!d || d.nonce !== nonce) return;
        finish({
          ok: !!d.mounted && (d.errs || []).length === 0,
          detail: `${label || '预演'}：挂载${d.mounted ? '成功' : '失败'}，侧栏 ${d.links} 项，版本 ${d.version || '?'}`,
          errs: d.errs || []
        });
      };
      window.addEventListener('message', onMsg);
      frame.srcdoc = html;
      document.body.appendChild(frame);
      setTimeout(() => finish({ ok: false, detail: (label || '预演') + '：超时，页面没起来' }), 7000);
    });
  }

  async function verify(files) {
    for (const p of Object.keys(files)) {
      if (!p.endsWith('.js')) continue;
      try { new Function(files[p]); }
      catch (e) { return { ok: false, stage: '语法', detail: p + ' 语法错误：' + e.message }; }
    }
    const first = await previewCheck(files, '预演');
    if (!first.ok) return { ok: false, stage: '预演', detail: first.detail + (first.errs && first.errs.length ? ' / ' + first.errs[0] : '') };

    // 故意改坏：摘掉启动钩子，预演必须失败，否则说明检查是瞎的
    const broken = Object.assign({}, files);
    const core = broken['assets/app.core.js'] || '';
    const hook = "document.addEventListener('DOMContentLoaded', boot);";
    if (core.indexOf(hook) < 0) return { ok: false, stage: '反证', detail: '找不到启动钩子，无法做反证' };
    broken['assets/app.core.js'] = core.replace(hook, '');
    const bad = await previewCheck(broken, '反证');
    if (bad.ok) return { ok: false, stage: '反证', detail: '故意摘掉启动钩子后预演仍然通过，说明检查抓不住问题' };

    return { ok: true, detail: first.detail + '；反证通过（摘掉启动钩子后预演失败，检查有效）' };
  }

  /* ---------- 发版 ---------- */
  function nextVersion(suggested) {
    const cur = window.XN_VERSION || '1.0.0';
    const ok = /^\d+\.\d+\.\d+$/.test(suggested || '');
    const cmp = (a, b) => {
      const A = a.split('.').map(Number), B = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] - B[i]; }
      return 0;
    };
    if (ok && cmp(suggested, cur) > 0) return suggested;
    const [maj, min, pat] = cur.split('.').map(Number);
    return `${maj}.${min}.${pat + 1}`;
  }

  function versionSource(v) {
    return '/* 当前版本。自动迭代发布时会改写这个文件。 */\nwindow.XN_VERSION = ' + JSON.stringify(v) + ';\n';
  }

  function changelogSource(list) {
    return '/* 版本记录。自动迭代新增的条目会写回这个文件。 */\nwindow.XN_CHANGELOG = ' + JSON.stringify(list, null, 2) + ';\n';
  }

  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function ghConfig() {
    const p = state.cfg.publish || {};
    return {
      owner: (p.owner || '').trim(),
      repo: (p.repo || '').trim(),
      autoMerge: !!p.autoMerge,
      token: (() => { try { return sessionStorage.getItem(GH_TOKEN_KEY) || ''; } catch (e) { return ''; } })()
    };
  }

  async function gh(path, opts) {
    const cfg = ghConfig();
    const res = await fetch('https://api.github.com' + path, {
      method: (opts && opts.method) || 'GET',
      headers: Object.assign({
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, (opts && opts.body) ? { 'Content-Type': 'application/json' } : {}),
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (data && data.message) || text.slice(0, 120) || res.status;
      throw new Error(`GitHub ${res.status}：${msg}`);
    }
    return data;
  }

  async function publish(files, touched, entry, verifyDetail) {
    const cfg = ghConfig();
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      log('没配发布通道，产物留作草稿。', 'warn');
      return { mode: 'draft' };
    }
    const repoPath = `/repos/${cfg.owner}/${cfg.repo}`;
    const info = await gh(repoPath);
    const base = info.default_branch || 'main';
    const ref = await gh(`${repoPath}/git/ref/heads/${base}`);
    const headSha = ref.object.sha;
    const headCommit = await gh(`${repoPath}/git/commits/${headSha}`);

    const branch = 'auto/v' + entry.version;
    const treeItems = [];
    for (const path of touched) {
      const blob = await gh(`${repoPath}/git/blobs`, { method: 'POST', body: { content: b64(files[path]), encoding: 'base64' } });
      treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await gh(`${repoPath}/git/trees`, {
      method: 'POST',
      body: { base_tree: headCommit.tree.sha, tree: treeItems }
    });

    const message = [
      `${entry.fixCount ? 'fix' : 'feat'}: ${entry.title} (v${entry.version})`,
      '',
      `工单: ${entry.ticketTitle}`,
      `Run: 语法检查 · 沙箱预演 · 反证`,
      `Verify: ${verifyDetail}`,
      `Not tried: 真机多浏览器、真实服务商（本次用假上游）`,
      '',
      `Score: 反馈 ${entry.feedbackCount} 条 / 工单来源 ${entry.source}`
    ].join('\n');

    const commit = await gh(`${repoPath}/git/commits`, {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [headSha] }
    });
    try {
      await gh(`${repoPath}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: commit.sha } });
    } catch (e) {
      await gh(`${repoPath}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: true } });
    }

    const pr = await gh(`${repoPath}/pulls`, {
      method: 'POST',
      body: {
        title: `${entry.title}（v${entry.version}）`,
        head: branch,
        base,
        body: `自动迭代产物。\n\n**改了什么**\n${entry.fixes.concat(entry.features).map((x) => '- ' + x).join('\n') || '- （见提交）'}\n\n**验证**\n${verifyDetail}\n\n**没验证**\n真机、多浏览器、真实服务商。\n\n合并前请自己点一遍：对话能发、学习台能记、侧栏能切。`
      }
    });

    let merged = false;
    if (cfg.autoMerge) {
      try {
        await gh(`${repoPath}/pulls/${pr.number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
        merged = true;
        log('已按设置自动合并 PR #' + pr.number, 'warn');
      } catch (e) {
        log('自动合并失败：' + e.message, 'warn');
      }
    }

    return { mode: 'pr', url: pr.html_url, number: pr.number, branch, merged };
  }

  /* ---------- 主循环 ---------- */
  function stop() {
    IT.stopped = true;
    IT.running = false;
    const btn = $('#itStop');
    if (btn) btn.hidden = true;
    setMeta('已停止');
    log('收到停止，收尾。', 'warn');
  }

  async function runOne(ticket, feedbackCount) {
    setStep('plan', 'run');
    const plan = await planPatch(ticket);
    log('方案：' + plan.title + '（' + plan.patches.length + ' 处改动）', 'ok');
    plan.ticketTitle = ticket.title;
    plan.ticketId = ticket.id;
    plan.source = ticket.source;
    plan.feedbackCount = feedbackCount;

    setStep('plan', 'ok');
    setStep('verify', 'run');

    const released = applyPatches(IT.sources, plan.patches);
    const v = nextVersion(plan.version);
    log('版本：' + (window.XN_VERSION || '?') + ' → ' + v);

    const entry = {
      version: v,
      date: new Date().toISOString().slice(0, 10),
      title: trim(plan.title || ticket.title, 30),
      fixes: (plan.fixes || []).map((x) => trim(x, 120)).slice(0, 6),
      features: (plan.features || []).map((x) => trim(x, 120)).slice(0, 6),
      notes: trim(plan.notTried || '未说明没验证的部分。', 160),
      ticketTitle: ticket.title,
      source: ticket.source,
      feedbackCount,
      fixCount: (plan.fixes || []).length
    };
    if (!entry.fixes.length && !entry.features.length) entry.fixes.push(entry.title);

    const files = Object.assign({}, released.files);
    files['index.html'] = (files['index.html'] || '').replace(/\?v=\d+\.\d+\.\d+/g, '?v=' + v);
    if (released.touched.indexOf('index.html') < 0) released.touched.push('index.html');
    files['assets/version.js'] = versionSource(v);
    const list = [entry].concat(window.XN_CHANGELOG || []);
    files['assets/changelog.js'] = changelogSource(list);

    const check = await verify(files);
    log(check.detail, check.ok ? 'ok' : 'fail');
    setStep('verify', check.ok ? 'ok' : 'fail');
    if (!check.ok) {
      ticket.status = 'failed';
      renderQueue();
      return { ok: false, reason: check.detail };
    }

    setStep('publish', 'run');
    let pub = { mode: 'draft' };
    try {
      pub = await publish(files, released.touched.concat(['assets/version.js', 'assets/changelog.js']), entry, check.detail);
      log(pub.mode === 'pr' ? ('已提 PR #' + pub.number + (pub.merged ? '（已合并）' : '，等你点合并')) : '草稿已生成', 'ok');
      setStep('publish', 'ok');
    } catch (e) {
      log('发布失败：' + e.message, 'fail');
      setStep('publish', 'fail');
    }

    // 记账：内存里立刻生效（页面本身要刷新才会用新代码）
    window.XN_CHANGELOG = list;
    window.XN_VERSION = v;
    setStep('record', 'ok');
    const chip = $('#verChip');
    if (chip) chip.textContent = 'v' + v;

    ticket.status = 'done';
    renderQueue();

    IT.result = {
      version: v,
      title: entry.title,
      fixes: entry.fixes,
      features: entry.features,
      notes: entry.notes,
      patches: plan.patches.map((p) => ({ file: p.file, lines: String(p.replace || '').split('\n').length })),
      verify: check.detail,
      run: plan.run || '',
      notTried: plan.notTried || '',
      publish: pub,
      files: Object.keys(files),
      changed: released.touched
    };
    renderResult();
    return { ok: true, result: IT.result };
  }

  async function start() {
    if (IT.running) return;
    if (!state.admin) { toast('先解锁管理模式'); return; }
    if (!state.key && state.cfg.tutor.baseUrl.charAt(0) !== '/') { toast('先配 Key'); return; }

    IT.running = true;
    IT.stopped = false;
    IT.queue = [];
    IT.log = [];
    IT.result = null;
    IT.stepState = {};
    IT.steps.forEach(([k]) => setStep(k, 'idle'));
    renderLog();
    renderQueue();
    renderResult();
    $('#itStop').hidden = false;
    setMeta('工作中');
    log('开始。版本 ' + (window.XN_VERSION || '?'));

    try {
      await loadSources();
      log('读到 ' + Object.keys(IT.sources).length + ' 个文件');
      const feedback = await gatherFeedback();
      log('反馈 ' + feedback.length + ' 条（本地 ' + (state.feedback || []).length + '）');

      setStep('triage', 'run');
      let tickets = await triage(feedback);
      setStep('triage', 'ok');
      log('拆出 ' + tickets.length + ' 条工单');

      if (!tickets.length) {
        setStep('critique', 'run');
        tickets = await selfCritique();
        setStep('critique', 'ok');
        log('自检得到 ' + tickets.length + ' 条');
      }
      if (!tickets.length) {
        setStep('grill', 'run');
        tickets = await grill();
        setStep('grill', 'ok');
        log('自问自答得到 ' + tickets.length + ' 条');
      }

      IT.queue = tickets;
      renderQueue();
      if (tickets.length) {
        if (!IT.stepState.critique || IT.stepState.critique === 'idle') setStep('critique', 'skip');
        if (!IT.stepState.grill || IT.stepState.grill === 'idle') setStep('grill', 'skip');
      }
      if (!tickets.length) {
        log('没有可做的事，收工。', 'warn');
        setMeta('无事可做');
        IT.running = false;
        $('#itStop').hidden = true;
        return;
      }

      const cycles = Number($('#itCycles').value) || 1;
      let done = 0;
      for (let i = 0; i < cycles; i++) {
        if (IT.stopped) break;
        const next = IT.queue.filter((t) => t.status === 'todo').sort((a, b) => b.severity - a.severity)[0];
        if (!next) break;
        next.status = 'doing';
        renderQueue();
        log(`第 ${i + 1} 轮：${next.title}`);
        const r = await runOne(next, feedback.length);
        if (!r.ok) { log('这一轮没过：' + r.reason, 'fail'); }
        else done++;
        await new Promise((res) => setTimeout(res, 300));
      }
      log(`收工：完成 ${done} 个版本。刷新页面才会用上新代码。`, 'ok');
      setMeta(done ? '完成 · v' + (window.XN_VERSION || '') : '没产出');
    } catch (e) {
      log('中断：' + (e.message || e), 'fail');
      setMeta('中断');
      toast('迭代中断：' + (e.message || ''));
    } finally {
      IT.running = false;
      $('#itStop').hidden = true;
    }
  }

  async function triageOnly() {
    if (IT.running) return;
    if (!state.admin) return;
    IT.running = true;
    IT.log = [];
    renderLog();
    setMeta('整理中');
    try {
      await loadSources();
      const feedback = await gatherFeedback();
      log('反馈 ' + feedback.length + ' 条');
      setStep('triage', 'run');
      const tickets = await triage(feedback);
      setStep('triage', 'ok');
      IT.queue = tickets;
      renderQueue();
      log('拆出 ' + tickets.length + ' 条工单', tickets.length ? 'ok' : 'warn');
      setMeta(tickets.length ? '待你点开始' : '没有可做的');
    } catch (e) {
      log('失败：' + (e.message || e), 'fail');
      setMeta('失败');
    } finally {
      IT.running = false;
    }
  }

  /* ---------- 渲染 ---------- */
  function renderQueue() {
    const box = $('#itQueue');
    if (!box) return;
    const meta = $('#itQueueMeta');
    if (meta) meta.textContent = IT.queue.length + ' 条';
    if (!IT.queue.length) {
      box.innerHTML = '<p class="it-empty">还没工单。点「只整理反馈」或「开始工作」。</p>';
      return;
    }
    box.innerHTML = IT.queue.map((t) => `
      <div class="it-ticket ${t.status}">
        <div class="it-ticket-top">
          <span class="it-kind ${t.kind}">${t.kind === 'bug' ? '缺陷' : t.kind === 'feature' ? '功能' : '内容'}</span>
          <strong>${esc(t.title)}</strong>
          <span class="it-sev">S${t.severity}</span>
        </div>
        ${t.why ? `<p>${esc(t.why)}</p>` : ''}
        <div class="it-ticket-foot"><span>${esc(t.scope || '—')}</span><span>${t.source === 'grill' ? '自问自答' : t.source === 'critique' ? '自检' : '反馈'}</span></div>
      </div>`).join('');
  }

  function renderResult() {
    const box = $('#itResult');
    if (!box) return;
    const meta = $('#itResultMeta');
    const r = IT.result;
    if (!r) {
      if (meta) meta.textContent = '还没跑过';
      box.innerHTML = '<p class="it-empty">跑一次「开始工作」，这里会出现版本号、改了哪些、验证过什么。</p>';
      $('#itResultBtns').hidden = true;
      return;
    }
    if (meta) meta.textContent = 'v' + r.version;
    const list = (arr) => (arr && arr.length ? arr.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="dim">无</li>');
    const pubText = r.publish.mode === 'pr'
      ? `<a href="${esc(r.publish.url)}" target="_blank" rel="noopener">PR #${r.publish.number}</a>${r.publish.merged ? '（已合并）' : '（等你合并）'}`
      : '草稿（没配发布通道，代码没提交，刷新即回到原版本）';
    box.innerHTML = `
      <div class="it-res-head"><strong>v${esc(r.version)}</strong><span>${esc(r.title)}</span></div>
      <div class="it-res-cols">
        <div><h4>修复</h4><ul>${list(r.fixes)}</ul></div>
        <div><h4>新增</h4><ul>${list(r.features)}</ul></div>
      </div>
      <dl class="it-res-meta">
        <dt>验证</dt><dd>${esc(r.verify)}</dd>
        <dt>发布</dt><dd>${pubText}</dd>
        <dt>改到的文件</dt><dd>${esc(r.changed.join('、'))}</dd>
        <dt>没验证</dt><dd>${esc(r.notTried || '—')}</dd>
      </dl>`;
    $('#itResultBtns').hidden = false;
    const link = $('#itPRLink');
    if (r.publish.mode === 'pr') { link.hidden = false; link.href = r.publish.url; }
    else link.hidden = true;
  }

  function downloadPatch() {
    const r = IT.result;
    if (!r) return;
    N.download(`xiaonuan-v${r.version}-patch.json`, JSON.stringify({
      version: r.version,
      title: r.title,
      fixes: r.fixes,
      features: r.features,
      verify: r.verify,
      notTried: r.notTried,
      files: r.files,
      publish: r.publish,
      note: '这是自动迭代产出的变更说明。没配发布通道时，代码改动没有自动提交。'
    }, null, 2));
  }

  /* ---------- 视图 ---------- */
  N.views = N.views || {};
  N.views.iterate = {
    init() {
      $('#itStart').addEventListener('click', start);
      $('#itStop').addEventListener('click', stop);
      $('#itTriage').addEventListener('click', triageOnly);
      $('#itDownload').addEventListener('click', downloadPatch);

      const p = state.cfg.publish || {};
      $('#pubOwner').value = p.owner || '';
      $('#pubRepo').value = p.repo || '';
      $('#pubAutoMerge').checked = !!p.autoMerge;
      try { $('#pubToken').value = sessionStorage.getItem(GH_TOKEN_KEY) || ''; } catch (e) {}

      $('#pubSave').addEventListener('click', () => {
        state.cfg.publish = {
          owner: $('#pubOwner').value.trim(),
          repo: $('#pubRepo').value.trim(),
          autoMerge: $('#pubAutoMerge').checked
        };
        try {
          const t = $('#pubToken').value.trim();
          if (t) sessionStorage.setItem(GH_TOKEN_KEY, t);
          else sessionStorage.removeItem(GH_TOKEN_KEY);
        } catch (e) {}
        N.saveConfig();
        renderPubState();
        toast('存下了');
      });
      $('#pubClear').addEventListener('click', () => {
        try { sessionStorage.removeItem(GH_TOKEN_KEY); } catch (e) {}
        $('#pubToken').value = '';
        renderPubState();
        toast('Token 已清掉');
      });

      renderPubState();
      renderQueue();
      renderResult();
      renderLog();
      IT.steps.forEach(([k]) => setStep(k, 'idle'));
    },

    onShow() {
      if (!state.admin) { N.switchView('settings'); return; }
      renderPubState();
      renderQueue();
      renderResult();
      renderLog();
      const chip = $('#verChip');
      if (chip) chip.textContent = 'v' + (window.XN_VERSION || '');
    }
  };

  function renderPubState() {
    const cfg = ghConfig();
    const el = $('#pubState');
    if (!el) return;
    el.textContent = cfg.token && cfg.owner && cfg.repo
      ? (cfg.autoMerge ? '已配置 · 自动合并' : '已配置 · 提 PR')
      : '未配置';
  }
})(window.XN);
