/* 小暖 · 自迭代界面
 * 真正的改代码发生在云端 /api/iterate（或本地后端），浏览器只负责发起、显示、下载结果。
 * 这样不会出现"浏览器一套、云端一套"的行为分裂，也不会把 GitHub Token 留在页面里。 */
(function (root) {
  'use strict';

  var XN = root.XN;
  var $ = XN.$;
  var state = XN.state, API = XN.api, S = XN.store;

  /* GitHub Token 只在服务端（XN_GH_TOKEN）：浏览器不持有、不落 DOM、也不落存储。 */

  var IT = {
    running: false,
    stopped: false,
    abort: null,
    queue: [],
    log: [],
    result: null,
    modelTouched: false,
    steps: [
      ['triage', '整理反馈'],
      ['plan', '出方案'],
      ['verify', '校验'],
      ['publish', '提交'],
      ['release', '发版'],
      ['record', '记账']
    ],
    stepState: {}
  };
  XN.IT = IT;

  function log(msg, kind) {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    IT.log.push({ t: hh, msg: String(msg), kind: kind || '' });
    renderLog();
  }

  function renderLog() {
    var el = $('#itLog');
    if (!el) return;
    el.innerHTML = IT.log.map(function (l) {
      return '<span class="it-line ' + l.kind + '"><span class="it-time">' + l.t + '</span>' + XN.esc(l.msg) + '</span>';
    }).join('');
    el.scrollTop = el.scrollHeight;
    var meta = $('#itLogMeta');
    if (meta) meta.textContent = IT.log.length ? IT.log.length + ' 行' : '—';
  }

  function setStep(key, status) {
    IT.stepState[key] = status;
    var box = $('#itSteps');
    if (!box) return;
    box.innerHTML = IT.steps.map(function (s) {
      var st = IT.stepState[s[0]] || 'idle';
      return '<span class="it-step ' + st + '" data-step="' + s[0] + '"><i></i>' + XN.esc(s[1]) + '</span>';
    }).join('');
  }

  function setMeta(text) {
    var el = $('#itMeta');
    if (el) el.textContent = text;
  }

  /* 网关到底能不能真用：服务器下发了地址，并且（本地回环 或 已经填过钥匙）。
     线上 config 里可能下发一个早就失效的隧道地址，所以只看 gatewayReady 不够。 */
  function gatewayStatus() {
    var runtime = XN.models.runtime();
    var base = String(runtime.gatewayBase || '');
    var ready = !!runtime.gatewayReady && !!base;
    /* 本机 3425 网关在同一台机器上不需要钥匙；只有公网隧道才必须带。 */
    var local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(base);
    var key = state.gatewayKey || S.sessionGet('xn.v2.gatewayKey', '') || '';
    return {
      ready: ready,
      base: base,
      local: local,
      key: key,
      usable: ready && (local || !!key)
    };
  }

  function modelArgs(mode) {
    var runtime = XN.models.runtime();
    if (mode === 'gateway') {
      var g = gatewayStatus();
      if (!g.ready) return { error: '服务器没有下发本机网关地址（XN_GATEWAY_BASE）。' };
      if (!g.local && !g.key) return { error: '公网网关需要钥匙：先在设置里填一次。' };
      return {
        apiKey: g.key,
        providerBase: g.base,
        model: runtime.gatewayModel || '',
        gateway: true
      };
    }
    var model = state.cfg.tutor.model || '';
    if (!model || XN.models.isCloud(model)) return {};
    var prov = state.cfg.tutor.provider || {};
    var base = prov.base || state.cfg.tutor.baseUrl || '';
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i.test(base)) {
      return { error: '你选的是本机地址，Cloudflare 访问不到你的电脑。请换公网 API，或在设置里选「自迭代模型（本机网关）」。' };
    }
    return { apiKey: state.key || '', providerBase: base, model: model };
  }

  /* GitHub 提交链接：真跑响应里有 commit 才给链接；试跑没有就不给。 */
  function repoSlug() {
    var r = state.cloudRepo || {};
    return (r.owner && r.name) ? (r.owner + '/' + r.name) : '';
  }

  function commitUrl(sha) {
    var slug = repoSlug();
    if (!slug || !sha) return '';
    return 'https://github.com/' + slug + '/commit/' + encodeURIComponent(sha);
  }

  /* ---------- 一键合并试跑分支 ---------- */
  /* 试跑分支（iterate/xxx）跑完只能手动去 GitHub 建 PR。这里补一个「合并到 main」按钮：
   *   1) 先读 GitHub compare（main...branch），没差异直接拦掉，顺便拿改动文件；
   *   2) 再建 PR（标题带版本号，body 写标题 + 改了哪些文件 + 验证结果）；
   *   3) 成功/失败都 toast，并在结果区留下 PR 链接或 GitHub 原文错误。
   *
   * 为什么先走「浏览器直连 GitHub」：worker 还没有 POST /api/merge-iterate，而本轮只允许改
   * 这个文件。等 worker 加了那个接口（用服务端 XN_GH_TOKEN 调 GitHub），把下面 ghApi() 的
   * fetch 换成 fetch('api/merge-iterate', {...}) 即可，compare 预检/建 PR/回显链接都不用动，
   * 浏览器也就不再需要 token 了。服务端已有 XN_GH_TOKEN 时这里会先试一次那个接口，
   * 404/405/501 再退回浏览器直连。
   *
   * Token 策略：只放 sessionStorage（关掉标签页即清空），不写 localStorage、不进 DOM、不打进日志。 */

  var MERGE = { busy: false, link: '', note: '', error: '', tokenKey: 'xn.v2.ghToken' };

  function mergeTarget(r) {
    if (!r || !r.publish) return null;
    var branch = String((r.publish && r.publish.branch) || r.branch || '').trim();
    var commit = String((r.publish && r.publish.commit) || r.commit || '').trim();
    if (!branch || !commit || branch === 'main') return null;
    return { branch: branch, commit: commit };
  }

  function ensureMergeUI() {
    var btns = $('#itResultBtns');
    if (!btns) return null;
    var btn = $('#itMergeBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'itMergeBtn';
      btn.className = 'btn sm';
      btn.hidden = true;
      btn.textContent = '合并到 main';
      btn.addEventListener('click', mergeToMain);
      var pr = $('#itPRLink');
      btns.insertBefore(btn, pr && pr.parentNode === btns ? pr : null);
    }
    var note = $('#itMergeNote');
    if (!note) {
      note = document.createElement('p');
      note.id = 'itMergeNote';
      note.className = 'dim';
      note.hidden = true;
      note.style.marginTop = '6px';
      btns.parentNode.insertBefore(note, btns.nextSibling);
    }
    return btn;
  }

  function updateMergeUI() {
    var btn = ensureMergeUI();
    if (!btn) return;
    var target = mergeTarget(IT.result);
    btn.hidden = !target;
    btn.disabled = !target || MERGE.busy;
    btn.textContent = MERGE.busy ? '合并中…' : '合并到 main';
    var note = $('#itMergeNote');
    if (!note) return;
    var html = '';
    if (MERGE.link) {
      html += 'PR：<a href="' + XN.esc(MERGE.link) + '" target="_blank" rel="noopener noreferrer">' + XN.esc(MERGE.link) + '</a>';
    }
    if (MERGE.note) html += (html ? '<br>' : '') + XN.esc(MERGE.note);
    if (MERGE.error) html += (html ? '<br>' : '') + '<span class="it-line fail">' + XN.esc(MERGE.error) + '</span>';
    note.innerHTML = html;
    note.hidden = !html;
  }

  function ghError(res) {
    var d = (res && res.data) || {};
    var msg = d.message || ('HTTP ' + (res && res.status));
    if (d.errors && d.errors.length) {
      var extra = d.errors.map(function (e) { return e.message || e.code || ''; }).filter(Boolean);
      if (extra.length) msg += '：' + extra.join('；');
    }
    return msg;
  }

  async function ghApi(method, path, token, payload) {
    var res = await fetch('https://api.github.com' + path, {
      method: method,
      headers: Object.assign({
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28'
      }, payload ? { 'Content-Type': 'application/json' } : {}),
      body: payload ? JSON.stringify(payload) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  function mergeToken() {
    var t = S.sessionGet(MERGE.tokenKey, '') || '';
    if (t) return t;
    var ask = typeof root.prompt === 'function' ? root.prompt.bind(root) : function () { return ''; };
    var input = ask('建 PR 需要一个有 repo 权限的 GitHub Token。\n只留在本标签页（sessionStorage），关掉页面就清空。');
    t = String(input || '').trim();
    if (t) S.sessionSet(MERGE.tokenKey, t);
    return t;
  }

  function prBody(r, target, files) {
    var lines = [];
    lines.push('自动迭代结果' + (r.version ? '：v' + r.version : '') + (r.title ? '「' + r.title + '」' : ''));
    lines.push('');
    lines.push('改了 ' + files.length + ' 个文件：');
    if (files.length) files.forEach(function (f) { lines.push('- ' + f); });
    else lines.push('- （compare 没有返回文件列表，以 diff 为准）');
    lines.push('');
    lines.push('验证：' + (r.verify || '—'));
    lines.push('来源分支：' + target.branch + ' @ ' + target.commit);
    lines.push('');
    lines.push('（由小暖迭代页「合并到 main」生成）');
    return lines.join('\n');
  }

  async function mergeToMain() {
    if (MERGE.busy) return;
    var r = IT.result;
    var target = mergeTarget(r);
    if (!target) return;
    var slug = repoSlug();
    if (!slug) { XN.toast('还不知道发布仓库，先跑一次迭代'); return; }

    MERGE.busy = true;
    MERGE.link = '';
    MERGE.note = '';
    MERGE.error = '';
    updateMergeUI();
    log('准备合并 ' + target.branch + ' → main（' + target.commit + '）');

    try {
      /* 服务端有 XN_GH_TOKEN 时优先让服务端做；worker 还没这个接口就退到浏览器直连。 */
      if ((state.cloudRepo || {}).serverToken) {
        var srv = await fetch('api/merge-iterate', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, XN.adminToken() ? { 'X-Admin-Token': XN.adminToken() } : {}),
          body: JSON.stringify({
            base: 'main', branch: target.branch, commit: target.commit,
            version: r.version || '', title: r.title || '', files: r.changed || []
          }),
          credentials: 'same-origin'
        });
        if (srv.status !== 404 && srv.status !== 405 && srv.status !== 501) {
          var srvData = null;
          try { srvData = await srv.json(); } catch (e) {}
          if (srv.ok && srvData && srvData.url) {
            MERGE.link = srvData.url;
            MERGE.note = '由服务端创建 PR（' + target.branch + ' → main）';
            XN.toast('PR 已建，链接在结果区');
            log('服务端已建 PR：' + srvData.url, 'ok');
            return;
          }
          throw new Error((srvData && (srvData.error || srvData.message)) || ('服务端合并失败：HTTP ' + srv.status));
        }
        log('服务端还没有 /api/merge-iterate（HTTP ' + srv.status + '），改用浏览器直连 GitHub', 'warn');
      }

      var token = mergeToken();
      if (!token) {
        MERGE.note = '没有提供 GitHub Token，合并已取消';
        XN.toast('没有 GitHub Token，合并取消');
        return;
      }

      /* 1) compare 预检：identical 说明没东西可合；顺便把改动文件拿来写进 PR body。
         注意：compare 的 {basehead} 是整段路径，分支里的 "/" 不能转成 %2F（实测 GitHub 会 404），
         直接拼 raw 分支名；这里的分支来自服务端响应（iterate/xxx），不含空格和问号。 */
      var cmp = await ghApi('GET', '/repos/' + slug + '/compare/main...' + target.branch, token);
      if (!cmp.ok) throw new Error(ghError(cmp));
      var commits = (cmp.data && cmp.data.commits) || [];
      var files = ((cmp.data && cmp.data.files) || []).map(function (f) { return f.filename; });
      if ((cmp.data && cmp.data.status) === 'identical' || !commits.length) {
        throw new Error('main 与 ' + target.branch + ' 没有差异，不用合并');
      }
      log('compare 预检通过：' + commits.length + ' 个提交 / ' + files.length + ' 个文件（status=' + ((cmp.data && cmp.data.status) || '?') + '）', 'ok');

      /* 2) 建 PR：标题带版本号，body 写标题 + 改了哪些文件 + 验证。 */
      var title = '合并 ' + target.branch + ' → main' + (r.version ? '（v' + r.version + '）' : '');
      var pr = await ghApi('POST', '/repos/' + slug + '/pulls', token, {
        title: title,
        head: target.branch,
        base: 'main',
        body: prBody(r, target, files)
      });

      if (pr.ok && pr.data && pr.data.html_url) {
        MERGE.link = pr.data.html_url;
        MERGE.note = 'PR #' + pr.data.number + '：' + target.branch + ' → main';
        XN.toast('PR 已建，链接在结果区');
        log('PR 已建：' + pr.data.html_url, 'ok');
      } else if (pr.status === 422 && /already exists/i.test(ghError(pr))) {
        /* GitHub 对同 head/base 已存在 PR 会回 422；这种情况把已有 PR 找回来给用户。 */
        var head = slug.split('/')[0] + ':' + target.branch;
        var exist = await ghApi('GET', '/repos/' + slug + '/pulls?state=open&base=main&head=' + encodeURIComponent(head), token);
        var found = exist.ok && exist.data && exist.data[0];
        if (!found) throw new Error(ghError(pr));
        MERGE.link = found.html_url;
        MERGE.note = 'PR 已存在（#' + found.number + '）：' + target.branch + ' → main';
        XN.toast('这个分支已经有 PR 了，链接在结果区');
        log('PR 已存在：' + found.html_url, 'ok');
      } else {
        throw new Error(ghError(pr));
      }
    } catch (e) {
      MERGE.error = String((e && e.message) || e);
      XN.toast('合并失败：' + MERGE.error);
      log('合并失败：' + MERGE.error, 'fail');
    } finally {
      MERGE.busy = false;
      updateMergeUI();
    }
  }

  /* 默认模型：网关确实可用才把 gateway 当默认，否则回落到「跟随模型条」。 */
  function applyModelDefault(force) {
    var sel = $('#itModel');
    if (!sel) return;
    var g = gatewayStatus();
    var opt = sel.querySelector('option[value="gateway"]');
    if (opt) {
      opt.disabled = !g.usable;
      opt.textContent = g.usable
        ? '自迭代模型（本机网关）'
        : (g.ready ? '自迭代模型（需要钥匙）' : '自迭代模型（服务器未配置）');
    }
    if (g.usable) {
      if (force) sel.value = 'gateway';
    } else {
      sel.value = 'follow';
    }
    var meta = $('#itModelMeta');
    if (meta) meta.textContent = sel.value === 'gateway' ? '自迭代模型' : '跟随模型条';
  }

  function effortArg() {
    var el = $('#itReason');
    var v = el ? String(el.value || '') : '';
    return ['low', 'medium', 'high', 'max'].indexOf(v) >= 0 ? v : 'max';
  }

  /* 服务端有 XN_GH_TOKEN 就够；前端不再收 token。 */

  function lockGuard() {
    /* 迭代界面不再要求先输密码：没解锁时服务端会把它落到试跑分支，不碰 main。 */
    if (!API.isProxy()) { XN.toast('自迭代需要云端或本地后端'); return false; }
    var lock = state.cloudRepo || {};
    if (!lock.locked) { XN.toast('服务器没有锁定发布仓库'); return false; }
    return true;
  }

  async function cloudRun(dryRun, triageOnly) {
    if (IT.running) return;
    if (!lockGuard()) return;

    /* 默认跟随模型条：网关不可用时不再默认选它（线上那台隧道早就失效了）。 */
    var pick = ($('#itModel') && $('#itModel').value) || 'follow';
    var args = modelArgs(pick);
    if (args.error) { XN.toast(args.error); return; }

    if (!dryRun && !(state.cloudRepo || {}).serverToken) {
      XN.toast('服务器没配 GitHub Token，没法提交改动');
      return;
    }

    IT.running = true;
    IT.stopped = false;
    IT.log = [];
    IT.result = null;
    IT.stepState = {};
    IT.steps.forEach(function (s) { setStep(s[0], 'idle'); });
    MERGE.link = '';
    MERGE.note = '';
    MERGE.error = '';
    renderLog();
    renderResult();
    setMeta(dryRun ? '试运行' : '云端跑');
    $('#itStop').hidden = false;
    $('#itStart').disabled = true;
    $('#itTriage').disabled = true;

    var ctrl = new AbortController();
    IT.abort = ctrl;
    setStep('triage', 'run');
    log(state.localMode ? '本地工作区：改完直接写文件，不需要 GitHub Token' : ('发布仓库锁定为 ' + state.cloudRepo.owner + '/' + state.cloudRepo.name));
    log('模型：' + (pick === 'gateway' ? '自迭代模型（本机网关）' : ('跟随模型条 · ' + (state.cfg.tutor.model || '默认'))));

    try {
      var res = await fetch('api/iterate', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, XN.adminToken() ? { 'X-Admin-Token': XN.adminToken() } : {}),
        body: JSON.stringify(Object.assign({
          dryRun: !!dryRun,
          triageOnly: !!triageOnly,
          reasoningEffort: effortArg()
        }, args)),
        signal: ctrl.signal,
        credentials: 'same-origin'
      });

      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.status === 401) { throw new Error('服务器拒绝了这次迭代（401）。'); }
      if (!data) throw new Error('服务器返回了空响应（HTTP ' + res.status + '）');

      if (data.publicMode && data.branch) {
        log('公开模式：改动只会提交到 ' + data.branch + ' 分支，确认没问题再合并到 main', 'ok');
      }
      (data.log || []).forEach(function (line) { log(line); });

      if (data.tickets) {
        IT.queue = data.tickets.map(function (x) {
          return {
            id: XN.uid('t'), title: x.title || '未命名', kind: x.kind || 'feature',
            severity: x.severity || 2, why: x.why || '', scope: x.scope || '',
            source: x.source || 'feedback', status: 'todo'
          };
        });
        renderQueue();
      }

      if (!data.ok) {
        setStep('plan', 'fail');
        if (data.attempt) {
          log('这一版想改：' + (data.attempt.title || '—'), 'warn');
          (data.attempt.patches || []).forEach(function (p, i) {
            log('  补丁 ' + (i + 1) + '：' + p.file, 'warn');
          });
          IT.result = {
            version: '', title: data.attempt.title || '', fixes: [], features: [],
            verify: '', publish: { mode: 'draft' }, changed: [],
            notTried: data.error || '', attempt: data.attempt
          };
          renderResult();
        }
        throw new Error(data.error || ('HTTP ' + res.status));
      }

      setStep('triage', 'ok');
      setStep('plan', 'ok');
      setStep('verify', 'ok');
      if (triageOnly) {
        setStep('publish', 'skip');
        setStep('release', 'skip');
        setStep('record', 'skip');
        setMeta('已整理 ' + (IT.queue.length || 0) + ' 条');
        log('只整理反馈：' + (IT.queue.length || 0) + ' 条工单', 'ok');
        return;
      }
      if (dryRun) {
        setStep('publish', 'skip');
        setStep('release', 'skip');
        setStep('record', 'skip');
      } else {
        setStep('publish', data.commits ? 'ok' : 'skip');
        setStep('release', data.tag ? 'ok' : 'skip');
        setStep('record', 'ok');
      }

      IT.result = {
        version: data.version || '',
        from: data.from || '',
        effort: data.effort || '',
        title: data.title || '',
        fixes: data.fixes || [],
        features: data.features || [],
        verify: data.verify || '',
        run: data.run || '',
        notTried: data.notTried || '',
        skipped: data.skipped || [],
        publicMode: !!data.publicMode,
        publish: state.localMode
          ? { mode: 'local', backup: data.backup || '', commit: data.commit || '' }
          : (data.tag
            ? { mode: 'tag', tag: data.tag, url: data.releaseUrl || ('https://github.com/' + state.cloudRepo.owner + '/' + state.cloudRepo.name + '/releases/tag/' + data.tag) }
            : (data.commit || data.url)
              ? {
                mode: 'commit',
                url: data.url || commitUrl(data.commit),
                commit: data.commit || '',
                branch: data.branch || 'main'
              }
              : { mode: 'dry' }),
        changed: data.files || [],
        attempt: data.attempt || null
      };
      renderResult();
      setMeta(dryRun ? ('方案 v' + IT.result.version) : ('完成 · v' + IT.result.version));
      log(dryRun ? '试运行完成，没有提交。' : '完成：v' + IT.result.version, 'ok');

      if (data.planCacheKey) log('这次方案已缓存 10 分钟，重复点「试运行」不会重复烧 token。');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        log('已停止等待。云端可能仍在跑完这一轮。', 'warn');
        setMeta('已停止');
      } else {
        log('没成：' + (e.message || e), 'fail');
        setMeta('失败');
      }
    } finally {
      IT.running = false;
      IT.abort = null;
      $('#itStop').hidden = true;
      $('#itStart').disabled = false;
      $('#itTriage').disabled = false;
    }
  }

  function stop() {
    IT.stopped = true;
    if (IT.abort) IT.abort.abort();
    setMeta('正在停止等待');
  }

  async function triageOnly() {
    return cloudRun(true, true);
  }

  function renderQueue() {
    var box = $('#itQueue');
    if (!box) return;
    var meta = $('#itQueueMeta');
    if (meta) meta.textContent = IT.queue.length + ' 条';
    if (!IT.queue.length) {
      box.innerHTML = '<p class="it-empty">还没工单。点「只整理反馈」或「开始工作」。</p>';
      return;
    }
    box.innerHTML = IT.queue.map(function (x) {
      return '<div class="it-ticket ' + x.status + '">' +
        '<div class="it-ticket-top"><span class="it-kind ' + x.kind + '">' +
        (x.kind === 'bug' ? '缺陷' : x.kind === 'feature' ? '功能' : '内容') + '</span>' +
        '<strong>' + XN.esc(x.title) + '</strong><span class="it-sev">S' + x.severity + '</span></div>' +
        (x.why ? '<p>' + XN.esc(x.why) + '</p>' : '') +
        '<div class="it-ticket-foot"><span>' + XN.esc(x.scope || '—') + '</span><span>' +
        (x.source === 'grill' ? '自问自答' : x.source === 'critique' ? '自检' : '反馈') + '</span></div></div>';
    }).join('');
  }

  function renderResult() {
    var box = $('#itResult');
    if (!box) return;
    var meta = $('#itResultMeta');
    var r = IT.result;
    if (!r) {
      if (meta) meta.textContent = '还没跑过';
      box.innerHTML = '<p class="it-empty">跑一次「开始工作」，这里会出现版本号、改了哪些、验证过什么。</p>';
      $('#itResultBtns').hidden = true;
      updateMergeUI();
      return;
    }
    if (meta) meta.textContent = r.version ? 'v' + r.version : '未通过';
    var list = function (arr) {
      return (arr && arr.length ? arr.map(function (x) { return '<li>' + XN.esc(x) + '</li>'; }).join('') : '<li class="dim">无</li>');
    };
    /* 真跑才有 commit：优先用服务端给的 url，否则按 owner/repo + sha 现拼一个。 */
    var commitHref = r.publish.url || commitUrl(r.publish.commit);
    var pubText = r.publish.mode === 'tag'
      ? '<a href="' + XN.esc(r.publish.url) + '" target="_blank" rel="noopener noreferrer">tag ' + XN.esc(r.publish.tag) + '</a>（Actions 正在打 exe）'
      : r.publish.mode === 'commit'
        ? (commitHref
          ? '<a href="' + XN.esc(commitHref) + '" target="_blank" rel="noopener noreferrer">提交 ' + XN.esc(r.publish.commit || '') + '</a>（' + XN.esc(r.publish.branch || 'main') + '）'
          : '已提交到 ' + XN.esc(r.publish.branch || 'main') + (r.publish.commit ? '（' + XN.esc(r.publish.commit) + '）' : ''))
        : r.publish.mode === 'local'
          ? '已写入本地' + (r.publish.backup ? '（备份：' + XN.esc(r.publish.backup) + '）' : '') + (r.publish.commit ? ' · ' + XN.esc(r.publish.commit) : '')
          : r.publish.mode === 'draft'
            ? '未提交（草稿）'
            : '试运行，未提交';

    var transition = (r.from && r.version && r.from !== r.version)
      ? 'v' + XN.esc(r.from) + ' → v' + XN.esc(r.version)
      : (r.version ? 'v' + XN.esc(r.version) : '这一版');
    var effortText = r.effort ? ({ low: '低', medium: '中', high: '高', max: '最高' })[r.effort] || r.effort : '—';

    box.innerHTML = '<div class="it-res-head"><strong>' + transition + '</strong>' +
      '<span>' + XN.esc(r.title || '') + '</span><span class="it-mode">' + (r.publicMode ? '公开模式' : '云端') + '</span></div>' +
      '<div class="it-res-cols"><div><h4>修复</h4><ul>' + list(r.fixes) + '</ul></div>' +
      '<div><h4>新增</h4><ul>' + list(r.features) + '</ul></div></div>' +
      '<dl class="it-res-meta">' +
      '<dt>思考强度</dt><dd>' + XN.esc(effortText) + '</dd>' +
      '<dt>验证</dt><dd>' + XN.esc(r.verify || '—') + '</dd>' +
      '<dt>发布</dt><dd>' + pubText + '</dd>' +
      '<dt>改到的文件</dt><dd>' + XN.esc((r.changed || []).join('、') || '—') + '</dd>' +
      '<dt>没验证</dt><dd>' + XN.esc(r.notTried || '—') + '</dd>' +
      (r.skipped && r.skipped.length ? '<dt>跳过的补丁</dt><dd>' + XN.esc(r.skipped.map(function (s) { return '#' + s.index + ' ' + s.reason; }).join('；')) + '</dd>' : '') +
      (r.attempt ? ('<dt>失败时想改</dt><dd>' + XN.esc(r.attempt.title || '—') + (r.attempt.files && r.attempt.files.length ? ' · 补丁文件：' + XN.esc(r.attempt.files.join('、')) : '') + (r.attempt.reason ? ' · 原因：' + XN.esc(r.attempt.reason) : '') + '</dd>') : '') +
      '</dl>';

    var vbox = $('#itVersion');
    if (vbox) {
      var vmeta = $('#itVersionMeta');
      if (vmeta) vmeta.textContent = r.version ? ('v' + r.version) : '—';
      var where = r.publish.mode === 'tag' ? ('tag v' + XN.esc(r.publish.tag) + '，Actions 会打包 exe')
        : r.publish.mode === 'commit' ? ('已提交到 ' + XN.esc(r.publish.branch || 'main') + ' · ' +
          (commitHref
            ? '<a href="' + XN.esc(commitHref) + '" target="_blank" rel="noopener noreferrer">' + XN.esc(r.publish.commit || '打开提交') + '</a>'
            : XN.esc(r.publish.commit || '')))
        : r.publish.mode === 'local' ? '已写入本地工作区'
        : r.publish.mode === 'draft' ? '未提交（草稿）'
        : '试运行，未提交';
      vbox.innerHTML = '<div class="kv"><span>版本</span><b>' + transition + '</b></div>' +
        '<div class="kv"><span>更新日志首条</span><b>' + XN.esc(r.title || '—') + '</b></div>' +
        '<div class="kv"><span>去向</span><b>' + where + '</b></div>';
    }
    $('#itResultBtns').hidden = false;
    updateMergeUI();
    var link = $('#itPRLink');
    link.hidden = r.publish.mode !== 'tag';
    if (r.publish.mode === 'tag') link.href = r.publish.url;
  }

  function downloadPatch() {
    var r = IT.result;
    if (!r) return;
    XN.download('xiaonuan-v' + (r.version || 'draft') + '-patch.json', JSON.stringify({
      version: r.version,
      title: r.title,
      fixes: r.fixes,
      features: r.features,
      verify: r.verify,
      run: r.run,
      notTried: r.notTried,
      changed: r.changed,
      publish: r.publish,
      attempt: r.attempt || null,
      note: '自动迭代产出的变更说明与结果。'
    }, null, 2));
  }

  XN.views = XN.views || {};
  XN.views.iterate = {
    init: function () {
      $('#itStart').addEventListener('click', function () { cloudRun(false, false); });
      $('#itStop').addEventListener('click', stop);
      $('#itTriage').addEventListener('click', triageOnly);
      $('#itDownload').addEventListener('click', downloadPatch);
      var sel = $('#itModel');
      if (sel) {
        sel.addEventListener('change', function () {
          IT.modelTouched = true;
          applyModelDefault(false);
        });
      }
      /* 停止只是停止「等待」：请求已发出，服务端那一轮可能仍会跑完。 */
      var stopBtn = $('#itStop');
      if (stopBtn) {
        stopBtn.textContent = '停止等待';
        stopBtn.title = '只停止这里的等待：服务端那一轮可能仍会跑完。';
        stopBtn.setAttribute('aria-label', '停止等待（服务端可能仍在跑完这一轮）');
      }
      applyModelDefault(true);
      IT.steps.forEach(function (s) { setStep(s[0], 'idle'); });
      ensureMergeUI();
      renderQueue();
      renderResult();
      renderLog();
    },

    onShow: function () {
      renderQueue();
      renderResult();
      renderLog();
      /* 用户自己改过就不再覆盖；否则按「网关真能用才默认 gateway」重算一次。 */
      applyModelDefault(!IT.modelTouched);
    }
  };

  XN.IT.cloudRun = cloudRun;
  XN.IT.mergeToMain = mergeToMain;
})(window);
