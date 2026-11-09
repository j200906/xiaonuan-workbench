/* 小暖 · 补丁规则（浏览器 / Node 通用）
 * 自迭代最容易出事的地方不是"模型不会写"，而是"写进去的补丁把文件弄坏了"。
 * 这里把校验集中成一处：唯一命中、禁止写法、括号配平、重复定义、版本号。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.XN_PATCH = api;
  if (root.XN) root.XN.patch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var FORBIDDEN = [
    { re: /\beval\s*\(/, label: 'eval' },
    { re: /new\s+Function\s*\(/, label: 'new Function' },
    { re: /document\.write\s*\(/, label: 'document.write' },
    { re: /<script[^>]+src\s*=\s*["']https?:/i, label: '外链脚本' },
    { re: /javascript\s*:/i, label: 'javascript: 伪协议' }
  ];

  var CONTROL = ['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'constructor'];

  function forbidden(text) {
    var s = String(text || '');
    for (var i = 0; i < FORBIDDEN.length; i++) {
      if (FORBIDDEN[i].re.test(s)) return FORBIDDEN[i].label;
    }
    return '';
  }

  /* 括号配平扫描：忽略字符串、模板字符串、注释、正则字面量。
   * 返回 {ok, reason}。比"数一数 {"可靠，字符串里的括号不会误判。 */
  function balance(src) {
    var s = String(src || '');
    var stack = [];
    var tpl = 0;
    var mode = 'code';
    var quote = '';
    var last = '';
    var inClass = false;
    var i = 0;

    while (i < s.length) {
      var ch = s.charAt(i);
      var next = s.charAt(i + 1);

      if (mode === 'line') {
        if (ch === '\n') { mode = 'code'; last = ''; }
        i++;
        continue;
      }
      if (mode === 'block') {
        if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
        i++;
        continue;
      }
      if (mode === 'str') {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) { mode = 'code'; last = 'x'; }
        i++;
        continue;
      }
      if (mode === 'regex') {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '[') { inClass = true; i++; continue; }
        if (ch === ']') { inClass = false; i++; continue; }
        if (ch === '/' && !inClass) {
          mode = 'code';
          last = 'x';
          i++;
          while (/[a-z]/i.test(s.charAt(i))) i++;
          continue;
        }
        i++;
        continue;
      }
      if (mode === 'tpl') {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') { mode = 'code'; last = 'x'; i++; continue; }
        if (ch === '$' && next === '{') {
          tpl++;
          stack.push('${');
          mode = 'code';
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      /* code */
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      /* 正则字面量：只有出现在 = ( [ { , : ; ! & | ? + - * % < > ~ ^ 之后才是正则 */
      if (ch === '/' && (last === '' || '([{=,:;!&|?+-*%<>~^'.indexOf(last) >= 0)) {
        mode = 'regex';
        inClass = false;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') { mode = 'str'; quote = ch; i++; continue; }
      if (ch === '`') { mode = 'tpl'; i++; continue; }

      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push(ch);
        last = ch;
        i++;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        var want = ch === ')' ? '(' : (ch === ']' ? '[' : '{');
        if (!stack.length) {
          if (ch === '}' && tpl > 0) {
            tpl--;
            stack.push('${');
            mode = 'tpl';
            i++;
            continue;
          }
          return { ok: false, reason: '多了一个 ' + ch };
        }
        var top = stack.pop();
        if (top !== want) {
          if (top === '${' && ch === '}') {
            tpl--;
            mode = 'tpl';
            i++;
            continue;
          }
          return { ok: false, reason: '括号不匹配：' + top + ' 对上了 ' + ch };
        }
        last = ch;
        i++;
        continue;
      }
      if (!/\s/.test(ch)) last = ch;
      i++;
    }

    if (mode === 'str') return { ok: false, reason: '字符串没有闭合' };
    if (mode === 'regex') return { ok: false, reason: '正则没有闭合' };
    if (mode === 'block') return { ok: false, reason: '块注释没有闭合' };
    if (mode === 'tpl' || tpl > 0) return { ok: false, reason: '模板字符串没有闭合' };
    if (stack.length) return { ok: false, reason: '还有 ' + stack.length + ' 个括号没闭合' };
    return { ok: true, reason: '' };
  }

  function defsIn(code) {
    var out = [];
    var s = String(code || '');
    var re = [
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
      /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\{|extends\b)/g,
      /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g
    ];
    re.forEach(function (r) {
      var m;
      while ((m = r.exec(s)) !== null) {
        if (CONTROL.indexOf(m[1]) < 0) out.push(m[1]);
      }
    });
    return out;
  }

  function hasDef(source, name) {
    var n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var pats = [
      new RegExp('\\bfunction\\s+' + n + '\\s*\\('),
      new RegExp('\\b(?:const|let|var)\\s+' + n + '\\b'),
      new RegExp('\\bclass\\s+' + n + '\\b')
    ];
    return pats.some(function (re) { return re.test(source); });
  }

  function applyPatches(files, patches, editable, opts) {
    opts = opts || {};
    var max = opts.maxPatches || 8;
    if (!Array.isArray(patches) || !patches.length) throw new Error('没有补丁');
    if (patches.length > max) throw new Error('补丁条数超过上限 ' + max);

    var touched = [];
    patches.forEach(function (p, idx) {
      var label = '第 ' + (idx + 1) + ' 处';
      var file = String((p && p.file) || '');
      if (editable && editable.indexOf(file) < 0) throw new Error('不允许改 ' + file);

      var find = String((p && p.find) || '');
      var replace = String((p && p.replace) || '');
      if (find.length < 8) throw new Error(label + ' find 太短，容易误伤');
      if (find.length > 8000) throw new Error(label + ' find 太长');
      if (replace.length > 24000) throw new Error(label + ' 改动过大');

      var bad = forbidden(replace);
      if (bad) throw new Error(label + ' 含被禁止的写法：' + bad);

      var source = files[file];
      if (typeof source !== 'string') throw new Error('读不到 ' + file);
      var first = source.indexOf(find);
      if (first < 0) throw new Error(label + ' 在 ' + file + ' 里找不到原文');
      if (source.indexOf(find, first + 1) >= 0) throw new Error(label + ' 原文不唯一');

      var after = source.slice(0, first) + replace + source.slice(first + find.length);
      var bal = balance(after);
      if (!bal.ok) throw new Error(label + ' 会让 ' + file + ' 括号不配平：' + bal.reason);

      var dupes = defsIn(replace).filter(function (name) {
        return hasDef(source, name) && !hasDef(find, name);
      });
      if (dupes.length) throw new Error(label + ' 重复定义：' + dupes.join('、'));

      files[file] = after;
      if (touched.indexOf(file) < 0) touched.push(file);
    });
    return touched;
  }

  function validatePlan(files, plan, editable, opts) {
    opts = opts || {};
    var out = Object.assign({}, files);
    var touched = [];
    var mode = plan && plan.mode === 'rewrite' ? 'rewrite' : 'patch';

    if (mode === 'rewrite') {
      var rewrites = Array.isArray(plan.rewrites) ? plan.rewrites : [];
      if (!rewrites.length) throw new Error('rewrite 模式却没有 rewrites');
      if (rewrites.length > (opts.maxRewrites || 3)) throw new Error('一次最多重写 3 个文件');
      rewrites.forEach(function (r, idx) {
        var file = String((r && r.file) || '');
        var label = '第 ' + (idx + 1) + ' 份';
        if (editable && editable.indexOf(file) < 0) throw new Error('不允许重写 ' + file);
        var content = String((r && r.content) || '');
        if (content.length < 1500) throw new Error(label + ' 太短，像是被截断');
        if (content.length > 90000) throw new Error(label + ' 超过 90KB');
        if (/(…省略|\.\.\.\s*省略|truncated|其余不变)/i.test(content)) throw new Error(label + ' 含省略标记');
        var ratio = content.length / Math.max(1, String(files[file] || '').length);
        if (ratio < 0.55) throw new Error(label + ' 比原文短太多（' + Math.round(ratio * 100) + '%），可能漏功能');
        var bad = forbidden(content);
        if (bad) throw new Error(label + ' 含被禁止的写法：' + bad);
        var bal = balance(content);
        if (!bal.ok) throw new Error(label + ' 括号不配平：' + bal.reason);
        out[file] = content;
        if (touched.indexOf(file) < 0) touched.push(file);
      });

      var creates = Array.isArray(plan.creates) ? plan.creates : [];
      if (creates.length > (opts.maxCreates || 2)) throw new Error('一次最多新建 2 个文件');
      creates.forEach(function (c) {
        var file = String((c && c.file) || '');
        if (!/^assets\/[a-z0-9._/-]+\.(js|css)$/i.test(file)) throw new Error('新文件名不合法：' + file);
        if (out[file]) throw new Error(file + ' 已经存在');
        var content = String((c && c.content) || '');
        if (!content.trim()) throw new Error('新文件内容是空的');
        if (content.length > 60000) throw new Error('新文件超过 60KB');
        var bad = forbidden(content);
        if (bad) throw new Error('新文件含被禁止的写法：' + bad);
        var bal = balance(content);
        if (!bal.ok) throw new Error('新文件括号不配平：' + bal.reason);
        if (file.slice(-3) === '.js' && String(out['index.html'] || '').indexOf(file) < 0) {
          throw new Error('新脚本 ' + file + ' 没在 index.html 里引用，加了也不会加载');
        }
        out[file] = content;
        touched.push(file);
      });
    }

    if (Array.isArray(plan.patches) && plan.patches.length) {
      applyPatches(out, plan.patches, editable, opts).forEach(function (f) {
        if (touched.indexOf(f) < 0) touched.push(f);
      });
    }

    if (!touched.length) throw new Error('这一版没有任何改动');
    return { files: out, touched: touched, mode: mode };
  }

  function parseVersion(v) {
    var m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function cmpVersion(a, b) {
    var A = parseVersion(a) || [0, 0, 0];
    var B = parseVersion(b) || [0, 0, 0];
    for (var i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return 0;
  }

  function bumpVersion(cur, type) {
    var p = parseVersion(cur) || [1, 0, 0];
    if (type === 'major') return (p[0] + 1) + '.0.0';
    if (type === 'minor') return p[0] + '.' + (p[1] + 1) + '.0';
    return p[0] + '.' + p[1] + '.' + (p[2] + 1);
  }

  function nextVersion(cur, suggested, type) {
    var base = bumpVersion(cur, type || 'patch');
    if (parseVersion(suggested) && cmpVersion(suggested, cur) > 0) {
      /* 模型给的版本必须和 bump 类型一致，避免 patch 改动跳大版本 */
      var S = parseVersion(suggested);
      var B = parseVersion(base);
      if (type === 'major' && S[1] === 0 && S[2] === 0) return suggested;
      if (type === 'minor' && S[0] === B[0] && S[2] === 0) return suggested;
      if (!type || type === 'patch') {
        if (S[0] === B[0] && S[1] === B[1]) return suggested;
      }
    }
    return base;
  }

  return {
    balance: balance,
    forbidden: forbidden,
    defsIn: defsIn,
    hasDef: hasDef,
    applyPatches: applyPatches,
    validatePlan: validatePlan,
    parseVersion: parseVersion,
    cmpVersion: cmpVersion,
    bumpVersion: bumpVersion,
    nextVersion: nextVersion
  };
});
