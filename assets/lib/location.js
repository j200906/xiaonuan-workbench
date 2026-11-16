/* 小暖 · 定位与天气（移植自 v5.8 的 get_user_location / _fetch_weather）
 *
 * 为什么要有：
 *   用户问「今天天气怎么样」，没说城市。以前只能反问「你在哪个城市呀」——
 *   多一轮对话。v5.8 的做法是：用 IP 定位猜一下（不精确但够用），
 *   直接答，然后顺带说明「按 IP 推测你在杭州」。
 *
 * 走哪条网络路径：
 *   浏览器直连第三方接口会被 CORS 挡，所以统一走 XN.services.use('fetch')，
 *   它背后是 /api/fetch（本地后端 / Cloudflare Worker 都有，且带 SSRF 防护）。
 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

  /* wttr.in 的英文天气描述 → 中文 */
  var WEATHER_CN = {
    'sunny': '晴', 'clear': '晴', 'partly cloudy': '多云', 'cloudy': '阴', 'overcast': '阴',
    'mist': '薄雾', 'fog': '雾', 'haze': '霾', 'smoky haze': '烟霾', 'freezing fog': '冻雾',
    'patchy rain nearby': '局部有雨', 'patchy rain possible': '可能有雨', 'light rain': '小雨',
    'moderate rain': '中雨', 'heavy rain': '大雨', 'light drizzle': '毛毛雨',
    'light rain shower': '阵雨', 'moderate or heavy rain shower': '较强阵雨',
    'thundery outbreaks possible': '可能有雷阵雨', 'patchy light rain with thunder': '雷阵雨',
    'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪',
    'patchy snow possible': '局部有雪', 'blizzard': '暴雪', 'sleet': '雨夹雪',
    'light sleet': '小雨夹雪', 'moderate or heavy sleet': '雨夹雪'
  };

  /* 定位结果缓存：同一台机器不必每次发消息都问一遍 */
  var locCache = { city: '', region: '', ts: 0, tried: false };
  var LOC_TTL = 30 * 60 * 1000; /* 半小时 */

  /* 城市级天气缓存 */
  var weatherCache = {};

  function weatherCn(desc) {
    var k = String(desc || '').trim().toLowerCase();
    return WEATHER_CN[k] || desc || '';
  }

  /* 统一的抓取出口：优先走能力层的 fetch（带 SSRF 防护的代理） */
  function getJson(url, timeoutMs) {
    var svc = XN.services && XN.services.use ? XN.services.use('fetch') : null;
    if (svc && typeof svc.get === 'function') {
      return svc.get(url, { timeout: timeoutMs || 8000 }).then(function (r) {
        if (r && typeof r === 'object' && r.json) return r.json;
        var text = (r && (r.text || r.body)) || r || '';
        return typeof text === 'string' ? JSON.parse(text) : text;
      });
    }
    /* 兜底：浏览器直连（第三方若允许 CORS 就能通） */
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000) : null;
    return fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /**
   * 用 IP 猜城市。失败返回空字符串（绝不抛）。
   * @returns {Promise<{city:string, region:string, source:string}>}
   */
  function locate(force) {
    if (!force && locCache.tried && Date.now() - locCache.ts < LOC_TTL) {
      return Promise.resolve({ city: locCache.city, region: locCache.region, source: locCache.source || 'cache' });
    }

    var sources = [
      { url: 'https://ipapi.co/json/', pick: function (d) { return { city: d.city, region: d.region }; } },
      { url: 'https://ipinfo.io/json', pick: function (d) { return { city: d.city, region: d.region }; } }
    ];

    var i = 0;
    function next() {
      if (i >= sources.length) {
        locCache = { city: '', region: '', ts: Date.now(), tried: true, source: 'fail' };
        return { city: '', region: '', source: 'fail' };
      }
      var s = sources[i++];
      return getJson(s.url, 6000).then(function (d) {
        var r = s.pick(d || {}) || {};
        var city = String(r.city || '').trim();
        if (!city) throw new Error('没拿到城市');
        locCache = { city: city, region: String(r.region || '').trim(), ts: Date.now(), tried: true, source: s.url };
        return { city: city, region: locCache.region, source: s.url };
      }).catch(function () { return next(); });
    }
    return Promise.resolve().then(next);
  }

  /**
   * 查天气（实况 + 三天预报）。
   * @returns {Promise<string|null>} 给模型看的一段文本；失败返回 null（不抛）
   */
  function weather(city) {
    var name = String(city || '').trim();
    if (!name) return Promise.resolve(null);

    var now = Date.now();
    var hit = weatherCache[name];
    if (hit && now - hit.ts < 10 * 60 * 1000) return Promise.resolve(hit.text);

    var url = 'https://wttr.in/' + encodeURIComponent(name) + '?format=j1&lang=zh';
    return getJson(url, 10000).then(function (d) {
      if (!d || !d.current_condition || !d.current_condition[0]) return null;
      var cur = d.current_condition[0];
      var desc = (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '';
      var lines = ['【' + name + ' 天气】实况：' + weatherCn(desc) +
        '，气温 ' + cur.temp_C + '℃，体感 ' + (cur.FeelsLikeC || '?') + '℃' +
        '，湿度 ' + (cur.humidity || '?') + '%，风速 ' + (cur.windspeedKmph || '?') + ' km/h'];

      var week = d.weather || [];
      if (week.length) {
        var labels = ['今天', '明天', '后天'];
        lines.push('未来三天：');
        for (var k = 0; k < Math.min(3, week.length); k++) {
          var w = week[k];
          var hourly = w.hourly || [{}];
          var midday = hourly[4] || hourly[0] || {};
          var md = (midday.weatherDesc && midday.weatherDesc[0] && midday.weatherDesc[0].value) || '';
          var hd = (hourly[0] && hourly[0].weatherDesc && hourly[0].weatherDesc[0] && hourly[0].weatherDesc[0].value) || '';
          lines.push('  ' + labels[k] + '(' + (w.date || '') + ') ' + weatherCn(md) +
            '，' + w.mintempC + '℃ ~ ' + w.maxtempC + '℃，' + weatherCn(hd));
        }
      }

      var text = lines.join('\n');
      weatherCache[name] = { text: text, ts: now };
      return text;
    }).catch(function () { return null; });
  }

  function cachedCity() {
    if (locCache.tried && Date.now() - locCache.ts < LOC_TTL) return locCache.city;
    return '';
  }

  XN.location = {
    locate: locate,
    weather: weather,
    weatherCn: weatherCn,
    cachedCity: cachedCity,
    _reset: function () { locCache = { city: '', region: '', ts: 0, tried: false }; weatherCache = {}; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
