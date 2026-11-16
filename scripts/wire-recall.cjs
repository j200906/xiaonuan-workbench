/* 接 memory-ext / proactive / recall_memory 工具 */
const fs = require('fs');
const root = process.argv[2];
let n = 0;

/* ---------- index.html ---------- */
let html = fs.readFileSync(root + '/index.html', 'utf8');
if (!html.includes('assets/lib/memory-ext.js')) {
  const anchor = '<script defer src="assets/lib/location.js" data-asset></script>';
  html = html.replace(anchor, anchor + '\n' +
    '<script defer src="assets/lib/memory-ext.js" data-asset></script>\n' +
    '<script defer src="assets/lib/proactive.js" data-asset></script>');
  fs.writeFileSync(root + '/index.html', html, 'utf8');
  n++;
}

/* ---------- tools.js：recall_memory 工具 ---------- */
let t = fs.readFileSync(root + '/assets/tools.js', 'utf8');

if (!t.includes("name: 'recall_memory'")) {
  const a = `    {
      type: 'function',
      function: {
        name: 'weather',`;
  if (t.includes(a)) {
    t = t.replace(a, `    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: '回查自己的长期记忆。上下文里显式记忆只展示前 20 条；出现「另有 N 条」时、用户问起以前提过的事但上下文没写全时、或想确认某条记忆是否还在，就调它。mode=expand 取全部显式记忆；mode=history 要 topic，查这个话题的记忆流水（含已淡出/被取代）；mode=stats 只看记忆库状态。',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['expand', 'history', 'stats'],
              description: 'expand=展开全部显式记忆（默认）；history=按 topic 查流水；stats=记忆库统计'
            },
            topic: {
              type: 'string',
              description: 'mode=history 时的检索关键词，尽量用记忆里的原词'
            }
          }
        }
      }
    },
` + a);
    n++;
  }
}

if (!t.includes('function toolRecall')) {
  const a2 = '  /* 天气：v5.8 的做法';
  if (t.includes(a2)) {
    t = t.replace(a2, `  /* 记忆回溯：上下文里塞不下的记忆，让模型自己来翻。
     没有这层，用户说「上次那个项目」，模型只能装不记得。 */
  function toolRecall(args) {
    var mp = root.XN && XN.memPlus;
    var m = root.XN_MEM;
    if (!mp || !m) return { ok: false, text: '记忆库还没就绪，暂时查不到。' };

    var mode = String((args && args.mode) || 'expand').toLowerCase();

    try {
      if (mode === 'history') {
        var topic = String((args && args.topic) || '').trim();
        if (!topic) return { ok: false, text: '查历史需要给出 topic（记忆里的关键词）。' };
        var rows = mp.history(topic);
        if (!rows.length) return { ok: true, text: '没有找到包含「' + topic + '」的记忆。' };
        var out = ['【「' + topic + '」的记忆流水】'];
        rows.slice(0, 20).forEach(function (r) {
          var when = r.from ? new Date(r.from).toISOString().slice(0, 10) : '?';
          out.push('- ' + r.content + '（状态 ' + r.status + '，' + when + ' 起）');
        });
        return { ok: true, text: out.join('\\n') };
      }

      if (mode === 'stats') {
        var st = mp.stageStats();
        return {
          ok: true,
          text: '【记忆库状态】待巩固 ' + (st.buffer || 0) + ' 条；长期 active ' + (st.active || 0) +
            ' / faded ' + (st.faded || 0) + ' / superseded ' + (st.superseded || 0) + ' / deleted ' + (st.deleted || 0)
        };
      }

      var all = (m.getActiveMemories ? m.getActiveMemories() : null) || {};
      var items = all.explicit || [];
      if (!items.length) return { ok: true, text: '当前没有需要展开的显式记忆。' };
      return { ok: true, text: '【全部显式记忆（共 ' + items.length + ' 条）】\\n' + items.map(function (c) { return '- ' + c; }).join('\\n') };
    } catch (e) {
      return { ok: false, text: '查询记忆出错：' + (e && e.message ? e.message : e) };
    }
  }

  /* 天气：v5.8 的做法`);
    n++;
  }
}

if (!t.includes("name === 'recall_memory'")) {
  t = t.replace(
    `      if (name === 'weather') return await toolWeather(a);`,
    `      if (name === 'recall_memory') return toolRecall(a);
      if (name === 'weather') return await toolWeather(a);`
  );
  n++;
}

fs.writeFileSync(root + '/assets/tools.js', t, 'utf8');
console.log('接入改动 ' + n + ' 处');
