/* 小暖 · Markdown 渲染
 * 目标不是完整 CommonMark，而是聊天里真正会出现的子集：
 * 代码块、标题、表格、有序/无序/嵌套列表、引用、分割线、链接、行内代码。
 * 所有文本先转义，URL 再过白名单，禁止 javascript:/data: 注入。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};
  var U = XN.util;

  var PLACEHOLDER = '\u0000XN';

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
        body = '<label class="md-task"><input type="checkbox" disabled' + (it.task ? ' checked' : '') + '> ' + body + '</label>';
      }
      html += '<li>' + body + (it.children.length ? it.children.join('') : '') + '</li>';
    });
    html += '</' + tag + '>';
    return { html: html, next: i };
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
    return blocks(kept.join('\n'));
  }

  XN.md = { render: render, inline: inline };
})(typeof window !== 'undefined' ? window : globalThis);
