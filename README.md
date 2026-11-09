# 小暖工作台

一个单页学习工作台：左边是导航，中间是和小暖的对话，另外三个页面放目标、笔记和反馈。
自带两级门禁——只填 Key 就能用；再填管理密码才解锁「架构」，可以改布局、配色、文案和人设。

纯静态，无构建步骤，直接用浏览器打开就能跑。

## 本地跑起来

```bash
# 最简单：静态起一个服务
python -m http.server 8080

# 或者带后端（能托管 Key、收反馈）
XN_API_KEY=sk-xxx XN_ADMIN_PASSWORD=你的密码 python server/app.py --port 8080
```

打开 `http://127.0.0.1:8080`。

> 为什么不用双击打开？`file://` 下浏览器会拦截跨域请求，模型调不通。任何静态服务器都行。

## 门禁怎么分两级

| 你填的 | 结果 | 能做什么 |
| --- | --- | --- |
| 只填 API Key | 访客 | 对话、学习台、反馈箱、设置。看不到「架构」 |
| API Key + 管理密码 `xiaonuanai` | 架构模式 | 以上全部 + 改整页架构 |
| 密码填错 | 挡在门外 | 不会悄悄降级成访客，避免你以为自己进了管理模式 |

Key 存在浏览器里（勾「记住」进 localStorage，不勾只进 sessionStorage）。
请求由浏览器直接发给你填的服务商，不经过任何中间服务器。

**这个密码不是安全边界。** 它写在前端，会读源码的人能绕过；它挡的是误触和手滑。
真要锁住，把后端跑起来，用服务端的 `XN_ADMIN_PASSWORD` 校验——前端检测到 Base URL 是 `/api` 时会自动走服务端校验。

## 四个页面

- **对话**：流式输出、Markdown、复制、重新生成、停止（Esc）。`Ctrl/Cmd + K` 回对话。
- **学习台**：今日目标（跨天自动重置完成状态）、专注计时（25/45/60，刷新不丢）、笔记（搜索、标签、点击编辑）。
- **反馈箱**：分类、字数统计、本地留存、导出 JSON；配了后端地址会同时 POST 到服务器。
- **架构**（仅管理密码）：导航顺序与命名、主色/圆角/字号/明暗/密度、人设全文、温度、配置导入导出。

## 架构能被改到什么程度

两条路，都只改白名单里的字段，改完立刻生效并落到 localStorage。

1. **手动**：右侧控件直接调，改一个存一个。
2. **一句话改版**：在「架构 → 用一句话改版」里写「换成深色、主色墨绿、学习台改名自习室」，
   模型返回一个 JSON 补丁，先给你看改了哪几条，点「应用」才生效。白名单：

   ```
   style.accent / style.radius / style.fontSize / style.theme / style.density
   brand / labels.{chat,study,feedback,arch,settings} / nav（顺序）
   ```

   模型想改别的（比如删掉某个页面、塞脚本）会被直接丢掉，不会执行。

配置可以导出成 `config.json`，换设备导入，等于一份可携带的皮肤。

## 部署

见 [DEPLOY.md](DEPLOY.md)。一句话版本：静态部分扔 GitHub Pages 或 Cloudflare Pages，
要藏 Key、要集中收反馈就把 `server/app.py` 部署到 Render（免费档会休眠，见文档里的注意项）。

## 验收

`tests/` 下有可复跑的端到端检查（无头 Edge + CDP，不装依赖）：

```bash
python tests/mock_llm.py                                   # 假上游，:8098
XN_BASE=http://127.0.0.1:8098/v1 XN_API_KEY=test-key \
  python server/app.py --port 8099
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/xn-edge about:blank &
node tests/ui-check.js http://127.0.0.1:8099
```

覆盖：门禁三种情况、流式对话、目标增删、计时器、笔记、反馈提交、架构改色/改名/排序、
AI 改版预览与应用、刷新后保持、390px 窄屏无溢出。当前 62 项全过（2026-11-09）。

## 文件

```
index.html            页面骨架（含门禁与五个视图）
assets/theme.css      设计令牌：颜色、间距、字体
assets/app.css        组件样式
assets/persona.js     小暖的默认人设（可在架构页覆盖）
assets/app.core.js    配置、门禁、导航、对话、Markdown、API
assets/app.views.js   学习台 / 反馈箱 / 架构 / 设置
server/app.py         可选后端：静态托管 + 模型代理 + 反馈收集（零依赖）
tests/                假上游与无头验收脚本
```

## 已知边界

- 数据都在**这一台设备的这个浏览器**里。换设备不同步，清缓存就没了——重要内容记得导出。
- 对话记忆只带最近 14 轮（可在配置里改 `historyTurns`），不是向量检索。
- 直连需要服务商允许浏览器跨域。DeepSeek 实测允许；OpenAI 官方接口不允许，走 `/api` 代理或换服务商。
- 后端免费档的文件系统是临时的，重启可能丢反馈；长期收反馈要挂持久盘或换成数据库。
