# 小暖工作台 · 全面体检（v1.4.8）

审计时间：2026-11-09 23:2x
范围：`index.html`、`assets/*.js`（7 个）、`cloudflare/*.js`、`server/app.py`、`.github/workflows/*`、文档与测试
方法：静态扫描（DOM id 对账、死代码、重复定义、键名一致性）+ 线上实测（无头浏览器点完 5 个视图、接口鉴权探测）

共 100 条，按严重程度分四档：
**P0 阻断**（做不成事）· **P1 危险**（安全/数据）· **P2 缺陷**（功能不对）· **P3 债务**（能跑但会拖垮维护）

---

## P0 · 阻断（12）

1. `settings.onShow` 调 `arch.onShow`，`arch.onShow` 未解锁时又 `switchView('settings')` → 无限递归，栈溢出。（已修，见 1.4.8）
2. 上条导致设置页的导航编辑、人设、外观控件**全部空白**——用户看到的就是"什么都干不成"。
3. 默认云端模型曾是推理型，token 全花在思考上，正文为空，表现为"一个模型都调不了"。（已修）
4. GLM 未关思考时首字要 25 秒，界面无任何提示，用户以为卡死。（已修）
5. 浏览器版迭代器用"模型猜 find 片段"的策略，对不上就整轮作废，连续 3 轮 0 产出。
6. 迭代页的轮数被写死 1–3 轮，用户以为被限制。（已改为不限轮）
7. 仓库未锁定时，迭代可被指向任意仓库（客户端传 owner/repo 即生效）。
8. `assets/app.views.js` 里隧道地址写死，隧道重启换域名后自迭代必然失败。
9. `tests/ui-check.js` 仍引用 `#itCycles`、`#navArch`（已删），整套测试无法运行。
10. GitHub Pages 站点版本停在 1.4.4，Cloudflare 是 1.4.8，同一产品两个行为。
11. exe 停在 1.2.1（还是带门禁的旧布局），与网页版差 6 个版本。
12. README 写"当前版本 v1.3.2"，同时又说"线上 j200906.github.io"，两处都过期。

## P1 · 安全（18）

13. 管理密码 `ADMIN_PASSWORD` 明文写在 `assets/app.core.js:5`，任何人查看源码即得。
14. 同一密码作为服务端 `XN_ADMIN_PASSWORD`，因此 `/api/feedback` 的读接口对"读过源码的人"完全开放。
15. `/api/search` 无任何鉴权，任何人可当免费搜索/维基代理刷（实测 200）。
16. `/api/feedback` POST 无鉴权、无限流，可被脚本灌垃圾（实测 200）。
17. `/api/iterate` 返回 `Access-Control-Allow-Origin: *`，跨站可触发（虽有密码挡着）。
18. `/api/iterate` 无限流，一次调用可创建 release、推 4 个 commit。
19. `/api/chat` 无限流；一旦服务器配了 `XN_API_KEY`，等于公开送额度。
20. `/api/chat` 无请求体大小限制（`/api/fetch` 有，`chat` 没有）。
21. `/api/fetch` 的 SSRF 防护只靠正则匹配主机名，`0x7f.0.0.1`、十进制 IP、DNS 重绑定都能绕过。
22. 隧道钥匙存 `tools/tunnel-token.txt` 明文，且同时被当作"模型 API Key"填进浏览器 localStorage。
23. 该钥匙一旦泄漏，攻击者可白嫖本机网关额度，限流只有 20/分钟/IP（可换 IP 绕过）。
24. GitHub Token 存在 `sessionStorage`，XSS 可直接读走。
25. `.cf_token` 曾被误提交（GitHub Push Protection 拦下）；本地历史里仍有悬空提交。
26. 口令比较用 `===`（worker 的 `admin/verify`），不是常量时间比较。
27. 迭代接口把用户 Key 放在请求体里明文传输（HTTPS 内可接受，但会进 Cloudflare 日志）。
28. 云端迭代的 `XN_EXTRA_HOSTS` 允许任意追加主机，配错就把 Worker 变成开放代理。
29. 反馈内容原样存 KV 并原样回显（`render` 用了 `esc`，但 `ua`、`contact` 未截断校验）。
30. 没有任何 CSP / X-Frame-Options / Referrer-Policy 响应头。

## P2 · 功能缺陷（32）

31. 本地后端 `server/app.py` 只有 chat/config/feedback/admin/verify，缺 search、fetch、iterate —— 本地版功能是云端版的子集。
32. 两份 allowlist（`worker.js` 与 `iterate.js`）各自维护，已经出现过只改一边的情况。
33. 模型清单三处重复：`MODEL_BY_PROVIDER`、`PROVIDERS`、`AI_CHOICES`，改一处漏两处。
34. `CLOUD_MODELS` 在前端硬编码，与 `/api/config` 返回的 `models` 并存，谁生效取决于代码路径。
35. 云端模型只剩 GLM 时，模型条仍会显示"自己的 API"分组为空的情况（无 provider 时不渲染）。
36. 选 `@cf/` 模型时不发 Authorization，但 `providerBase` 逻辑仍会计算，容易误传。
37. 情绪判定 `emoLLM` 默认关闭，等于"LLM 情绪判定"这条对齐没真正生效。
38. 记忆引擎 `consolidate`（睡眠巩固）没有任何触发点，是死代码。
39. `XN_MEM` 的 stage 由 warmth 推导，上限 10，`老朋友(10)/自己人(30)` 两个标签永远到不了。
40. 记忆的 `activate` 用 2-gram 打分，中文停用词表很短，长句召回噪声大。
41. `pushBuffer` 只在内存里，刷新即丢，巩固前丢失上下文。
42. `addImplicit` 把每条用户消息都存，200 条上限很快被日常对话占满。
43. 关系 `touch()` 每发一条消息 +1，机器人/重试也会计数，数据会虚高。
44. 工具循环只在"联网"开关打开时启用，关掉后模型完全不能调工具。
45. 工具循环依赖服务商支持 `tools`；GLM 走 AI 绑定不支持，退化路径只做关键词判断。
46. `web_search` 实际走维基百科（DDG 对 CF 机房 IP 全挡），"联网"名不副实。
47. `fetch_page` 截断 3500 字，长文问答会丢关键段落。
48. 迭代的 prompt 只带每个文件前 70 行，模型看不到大部分代码，补丁只能瞎猜。
49. 迭代一次最多 4 处补丁、2 个文件，改不了结构性问题（用户明确要过"大改"）。
50. 迭代的括号配平校验是朴素计数，字符串里的 `{` 会误判。
51. 重复定义检查只认 `name() {}` 形式，`const f = function(){}` 漏检。
52. 迭代提交是 4 个独立 commit（app.views/version/changelog/README），中途失败会留下半套改动。
53. 迭代先建 release 再等 Actions 打包，打包失败就留下一个空 release。
54. 迭代失败时（422）只回错误，不保留"这一版想改什么"，无法复盘。
55. `dryRun` 也要读全部文件 + 调模型，成本与真跑一样。
56. 云端迭代读 GitHub 文件是串行 `await`，4 个文件 4 次往返。
57. 版本号只支持 patch+1，永远到不了 minor/major。
58. 更新日志写进单个 `changelog.js`，已经 248 行，无限增长。
59. `version.js` 靠手改，与 `changelog.js` 首条容易不一致。
60. 本地浏览器迭代器与云端迭代器两套逻辑，行为不同（前者不做发版）。
61. 新对话按钮在"当前为空"时只给 toast，不做任何清空/重置。
62. 聊天页没有侧栏入口（`data-view="chat"` 不存在），刷新后靠 sessionStorage 恢复，清掉就回不去。
63. 反馈"拉取云端"只在 admin 且 proxy 时显示，本地部署看不到这个按钮。
64. 反馈条目本地与云端 id 不同源，同一内容会重复显示。
65. 学习台的笔记没有分页/虚拟滚动，多了会卡。
66. 目标每天重置逻辑只按日期字符串比较，跨时区会错。
67. 计时器用 `endsAt` 时间戳，但页面休眠后不校时，回来会跳。
68. Markdown 渲染是自己写的简化版，代码块里含 HTML 会被转义不全。
69. `md()` 不支持表格/嵌套列表，模型输出表格时排版会乱。
70. 流式输出时若中途报错，已输出内容保留但没有"未完成"标记。
71. 停止按钮只在流式时有用，工具循环路径无法中断。
72. 消息重试/重新生成会复制上下文，长对话容易超 token 上限（无截断保护）。

## P3 · 债务（38）

73. `app.core.js` 1414 行、`iterate.js` 1021 行、`app.views.js` 1012 行，单文件过大且职责混杂。
74. `app.core.js` 同时负责状态、渲染、请求、路由、DOM 绑定，无法单测。
75. 全局只有一个 `XN` 命名空间，模块间靠约定，没有依赖注入。
76. 事件绑定散落在 3 个文件，重复绑定风险靠"只 init 一次"。
77. `N.` 上挂了 16 个内部函数（`$`、`md`、`sendMessage`、`renderSessions`…），实际是"把私有函数暴露出去"。
78. `renderPubState`、`webSearchFor` 已是死函数（前者控件已删，后者被工具循环取代）。
79. `tests/ui-check.js` 无法运行，等于没有回归测试。
80. CI 只有"语法护栏"（`node --check` + 5 个 id 存在性），没有任何行为测试。
81. 护栏 workflow 只在 push 时跑，PR 不跑。
82. 护栏自动 revert 用 `git revert HEAD`，连续两次失败会 revert 掉修复本身。
83. 没有 lint（ESLint/Prettier），风格靠手写一致。
84. 没有 TypeScript 或 JSDoc 类型，接口形状靠记忆。
85. 存储键 `xn.*.v1` 与 `xn.mem.v2` 版本策略不统一，迁移代码只有 `legacyChat` 一处。
86. `readJSON` 失败静默返回默认值，坏数据无告警。
87. `localStorage` 容量未监控，超限时写入静默失败。
88. 会话上限 30 个、每条 60 条消息，硬编码且无提示。
89. `uid()` 用时间戳+随机，理论上可碰撞。
90. `toast` 无队列，连续提示会互相覆盖。
91. 无 i18n，中文硬编码在 JS 字符串里。
92. 无暗色主题下的对比度校验，部分 `--ink-4` 文字偏淡。
93. 移动端断点只有 860/640 两档，平板竖屏体验未验证。
94. 无键盘可达性测试（模型菜单有键盘支持，其他弹层没有）。
95. 无 `aria-live`，流式输出屏幕阅读器读不到。
96. `index.html` 里脚本无 `defer`，7 个 `<script>` 阻塞渲染。
97. 资源用 `?v=` 手工改版本号，漏改就缓存错乱（已出现过）。
98. 部署脚本 `deploy_pages.mjs` 每次全量上传 14 个文件，无增量。
99. 环境变量靠命令行传，`XN_EXTRA_HOSTS` 漏传过一次导致白名单失效。
100. 文档三份（README/DEPLOY/AUDIT）互相矛盾，没有单一事实来源。

---

## 已在本轮修复的（供对照）

- #1/#2 递归栈溢出（1.4.8）
- #3/#4 默认模型空正文、25 秒无提示（1.4.4）
- #6 轮数限制（1.4.6 取消）
- #7 仓库锁定（1.4.6）
- 5 个视图逐一点击验证：`study / feedback / changelog / settings / iterate` 全部可进入，控制台 0 报错
