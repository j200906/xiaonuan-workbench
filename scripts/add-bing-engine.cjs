/* 给 Python 后端和 Cloudflare Worker 同时加 Bing 中文引擎 + 封禁检测 */
const fs = require('fs');
const root = process.argv[2];
let n = 0;

/* ==================== Python 后端 ==================== */
const pyPath = root + '/server/app.py';
let py = fs.readFileSync(pyPath, 'utf8');

if (!py.includes('def bing_search')) {
  const anchor = 'def web_search(q):';
  if (py.includes(anchor)) {
    py = py.replace(anchor, `def bing_search(q):
    """Bing 中文检索。比 DuckDuckGo 更容易搜到中文长尾内容（v5.8 的多引擎之一）。

    返回 [] 表示这家引擎没给结果（被限流、验证页、或者真的没有），
    由上层换下一家，不要让用户看到异常。
    """
    try:
        req = urllib.request.Request(
            "https://cn.bing.com/search?q=" + urllib.parse.quote(q) + "&setlang=zh-CN&ensearch=0",
            headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"},
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            page = res.read().decode("utf-8", "ignore")
        # 反爬/验证页特征：没有 b_algo 又出现这些字，说明被挡了
        if "b_algo" not in page and ("验证" in page[:3000] or "captcha" in page[:3000].lower()):
            return []
        out = []
        for m in re.finditer(
            r'<li class="b_algo"[\\s\\S]*?<h2>\\s*<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)</a>([\\s\\S]*?)</li>',
            page, re.I,
        ):
            link = html.unescape(m.group(1))
            title = strip_tags(m.group(2))
            snippet = strip_tags(m.group(3))[:220]
            if title and link.startswith("http"):
                out.append({"title": title, "url": link, "snippet": snippet})
            if len(out) >= 6:
                break
        return out
    except Exception:
        return []


def web_search(q):`);
    n++;
  }
}

/* 把 bing 插到 DDG 之前 */
if (py.includes('items, source = [], "duckduckgo"') && !py.includes('source = "bing"')) {
  py = py.replace(
    `    items, source = [], "duckduckgo"
    try:`,
    `    items, source = [], "bing"

    # 先试 Bing：中文内容覆盖比 DDG 好
    items = bing_search(q)
    if items:
        payload = {"ok": True, "q": q, "count": len(items), "items": items, "source": source}
        _search_cache[q] = (now, payload)
        if len(_search_cache) > 200:
            _search_cache.clear()
        return payload

    source = "duckduckgo"
    try:`
  );
  n++;
}

fs.writeFileSync(pyPath, py, 'utf8');
console.log('app.py 改动 ' + n + ' 处');

/* ==================== Cloudflare Worker ==================== */
const wPath = root + '/cloudflare/worker.js';
let w = fs.readFileSync(wPath, 'utf8');
const before = n;

if (!w.includes('function bingSearch')) {
  const anchor2 = "  if (path === '/api/search') {";
  if (w.includes(anchor2)) {
    /* 把函数插在 worker 模块顶层：找一个合适的位置 */
    const anchor3 = "function json(";
    if (w.includes(anchor3)) {
      w = w.replace(anchor3, `/* Bing 中文检索：中文长尾内容比 DuckDuckGo 覆盖好（v5.8 的多引擎之一）。
   返回空数组表示这家没给结果（限流/验证页/真没有），由上层换下一家。 */
async function bingSearch(q) {
  try {
    const u = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0';
    const res = await fetchWithTimeout(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
    }, 15000);
    if (!res || !res.ok) return [];
    const page = await res.text();
    if (page.indexOf('b_algo') < 0 && /验证|captcha/i.test(page.slice(0, 3000))) return [];

    const out = [];
    const re = /<li class="b_algo"[\\s\\S]*?<h2>\\s*<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>([\\s\\S]*?)<\\/li>/gi;
    let m;
    while ((m = re.exec(page)) && out.length < 6) {
      const link = decodeEntities(m[1]);
      const title = stripTags(m[2]);
      const snippet = stripTags(m[3]).slice(0, 220);
      if (title && /^https?:/i.test(link)) out.push({ title: title, url: link, snippet: snippet });
    }
    return out;
  } catch (e) {
    return [];
  }
}

function json(`);
      n++;
    }
  }
}

fs.writeFileSync(wPath, w, 'utf8');
console.log('worker.js 改动 ' + (n - before) + ' 处');
