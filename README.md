# 小暖

一个可以对话、记笔记、收反馈、自己改自己的学习工作台。

- 线上（带后端）：<https://xiaonuan-app.pages.dev>
- 静态站（GitHub Pages）：<https://j200906.github.io/xiaonuan-workbench/>
- 仓库：<https://github.com/j200906/xiaonuan-workbench>
- Windows 桌面版：<https://github.com/j200906/xiaonuan-workbench/releases/latest>

<!-- XN:VERSION -->
当前版本 **v1.5.4**
<!-- /XN:VERSION -->

<!-- XN:RECENT -->
- **v1.5.4** Q61–Q100：发布链路、自迭代与安全收口
- **v1.5.3** 修更新日志对比漏版本
- **v1.5.2** 网关地址每次下发都生效
- **v1.5.1** 本地版能用了：人格可见、网关直连、迭代写本地
- **v1.5.0** 100 条体检全部处理
<!-- /XN:RECENT -->

---

## 它是什么

打开就是对话：左边是会话，中间是聊天，另外几页放今日目标、专注计时、笔记和反馈箱。
聊天记录、笔记、目标、计时都存在浏览器本机；换设备不同步，清缓存会丢，重要内容请导出。

小暖的人设、三种说话方式、情绪护栏来自 `xiaonuan_v5.8.py` 的对齐版本：
不装懂、不编记忆、不说"我永远爱你"这种兑现不了的承诺。

## 三种用法

### 1. 直接用线上版

<https://xiaonuan-app.pages.dev>

服务器没配 Key 时，云端自带一个 GLM-4.7-Flash 兜底；想要更好的模型，在「设置 → 模型」填自己的 Key。

### 2. 本机跑（带后端、可自迭代）

Windows 双击 **`start-local.bat`**；macOS / Linux 跑 **`./start-local.sh`**。

它会：

- 问你一次本机管理密码（只存在本次进程）
- 把模型接到本机 magpie 网关 `http://127.0.0.1:3425/v1`
- 启动后端并自动打开 `http://127.0.0.1:8080`

也可以用 `.env` / 环境变量自己起：

```bash
XN_ADMIN_PASSWORD=你的密码 \
XN_BASE=http://127.0.0.1:3425/v1 \
XN_MODEL=marvis/deepseek-v4-1-flash-261017 \
XN_GATEWAY_BASE=http://127.0.0.1:3425/v1 \
XN_GATEWAY_MODEL=marvis/deepseek-v4-1-flash-261017 \
python server/app.py --port 8080
```

本机 3425 网关不需要 Key；浏览器不能直连它（没有 CORS），所以必须经过这个本地后端。
本地模式的迭代会直接改工作区，改前自动备份到 `data/backups/`，不需要 GitHub Token。

### 3. Windows 桌面版

从 [Releases](https://github.com/j200906/xiaonuan-workbench/releases/latest) 下载 `XiaoNuan.exe`，双击即用。
数据在 `%APPDATA%\xiaonuan`。自己打包：

```bash
python -m pip install "pyinstaller==6.22.3"   # 和 CI 一致：release.yml 里 pin 的就是这个版本
python build_exe.py
```

## 目录

```text
index.html                 唯一页面（脚本全部 defer）
assets/
  lib/util.js              DOM / 格式化 / 提示队列 / 事件总线
  lib/store.js             xn.v2.* 存储、旧键迁移、配额剪枝、坏数据备份
  lib/i18n.js              中英文案与 data-i18n
  lib/md.js                Markdown：代码块、表格、嵌套列表、链接白名单
  lib/models.js            模型与服务商的唯一来源
  lib/api.js               请求、流式解析、超时/重试、上下文裁剪
  lib/patch.js             补丁校验（浏览器与 Node 共用）
  app.core.js              状态、路由、会话、发送、管理模式
  views.study.js           目标 / 计时 / 笔记
  views.feedback.js        反馈箱
  views.settings.js        外观 / 导航 / 人设 / 模型 / 管理
  views.changelog.js       更新日志
  iterate.js               自迭代界面（云端优先）
  persona.js emotion.js memory.js tools.js
server/app.py              本地后端（标准库，零依赖）
cloudflare/
  worker.js                边缘路由（Pages Functions / Workers）
  shared.js                白名单、限流、令牌版本、同源、SSRF、安全响应头
  rules.js                 服务端补丁校验
  iterate.js               云端自迭代：一次提交 + 打 tag
  lessons.js               自迭代教训库（失败记账，踩 3 次升成硬规则）
  deploy_pages.mjs         Pages 部署（默认 dry-run，--apply 才真发）
scripts/
  build-pages.mjs          组装 cloudflare/.pages（页面 + 边缘模块 + 内容哈希）
  check.mjs                本地自检：语法 / 引用 / 版本一致性 / .pages 漂移
  stamp.mjs                给静态资源写内容哈希（sha256 前 8 位）
  protect-main.sh          开 main 分支保护（要求 guard 通过、禁 force-push）
tests/
  unit.test.mjs            Markdown / 补丁规则 / SSRF / 版本一致
  pipeline.test.mjs        自迭代管线：digest、缓存 key、TTL、tag、README 块
  security.test.mjs        令牌版本、同源、反馈保留期与删除、Key 不外泄
  security-adversarial.test.mjs  对抗性复核：绕行尝试与已钉住的洞
  smoke.mjs ui-check.mjs   真后端冒烟、无头浏览器 UI 检查
  ui-ci.mjs                CI 端到端入口（自选浏览器、失败截图）
SECURITY.md PRIVACY.md     钥匙轮换 / 数据留存与删除
DEPLOY.md                  部署细节（Cloudflare / Render / 桌面版）
.env.example               环境变量模板（复制成 .env 再改）
```

## 自迭代怎么跑

「设置 → 管理模式」输入管理密码解锁后才能进「迭代」页（没解锁时点进去会退回设置页；服务端也会把未解锁的请求落到试跑分支）。

流程：

1. 读云端反馈（KV）或本机 `data/feedback.jsonl`
2. 把反馈 + 代码结构交给模型，出一个方案
3. 校验：find 必须唯一、括号配平（忽略字符串/注释）、禁止 `eval` 等写法、重复定义检测
4. 改版本号（patch/minor/major）、更新日志（最近 12 条 + 归档）、README
5. 云端用 Git Data API **一次提交**；然后打 `vX.Y.Z` tag
6. GitHub Actions 在 tag 上打 exe，成功后才创建/更新 Release

安全边界：

- 发布仓库锁在服务器（`XN_REPO_OWNER` / `XN_REPO_NAME`），客户端传什么都不认
- 管理密码只在 `/api/admin/verify` 用一次，换 12 小时 HMAC 令牌；前端不存密码
- 令牌带 `ver`：把 `XN_ADMIN_TOKEN_VERSION` 从 `1` 改成 `2`，已发会话下一次请求就 401（见 [SECURITY.md](SECURITY.md)）
- GitHub Token 只在服务器（`XN_GH_TOKEN`）：浏览器不持有、没有输入框、也不读本地存储；本地模式根本不需要
- 没解锁的请求一律落到试跑分支（`XN_PUBLIC_ITERATE_BRANCH`，默认 `iterate/public`），不写 main、不打 tag；解锁后才直接进 main
- 试运行和真跑分开记账，打满试运行不会吃掉真跑额度（具体数字见下节）
- 自迭代模型优先用你在模型条里选的服务商；选「自迭代模型（本机网关）」时走服务器下发的网关地址

## 安全模型

| 面 | 做法 |
| --- | --- |
| 管理会话 | 密码只在 `/api/admin/verify` 用一次，换 12 小时 HMAC 令牌；令牌带版本号，`XN_ADMIN_TOKEN_VERSION` 一改全部吊销 |
| 同源 / CSRF | 有 `Origin` 就必须同源或在 `XN_ALLOWED_ORIGINS` 白名单；`Sec-Fetch-Site: cross-site` 一律 403；`XN_REQUIRE_ORIGIN=1` 时缺 `Origin` 也拒 |
| 聊天代理 | 30 次/分钟/IP，请求体 256KB 上限；服务端 Key 只允许白名单模型 |
| 搜索 / 抓网页 | 同源 + 浏览器同站校验 + 限流（20 次/分钟、10 次/分钟/IP）；结果缓存 10 分钟 |
| SSRF | 解析 IP 字面量（含 `0x7f`、十进制、缩写），DoH 校验解析结果，重定向逐跳复核 |
| 反馈 | 5 次/分钟/IP，正文 ≤2000 字；保留期默认 180 天（`XN_FEEDBACK_TTL_DAYS`，1–365）；管理员可 `DELETE /api/feedback`（`?all=1` / `?id=` / `?before=`）；IP 只存按天加盐哈希 |
| 自迭代 | 试运行与真跑分开计数：公开 8 / 4 次/小时，解锁后 20 / 10 次/小时；512KB 上限；单提交 + 打 tag |
| 响应头 | CSP、X-Frame-Options、Referrer-Policy、Permissions-Policy、COOP |
| 本机存储 | `xn.v2.*`，坏数据备份后重置，配额满先剪枝再提示 |
| Key | 默认只进 sessionStorage；勾「记住」才写 localStorage；`X-Admin-Token` 绝不会被当模型 Key 转发 |
| 隧道钥匙 | 默认写到用户目录（`%APPDATA%\xiaonuan\tunnel-key.txt`），不再进仓库 |

## 安全与隐私

- 钥匙怎么轮换、泄露了怎么办、哪些边界还没做：[SECURITY.md](SECURITY.md)
- 数据存在哪、保留多久、怎么删：[PRIVACY.md](PRIVACY.md)

## 环境变量

复制仓库根目录的 `.env.example` 成 `.env`：本地后端（`server/app.py`）、`start-local.*` 和 `cloudflare/deploy_pages.mjs` 都会读它。
边缘（Cloudflare Pages / Workers）的变量是另一份，要在 Pages 项目里配置，不能靠本地 `.env` 生效。

| 变量 | 作用 | 读它 |
| --- | --- | --- |
| `XN_BASE` / `XN_MODEL` | 上游模型地址与默认模型 | 本地 + 边缘 |
| `XN_API_KEY` | 服务器自己的模型 Key（可选） | 本地 + 边缘 |
| `XN_ALLOWED_MODELS` | 服务端 Key 允许的模型，逗号分隔 | 本地 + 边缘 |
| `XN_ADMIN_PASSWORD` | 管理密码（只在验证接口用一次） | 本地 + 边缘 |
| `XN_ADMIN_SECRET` | 令牌签名密钥（建议单独设随机串） | 本地 + 边缘 |
| `XN_ADMIN_TOKEN_VERSION` | 令牌版本，默认 `1`；改成 `2` 立即吊销所有已发管理会话 | 边缘 |
| `XN_ALLOWED_ORIGINS` | 额外允许的跨站来源；留空只允许同源 | 边缘 |
| `XN_REQUIRE_ORIGIN` | 设 `1` / `true` 时缺 `Origin` 也拒绝（只给浏览器用的部署建议开） | 本地 + 边缘 |
| `XN_TRUST_PROXY` | 设 `1` 时才信 `X-Forwarded-For`（确实在反向代理后面才开，否则限流可被伪造头绕过） | 本地 |
| `XN_REPO_OWNER` / `XN_REPO_NAME` | 锁定的发布仓库 | 本地 + 边缘 |
| `XN_GH_TOKEN` | GitHub Token（可选）：只在服务端用，浏览器不持有 | 本地 + 边缘 |
| `XN_EXTRA_HOSTS` | 额外允许的模型主机（如本机网关隧道域名，最多 8 个） | 本地 + 边缘 |
| `XN_GATEWAY_BASE` / `XN_GATEWAY_MODEL` | 下发给前端的本机网关地址与模型 | 本地 + 边缘 |
| `XN_GATEWAY_KEY` | 走网关时带的 Key（本机 3425 一般留空） | 边缘 |
| `XN_ALLOW_LOCAL_GATEWAY` | 设 `1` 才认 `http://127.0.0.1` 网关（默认只认 https） | 边缘 |
| `XN_ITER_MODEL` | 没有外部 Key、网关也不可用时，云端自迭代退回的 Workers AI 模型 | 边缘 |
| `XN_AI_MODEL` | 边缘自带 Workers AI 模型的覆盖值（默认 GLM-4.7-Flash） | 边缘 |
| `XN_ITER_BRANCH` | 解锁后自迭代提交 / 打 tag 的目标分支（留空 = 仓库默认分支） | 边缘 |
| `XN_PUBLIC_ITERATE_BRANCH` | 未解锁时的试跑分支，默认 `iterate/public` | 边缘 |
| `XN_FEEDBACK_TTL_DAYS` | 云端反馈保留天数，默认 180，范围 1–365 | 边缘 |
| `XN_DATA_DIR` | 本地反馈 / 备份目录，默认 `./data` | 本地 |
| `XN_AUTO_COMMIT` | 本地自迭代成功后自动 `git commit`（默认 0） | 本地 |
| `XN_PORT` | `start-local` 起的端口，默认 8080 | 本地 |
| `XN_TUNNEL_KEY` | 本机网关出口代理的钥匙（优先于钥匙文件） | 工具 |
| `XN_KV_ID` / `XN_PAGES_PROJECT` | KV 命名空间 id / Pages 项目名 | 部署脚本 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 部署凭据 | 部署脚本 |

`deploy_pages.mjs --env` 只写它认识的那批键（`XN_BASE` / `XN_MODEL` / `XN_ADMIN_PASSWORD` / `XN_ADMIN_SECRET` / `XN_REPO_*` / `XN_GH_TOKEN` / `XN_ALLOWED_*` / `XN_GATEWAY_BASE` / `XN_GATEWAY_MODEL` / `XN_ITER_MODEL` / `XN_EXTRA_HOSTS` / `XN_API_KEY`），而且是整表 PATCH：`secret_text` 读不回来，没带上的 secret 会被清空，所以 `--env` 必须配 `--yes`。
`XN_ADMIN_TOKEN_VERSION`、`XN_REQUIRE_ORIGIN`、`XN_FEEDBACK_TTL_DAYS`、`XN_GATEWAY_KEY`、`XN_ALLOW_LOCAL_GATEWAY`、`XN_ITER_BRANCH`、`XN_PUBLIC_ITERATE_BRANCH`、`XN_AI_MODEL` 目前要在 Pages 项目的 Settings → Variables and Secrets 里单独加。

## 部署

### Cloudflare Pages（推荐）

```bash
cp .env.example .env       # 填 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / XN_*
npm run build              # 组装 cloudflare/.pages（页面 + assets + 边缘模块，并打内容哈希）
node cloudflare/deploy_pages.mjs                       # 默认 dry-run：只组装、打印计划，不上传
node cloudflare/deploy_pages.mjs --apply               # 真部署：只发文件，不动环境变量
node cloudflare/deploy_pages.mjs --apply --env --yes   # 连环境变量一起整表 PATCH
```

`cloudflare/.pages` 是构建产物（已 `gitignore`），别手改、别入库；`npm run check:pages` 只比对不落盘。
`--env` 是整表 PATCH，`secret_text` 读不回来：少带一个 secret 就会清空线上那个，所以必须显式 `--yes`。
KV 命名空间 id 用 `XN_KV_ID`（`npx wrangler kv namespace create XN_KV` 的输出）。

### GitHub Pages

`main` 推送后先跑「校验与护栏」（`.github/workflows/guard.yml`），**通过之后**才由 `pages.yml` 部署到 github.io。
guard 失败时只回滚那一次提交；guard 自己生成的回滚提交会跳过部署（坏提交从没上过线，回滚后的内容就是线上的上一版）。
部署前 `scripts/stamp.mjs` 给资源写内容哈希；紧急手动发布走 Actions → Deploy static site → Run workflow。
仓库 Settings → Pages → Source 要选 **GitHub Actions**。

分支保护：先 `bash scripts/protect-main.sh --dry-run` 看要发什么，再正式开（要求 `check (20)` / `check (22)` / `ui` 通过，禁 force-push、禁删分支，`enforce_admins=false` 让自迭代和回滚仍能直推）。

### Docker / Render

```bash
docker build -t xiaonuan .
docker run -p 8080:8080 -e XN_ADMIN_PASSWORD=... xiaonuan
```

`render.yaml` 已给出免费 Web 服务的配置。

## 测试

```bash
npm test          # 单元四个文件：unit / pipeline / security / security-adversarial
npm run smoke     # 起真后端 + 假模型，测接口、鉴权、SSRF、413、CORS
npm run ui        # 起无头 Edge/Chrome，点完五个视图、发消息、解锁、反馈
npm run check     # 语法 + 引用 + 关键控件 + 版本一致性 + .pages 漂移（只告警）
npm run lint      # eslint
node cloudflare/test.mjs   # Worker 路由与安全边界
```

`npm test` 跑 `tests/unit.test.mjs`、`tests/pipeline.test.mjs`、`tests/security.test.mjs`、
`tests/security-adversarial.test.mjs` 四个文件：Markdown / 补丁规则 / SSRF；自迭代管线
（digest、缓存 key、TTL、tag 422、README 标记）；令牌版本、同源、反馈保留期与删除、
管理令牌不会被当模型 Key 转发；以及针对这些边界的对抗性回归（并发限流、IPv4-mapped IPv6、
before 误删、CORS DELETE 等）。

发布前把 `.pages` 对齐（它是构建产物，平时没有也不该报错）：

```bash
npm run build                     # 生成 cloudflare/.pages
npm run check:pages               # 只比对不落盘：源码和 .pages 有漂移就退出 1
node scripts/check.mjs --strict   # 把 .pages 漂移算失败（平时只 WARN）
```

CI：`.github/workflows/guard.yml`（push / PR）用 Node 20/22 矩阵跑 lint → 自检 → 单元（`node --test tests/*.test.mjs`）→ 冒烟 → Worker 路由，
失败时只回滚这一次提交（不 `reset --hard`），PR 只检查不回滚；GitHub Pages 要等它通过才部署（见上节）。
端到端 UI 在 CI 里也是真跑的：guard 的 `ui` job 用 `tests/ui-ci.mjs` 起真后端 + 假模型 + 无头 Chromium，点完五个视图；失败会挡住 GitHub Pages 部署，并把截图 / `summary.json` / 后端日志传成 artifact。

## 已知边界

- 单页应用：前端没有打包器，文件拆分靠 `<script defer>`；`npm run build` 只是把页面和边缘模块组装成 Pages 直传目录。
- 对话本地保存上限 30 个会话 × 60 条消息，超出会丢最旧的；重要的导出。
- 联网搜索优先 DuckDuckGo，机房 IP 被挡时回退维基百科；结果会标明来源，云端缓存 10 分钟。
- 云端自带模型只有一个 GLM-4.7-Flash，质量一般；认真用请填自己的 Key。
- 自迭代能改前端、文档、`package.json` 和版本文件，不能改 `server/`、`cloudflare/`、`.github/`、`tests/`。
- 限流是 KV + 内存两级，KV 最终一致，极端并发下会略超；也没有 WAF / 人机验证（详见 [SECURITY.md](SECURITY.md)）。
- 真机多浏览器、真实服务商、长上下文仍需人工验；每次迭代结果里会写明“没验证什么”。
