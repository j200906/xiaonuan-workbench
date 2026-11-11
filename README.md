# 小暖

一个可以对话、记笔记、收反馈、自己改自己的学习工作台。

- 线上（带后端）：<https://xiaonuan-app.pages.dev>
- 静态站（GitHub Pages）：<https://j200906.github.io/xiaonuan-workbench/>
- 仓库：<https://github.com/j200906/xiaonuan-workbench>
- Windows 桌面版：<https://github.com/j200906/xiaonuan-workbench/releases/latest>

<!-- XN:VERSION -->
当前版本 **v3.2.0**
<!-- /XN:VERSION -->

<!-- XN:RECENT -->
- **v1.5.9** 主页更干净
- **v1.5.8** 并入自迭代批次（AUDIT #61–#100）
- **v1.5.5** 令牌只留内存，离开即清空
- **v1.5.4** 反馈输入加长度硬上限
- **v1.5.3** 修更新日志对比漏版本
- **v1.5.2** 网关地址每次下发都生效
- **v1.5.1** 本地版能用了：人格可见、网关直连、迭代写本地
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
python -m pip install pyinstaller
python build_exe.py
```

## 插件

小暖的能力可以像插件一样「一行挂上去」：一个普通对象、一个 `id`，宿主负责挂载、卸载和开关。
内置示例是「导出当前会话」，设置页的「插件」卡随时可以关掉再打开；视图和按钮都能做成插件。
完整契约（字段表、`ctx`、错误隔离、迁移步骤）见 [docs/PLUGINS.md](docs/PLUGINS.md)。

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
  shared.js                白名单、限流、令牌、SSRF、安全响应头
  rules.js                 服务端补丁校验
  iterate.js               云端自迭代：一次提交 + 打 tag
  deploy_pages.mjs         Pages 一键部署
tests/                     单元、冒烟、无头浏览器 UI 检查
```

## 自迭代怎么跑

「设置 → 管理模式」输入管理密码即可解锁。侧栏的「迭代」入口始终可见，「迭代」页本身也不用解锁就能直接打开；解锁只决定它能不能真写：未解锁的请求只跑试运行——云端落 `XN_PUBLIC_ITERATE_BRANCH`（默认 `iterate/public`）试跑分支，本地只出方案不写文件。

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
- GitHub Token 只在服务端（`XN_GH_TOKEN`），浏览器不持有、也没有输入框
- 自迭代模型优先用你在模型条里选的服务商；选「自迭代模型（本机网关）」时走服务器下发的网关地址，网关不可用会自动回落成「跟随模型条」
- 网关下发：`/api/config` 只在地址有效时才带 `gateway`（空地址 / 解析不出 / 非 http(s) 就整块不带，前端按「服务器未配置」处理）；`gateway.stale` 标出临时隧道（`*.trycloudflare.com`），`gateway.reachableHint` 只有服务器设了 `XN_GATEWAY_VERIFIED=1` 才是 true——没标的地址前端不默认选它

## 长期记忆（海马体）

页面里的 `assets/memory.js` 记的是「小暖记得你说过什么」，存在你这台设备的浏览器里；
开发侧另有 [海马体](docs/HIPPOCAMPUS.md)：把工作区里每一次对话和工具调用的**原话**落盘，
按线索召回、要证据给原文。它让我们改小暖时不用从零回忆「上次为什么这么定」。

安装与配置见 [docs/HIPPOCAMPUS.md](docs/HIPPOCAMPUS.md)。要点只有一个：
`~/.dsh/hippocampus/config.json` 的 `workspaces` 必须写出本仓库所在工作区的**绝对路径**，
否则插件装了也不生效（默认空数组 = 全关）。

## 安全模型

| 面 | 做法 |
| --- | --- |
| 管理密码 | 服务端常量时间比较，换 HMAC 令牌；前端不硬编码 |
| 聊天代理 | 30 次/分钟/IP，请求体 256KB 上限；服务端 Key 只允许白名单模型 |
| 搜索 / 抓网页 | 同源 + 浏览器同站校验 + 限流；结果缓存 10 分钟 |
| SSRF | 解析 IP 字面量（含 `0x7f`、十进制、缩写），DoH 校验解析结果，重定向逐跳复核 |
| 反馈 | 5 次/分钟/IP，字段截断，IP 只存哈希 |
| 自迭代 | 管理员令牌 + 3 次/小时/IP + 512KB 上限 + 单提交 |
| 响应头 | CSP、X-Frame-Options、Referrer-Policy、Permissions-Policy、COOP |
| 本机存储 | `xn.v2.*`，坏数据备份后重置，配额满先剪枝再提示 |
| Key | 默认只进 sessionStorage；勾「记住」才写 localStorage |
| 隧道钥匙 | 默认写到用户目录（`%APPDATA%\xiaonuan\tunnel-key.txt`），不再进仓库 |

## 网页抓取（`/api/fetch`）

模型的「读网页」工具走 `GET /api/fetch?url=<URL 编码的地址>&offset=<从第几个字符开始>`：

- 单次最多返回 12000 字（`assets/tools.js` 的 `FETCH_LIMIT`）；长文靠 `offset` 分段读，别一次拉整页
- 响应里 `offset` 是本次起点、`nextOffset` 是下一段起点、`total` 是全文总长、`truncated` 表示后面还有没读完的部分
- `offset` 超出总长时返回空 `text` 且 `truncated: false`，不报错
- 边界：同源校验（Worker 还对浏览器请求加同站校验）、10 次/分钟/IP；只认 http(s)，内网地址一律拒绝

## 环境变量

复制 `.env.example` 成 `.env`。本地后端和 `deploy_pages.mjs` 都会读。

| 变量 | 作用 |
| --- | --- |
| `XN_BASE` / `XN_MODEL` | 上游模型地址与默认模型 |
| `XN_API_KEY` | 服务器自己的模型 Key（可选） |
| `XN_ALLOWED_MODELS` | 服务端 Key 允许的模型，逗号分隔 |
| `XN_ADMIN_PASSWORD` | 管理密码 |
| `XN_ADMIN_SECRET` | 令牌签名密钥（建议单独设随机串） |
| `XN_ALLOWED_ORIGINS` | 额外允许的跨站来源；留空只允许同源 |
| `XN_REPO_OWNER` / `XN_REPO_NAME` | 锁定的发布仓库 |
| `XN_GH_TOKEN` | 服务器 GitHub Token（可选） |
| `XN_EXTRA_HOSTS` | 额外允许的模型主机（如本机网关隧道域名） |
| `XN_GATEWAY_BASE` / `XN_GATEWAY_MODEL` | 下发给前端的本机网关地址与模型 |
| `XN_GATEWAY_VERIFIED` | 设 1 才把网关标成「已验证」（`/api/config` 的 `gateway.reachableHint`）；不设则地址照发但按未验证处理 |
| `XN_ITER_MODEL` | 没有外部 Key 时，云端自迭代用的 Workers AI 模型 |
| `XN_PUBLIC_ITERATE_BRANCH` | 未解锁时云端自迭代落的分支，默认 `iterate/public` |
| `XN_DATA_DIR` | 本地反馈/备份目录 |
| `XN_AUTO_COMMIT` | 本地自迭代成功后自动 `git commit`（默认 0） |
| `XN_TUNNEL_KEY` | 本机网关出口代理的钥匙（优先于文件） |

## 部署

### Cloudflare Pages（推荐）

```bash
cp .env.example .env      # 填 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / XN_*
node cloudflare/deploy_pages.mjs
```

脚本会：组装 `index.html` + `assets` + Worker 模块 → 写环境变量与 KV → 给静态资源打内容哈希 → `wrangler pages deploy`。

### GitHub Pages

`main` 分支每次推送自动部署（`.github/workflows/pages.yml`），部署前会跑 `scripts/stamp.mjs` 给资源加内容哈希。

### Docker / Render

```bash
docker build -t xiaonuan .
docker run -p 8080:8080 -e XN_ADMIN_PASSWORD=... xiaonuan
```

`render.yaml` 已给出免费 Web 服务的配置。

## 测试

```bash
npm test          # 单元：Markdown / 补丁规则 / SSRF / 版本一致性
npm run smoke     # 起真后端 + 假模型，测接口、鉴权、SSRF、413、CORS
npm run ui        # 起无头 Edge/Chrome，点完五个视图、发消息、解锁、反馈
npm run check     # 语法 + 引用 + 关键控件 + 版本一致性
node cloudflare/test.mjs   # Worker 路由与安全边界
```

CI（`.github/workflows/guard.yml`）在 push 和 PR 上都跑前四项；失败只回滚本次提交，不会 `reset --hard`。

## 已知边界

- 单页应用，没有构建步骤；文件拆分靠 `<script defer>`，不引入打包器。
- 对话本地保存上限 30 个会话 × 60 条消息，超出会丢最旧的；重要的导出。
- 联网搜索优先 DuckDuckGo，机房 IP 被挡时回退维基百科；结果会标明来源。
- 云端自带模型只有一个 GLM-4.7-Flash，质量一般；认真用请填自己的 Key。
- 自迭代能改前端与文档，不能改 `server/`、`cloudflare/`、`.github/`、`tests/`。
- 真机多浏览器、真实服务商、长上下文仍需人工验；每次迭代结果里会写明"没验证什么"。
