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

  function modelArgs(mode) {
    var runtime = XN.models.runtime();
    if (mode === 'gateway') {
      if (!runtime.gatewayReady) return { error: '服务器没有下发本机网关地址（XN_GATEWAY_BASE）。' };
      var gk = state.gatewayKey || S.sessionGet('xn.v2.gatewayKey', '') || '';
      /* 本机 3425 网关在同一台机器上不需要钥匙；只有公网隧道才必须带。 */
      var localGateway = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(runtime.gatewayBase);
      if (!gk && !localGateway) return { error: '公网网关需要钥匙：先在设置里填一次。' };
      return {
        apiKey: gk,
        providerBase: runtime.gatewayBase,
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

    var pick = ($('#itModel') && $('#itModel').value) || 'gateway';
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
            : { mode: 'commit', url: data.url || '', commit: data.commit || '', branch: data.branch || 'main' }),
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
      return;
    }
    if (meta) meta.textContent = r.version ? 'v' + r.version : '未通过';
    var list = function (arr) {
      return (arr && arr.length ? arr.map(function (x) { return '<li>' + XN.esc(x) + '</li>'; }).join('') : '<li class="dim">无</li>');
    };
    var pubText = r.publish.mode === 'tag'
      ? '<a href="' + XN.esc(r.publish.url) + '" target="_blank" rel="noopener">tag ' + XN.esc(r.publish.tag) + '</a>（Actions 正在打 exe）'
      : r.publish.mode === 'commit'
        ? '<a href="' + XN.esc(r.publish.url) + '" target="_blank" rel="noopener">提交 ' + XN.esc(r.publish.commit || '') + '</a>（' + XN.esc(r.publish.branch || 'main') + '）'
        : r.publish.mode === 'local'
          ? '已写入本地' + (r.publish.backup ? '（备份：' + XN.esc(r.publish.backup) + '）' : '') + (r.publish.commit ? ' · ' + XN.esc(r.publish.commit) : '')
          : '未提交（试运行或草稿）';

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
        : r.publish.mode === 'commit' ? ('已提交到 ' + XN.esc(r.publish.branch || 'main') + '（' + XN.esc(r.publish.commit || '') + '）')
        : r.publish.mode === 'local' ? '已写入本地工作区'
        : '试运行，没有写仓库';
      vbox.innerHTML = '<div class="kv"><span>版本</span><b>' + transition + '</b></div>' +
        '<div class="kv"><span>更新日志首条</span><b>' + XN.esc(r.title || '—') + '</b></div>' +
        '<div class="kv"><span>去向</span><b>' + where + '</b></div>';
    }
    $('#itResultBtns').hidden = false;
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
      IT.steps.forEach(function (s) { setStep(s[0], 'idle'); });
      renderQueue();
      renderResult();
      renderLog();
    },

    onShow: function () {
      renderQueue();
      renderResult();
      renderLog();
      var runtime = XN.models.runtime();
      var opt = $('#itModel option[value="gateway"]');
      if (opt) {
        opt.disabled = !runtime.gatewayReady;
        opt.textContent = runtime.gatewayReady ? '自迭代模型（本机网关）' : '自迭代模型（服务器未配置）';
      }
    }
  };

  XN.IT.cloudRun = cloudRun;
})(window);
