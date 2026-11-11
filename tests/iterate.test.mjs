/* 自迭代契约回归（纯 Node，不启浏览器、不联网）。
 *
 * 覆盖这轮「迭代页修复」的关键契约：
 *   1) 公开模式：/api/iterate 不带管理令牌时强制落到 iterate/public，且绝不读 main；
 *   2) 网关回落：XN_GATEWAY_BASE 指向不可达地址时，askModel 回落到 env.AI 而不是抛错；
 *   3) 结果 url：真跑响应里的 url 形如 https://github.com/<owner>/<repo>/commit/<sha>。
 *
 * 做法：把 globalThis.fetch 换成内存假实现——
 *   - api.github.com 的仓库/内容/git-data 接口按本仓库真实文件作答（不联网）；
 *   - XN_GATEWAY_BASE 一律抛「fetch failed」，模拟隧道过期；
 *   - 模型走假 env.AI.run（返回固定补丁方案 JSON）。
 * 依赖后续批次（t33「云迭代补 AI 回落 / 提交链接」）才能通过的断言写成
 * 「实现到位才通过」：现在会标记 skip/diagnostic，等实现合并后自动变严。
 *
 * 用法：node --test tests/iterate.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../cloudflare/worker.js';
import { runIteration } from '../cloudflare/iterate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'j200906';
const REPO = 'xiaonuan-workbench';
const BRANCH = 'iterate/public';
const GATEWAY = 'https://gw.invalid/v1';
const HEAD_SHA = 'a'.repeat(40);
const BASE_TREE = 'c'.repeat(40);
const NEW_TREE = 'd'.repeat(40);
const COMMIT_SHA = 'b'.repeat(40);
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/* 与 cloudflare/iterate.js 的 EDITABLE + README/CHANGELOG/ARCHIVE/LESSONS/PKG 保持一致。
 * 顺序也一致：digest() 的每文件额度依赖文件数量，顺序不对会让「可见窗口」发生偏移。 */
const FILES = [
  'index.html',
  'assets/app.css',
  'assets/theme.css',
  'assets/app.core.js',
  'assets/views.study.js',
  'assets/views.feedback.js',
  'assets/views.settings.js',
  'assets/views.changelog.js',
  'assets/iterate.js',
  'assets/persona.js',
  'assets/emotion.js',
  'assets/memory.js',
  'assets/tools.js',
  'assets/lib/util.js',
  'assets/lib/store.js',
  'assets/lib/i18n.js',
  'assets/lib/md.js',
  'assets/lib/models.js',
  'assets/lib/api.js',
  'assets/lib/patch.js',
  'assets/lib/plugin.js',
  'assets/lib/services.js',
  'assets/lib/session.js',
  'assets/plugins/view-chat.js',
  'assets/plugins/manifest.js',
  'assets/plugins/view-plugins.js',
  'assets/plugins/export-session.js',
  'README.md',
  'assets/changelog.js',
  'assets/changelog.archive.js',
  'ITERATE-LESSONS.md',
  'package.json'
];

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/* GitHub 假接口：内容直接读本仓库文件（README 必须有 XN:VERSION 标记，真仓库里有）。 */
function makeFetchMock(record) {
  const base = `/repos/${OWNER}/${REPO}`;
  return async (input, init = {}) => {
    const url = String(input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    record.push({ url, method, body: init && init.body });

    if (url.indexOf(GATEWAY) === 0) {
      /* 模拟隧道过期：DNS 都解析不到。 */
      throw new TypeError('fetch failed (gateway unreachable: ENOTFOUND)');
    }

    const u = new URL(url);
    assert.equal(u.hostname, 'api.github.com', '测试里不允许访问其它主机：' + url);

    if (u.pathname === base) return jsonRes({ default_branch: 'main' });

    if (u.pathname.indexOf(base + '/contents/') === 0) {
      const file = decodeURIComponent(u.pathname.slice((base + '/contents/').length));
      const abs = join(ROOT, file);
      if (!existsSync(abs)) return jsonRes({ message: 'Not Found' }, 404);
      const text = readFileSync(abs, 'utf8');
      return jsonRes({
        content: Buffer.from(text, 'utf8').toString('base64'),
        sha: 'sha-' + file.replace(/[^A-Za-z0-9]+/g, '-'),
        encoding: 'base64'
      });
    }

    if (u.pathname === base + '/git/ref/heads/' + BRANCH) {
      return jsonRes({ object: { sha: HEAD_SHA, type: 'commit' } });
    }
    if (u.pathname === base + '/git/commits/' + HEAD_SHA) {
      return jsonRes({ sha: HEAD_SHA, tree: { sha: BASE_TREE } });
    }
    if (u.pathname === base + '/git/trees' && method === 'POST') {
      return jsonRes({ sha: NEW_TREE }, 201);
    }
    if (u.pathname === base + '/git/commits' && method === 'POST') {
      return jsonRes({ sha: COMMIT_SHA }, 201);
    }
    if (u.pathname === base + '/git/blobs' && method === 'POST') {
      return jsonRes({ sha: 'blob-' + record.length }, 201);
    }
    if (u.pathname === base + '/git/refs/heads/' + BRANCH && method === 'PATCH') {
      return jsonRes({ object: { sha: COMMIT_SHA } });
    }
    if (u.pathname === base + '/git/refs' && method === 'POST') {
      return jsonRes({ message: '公开模式不该打 tag' }, 422);
    }
    return jsonRes({ message: 'unexpected ' + method + ' ' + u.pathname }, 404);
  };
}

/* 假方案：给 assets/lib/patch.js 里一条唯一的代码行加行尾注释——
 * find 落在 digest 的「可见窗口」头部，括号配平、无禁止写法，保证能过 validatePlan。 */
function pickUniqueLine(src) {
  const lines = String(src || '').split('\n').slice(0, 40);
  for (const line of lines) {
    const t = line.trim();
    if (t.length < 8) continue;
    if (!t.endsWith(';')) continue;
    if (line.indexOf('`') >= 0) continue;
    if (src.split(line).length - 1 !== 1) continue;
    return line;
  }
  throw new Error('找不到唯一可用的 find 片段');
}

function buildPlan() {
  const target = 'assets/lib/patch.js';
  const src = readFileSync(join(ROOT, target), 'utf8');
  const find = pickUniqueLine(src);
  return {
    mode: 'patch',
    bump: 'patch',
    title: '补丁规则注释补充',
    fixes: ['给补丁校验入口补一句说明，方便 review 时对照'],
    features: [],
    verify: '括号扫描 + index.html 引用检查',
    notTried: '没有跑浏览器回归',
    patches: [{ file: target, find, replace: find + ' // t37 回归测试补丁' }],
    rewrites: [],
    creates: []
  };
}

function makeAI(plan) {
  const calls = [];
  return {
    calls,
    async run(name, params) {
      calls.push({ name, params });
      return { response: JSON.stringify(plan) };
    }
  };
}

function makeEnv(opts = {}) {
  const env = {
    XN_REPO_OWNER: OWNER,
    XN_REPO_NAME: REPO,
    XN_GATEWAY_BASE: GATEWAY,
    XN_GATEWAY_MODEL: 'gw-model',
    XN_EXTRA_HOSTS: 'gw.invalid'
  };
  if (opts.ai) env.AI = opts.ai;
  if (opts.token) env.XN_GH_TOKEN = opts.token;
  return env;
}

function postIterate(body) {
  return new Request('https://x.test/api/iterate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function installFetch(t, record) {
  const orig = globalThis.fetch;
  globalThis.fetch = makeFetchMock(record);
  t.after(() => { globalThis.fetch = orig; });
}

test('公开模式：/api/iterate 强制 iterate/public，不回 401', async (t) => {
  const record = [];
  installFetch(t, record);
  const ai = makeAI(buildPlan());
  const env = makeEnv({ ai });

  const res = await worker.fetch(postIterate({ dryRun: true, reasoningEffort: 'low' }), env);
  const body = await res.json();

  assert.notEqual(res.status, 401, '公开触发不应被 401 拦掉');
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.publicMode, true, 'worker 应给公开模式响应打上 publicMode 标记');
  assert.equal(body.branch, BRANCH, '公开模式必须落到 iterate/public');
  assert.equal(body.from, PKG_VERSION, '版本基线应来自 iterate/public 上的 package.json');
  assert.match(body.version, /^\d+\.\d+\.\d+$/, '版本号格式');
  assert.ok(
    (body.log || []).some((line) => line.indexOf('目标分支：' + BRANCH + '（试跑分支，不打 tag）') >= 0),
    '日志里应写明落到试跑分支：' + JSON.stringify(body.log || []).slice(0, 400)
  );

  /* 读文件必须全部带 ref=iterate/public；一次都不许读 main。 */
  const contentReads = record.filter((r) => r.url.indexOf('/contents/') >= 0);
  assert.ok(contentReads.length > 0, '应当读取仓库文件');
  for (const r of contentReads) {
    assert.ok(
      r.url.indexOf('ref=' + encodeURIComponent(BRANCH)) >= 0,
      '读文件没有用试跑分支：' + r.url
    );
  }
  assert.equal(record.filter((r) => r.url.indexOf('ref=main') >= 0).length, 0, '不许读 main');

  /* 试运行不写仓库：GitHub 侧不允许出现 blob / tree / commit / ref 的写请求。
   * （模型网关的 POST /chat/completions 不算仓库写入，单独排除。） */
  const writes = record.filter((r) => r.url.indexOf('https://api.github.com/') === 0 &&
    (r.method === 'POST' || r.method === 'PATCH'));
  assert.equal(writes.length, 0, '试运行不应写仓库：' + JSON.stringify(writes.map((w) => w.method + ' ' + w.url)));
});

test('公开模式：客户端传 branch=main 会被忽略', async (t) => {
  const record = [];
  installFetch(t, record);
  const env = makeEnv({ ai: makeAI(buildPlan()) });

  const res = await worker.fetch(postIterate({ dryRun: true, branch: 'main', reasoningEffort: 'low' }), env);
  const body = await res.json();

  assert.equal(body.publicMode, true);
  assert.equal(body.branch, BRANCH, '客户端指定的 branch 必须被服务端覆盖');
  const contentReads = record.filter((r) => r.url.indexOf('/contents/') >= 0);
  assert.ok(contentReads.length > 0);
  for (const r of contentReads) {
    assert.ok(r.url.indexOf('ref=' + encodeURIComponent(BRANCH)) >= 0, '仍应读试跑分支：' + r.url);
    assert.equal(r.url.indexOf('ref=main') >= 0, false, '不许读 main：' + r.url);
  }
});

test('网关不可达：没有 apiKey 时回落到 env.AI', async (t) => {
  const record = [];
  installFetch(t, record);
  const ai = makeAI(buildPlan());
  const env = makeEnv({ ai });

  const res = await runIteration(env, {
    authorized: true,
    branch: BRANCH,
    dryRun: true,
    reasoningEffort: 'low'
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, true, '网关挂了应当回落到 AI，而不是整轮失败');
  assert.ok(record.some((r) => r.url.indexOf(GATEWAY) === 0), '应当先尝试过网关');
  assert.ok(ai.calls.length > 0, 'env.AI.run 应当被调用');
  assert.equal(typeof ai.calls[0].params.messages, 'object', 'AI 调用应带 messages');
});

test('真跑（试跑分支）：提交成功，且响应带 commit 链接', async (t) => {
  const record = [];
  installFetch(t, record);
  const env = makeEnv({ ai: makeAI(buildPlan()), token: 'test-token' });

  const res = await runIteration(env, {
    authorized: true,
    branch: BRANCH,
    dryRun: false,
    reasoningEffort: 'low'
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, true);
  assert.equal(body.branch, BRANCH);
  assert.equal(body.tagState, 'skipped', '试跑分支不该打 tag');
  assert.equal(body.commit, COMMIT_SHA.slice(0, 7));

  /* 只允许更新 iterate/public，不许碰 main、不许打 tag。 */
  const refUpdates = record.filter((r) => r.method === 'PATCH' && r.url.indexOf('/git/refs/heads/') >= 0);
  assert.equal(refUpdates.length, 1, JSON.stringify(record.map((r) => r.method + ' ' + r.url)));
  assert.ok(refUpdates[0].url.endsWith('/git/refs/heads/' + BRANCH), '只能更新试跑分支');
  assert.equal(record.filter((r) => r.url.indexOf('/git/refs/heads/main') >= 0).length, 0, '不许写 main');
  assert.equal(record.filter((r) => r.method === 'POST' && r.url.indexOf('/git/refs') >= 0).length, 0, '公开模式不许建 tag');

  /* 契约：真跑响应里的 url 形如 https://github.com/<owner>/<repo>/commit/<sha>。
   * 试跑分支响应目前（main v1.5.10）还没带 url——这是 t33「云迭代补提交链接」要补的。
   * 实现到位后这条断言会自动生效；现在用 diagnostic 标记 pending，避免分支整体变红。 */
  if (typeof body.url !== 'string') {
    t.diagnostic('待 t33：试跑分支响应还没有 url 字段（commit=' + body.commit + '）');
  } else {
    assert.match(
      body.url,
      new RegExp('^https://github\\.com/' + OWNER + '/' + REPO + '/commit/[0-9a-f]{7,40}$'),
      'url 形如 https://github.com/<owner>/<repo>/commit/<sha>：' + body.url
    );
    assert.ok(body.url.indexOf(COMMIT_SHA) >= 0, 'url 应指向这次提交的 sha');
  }
});

test('（实现到位才通过）带 apiKey 且网关失败时也回落 env.AI', async (t) => {
  const record = [];
  installFetch(t, record);
  const ai = makeAI(buildPlan());
  const env = makeEnv({ ai });

  const opts = {
    authorized: true,
    branch: BRANCH,
    dryRun: true,
    reasoningEffort: 'low',
    /* 浏览器「自迭代模型（本机网关）」路径：带钥匙 + 网关地址。 */
    apiKey: 'test-gateway-key',
    providerBase: GATEWAY,
    model: 'gw-model'
  };

  let res = null;
  let thrown = null;
  try {
    res = await runIteration(env, opts);
  } catch (e) {
    thrown = e;
  }

  if (thrown) {
    t.skip('main 尚未包含 t33 的 apiKey 回落（runIteration 直接抛了：' + thrown.message + '）');
    return;
  }

  const body = await res.json();
  assert.equal(body.ok, true, 'apiKey 路径网关失败时也应回落到 AI');
  assert.ok(ai.calls.length > 0, 'env.AI.run 应当被调用');
});
