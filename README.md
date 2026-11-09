# 小暖

线上（云端，带后端）：<https://xiaonuan-app.pages.dev>

<!-- XN:VERSION -->
当前版本 **v1.3.3**
<!-- /XN:VERSION -->

一个单页学习工作台。打开就是对话：左边是一串会话，中间是聊天，另外几页放目标、笔记和反馈。
没配 Key 也能用——服务器自带一个模型兜底，填了自己的 Key 就用自己的。

## 最近更新

<!-- XN:RECENT -->
- **v1.3.3** 云端自动收反馈
- **v1.3.2** 反馈真正汇总到云端：部署在云端时自动投 `/api/feedback`，解锁后可在反馈箱「拉取云端」
- **v1.3.1** 模型可自选：自己的 API 在最前，云端自带模型在最底
- **v1.3.0** 云端自迭代；外观与布局并入设置页
<!-- /XN:RECENT -->

## 三种用法

| 用法 | 地址 | 需要什么 |
| --- | --- | --- |
| 云端直接用 | <https://xiaonuan-app.pages.dev> | 什么都不用填 |
| 自己电脑跑 | `python -m http.server 8080` | 一个 API Key |
| Windows 程序 | [ Releases ](https://github.com/j200906/xiaonuan-workbench/releases/latest) | 双击即可 |

## 模型

设置里的「模型」是一个下拉，按顺序：

1. **自定义** —— 自己填 Base URL 和模型名，任何 OpenAI 兼容接口都行
2. **DeepSeek / Moonshot / OpenAI / 智谱 / 硅基流动** —— 选完只填 Key
3. **Cloudflare 自带** —— 不用 Key，质量一般，兜底用

解锁密码后填的那个 API Key，同时也是云端自迭代用的 Key。

## 本地跑

```bash
python -m http.server 8080

# 或者带后端（能托管 Key、收反馈、跑云端自迭代的本地版）
XN_API_KEY=sk-xxx XN_ADMIN_PASSWORD=你的密码 python server/app.py --port 8080
```

打开 `http://127.0.0.1:8080`。别用 `file://` 直接双击，浏览器会拦跨域请求。

## 密码能干什么

在「设置 → 管理模式」输入密码后：

- 侧栏多出 **迭代**（浏览器里跑的那版）
- 设置里多出 **云端自迭代**（在 Cloudflare 上跑，直接改 GitHub 里的文件）

密码存在前端源码里，只防误触，不是安全边界。要真的锁住，把服务器上的 `XN_ADMIN_PASSWORD` 换成别的。

## 五个地方

- **对话**：多会话，侧栏按时间排；流式输出、Markdown、复制、重新生成、停止（Esc）；
  `⌘K` / `Ctrl+K` 开新对话，新对话在发出第一句话之前不占侧栏。
- **学习台**：今日目标（跨天重置完成状态）、专注计时（25/45/60）、笔记（搜索、标签、点击编辑）。
- **反馈箱**：分类、字数、本地留存、导出 JSON；配了后端地址会同时 POST 到服务器。
- **架构**（解锁后）：侧栏顺序与命名、主色/圆角/字号/明暗/密度、人设全文、温度、配置导入导出。
- **设置**：接口、Key、管理模式、本机数据。
- **更新日志**：选「从 vA 到 vB」，列出这段区间修了哪些 bug、加了哪些功能。区间不含起点版本。

## 架构能被改到什么程度

两条路，都只动白名单字段，改完立刻生效并落盘。

1. 手动：右侧控件调一个存一个。
2. 一句话改版：写「换成深色、主色墨绿、把学习台改名叫自习室」，模型回一个 JSON 补丁，
   先列出改了哪几条，点「应用」才生效。白名单：

   ```
   style.accent / style.radius / style.fontSize / style.theme / style.density
   brand / labels.{study,feedback,arch,settings} / nav（顺序）
   ```

   想改别的（删页面、塞脚本）会被直接丢掉，不执行。

配置能导出成 `config.json`，换设备导入，等于一份可携带的皮肤。

## 部署

见 [DEPLOY.md](DEPLOY.md)。静态部分扔 GitHub Pages 或 Cloudflare Pages；
要藏 Key、集中收反馈，把 `server/app.py` 部署到 Render（免费档会休眠，注意项写在文档里）。

## 验收

`tests/` 下是能复跑的端到端检查（无头 Edge + CDP，不装任何依赖）：

```bash
python tests/mock_llm.py                                    # 假上游，:8098
XN_BASE=http://127.0.0.1:8098/v1 XN_API_KEY=test-key python server/app.py --port 8099
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/xn-edge about:blank &
node tests/ui-check.js http://127.0.0.1:8099
```

覆盖：首屏无门禁、没 Key 时的行内提示与自动补发、多会话切换、流式对话、目标/笔记/计时/反馈、
错误密码不解锁、正确密码解锁架构、改色改名、AI 改版预览与应用、更新日志区间、自动迭代
（整理→出方案→预演→反证→草稿）、刷新保持、390px 抽屉侧栏。当前 **79 项全过**（2026-11-09）。

## 文件

```
index.html            页面骨架
assets/theme.css      设计令牌
assets/app.css        组件样式
assets/persona.js     默认人设（可在架构页整段覆盖）
assets/app.core.js    会话、配置、Key、对话、Markdown、API
assets/app.views.js   学习台 / 反馈箱 / 架构 / 设置 / 更新日志
assets/iterate.js     自动迭代引擎（拆工单、出补丁、沙箱预演、反证、提 PR）
assets/version.js     当前版本号
assets/changelog.js   版本记录
server/app.py         可选后端：静态托管 + 模型代理 + 反馈收集（零依赖）
tests/                假上游与无头验收
```

## 已知边界

- 数据都在**这一台设备的这个浏览器**里。换设备不同步，清缓存就没了。
- 对话只带最近 14 轮上下文（`historyTurns` 可改），不是向量检索。
- 直连要求服务商允许浏览器跨域。DeepSeek 实测允许；OpenAI 官方接口不允许，走 `/api` 或换服务商。
- 后端免费档磁盘是临时的，重启可能丢反馈；长期收反馈要挂持久盘或换数据库。
