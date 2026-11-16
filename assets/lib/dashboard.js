/* 小暖 · 运行状态（v5.8 的仪表盘 + 快照同步，改成适合无服务器形态的版本）
 *
 * v5.8 是本地常驻程序，有 dashboard_server 和一个后台线程定时同步快照。
 * 网页版没有常驻进程，所以改成：
 *   - 在「设置」里挂一张状态卡：记忆库、主动引擎、上下文，一眼能看出它在想什么
 *   - 一个「导出快照」按钮：把记忆/会话/配置打包成 JSON 下载（相当于 v5.8 的快照）
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var mounted = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtAgo(ts) {
    if (!ts) return '从未';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function collect() {
    var mp = XN.memPlus;
    var mem = root.XN_MEM;
    var pro = XN.proactive;
    var ctx = XN.context;
    var st = XN.state || {};

    var stats = mp && mp.stageStats ? mp.stageStats() : { buffer: 0, active: 0, faded: 0, superseded: 0, deleted: 0 };
    var traits = mp && mp.activeTraits ? mp.activeTraits() : [];
    var follow = mp && mp.dueFollowups ? mp.dueFollowups() : [];
    var pCount = mp && mp.proactiveCountToday ? mp.proactiveCountToday() : 0;
    var pLast = mp && mp.lastProactiveAt ? mp.lastProactiveAt() : 0;
    var topic = ctx && ctx.lastTopic ? ctx.lastTopic() : '';

    var nextAllowed = '';
    if (pLast && pro && pro.MIN_GAP_HOURS) {
      var nextAt = pLast + pro.MIN_GAP_HOURS * 3600000;
      nextAllowed = nextAt > Date.now() ? fmtAgo(nextAt).replace('前', '后') : '随时可以';
    } else {
      nextAllowed = '随时可以';
    }

    return {
      stats: stats,
      traits: traits,
      follow: follow,
      pCount: pCount,
      pLast: pLast,
      nextAllowed: nextAllowed,
      topic: topic,
      sessions: (XN.session && XN.session.count) ? XN.session.count() : 0,
      turns: st.turnCount || 0,
      maxPerDay: pro && pro.MAX_PER_DAY ? pro.MAX_PER_DAY : 3
    };
  }

  function render() {
    var box = document.getElementById('xnStatusBody');
    if (!box) return;
    var d = collect();

    var rows = [
      ['记忆库', '长期 ' + d.stats.active + ' 条 · 已淡出 ' + d.stats.faded +
        ' · 被取代 ' + d.stats.superseded + ' · 待巩固 ' + d.stats.buffer],
      ['长出来的性格', d.traits.length ? d.traits.join('、') : '还在形成中'],
      ['到期该跟进', d.follow.length ? d.follow.map(function (f) { return f.topic; }).join('、') : '没有'],
      ['主动开口', '今天 ' + d.pCount + '/' + d.maxPerDay + ' 次 · 上次 ' + fmtAgo(d.pLast) + ' · 下次 ' + d.nextAllowed],
      ['当前话题', d.topic || '（没有）'],
      ['这次会话', d.turns + ' 轮 · 共 ' + d.sessions + ' 个会话']
    ];

    box.innerHTML = '<dl class="status-list">' + rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('') + '</dl>' +
      '<div class="status-actions">' +
      '<button type="button" class="btn sm" id="xnStatusRefresh">刷新</button>' +
      '<button type="button" class="btn sm" id="xnSnapshot">导出快照</button>' +
      '</div>' +
      '<p class="status-hint">快照含记忆、会话与配置（不含模型 Key），用于换设备时搬过去。</p>';

    var rf = document.getElementById('xnStatusRefresh');
    if (rf) rf.addEventListener('click', render);
    var sn = document.getElementById('xnSnapshot');
    if (sn) sn.addEventListener('click', exportSnapshot);
  }

  function exportSnapshot() {
    try {
      var snap = {
        v: 1,
        at: new Date().toISOString(),
        version: root.XN_VERSION || '',
        memory: (root.XN_MEM && root.XN_MEM.load) ? root.XN_MEM.load() : null,
        sessions: (XN.session && XN.session.list) ? XN.session.list() : [],
        config: (XN.state && XN.state.cfg) ? XN.state.cfg : null
      };
      /* 绝不把 Key 带出去 */
      if (snap.config && snap.config.tutor) delete snap.config.tutor.key;
      delete snap.config.apiKey;

      var text = JSON.stringify(snap, null, 2);
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'xiaonuan-snapshot-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
    } catch (e) {
      if (XN.util && XN.util.toast) XN.util.toast('导出失败：' + (e && e.message ? e.message : e));
    }
  }

  /** 往设置页挂一张「运行状态」卡（不动 index.html 结构，避免多端同步负担） */
  function mount() {
    if (mounted) return;
    var board = document.querySelector('#view-settings .board');
    if (!board) return;
    if (document.getElementById('xnStatusCard')) { mounted = true; return; }

    var card = document.createElement('article');
    card.className = 'card wide';
    card.id = 'xnStatusCard';
    card.innerHTML = '<header class="card-head"><h2>运行状态</h2>' +
      '<span class="card-meta">记忆 · 主动 · 上下文</span></header>' +
      '<div class="status-body" id="xnStatusBody"></div>';
    board.appendChild(card);
    mounted = true;
    render();
  }

  XN.dashboard = {
    mount: mount,
    render: render,
    collect: collect,
    exportSnapshot: exportSnapshot
  };

  /* 设置页可能在挂载后才渲染，这里两种时机都兜住 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 800); });
  } else {
    setTimeout(mount, 800);
  }
  if (XN.on) {
    XN.on('ready', function () { setTimeout(mount, 300); });
    XN.on('view:change', function (v) { if (v === 'settings') setTimeout(mount, 120); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
