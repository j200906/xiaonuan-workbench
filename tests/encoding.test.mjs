/* 编码护栏：仓库里任何文本文件都不许出现「双重编码」乱码或 BOM。
 *
 * 背景：一次 PowerShell 读写把 app.py / iterate.js / package.json 的中文
 * 双重编码了（小暖 → å°æš­），导致自迭代提示词失效、接口 502，而且是
 * 静默的——测试全绿，只有线上出错。这条测试就是为了让这种情况立刻红。
 *
 * 注意：本文件自己就是检测器，里面用 charCode 构造模式、并从扫描里排除，
 * 否则会自己命中自己（CI 上曾因此红过一次）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tests/encoding.test.mjs';
const TEXT_EXT = /\.(js|mjs|css|html|md|json|py|yml|yaml|txt|ps1)$/i;

/* 双重编码的典型双字节：0xC3/0xC2/0xE5… 后面跟一个续字节 */
const LEAD = [0xc3, 0xc2, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef]
  .map((c) => String.fromCharCode(c))
  .join('');
const MOJIBAKE = new RegExp('[' + LEAD + '][\\u0080-\\u00BF]');

function trackedFiles() {
  const out = execSync('git ls-files', { cwd: root, maxBuffer: 20 * 1024 * 1024 }).toString();
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => TEXT_EXT.test(f))
    .filter((f) => f !== SELF);
}

test('编码护栏：没有双重编码的中文，也没有 BOM', () => {
  const files = trackedFiles();
  assert.ok(files.length > 30, '应当扫到足够多的文本文件，实际 ' + files.length);

  const corrupted = [];
  const bom = [];
  for (const f of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(root, f));
    } catch (e) {
      continue;
    }
    if (buf.length > 3 * 1024 * 1024) continue;
    const text = buf.toString('utf8');
    if (MOJIBAKE.test(text)) corrupted.push(f);
    if (text.charCodeAt(0) === 0xfeff) bom.push(f);
  }

  assert.deepEqual(corrupted, [], '这些文件疑似被双重编码（中文变乱码）：' + JSON.stringify(corrupted));
  assert.deepEqual(bom, [], '这些文件带 BOM，会让 JSON.parse / 某些工具出错：' + JSON.stringify(bom));
});

test('编码护栏：关键中文文案仍然可读（防止静默损坏）', () => {
  const anchors = [
    ['server/app.py', '你是代码修改计划器'],
    ['cloudflare/iterate.js', '自迭代'],
    ['assets/lib/i18n.js', '学习台'],
    ['package.json', '小暖']
  ];
  for (const [file, text] of anchors) {
    const body = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(body.includes(text), file + ' 里应当还能读到「' + text + '」，现在读不到（可能被编码破坏）');
  }
});
