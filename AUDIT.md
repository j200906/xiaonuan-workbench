# 小暖工作台 · 体检修复台账（v1.5.0）

审计时间：2026-11-09
修复时间：2026-11-09 ~ 2026-11-10
范围：`index.html`、`assets/*`、`cloudflare/*`、`server/app.py`、`.github/workflows/*`、文档与测试

状态：✅ 已修 · 🟡 已处理但有边界 · ❌ 未修（本轮没有）
本轮验证：`npm test` 9/9、`npm run smoke` 17/17、`npm run ui` 17/17、`node cloudflare/test.mjs` 16/16、`npm run check` 通过。

---

## P0 · 阻断（12）

| # | 状态 | 处理 |
| --- | --- | --- |
| 1 | ✅ | 删除 `settings.onShow ↔ arch.onShow` 互调；设置页不再递归 |
| 2 | ✅ | 导航编辑、人设、外观全部在 `views.settings` 初始化并渲染 |
| 3 | ✅ | 默认云端模型改为 GLM-4.7-Flash，关闭 thinking；空正文有兜底重试 |
| 4 | ✅ | 首字前显示「正在想…」，流式/工具/非流式三条路都有占位 |
| 5 | ✅ | 浏览器里那套猜 find 的迭代器已删除；统一走 `/api/iterate` |
| 6 | ✅ | 轮数不再写死；服务端跑到没有工单或达到安全上限 |
| 7 | ✅ | 仓库锁在 `XN_REPO_OWNER/XN_REPO_NAME`，客户端传 owner/repo 被忽略 |
| 8 | ✅ | 网关地址由 `/api/config` 的 `gateway` 下发，前端不再写死隧道域名 |
| 9 | ✅ | `tests/ui-check.mjs` 重写；自动起后端 + 假模型 + 无头浏览器 |
| 10 | ✅ | GitHub Pages 已部署 v1.5.0；Cloudflare Pages 需用 `deploy_pages.mjs` 再推一次（见下方部署状态） |
| 11 | ✅ | v1.5.0 已由 Actions 在 Windows 上打包并挂到 Release（12.2 MB，附 SHA256） |
| 12 | ✅ | README 版本改为 v1.5.0，与 changelog/package.json 一致，并有单测校验 |

## P1 · 安全（18）

| # | 状态 | 处理 |
| --- | --- | --- |
| 13 | ✅ | 前端不再硬编码管理密码；只在解锁时发给服务器 |
| 14 | ✅ | `/api/feedback` 读接口改为管理员令牌；密码只用于换令牌 |
| 15 | ✅ | `/api/search` 加同源 + 浏览器同站校验 + 20 次/分钟/IP + 10 分钟缓存 |
| 16 | ✅ | `/api/feedback` POST 加 5 次/分钟/IP、16KB 上限、字段截断 |
| 17 | ✅ | CORS 不再 `*`；只回显允许的 Origin，同源请求不需要 CORS |
| 18 | ✅ | `/api/iterate` 3 次/小时/IP；管理员令牌 + 512KB 上限 |
| 19 | ✅ | `/api/chat` 30 次/分钟/IP；服务端 Key 只允许 `XN_ALLOWED_MODELS` |
| 20 | ✅ | `/api/chat` 请求体 256KB 上限；前端也做 480KB 序列化上限 |
| 21 | ✅ | SSRF 改为解析 IP 字面量（十六进制/十进制/缩写）+ DoH 校验 + 逐跳重定向复核 |
| 22 | ✅ | 隧道钥匙默认写用户目录；env `XN_TUNNEL_KEY` 优先；前端网关 Key 只进 sessionStorage |
| 23 | ✅ | 出口代理 60 次/分钟/IP + 240 次/分钟全局；只放行两个端点；不转发外部 Authorization |
| 24 | ✅ | GitHub Token 不再进 sessionStorage，只存在内存变量，刷新即失效 |
| 25 | 🟡 | `.cf_token` 已 gitignore 且从工作区移除；Git 历史里的悬空提交未重写（重写会破坏所有克隆） |
| 26 | ✅ | 口令比较改 `hmac.compare_digest` / 常量时间比较；令牌用 HMAC-SHA256 |
| 27 | ✅ | 迭代不再传明文密码，改 `X-Admin-Token`；模型 Key 只在服务端到上游的请求里 |
| 28 | ✅ | `XN_EXTRA_HOSTS` 只接受合法域名、排除内网、最多 8 个 |
| 29 | ✅ | 反馈 type/contact/ua 全部截断并去标签；IP 只存哈希 |
| 30 | ✅ | Worker 与 Python 都加 CSP、X-Frame-Options、Referrer-Policy、Permissions-Policy、COOP |

## P2 · 功能缺陷（32）

| # | 状态 | 处理 |
| --- | --- | --- |
| 31 | ✅ | Python 后端补齐 `/api/search`、`/api/fetch`、`/api/iterate` |
| 32 | ✅ | 白名单收敛到 `cloudflare/shared.js`，worker 与 iterate 共用 |
| 33 | ✅ | 模型清单收敛到 `assets/lib/models.js`，设置页选项也由它生成 |
| 34 | ✅ | `/api/config.models` 覆盖 `CLOUD_MODELS`；本地代理不再冒充云端模型 |
| 35 | ✅ | 没有自己的模型时给一条禁用提示，不再出现空分组；云端组只在启用时显示 |
| 36 | ✅ | 只在有 Key 且非 `@cf/` 时发 Authorization；`/api` 不再当 providerBase |
| 37 | ✅ | `emoLLM` 默认 `auto`：关键词判 neutral/低强度时调一次模型，45 秒/6 次节流 |
| 38 | ✅ | `maybeConsolidate` 在切会话、页面隐藏、pagehide 触发；攒够 8 条或 12 小时 |
| 39 | ✅ | 关系等级改由有效互动次数驱动：10/30/80 次升「熟了/老朋友/自己人」 |
| 40 | ✅ | 停用词表扩充；召回按 IDF 加权；查询 token 上限 60 |
| 41 | ✅ | 记忆缓冲写入 `xn.v2.memBuffer`，刷新不丢 |
| 42 | ✅ | 隐式记忆只存 ≥12 字且有信息量的话，并做相似去重 |
| 43 | ✅ | `touch(用户消息 id)` 去重；重试/重新生成不重复计数 |
| 44 | ✅ | 时间工具始终可用；搜索/抓网页只在「联网」打开时挂给模型 |
| 45 | ✅ | 工具循环保留降级路线：关键词判断 + 普通对话 |
| 46 | ✅ | 搜索结果显示来源（DuckDuckGo / 维基百科），不再含糊叫「联网」 |
| 47 | ✅ | 网页正文上限 12000 字，支持 `offset` 续读 |
| 48 | ✅ | 迭代按文件给 18k 字 + 函数结构提纲，总预算 100k |
| 49 | ✅ | 最多 8 处补丁 / 3 个整份重写 / 2 个新文件 |
| 50 | ✅ | 括号扫描识别字符串、模板字符串、行/块注释，不再数花括号 |
| 51 | ✅ | 重复定义检测覆盖 `function`、`const/let/var`、`class`、对象方法 |
| 52 | ✅ | 云端改为 Git Data API：blobs → tree → commit → 更新 ref，一次提交 |
| 53 | ✅ | 只打 tag；`release.yml` 在 tag 上打包成功后才创建/更新 Release |
| 54 | ✅ | 422 返回 `attempt`（标题、补丁文件、原因），界面保留「这一版想改什么」 |
| 55 | ✅ | 试运行方案按仓库缓存 10 分钟；重复点不重复烧 token |
| 56 | ✅ | GitHub 文件读取改 `Promise.all` 并行 |
| 57 | ✅ | 版本号支持 patch/minor/major，并校验必须大于当前 |
| 58 | ✅ | 更新日志拆 `changelog.js`（最近 12 条）+ `changelog.archive.js` |
| 59 | ✅ | `version.js` 从更新日志首条推导；单测校验 package.json/changelog 一致 |
| 60 | ✅ | 浏览器不再维护第二套迭代器；静态部署直接提示需要后端 |
| 61 | ✅ | 「新对话」始终创建新会话并聚焦输入框，不再只弹 toast |
| 62 | ✅ | 侧栏新增「对话」入口；刷新后可从侧栏回去 |
| 63 | ✅ | 「拉取云端」在管理员 + 有后端时显示；本地后端也算 |
| 64 | ✅ | 本地/云端反馈按 type+body 去重，同一内容不重复显示 |
| 65 | ✅ | 笔记分页，每次 20 条，底部显示剩余数量 |
| 66 | ✅ | 统一用本地日历日 `dayKey()`，不再用 UTC `toISOString()` 跨天 |
| 67 | ✅ | 计时器用 `endsAt` 校时；`visibilitychange` 回来立即重算 |
| 68 | ✅ | Markdown 先转义再解析；代码块单独抽出，HTML 不会漏转义 |
| 69 | ✅ | 支持表格、对齐、嵌套列表、任务列表、删除线、图片协议白名单 |
| 70 | ✅ | 流式中断追加「这条没写完」，并标记 `incomplete` |
| 71 | ✅ | AbortSignal 贯穿工具循环每一轮和收尾请求 |
| 72 | ✅ | `fitMessages` 按 token 预算丢最老对话并插入省略说明 |

## P3 · 债务（38）

| # | 状态 | 处理 |
| --- | --- | --- |
| 73 | ✅ | 拆出 `assets/lib/*` 六个模块与四个视图文件；`iterate.js` 从 1021 行降到约 300 行 |
| 74 | ✅ | 请求/存储/Markdown/模型/文案各自成模块；core 只留状态、路由、会话、发送 |
| 75 | 🟡 | 仍是 `window.XN` 命名空间，但改成 `util/store/api/models/views` 分组；没有引入依赖注入容器 |
| 76 | ✅ | 侧栏与会话列表用事件委托；其余绑定集中在 `bind()` 与各视图 `init()` |
| 77 | 🟡 | 保留了一批 `XN.*` 兼容别名给旧代码/控制台；内部调用已改走 `XN.util`/`XN.api` |
| 78 | ✅ | 删除 `renderPubState`、`webSearchFor` 等死函数 |
| 79 | ✅ | UI 检查重写并能自动跑；不再是引用已删 id 的坏脚本 |
| 80 | ✅ | 单测 + 冒烟 + Worker 路由 + UI 检查；CI 跑前三项 |
| 81 | ✅ | `guard.yml` 同时监听 push 与 pull_request |
| 82 | ✅ | 回滚只 `git revert HEAD`；上一条是 guard 提交则停手；不再 `reset --hard` |
| 83 | ✅ | 加 `eslint.config.mjs` 与 `npm run lint`；只抓真问题，不做风格警察 |
| 84 | ✅ | 加 `jsconfig.json` + `types/xn.d.ts`，核心接口有 JSDoc/类型形状 |
| 85 | ✅ | 所有键统一 `xn.v2.*`；旧键迁移表覆盖 11 类数据 |
| 86 | ✅ | 坏 JSON 先备份到 `xn.bad.*` 再重置，并发出 `storage:issue` |
| 87 | ✅ | 配额满先剪枝旧会话/反馈再重试；仍失败会明确提示导出 |
| 88 | ✅ | 会话/消息/笔记分页上限进 `cfg.limits`，笔记有「还剩多少」提示 |
| 89 | ✅ | `uid()` 用 `crypto.getRandomValues` + 递增序号 + 时间戳 |
| 90 | ✅ | toast 改队列 + 堆叠容器，连续提示不再互相覆盖 |
| 91 | ✅ | 中英文词典 + `t()` + `data-i18n`，设置里可切换 |
| 92 | ✅ | 调深 `--ink-3/--ink-4`，浅色/暗色都过 4.5:1 附近；保留 `prefers-reduced-motion` |
| 93 | ✅ | 增加 1024 平板与 420 窄屏断点；侧栏抽屉在 860 以下 |
| 94 | ✅ | 全局 `:focus-visible`；模型菜单方向键/Enter/Esc；笔记卡可键盘打开 |
| 95 | ✅ | 消息区 `role="log" aria-live="polite"`；toast 也是 live region |
| 96 | ✅ | 9 个 `<script>` 全部 `defer`；CSS 不阻塞交互脚本执行顺序 |
| 97 | ✅ | `scripts/stamp.mjs` 按内容哈希重写 `?v=`；Cloudflare 与 Pages 部署都跑 |
| 98 | 🟡 | 部署仍组装完整目录；增量由 `wrangler pages deploy` 的内容哈希去重负责，没有自建 manifest |
| 99 | ✅ | `.env` + `.env.example`；`deploy_pages.mjs` 自动读取并写全部新变量 |
| 100 | ✅ | README 成唯一事实来源；DEPLOY 只留步骤；本文件是修复台账 |

## 本轮新增的验证

```text
npm test                 9/9     Markdown、补丁、SSRF、版本、i18n、存储键
npm run smoke           17/17    真后端 + 假模型：聊天的流式/非流式、令牌、反馈、SSRF、413、CORS
npm run ui              17/17    无头 Edge：五视图、模型菜单、发消息、表格、解锁、反馈、新对话
node cloudflare/test.mjs 16/16   Worker 路由、令牌、CORS、SSRF、静态响应头
npm run check            通过     37 个脚本语法、22 个资源引用、关键 id、版本一致
```

## 明确没做的

- 没有重写 Git 历史（`#25`）。`.cf_token` 不再入库，但旧提交仍在；要彻底清除得 `filter-repo` + 强推，会影响所有克隆。
- 没有引入打包器/TypeScript 编译（`#75/#84`）。项目刻意保持「克隆即可打开」，类型只做编辑器和文档。
- 没有做真机多浏览器矩阵。UI 检查覆盖 Chromium 内核；Safari/Firefox 仍需人工点一遍。

## 部署状态（2026-11-10 00:30）

| 目标 | 状态 | 说明 |
| --- | --- | --- |
| GitHub `main` | ✅ 535b580 | v1.5.0 已推送 |
| GitHub Pages | ✅ v1.5.0 | Actions「Deploy static site」成功 |
| GitHub Release | ✅ v1.5.0 | `XiaoNuan.exe` 12.2 MB + `.sha256`，Actions 打包 |
| GitHub Actions 校验 | ✅ | 「校验与护栏」成功（lint、语法、单测、冒烟、Worker） |
| Cloudflare Pages | ⏳ 待重新部署 | `xiaonuan-app.pages.dev` 仍是 1.4.8；本机没有 `CLOUDFLARE_API_TOKEN`，需要补一次 `node cloudflare/deploy_pages.mjs` |
