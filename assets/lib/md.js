/* 小暖 · Markdown 渲染
 * 目标不是完整 CommonMark，而是聊天里真正会出现的子集：
 * 代码块、标题、表格、有序/无序/嵌套列表、引用、分割线、链接、行内代码。
 * 所有文本先转义，URL 再过白名单，禁止 javascript:/data: 注入。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var U = XN.util;

  /* 任务列表：可勾选，但只改 DOM —— 渲染不持有原文，也就没有回写的地方。
     要勾选状态在重渲染后保留，得上层自己记；这里只保证点了有反应、不报错。 */
  var PLACEHOLDER = '\u0000XN';

  /* 脚注状态：render() 每次调用重置；inline() 单独调用时 FN_DEFS 为 null，按普通文本处理。 */
  var FN_DEFS = null;
  var FN_ORDER = [];
  var FN_SEEN = {};

  function fnKey(id) {
    return String(id == null ? '' : id).replace(/[^\w-]/g, '');
  }

  function safeHref(raw) {
    var url = String(raw || '').trim();
    if (!url) return '';
    if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
    if (/^(\/|\.\/|#|\?)/.test(url)) return url;
    return '';
  }

  /* 图片单独走白名单：只允许 http(s) 与站内相对路径，挡掉 mailto 等其它协议 */
  function imgSrc(raw) {
    var url = String(raw || '').trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^(\/|\.\/)/.test(url)) return url;
    return '';
  }

  function inline(src) {
    var codes = [];
    var text = String(src == null ? '' : src);

    /* 行内代码先摘出来，里面的 * _ [ ] 不参与后续解析 */
    text = text.replace(/`([^`\n]+)`/g, function (m, code) {
      codes.push('<code>' + U.esc(code) + '</code>');
      return PLACEHOLDER + 'C' + (codes.length - 1) + '\u0000';
    });

    text = U.esc(text);

    /* 图片：只允许 http(s)，不加载 data: */
    text = text.replace(/!\[([^\]]{0,120})\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, function (m, alt, url, title) {
      var href = imgSrc(url);
      if (!href) return m;
      return '<img src="' + U.esc(href) + '" alt="' + U.esc(alt) + '"' +
        (title ? ' title="' + U.esc(title) + '"' : '') +
        ' loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    });

    /* 链接 */
    text = text.replace(/\[([^\]]{0,200})\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, function (m, label, url, title) {
      var href = safeHref(url);
      if (!href) return m;
      return '<a href="' + U.esc(href) + '" target="_blank" rel="noopener noreferrer nofollow"' +
        (title ? ' title="' + U.esc(title) + '"' : '') + '>' + label + '</a>';
    });

    /* 自动链接：转义后是 &lt;https://...&gt; */
    text = text.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, function (m, url) {
      return '<a href="' + U.esc(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + url + '</a>';
    });

    /* 脚注引用：[^id] → 上标；只认 render() 收集到的定义，没定义就保持原文 */
    if (FN_DEFS) {
      text = text.replace(/\[\^([^\]\s]{1,40})\]/g, function (m, id) {
        if (!FN_DEFS[id]) return m;
        var key = fnKey(id);
        if (!key) return m;
        var n = FN_ORDER.indexOf(id);
        if (n < 0) { FN_ORDER.push(id); n = FN_ORDER.length - 1; }
        FN_SEEN[key] = (FN_SEEN[key] || 0) + 1;
        var refId = 'fnref-' + key + (FN_SEEN[key] > 1 ? '-' + FN_SEEN[key] : '');
        return '<sup class="md-fn-ref" id="' + U.esc(refId) + '"><a href="#fn-' +
          U.esc(key) + '">' + (n + 1) + '</a></sup>';
      });
    }

    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(（>])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(（>])_([^_\n]+)_/g, '$1<em>$2</em>');

    text = text.replace(/\u0000XNC(\d+)\u0000/g, function (m, i) { return codes[Number(i)] || ''; });
    return text;
  }

  function isTableSeparator(line) {
    var t = String(line || '').trim();
    if (t.indexOf('-') < 0 || t.indexOf('|') < 0) return false;
    var cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (!cells.length) return false;
    return cells.every(function (c) { return /^\s*:?-{3,}:?\s*$/.test(c); });
  }

  function splitRow(line) {
    var t = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    var out = [];
    var buf = '';
    var inCode = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '\\' && i + 1 < t.length) { buf += t.charAt(i + 1); i++; continue; }
      if (ch === '`') inCode = !inCode;
      if (ch === '|' && !inCode) { out.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf.trim());
    return out;
  }

  function renderTable(lines, start) {
    var head = splitRow(lines[start]);
    var seps = splitRow(lines[start + 1]);
    var aligns = seps.map(function (s) {
      var t = s.trim();
      if (/^:-+:$/.test(t)) return 'center';
      if (/^:-+$/.test(t)) return 'left';
      if (/^-+:$/.test(t)) return 'right';
      return '';
    });
    var rows = [];
    var i = start + 2;
    while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
      rows.push(splitRow(lines[i]));
      i++;
    }
    var html = '<div class="md-table"><table><thead><tr>';
    head.forEach(function (cell, idx) {
      html += '<th' + (aligns[idx] ? ' class="ta-' + aligns[idx] + '"' : '') + '>' + inline(cell) + '</th>';
    });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr>';
      head.forEach(function (_, idx) {
        html += '<td' + (aligns[idx] ? ' class="ta-' + aligns[idx] + '"' : '') + '>' + inline(row[idx] || '') + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return { html: html, next: i };
  }

  function listMatch(line) {
    var m = String(line).match(/^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/);
    if (!m) return null;
    return {
      indent: m[1].replace(/\t/g, '  ').length,
      ordered: /^\d/.test(m[2]),
      marker: m[2],
      text: m[3]
    };
  }

  function renderList(lines, start) {
    var first = listMatch(lines[start]);
    if (!first) return null;
    var ordered = first.ordered;
    var baseIndent = first.indent;
    var items = [];
    var i = start;

    while (i < lines.length) {
      var m = listMatch(lines[i]);
      if (!m) break;
      if (m.indent < baseIndent) break;
      if (m.indent > baseIndent) {
        if (!items.length) break;
        var sub = renderList(lines, i);
        if (!sub) break;
        items[items.length - 1].children.push(sub.html);
        i = sub.next;
        continue;
      }
      if (m.ordered !== ordered) break;

      var text = m.text;
      var task = null;
      var tm = text.match(/^\[([ xX])\][ \t]+(.*)$/);
      if (tm) { task = tm[1].toLowerCase() === 'x'; text = tm[2]; }

      var item = { text: text, children: [], task: task };
      i++;

      /* 续行：缩进更深、且不是新的列表项，接到当前项上 */
      while (i < lines.length) {
        var line = lines[i];
        if (!line.trim()) { i++; break; }
        if (listMatch(line)) break;
        var cont = line.match(/^([ \t]+)(.*)$/);
        if (!cont || cont[1].replace(/\t/g, '  ').length <= baseIndent) break;
        item.text += '\n' + cont[2];
        i++;
      }
      items.push(item);

      /* 空行之后仍是同级列表项，继续（loose list） */
      while (i < lines.length && !lines[i].trim()) {
        var probe = i + 1;
        while (probe < lines.length && !lines[probe].trim()) probe++;
        var nm = probe < lines.length ? listMatch(lines[probe]) : null;
        if (nm && nm.indent === baseIndent) i = probe;
        else break;
      }
    }

    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>';
    items.forEach(function (it) {
      var body = inline(it.text).replace(/\n/g, '<br>');
      if (it.task != null) {
        body = '<label class="md-task"><input type="checkbox"' + (it.task ? ' checked' : '') + '> ' + body + '</label>';
      }
      html += '<li>' + body + (it.children.length ? it.children.join('') : '') + '</li>';
    });
    html += '</' + tag + '>';
    return { html: html, next: i };
  }

  /* ---------- 标题锚点 + 目录 ---------- */

  /* 从标题的纯文本生成锚点 slug：保留中英文数字、连字符，其余字符一律丢掉；
     全空就用 section，长度封顶 40，避免超长 id。 */
  function slugify(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    s = s.replace(/<[^>]*>/g, '').replace(/\s+/g, '-');
    s = s.replace(/[^\w\u4e00-\u9fa5-]/g, '');
    s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 40) || 'section';
  }

  /* 给 h1–h4 补 id，同时收集成目录条目；同名标题自动加 -2 / -3 后缀。 */
  function anchorHeadings(html) {
    var used = {};
    var headings = [];
    var out = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, function (m, level, inner) {
      var plain = inner.replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      var base = slugify(plain);
      var slug = base;
      var n = 1;
      while (used[slug]) { n++; slug = base + '-' + n; }
      used[slug] = true;
      headings.push({ level: Number(level), text: plain, id: slug });
      return '<h' + level + ' id="' + U.esc(slug) + '">' + inner + '</h' + level + '>';
    });
    return { html: out, headings: headings };
  }

  /* 目录：≥3 个标题才生成；用原生 <details> 折叠，不依赖任何 JS，锚点直接跳。 */
  function tocHtml(headings) {
    if (headings.length < 3) return '';
    var base = headings[0].level;
    var items = headings.map(function (h) {
      var depth = Math.max(0, Math.min(3, h.level - base));
      return '<li class="md-toc-l' + depth + '"><a href="#' + U.esc(h.id) + '">' +
        U.esc(h.text) + '</a></li>';
    }).join('');
    return '<details class="md-toc"><summary>目录 · ' + headings.length +
      ' 个标题</summary><ul>' + items + '</ul></details>';
  }

  /* ---------- 脚注 ---------- */

  /* 按正文里出现的顺序输出脚注列表；定义文本仍走 inline()（转义顺序不变）。 */
  function footnotesHtml() {
    if (!FN_DEFS || !FN_ORDER.length) return '';
    var defs = FN_DEFS;
    FN_DEFS = null; /* 定义里再出现 [^x] 就按普通文本处理，不再套娃 */
    var items = '';
    FN_ORDER.forEach(function (id) {
      var key = fnKey(id);
      if (!key || !defs[id]) return;
      items += '<li id="fn-' + U.esc(key) + '">' + inline(defs[id]) +
        ' <a class="md-fn-back" href="#fnref-' + U.esc(key) + '" aria-label="回到正文">↩</a></li>';
    });
    FN_DEFS = defs;
    if (!items) return '';
    return '<section class="md-footnotes"><hr><ol>' + items + '</ol></section>';
  }

  function blocks(src) {
    var lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flush() {
      if (!para.length) return;
      out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) { flush(); i++; continue; }

      var fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (fence) {
        flush();
        var mark = fence[1];
        var body = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(mark) !== 0) { body.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push('<pre><code>' + U.esc(body.join('\n')) + '</code></pre>');
        continue;
      }

      var ph = trimmed.match(/^\u0000XNCODE(\d+)\u0000$/);
      if (ph) { flush(); out.push(CODE_BLOCKS[Number(ph[1])] || ''); i++; continue; }

      var h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        var level = Math.min(h[1].length, 6);
        out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); out.push('<hr>'); i++; continue; }

      if (/^>\s?/.test(trimmed)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + blocks(quote.join('\n')) + '</blockquote>');
        continue;
      }

      if (trimmed.indexOf('|') >= 0 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flush();
        var table = renderTable(lines, i);
        out.push(table.html);
        i = table.next;
        continue;
      }

      var lm = listMatch(line);
      if (lm) {
        flush();
        var list = renderList(lines, i);
        if (list) { out.push(list.html); i = list.next; continue; }
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  /* 代码块在块解析前抽出，避免内部内容被当成标题/列表 */
  var CODE_BLOCKS = [];

  function render(src) {
    CODE_BLOCKS = [];
    FN_DEFS = {};
    FN_ORDER = [];
    FN_SEEN = {};
    var text = String(src == null ? '' : src).replace(/\r\n/g, '\n');
    var lines = text.split('\n');
    var kept = [];
    var i = 0;
    while (i < lines.length) {
      var m = lines[i].trim().match(/^(`{3,}|~{3,})([^\n]*)$/);
      if (m) {
        var mark = m[1];
        var lang = (m[2] || '').trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '');
        var body = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(mark) !== 0) { body.push(lines[i]); i++; }
        if (i < lines.length) i++;
        CODE_BLOCKS.push('<pre><code' + (lang ? ' class="language-' + U.esc(lang) + '"' : '') + '>' +
          U.esc(body.join('\n')) + '</code></pre>');
        kept.push(PLACEHOLDER + 'CODE' + (CODE_BLOCKS.length - 1) + '\u0000');
      } else {
        kept.push(lines[i]);
        i++;
      }
    }

    /* 脚注定义先摘出来（代码块已换成占位符，所以不会误抓代码里的 [^x]:）：
       [^id]: 说明 —— 定义行本身不参与正文渲染，最后统一输出脚注列表。 */
    var defined = [];
    for (var j = 0; j < kept.length; j++) {
      var dm = kept[j].match(/^ {0,3}\[\^([^\]\s]{1,40})\]:[ \t]*(.*)$/);
      if (!dm) { defined.push(kept[j]); continue; }
      if (!FN_DEFS[dm[1]]) FN_DEFS[dm[1]] = dm[2];
    }

    var body = blocks(defined.join('\n'));
    var anchored = anchorHeadings(body);
    var html = anchored.html;
    var toc = tocHtml(anchored.headings);
    if (toc) html = toc + html;
    html += footnotesHtml();
    FN_DEFS = null;
    return html;
  }

  XN.md = { render: render, inline: inline };
})(typeof window !== 'undefined' ? window : globalThis);
