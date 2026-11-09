/**
 * 小暖 · 自迭代补丁规则（服务端）
 * 与 assets/lib/patch.js 保持同一套判定：唯一命中、禁止写法、括号配平、重复定义。
 * 服务端不能 new Function，所以这里用字符串/注释感知的扫描器代替语法检查。
 */

const FORBIDDEN = [
  { re: /\beval\s*\(/, label: 'eval' },
  { re: /new\s+Function\s*\(/, label: 'new Function' },
  { re: /document\.write\s*\(/, label: 'document.write' },
  { re: /<script[^>]+src\s*=\s*["']https?:/i, label: '外链脚本' },
  { re: /javascript\s*:/i, label: 'javascript: 伪协议' }
];

const CONTROL = ['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'constructor'];

export function forbidden(text) {
  const s = String(text || '');
  for (const f of FORBIDDEN) if (f.re.test(s)) return f.label;
  return '';
}

export function balance(src) {
  const s = String(src || '');
  const stack = [];
  let tpl = 0;
  let mode = 'code';
  let quote = '';
  let i = 0;

  while (i < s.length) {
    const ch = s.charAt(i);
    const next = s.charAt(i + 1);

    if (mode === 'line') { if (ch === '\n') mode = 'code'; i++; continue; }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; } i++; continue; }
    if (mode === 'str') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) mode = 'code';
      i++;
      continue;
    }
    if (mode === 'tpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { mode = 'code'; i++; continue; }
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

    if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
    if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
    if (ch === "'" || ch === '"') { mode = 'str'; quote = ch; i++; continue; }
    if (ch === '`') { mode = 'tpl'; i++; continue; }

    if (ch === '(' || ch === '[' || ch === '{') { stack.push(ch); i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      const want = ch === ')' ? '(' : (ch === ']' ? '[' : '{');
      if (!stack.length) {
        if (ch === '}' && tpl > 0) { tpl--; stack.push('${'); mode = 'tpl'; i++; continue; }
        return { ok: false, reason: '多了一个 ' + ch };
      }
      const top = stack.pop();
      if (top !== want) {
        if (top === '${' && ch === '}') { tpl--; mode = 'tpl'; i++; continue; }
        return { ok: false, reason: '括号不匹配：' + top + ' 对上了 ' + ch };
      }
      i++;
      continue;
    }
    i++;
  }

  if (mode === 'str') return { ok: false, reason: '字符串没有闭合' };
  if (mode === 'block') return { ok: false, reason: '块注释没有闭合' };
  if (mode === 'tpl' || tpl > 0) return { ok: false, reason: '模板字符串没有闭合' };
  if (stack.length) return { ok: false, reason: '还有 ' + stack.length + ' 个括号没闭合' };
  return { ok: true, reason: '' };
}

function defsIn(code) {
  const out = [];
  const s = String(code || '');
  const res = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\{|extends\b)/g,
    /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g
  ];
  for (const r of res) {
    let m;
    while ((m = r.exec(s)) !== null) {
      if (CONTROL.indexOf(m[1]) < 0) out.push(m[1]);
    }
  }
  return out;
}

function hasDef(source, name) {
  const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp('\\bfunction\\s+' + n + '\\s*\\('),
    new RegExp('\\b(?:const|let|var)\\s+' + n + '\\b'),
    new RegExp('\\bclass\\s+' + n + '\\b')
  ].some((re) => re.test(source));
}

export function applyPatches(files, patches, editable, opts = {}) {
  const max = opts.maxPatches || 8;
  if (!Array.isArray(patches) || !patches.length) throw new Error('没有补丁');
  if (patches.length > max) throw new Error('补丁条数超过上限 ' + max);

  const touched = [];
  patches.forEach((p, idx) => {
    const label = '第 ' + (idx + 1) + ' 处';
    const file = String((p && p.file) || '');
    if (editable && editable.indexOf(file) < 0) throw new Error('不允许改 ' + file);

    const find = String((p && p.find) || '');
    const replace = String((p && p.replace) || '');
    if (find.length < 8) throw new Error(label + ' find 太短，容易误伤');
    if (find.length > 8000) throw new Error(label + ' find 太长');
    if (replace.length > 24000) throw new Error(label + ' 改动过大');

    const bad = forbidden(replace);
    if (bad) throw new Error(label + ' 含被禁止的写法：' + bad);

    const source = files[file];
    if (typeof source !== 'string') throw new Error('读不到 ' + file);
    const first = source.indexOf(find);
    if (first < 0) throw new Error(label + ' 在 ' + file + ' 里找不到原文');
    if (source.indexOf(find, first + 1) >= 0) throw new Error(label + ' 原文不唯一');

    const after = source.slice(0, first) + replace + source.slice(first + find.length);
    const bal = balance(after);
    if (!bal.ok) throw new Error(label + ' 会让 ' + file + ' 括号不配平：' + bal.reason);

    const dupes = defsIn(replace).filter((name) => hasDef(source, name) && !hasDef(find, name));
    if (dupes.length) throw new Error(label + ' 重复定义：' + dupes.join('、'));

    files[file] = after;
    if (touched.indexOf(file) < 0) touched.push(file);
  });
  return touched;
}

export function validatePlan(files, plan, editable, opts = {}) {
  const out = Object.assign({}, files);
  const touched = [];
  const mode = plan && plan.mode === 'rewrite' ? 'rewrite' : 'patch';

  if (mode === 'rewrite') {
    const rewrites = Array.isArray(plan.rewrites) ? plan.rewrites : [];
    if (!rewrites.length) throw new Error('rewrite 模式却没有 rewrites');
    if (rewrites.length > (opts.maxRewrites || 3)) throw new Error('一次最多重写 3 个文件');
    rewrites.forEach((r, idx) => {
      const file = String((r && r.file) || '');
      const label = '第 ' + (idx + 1) + ' 份';
      if (editable && editable.indexOf(file) < 0) throw new Error('不允许重写 ' + file);
      const content = String((r && r.content) || '');
      if (content.length < 1500) throw new Error(label + ' 太短，像是被截断');
      if (content.length > 90000) throw new Error(label + ' 超过 90KB');
      if (/(…省略|\.\.\.\s*省略|truncated|其余不变)/i.test(content)) throw new Error(label + ' 含省略标记');
      const ratio = content.length / Math.max(1, String(files[file] || '').length);
      if (ratio < 0.55) throw new Error(label + ' 比原文短太多（' + Math.round(ratio * 100) + '%），可能漏功能');
      const bad = forbidden(content);
      if (bad) throw new Error(label + ' 含被禁止的写法：' + bad);
      const bal = balance(content);
      if (!bal.ok) throw new Error(label + ' 括号不配平：' + bal.reason);
      out[file] = content;
      if (touched.indexOf(file) < 0) touched.push(file);
    });

    const creates = Array.isArray(plan.creates) ? plan.creates : [];
    if (creates.length > (opts.maxCreates || 2)) throw new Error('一次最多新建 2 个文件');
    creates.forEach((c) => {
      const file = String((c && c.file) || '');
      if (!/^assets\/[a-z0-9._/-]+\.(js|css)$/i.test(file)) throw new Error('新文件名不合法：' + file);
      if (out[file]) throw new Error(file + ' 已经存在');
      const content = String((c && c.content) || '');
      if (!content.trim()) throw new Error('新文件内容是空的');
      if (content.length > 60000) throw new Error('新文件超过 60KB');
      const bad = forbidden(content);
      if (bad) throw new Error('新文件含被禁止的写法：' + bad);
      const bal = balance(content);
      if (!bal.ok) throw new Error('新文件括号不配平：' + bal.reason);
      if (file.slice(-3) === '.js' && String(out['index.html'] || '').indexOf(file) < 0) {
        throw new Error('新脚本 ' + file + ' 没在 index.html 里引用，加了也不会加载');
      }
      out[file] = content;
      touched.push(file);
    });
  }

  if (Array.isArray(plan.patches) && plan.patches.length) {
    applyPatches(out, plan.patches, editable, opts).forEach((f) => {
      if (touched.indexOf(f) < 0) touched.push(f);
    });
  }

  if (!touched.length) throw new Error('这一版没有任何改动');
  return { files: out, touched, mode };
}
