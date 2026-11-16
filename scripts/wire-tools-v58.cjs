/* 把 v5.8 的 weather 工具 + 上下文消解接进 tools.js */
const fs = require('fs');
const root = process.argv[2];
const p = root + '/assets/tools.js';
let t = fs.readFileSync(p, 'utf8');
let n = 0;

/* ---------- 1. 加 weather 工具规格 ---------- */
if (!t.includes("name: 'weather'")) {
  const anchor = `    {
      type: 'function',
      function: {
        name: 'fetch_page',`;
  if (t.includes(anchor)) {
    t = t.replace(anchor, `    {
      type: 'function',
      function: {
        name: 'weather',
        description: '查某个城市的天气实况和未来三天预报。用户只问「今天天气怎么样」而没说城市时，city 留空——程序会自动用 IP 定位猜一个，并把「按 IP 推测」写进结果里。不要为了填 city 自己编一个城市名。',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: '城市名，如「杭州」「北京」。用户没说就留空。'
            }
          }
        }
      }
    },
` + anchor);
    n++;
  }
}

/* ---------- 2. 加 toolWeather 实现 ---------- */
if (!t.includes('function toolWeather')) {
  const anchor2 = '  async function toolFetch(args) {';
  if (t.includes(anchor2)) {
    t = t.replace(anchor2, `  /* 天气：v5.8 的做法——给了城市就查；没给就用 IP 猜，并把「推测」说出来。
     绝不自己编城市，也不把多个城市混在一起答。 */
  async function toolWeather(args) {
    var city = String((args && args.city) || '').trim();
    var guessed = false;

    if (!city) {
      if (!root.XN || !XN.location || !XN.location.locate) {
        return { ok: false, text: '问天气需要城市。程序没有定位能力，请直接问用户「你在哪个城市」。' };
      }
      var loc = await XN.location.locate();
      city = (loc && loc.city) || '';
      guessed = !!city;
      if (!city) {
        return {
          ok: false,
          text: '用户没说城市，IP 定位也失败了。请直接问一句「你在哪个城市呀」，不要猜城市，也不要给任何天气数据。'
        };
      }
    }

    if (!root.XN || !XN.location || !XN.location.weather) {
      return { ok: false, text: '天气服务没接上，直接告诉用户查不了。' };
    }

    var text = await XN.location.weather(city);
    if (!text) {
      return { ok: false, text: '天气接口没返回数据。告诉用户天气服务暂时挂了，别编。' };
    }

    var head = guessed
      ? '（用户没说城市，按 IP 推测在「' + city + '」；回答时要说明这是推测，让他确认一下）\\n'
      : '';
    if (root.XN && XN.context && XN.context.markIntent) XN.context.markIntent('weather');
    if (root.XN && XN.context && XN.context.rememberFocus) XN.context.rememberFocus(city);

    return { ok: true, text: head + text };
  }

` + anchor2);
    n++;
  }
}

/* ---------- 3. run() 里加天气分支 ---------- */
if (!t.includes("name === 'weather'")) {
  t = t.replace(
    `      if (name === 'web_search') return await toolSearch(a);`,
    `      if (name === 'weather') return await toolWeather(a);
      if (name === 'web_search') return await toolSearch(a);`
  );
  n++;
}

/* ---------- 4. toolSearch 里先做上下文消解 ---------- */
if (!t.includes('XN.context.resolve')) {
  t = t.replace(
    `  async function toolSearch(args) {
    var q = args && args.query ? String(args.query).trim() : '';
    if (!q) return { ok: false, text: '工具没跑通：web_search 缺少 query' };`,
    `  async function toolSearch(args) {
    var q = args && args.query ? String(args.query).trim() : '';
    var raw = args && args.raw_query ? String(args.raw_query).trim() : '';
    if (!q) return { ok: false, text: '工具没跑通：web_search 缺少 query' };

    /* 上下文消解：把「那个」「它」还原成上文的具体对象。
       没这层的话，「那明天呢」会被原样丢进搜索，搜回来一堆无关的东西。 */
    if (root.XN && XN.context && XN.context.resolve) {
      var r = XN.context.resolve(q, raw);
      if (r.blocked) {
        return {
          ok: false,
          text: '用户这句里只有代词或疑问词，上文也没有可指代的对象，搜了也只会跑题。请直接问清「它」具体指什么，不要猜。'
        };
      }
      if (r.resolved) {
        q = r.query || r.fallbackQuery || q;
      }
    }`
  );
  n++;
}

/* ---------- 5. 搜索成功后记住话题 ---------- */
if (!t.includes('rememberFocus(q)')) {
  t = t.replace(
    `    var source = data.source === 'wikipedia' ? '维基百科' : (data.source === 'duckduckgo' ? 'DuckDuckGo' : '网页');`,
    `    if (root.XN && XN.context && XN.context.rememberFocus) XN.context.rememberFocus(q);
    var source = data.source === 'wikipedia' ? '维基百科' : (data.source === 'duckduckgo' ? 'DuckDuckGo' : '网页');`
  );
  n++;
}

/* ---------- 6. web_search 规格加 raw_query ---------- */
if (!t.includes('raw_query')) {
  t = t.replace(
    `            query: {
              type: 'string',
              description: '搜索关键词，尽量具体，例如「上海 今天 天气」「Node.js 最新 LTS 版本」'
            }`,
    `            query: {
              type: 'string',
              description: '搜索关键词，尽量具体，例如「上海 今天 天气」「Node.js 最新 LTS 版本」'
            },
            raw_query: {
              type: 'string',
              description: '用户原话（可选）。程序会自动回看上文把「它/那个/这家」解析成具体对象；你拿不准指代物时把原话放这里，别自己编实体。'
            }`
  );
  n++;
}

fs.writeFileSync(p, t, 'utf8');
console.log('tools.js 改动 ' + n + ' 处');
