/* CI 端到端 UI 入口（Q95：让 tests/ui-check.mjs 真的进 CI）。
 *
 * 和本地脚本的区别：
 *   1. 浏览器按「环境变量 → Playwright 缓存 → 系统路径」解析，CI 上不用改脚本；
 *   2. --dry 模式不起浏览器，只验证后端/静态服务器 + index.html + 所有 assets；
 *   3. 失败时把截图和 summary.json 写进 --shot-dir（CI 里当 artifact 上传）；
 *   4. 依赖只用了 Node 内置模块（CDP 直连浏览器），不新增 npm 依赖。
 *
 * 用法：
 *   node tests/ui-ci.mjs                     # 完整端到端（python 后端 + 假模型 + 无头 Chromium）
 *   node tests/ui-ci.mjs --dry               # 只做资源/HTTP 预检
 *   node tests/ui-ci.mjs --dry --static      # 不用 python、不用浏览器：node 内置静态服务器 + 资源检查
 *   node tests/ui-ci.mjs --browser=<路径> --shot-dir=<目录>
 *
 * 环境变量：XN_CHROME / CHROME_PATH / CHROME_BIN 指定浏览器；XN_SHOT_DIR 覆盖截图目录；
 *           XN_PYTHON 指定 python（默认 Windows 用 python，其他平台用 python3）。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUiCheck, resolveBrowser, parseUiArgs, pythonBin } from './ui-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法：node tests/ui-ci.mjs [--dry] [--static] [--browser=<路径>] [--shot-dir=<目录>]

  （无参数）        完整端到端：起 python 后端 + 假模型 + 无头 Chromium，跑 18 项 UI 检查
  --dry            不起浏览器；--static 时不依赖 python，用 node 内置静态服务器发页面
  --browser=...    指定浏览器可执行文件（CI 里由 guard.yml 的 ui job 写进 XN_CHROME 也行）
  --shot-dir=...   失败截图和 summary.json 的目录，默认 coverage/ui-e2e/`;

function log(line = '') {
  process.stdout.write(line + '\n');
}

function checkRuntime(opts) {
  if (!opts.dry && typeof WebSocket === 'undefined') {
    throw new Error(`当前 Node ${process.version} 没有全局 WebSocket；端到端模式需要 Node 22+`);
  }
  if (!opts.staticOnly) {
    const py = pythonBin();
    const probe = spawnSync(py, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `找不到 python（尝试执行 ${py} --version）。\n` +
        'CI 里用 actions/setup-python 装；本地只想验证页面资源可以跑 node tests/ui-ci.mjs --dry --static'
      );
    }
  }
}

async function main(argv) {
  const startedAt = Date.now();
  const opts = parseUiArgs(argv);
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const shotDir = resolve(root, opts.shotDir || join('coverage', 'ui-e2e'));
  const mode = opts.dry ? (opts.staticOnly ? 'dry+static' : 'dry') : 'browser';

  log(`小暖 UI 端到端检查（${mode}）`);
  log(`  node    ${process.version}`);
  log(`  python  ${pythonBin()}`);
  log(`  截图    ${relative(root, shotDir) || shotDir}`);

  checkRuntime(opts);

  let browser = null;
  if (!opts.dry) {
    browser = await resolveBrowser(opts.browserPath);
    log(`  浏览器  ${browser}`);
    log('');
  }

  const r = await runUiCheck({ ...opts, browserPath: browser || opts.browserPath, shotDir });

  const passed = r.results.filter((x) => x.ok).length;
  const failed = r.results.length - passed;
  const durationMs = Date.now() - startedAt;

  if (r.log && r.log.trim()) {
    const tail = r.log.trim().split('\n').slice(-40).join('\n');
    log(`\n--- 后端日志（末尾 40 行）---\n${tail}`);
    /* 失败时把完整后端日志也留在 artifact 里，省得回头翻 CI 控制台。 */
    if (!r.ok) {
      try {
        await mkdir(shotDir, { recursive: true });
        await writeFile(join(shotDir, 'backend.log'), r.log);
      } catch (e) { /* 写不进去也不影响判定 */ }
    }
  }
  log(`\n结果：${passed} 通过 / ${failed} 失败，耗时 ${(durationMs / 1000).toFixed(1)}s`);
  if (r.shots.length) log('截图：' + r.shots.map((s) => relative(root, s)).join(', '));

  try {
    await mkdir(shotDir, { recursive: true });
    await writeFile(join(shotDir, 'summary.json'), JSON.stringify({
      ok: r.ok,
      mode: r.mode,
      node: process.version,
      python: pythonBin(),
      browser,
      durationMs,
      checks: r.results,
      shots: r.shots.map((s) => relative(root, s)),
      error: r.error ? String(r.error.message || r.error) : null
    }, null, 2) + '\n');
    log(`报告：${relative(root, join(shotDir, 'summary.json'))}`);
  } catch (e) {
    log('写 summary.json 失败：' + e.message);
  }

  if (!r.ok) {
    log(`\nUI 检查失败：${failed} 项${r.error ? '（脚本异常：' + r.error.message + '）' : ''}`);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write('\n' + (e && e.stack || String(e)) + '\n');
    process.stderr.write('\nCI 里常见处理：\n' +
      '  - 没有浏览器：ubuntu runner 自带 /usr/bin/google-chrome；没有就 npx playwright install chromium，脚本会自动用 ~/.cache/ms-playwright 里的 chromium\n' +
      '  - 没有 python：actions/setup-python 装 3.12\n' +
      '  - 只想确认页面资源没坏：node tests/ui-ci.mjs --dry --static\n');
    process.exitCode = 1;
  });
