/*
 * 小暖 · 工具调用模块（纯浏览器 / 无依赖 / ES5 风格，仅用 async-await）
 * ---------------------------------------------------------------------------
 * 设计意图：
 *   模型本身没有联网能力，问「今天几号」「最近有什么新闻」「这个库最新版本」
 *   这类问题时只能编。本模块给聊天前端补上三件事——联网搜索、抓网页、取本地时间，
 *   并把它包装成两种「对话推进方式」，供上层按服务商能力挑选：
 *
 *   路线 A（支持 tools）：走 `loop()`。
 *     模型在 OpenAI 兼容协议里可以直接返回 tool_calls，我们执行完把结果以
 *     role:'tool' 消息回填，再让它接着推理。模型自己决定搜不搜、搜什么，
 *     可以连续多轮（最多 maxRounds 轮），信息准确率最高。
 *
 *   路线 B（不支持 tools）：走 `loopWithFallback()`。
 *     先按路线 A 试一次；若第一轮 chat 既不给 toolCalls 又没输出内容（说明服务商
 *     直接忽略了 tools 参数）、或者干脆抛错，就退化成「关键词猜测」：
 *     用一张关键词表判断用户这句话需不需要实时信息，需要就先本地调 web_search，
 *     把结果拼成一条 system 消息塞进 messages，再用普通对话走一遍。
 *     代价是判断粗糙（模型没参与决策），好处是任何服务商都能用。
 *
 *   两条路的共同点：工具永远只在浏览器里执行，模型只看到纯文本摘要
 *   （搜索结果最多 5 条、网页正文最多 3500 字），避免把超长内容塞回上下文。
 */
window.XN_TOOLS = (function () {
  'use strict';

  /* 搜索结果最多回填几条，网页正文最多回填多少字。
     3500 字对长文问答太短，关键段落经常刚好在截断线后面；提到 12000。 */
  var SEARCH_LIMIT = 5;
  var FETCH_LIMIT = 12000;
  /* 续读提示统一成一句：还剩多少字、下次用哪个 offset。 */
  function cutHint(rest, nextOffset) {
    return '\n…（已截断：还剩 ' + rest + ' 字，可用 offset=' + nextOffset + ' 继续读）';
  }

  /* 不支持 tools 时用于猜测「这句话要不要联网」的关键词表 */
  var AUTO_KEYWORDS = [
    '今天', '现在', '几号', '新闻', '天气',
    '最新', '多少钱', '谁是', '怎么样', '查一下', '搜一下'
  ];

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------------- 通用小工具 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* 工具描述：给模型的说明书，决定它什么时候会来调 */
  var specs = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索。用于查实时信息：新闻、天气、今天几号、最新版本号、你不确定或可能过时的事实。不要用它来查聊天里已经给出的内容。返回的每条结果都带来源（DuckDuckGo / 维基百科）；回答时请把来源一起说清楚，不要笼统地说「网上说」。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，尽量具体，例如「上海 今天 天气」「Node.js 最新 LTS 版本」'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_page',
        description: '抓取一个网页的正文纯文本。用于用户给出链接、或搜索结果摘要不够需要看全文时。长文可先用 offset 读中段。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '完整网址，必须带 http:// 或 https://'
            },
            offset: {
              type: 'number',
              description: '从第几个字符开始读，默认 0；一次最多返回 12000 字'
            }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'now',
        description: '返回当前本地时间（年月日时分秒、星期）。用于确认今天几号、现在几点，不要靠猜。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    }
  ];

  /* 把错误统一成给模型看的字符串，别让异常冒到界面层 */
  function errText(e) {
    var msg = (e && e.message) ? e.message : String(e);
    return '工具没跑通：' + msg;
  }

  /* 模型给的 arguments 可能是字符串（OpenAI 协议）也可能是对象 */
  function toArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    var s = String(raw).trim();
    if (!s) return {};
    try {
      var o = JSON.parse(s);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) {
      return {};
    }
  }

  /* 同源 GET，返回已校验过 ok 的 JSON */
  async function getJSON(path) {
    var res = await fetch(path, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });
    if (!res || !res.ok) {
      throw new Error('HTTP ' + (res ? res.status : '无响应'));
    }
    var data = await res.json();
    if (!data || data.ok !== true) {
      throw new Error((data && (data.error || data.message)) || '接口返回 ok:false');
    }
    return data;
  }

  /* ---------------- 三个工具的具体实现 ---------------- */

  async function toolSearch(args) {
    var q = args && args.query ? String(args.query).trim() : '';
    if (!q) return { ok: false, text: '工具没跑通：web_search 缺少 query' };

    var data = await getJSON('api/search?q=' + encodeURIComponent(q));
    var items = data.items || [];
    var total = typeof data.count === 'number' ? data.count : items.length;

    if (!items.length) {
      return { ok: true, text: '搜索「' + q + '」没有结果。' };
    }

    var n = Math.min(items.length, SEARCH_LIMIT);
    var lines = [];
    for (var i = 0; i < n; i++) {
      var it = items[i] || {};
      lines.push((i + 1) + '. ' + (it.title || '(无标题)'));
      lines.push('   ' + (it.url || ''));
      lines.push('   ' + (it.snippet || '(无摘要)'));
    }
    var source = data.source === 'wikipedia' ? '维基百科' : (data.source === 'duckduckgo' ? 'DuckDuckGo' : '网页');
    var head = '搜索「' + q + '」（来源：' + source + '）获得 ' + total + ' 条，给出前 ' + n + ' 条：';
    return { ok: true, text: head + '\n' + lines.join('\n') };
  }

  async function toolFetch(args) {
    var u = args && args.url ? String(args.url).trim() : '';
    if (!u) return { ok: false, text: '工具没跑通：fetch_page 缺少 url' };
    if (!/^https?:\/\//i.test(u)) {
      return { ok: false, text: '工具没跑通：url 必须是 http:// 或 https:// 开头的完整网址' };
    }

    var offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    /* offset 必须真的发给服务端：老服务端会忽略它，新服务端按它切片并回 total/nextOffset/truncated。 */
    var fc = (root.XN && XN.services && XN.services.use) ? XN.services.use('fetch') : null;
  var data = (fc && fc.get) ? await fc.get(u, offset) : await getJSON('api/fetch?url=' + encodeURIComponent(u) + (offset > 0 ? '&offset=' + offset : ''));

    var full = String(data.text || '');
    /* 服务端自己切过片（带回 total / nextOffset / truncated）时，full 已经是 offset 之后那一段，
       不能再按 offset 切第二次；没有这些字段说明是老服务端，给的是整段正文，就在本地切。 */
    var serverSliced = (data.truncated === true)
      || Number.isFinite(Number(data.nextOffset))
      || Number.isFinite(Number(data.total));
    var total = Number(data.total);
    if (!Number.isFinite(total) || total < 0) total = serverSliced ? (offset + full.length) : full.length;

    var body = serverSliced ? full.slice(0, FETCH_LIMIT) : full.slice(offset, offset + FETCH_LIMIT);
    var nextOffset = Number(data.nextOffset);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) nextOffset = offset + body.length;
    /* 还剩多少字统一按 total - offset - 12000，负数按 0。 */
    var rest = total - offset - FETCH_LIMIT;
    if (rest < 0) rest = 0;
    var truncated = serverSliced ? (data.truncated === true || nextOffset < total) : (offset + FETCH_LIMIT < total);
    if (truncated) body += cutHint(rest, nextOffset);
    var text = '标题：' + (data.title || '(无标题)') + '\n'
      + '网址：' + (data.url || u) + '\n'
      + '正文' + (offset ? '（从 ' + offset + ' 字开始）' : '') + '：\n' + (body || '(正文为空)');
    return { ok: true, text: text };
  }

  /* 浏览器能给的只有时区，不是精确城市。这里把它翻成一句人话给模型，
     并且明确标注「推测」，避免模型把它当既定事实去编。 */
  var TZ_CITY = {
    'Asia/Shanghai': '中国大陆（北京时间）',
    'Asia/Chongqing': '中国大陆（北京时间）',
    'Asia/Harbin': '中国大陆（北京时间）',
    'Asia/Urumqi': '中国大陆新疆（乌鲁木齐时间）',
    'Asia/Hong_Kong': '中国香港',
    'Asia/Macau': '中国澳门',
    'Asia/Taipei': '中国台湾（台北）',
    'Asia/Tokyo': '日本（东京）',
    'Asia/Seoul': '韩国（首尔）',
    'Asia/Singapore': '新加坡',
    'America/New_York': '美国东部',
    'America/Chicago': '美国中部',
    'America/Denver': '美国山地',
    'America/Los_Angeles': '美国西部',
    'Europe/London': '英国（伦敦）',
    'Europe/Paris': '欧洲中部',
    'Europe/Berlin': '德国（柏林）',
    'Australia/Sydney': '澳大利亚（悉尼）'
  };

  function guessPlace() {
    var tz = '';
    try {
      tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
    } catch (e) {
      tz = '';
    }
    if (!tz) return { timeZone: '', hint: '' };
    var hint = TZ_CITY[tz] || '';
    /* 大陆各城市都落在 Asia/Shanghai，具体是哪个市浏览器不告诉，只能到省/国级 */
    if (!hint && tz.indexOf('Asia/') === 0) hint = '亚洲（时区 ' + tz + '）';
    return { timeZone: tz, hint: hint };
  }

  function toolNow() {
    var d = new Date();
    var text = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
      + ' 星期' + WEEK[d.getDay()];
    var place = guessPlace();
    var placeText = place.timeZone
      ? '\n设备时区：' + place.timeZone + (place.hint ? '（大致对应' + place.hint + '）' : '')
        + '\n注意：时区只说明「大概在哪一片」，不等于精确城市。问天气、温度、本地新闻这类需要具体城市的事，必须让用户说出城市，不要自己猜。'
      : '\n拿不到设备时区；问天气这类本地信息时，必须让用户说出城市。';
    return { ok: true, text: '当前本地时间是 ' + text + '。' + placeText };
  }

  /* ---------------- 对外：执行单个工具 ---------------- */

  async function run(name, args) {
    var a = toArgs(args);
    try {
      if (name === 'web_search') return await toolSearch(a);
      if (name === 'fetch_page') return await toolFetch(a);
      if (name === 'now') return toolNow();
      return { ok: false, text: '工具没跑通：没有名为 ' + name + ' 的工具' };
    } catch (e) {
      return { ok: false, text: errText(e) };
    }
  }

  /* ---------------- 对外：工具调用循环 ---------------- */

  /*
   * firstRes：可选的「已经拿到手的第 1 轮 chat 结果」。
   * loopWithFallback 需要先探一次 chat 才能判断服务商是否支持 tools，
   * 探到的结果直接喂进来复用，避免同一轮重复请求。
   */
  async function loopCore(opts, firstRes, firstSpecs) {
    opts = opts || {};
    var messages = opts.messages || [];
    var chat = opts.chat;
    var toolSpecs = opts.specs || specs;
    var maxRounds = typeof opts.maxRounds === 'number' && opts.maxRounds > 0 ? opts.maxRounds : 3;
    var onTool = typeof opts.onTool === 'function' ? opts.onTool : null;
    var onText = typeof opts.onText === 'function' ? opts.onText : null;

    var calls = [];
    var rounds = 0;
    var content = '';

    if (typeof chat !== 'function') {
      return { content: '', calls: calls, rounds: 0 };
    }

    var pending = firstRes || null;
    var started = Date.now();

    while (rounds < maxRounds) {
      if (opts.signal && opts.signal.aborted) {
        var stopErr = new Error('aborted');
        stopErr.name = 'AbortError';
        throw stopErr;
      }
      /* 工具循环也要有总时长上限，避免模型无限调工具把页面拖死 */
      if (Date.now() - started > (opts.deadlineMs || 180000)) break;

      rounds++;

      var res;
      if (pending) {
        res = pending;
        pending = null;
      } else {
        /* 这里不 catch：让调用方（loopWithFallback）能感知服务商不支持 tools */
        res = await chat(messages, toolSpecs);
      }

      content = (res && res.content) ? String(res.content) : '';
      var tcs = (res && res.toolCalls) ? res.toolCalls : null;

      /* 没有工具调用 = 模型已经能直接回答，结束 */
      if (!tcs || !tcs.length) {
        if (onText && content) onText(content);
        return { content: content, calls: calls, rounds: rounds };
      }

      /* 有工具调用：先补一条 assistant 消息，保证后续 role:'tool' 能对上 id */
      messages.push({
        role: 'assistant',
        content: content,
        tool_calls: tcs
      });

      for (var i = 0; i < tcs.length; i++) {
        var tc = tcs[i] || {};
        var fn = tc.function || {};
        var name = fn.name || '';
        var args = toArgs(fn.arguments);
        var result = await run(name, args);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id || ('call_' + rounds + '_' + i),
          content: result.text
        });

        calls.push({ name: name, args: args, ok: result.ok });
        if (onTool) onTool(name, args, result);
      }
    }

    /* 轮数用尽：摘掉工具、强制收尾，逼模型用已有信息说话 */
    if (!(opts.signal && opts.signal.aborted)) {
      try {
        var fin = await chat(messages, []);
        var finText = (fin && fin.content) ? String(fin.content) : '';
        if (finText) content = finText;
      } catch (e) {
        /* 收尾也失败就保留上一轮内容 */
      }
    }

    if (!content) {
      content = '（这次工具调用次数达到上限，还没有结论，要不要我换个问法再试？）';
    }
    if (onText) onText(content);

    return { content: content, calls: calls, rounds: rounds };
  }

  async function loop(opts) {
    return await loopCore(opts, null);
  }

  /* 联网开关只影响搜索/抓网页；时间工具永远可用。 */
  function specsFor(online) {
    if (online) return specs;
    return specs.filter(function (s) { return s.function && s.function.name === 'now'; });
  }

  /* ---------------- 对外：带降级的两条路 ---------------- */

  /* 从最后一条用户消息里取关键词，顺便当作搜索词 */
  function lastUserText(messages) {
    if (!messages || !messages.length) return '';
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (m && m.role === 'user') return String(m.content || '');
    }
    return '';
  }

  /* 需要具体地点的词：这类问题如果用户没说是哪，搜索结果会混进多个城市 */
  var PLACE_NEEDED = /天气|气温|温度|下雨|下雪|空气质量|限行|路况|本地新闻|附近/;
  var CITY_WORDS = ["北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "重庆", "武汉", "西安",
    "天津", "苏州", "郑州", "长沙", "青岛", "沈阳", "大连", "厦门", "福州", "昆明", "合肥",
    "济南", "哈尔滨", "长春", "石家庄", "太原", "南昌", "贵阳", "南宁", "兰州", "海口",
    "香港", "澳门", "台北", "日本", "韩国", "美国", "英国", "德国", "法国", "新加坡"];

  function hasCity(s) {
    for (var i = 0; i < CITY_WORDS.length; i++) {
      if (s.indexOf(CITY_WORDS[i]) >= 0) return true;
    }
    return false;
  }

  /* 返回 { query, needPlace } 或 null。needPlace=true 表示「要地点但用户没说」*/
  function needSearch(messages) {
    var s = lastUserText(messages);
    if (!s) return null;
    for (var i = 0; i < AUTO_KEYWORDS.length; i++) {
      if (s.indexOf(AUTO_KEYWORDS[i]) >= 0) {
        var q = s.length > 60 ? s.slice(0, 60) : s;
        if (PLACE_NEEDED.test(s) && !hasCity(s)) return { query: q, needPlace: true };
        return { query: q, needPlace: false };
      }
    }
    return null;
  }

  async function loopWithFallback(opts) {
    opts = opts || {};
    var messages = opts.messages || [];
    var chat = opts.chat;
    var textChat = opts.textChat;
    var toolSpecs = opts.specs || specs;
    var onTool = typeof opts.onTool === 'function' ? opts.onTool : null;
    var maxRounds = typeof opts.maxRounds === 'number' && opts.maxRounds > 0 ? opts.maxRounds : 3;

    var first = null;
    var unsupported = false;

    /* 先按「支持 tools」探一轮 */
    if (typeof chat === 'function') {
      try {
        first = await chat(messages, toolSpecs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        unsupported = true;
      }
      if (!unsupported) {
        var fc = (first && first.content) ? String(first.content) : '';
        var ftc = (first && first.toolCalls) ? first.toolCalls : null;
        /* 既没内容又没工具调用 → 服务商把 tools 参数吃了，走降级 */
        if ((!ftc || !ftc.length) && !fc) unsupported = true;
        if (!unsupported) {
          return await loopCore({
            messages: messages,
            chat: chat,
            specs: toolSpecs,
            maxRounds: maxRounds,
            onTool: onTool,
            onText: opts.onText,
            signal: opts.signal,
            deadlineMs: opts.deadlineMs
          }, first, toolSpecs);
        }
      }
    } else {
      unsupported = true;
    }

    /* ---- 降级路线：关键词判断 + 普通对话 ---- */
    var calls = [];
    var need = needSearch(messages);

    /* 要地点但用户没说：不搜索（搜了也是一堆城市混在一起），直接要求先问清 */
    if (need && need.needPlace) {
      messages.push({
        role: "system",
        content: "用户问的是需要具体地点的信息（天气/本地情况），但这句话里没有城市。" +
          "绝对不要猜城市，也不要把多个城市的数据混在一起说。" +
          "只用一句话问清「你在哪个城市」，问完就停，不要附带任何天气数据。"
      });
    } else if (need && toolSpecs.some(function (s) { return s.function && s.function.name === "web_search"; })) {
      var result = await run("web_search", { query: need.query });
      calls.push({ name: "web_search", args: { query: need.query }, ok: result.ok });
      if (onTool) onTool("web_search", { query: need.query }, result);

      messages.push({
        role: "system",
        content: "以下是刚刚联网查到的实时资料，请优先参考它回答，不要凭记忆编造。" +
          "如果资料里出现多个城市，只挑用户问到的那一个说；用户没指定城市就别给具体数值：\n" + result.text
      });
    }

    var content = '';
    if (typeof textChat === 'function') {
      var out = opts.signal
        ? await textChat(messages, { signal: opts.signal })
        : await textChat(messages);
      content = (out && typeof out === 'object') ? String(out.content || '') : String(out || '');
    }
    if (!content) content = '（这次没能生成回复，要不要再说一次？）';
    if (typeof opts.onText === 'function') opts.onText(content);

    return { content: content, calls: calls, rounds: need ? 0 : 1 };
  }

  return {
    specs: specs,
    specsFor: specsFor,
    run: run,
    loop: loop,
    loopWithFallback: loopWithFallback
  };
})();
