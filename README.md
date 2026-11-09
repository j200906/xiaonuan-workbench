# 小暖

线上：<https://j200906.github.io/xiaonuan-workbench/>

一个单页学习台。打开就是对话：左边是一串会话，中间是聊天，另外几页放目标、笔记和反馈。
没有「先登录再使用」那一屏——没配 Key 时，发送会在输入框上方提示一次，填完就再也不出现。

纯静态，无构建步骤，任何静态服务器都能跑。

## 本地跑

```bash
python -m http.server 8080

# 或者带后端（能托管 Key、收反馈）
XN_API_KEY=sk-xxx XN_ADMIN_PASSWORD=你的密码 python server/app.py --port 8080
```

打开 `http://127.0.0.1:8080`。为什么不用双击打开？`file://` 下浏览器会拦跨域请求，模型调不通。

## Key 放在哪，谁能看到

| 你的状态 | 能做什么 |
| --- | --- |
| 没填 Key | 能翻笔记、写目标、投反馈；发送时输入框上方弹一次 Key 提示 |
| 填了 Key | 对话、学习台、反馈箱、设置 |
| 填了 Key + 在「设置 → 管理模式」输密码 `xiaonuanai` | 以上全部 + 侧栏多出「架构」 |

Key 只存在浏览器里（localStorage），请求由浏览器直接发给你填的服务商，不经过任何中间服务器。
侧栏底部那行小字就是状态：`未配置 Key` / `deepseek-chat` / `生成中…`。

**管理密码不是安全边界。** 它写在前端，会读源码的人能绕过，挡的是误触。
后端跑起来后，Base URL 填 `/api`，密码改由服务端 `XN_ADMIN_PASSWORD` 校验。

## 自动迭代（解锁后可见）

侧栏「迭代」这一页，是给管理密码用的。它模仿的是 magpie 仓库里那套工程习惯，不是「让 AI 随便改代码」。

**一轮做什么**

1. **整理反馈**：把反馈箱里的意见（配了后端会连服务器上的）丢给模型，拆成工单，合并重复项，不许发明用户没说过的问题。
2. **验证**：工单为空时先自检——让模型读项目清单，指出 1-3 个能落到具体文件的小毛病。
3. **自问自答**：还没有，就用 [grill-me](https://github.com/mattpocock/skills) 的方法审自己——先列 3-6 个决策分支，每条先给自己的推荐答案，再自问，最后把结论变成 1-2 个小功能。
4. **出方案**：模型只能改白名单文件，必须给出逐字唯一的 `find`，一处改动不超过 40 行，禁止 `eval`、外链脚本。
5. **预演**：在浏览器里内联重建一份页面，塞进 `sandbox` iframe 真的跑起来，检查 `#messages` 有没有渲染、有没有报错。
6. **反证**：把 `DOMContentLoaded` 那行摘掉，再跑一遍——必须失败。不失败就说明检查是瞎的，这一版直接毙掉。
7. **发布**：验证过了才提交到 `auto/vX.Y.Z` 分支并开 PR；不合并到 main，除非你勾了自动合并。
8. **记账**：改写 `version.js` 和 `changelog.js`，新版本和改动条目一起进仓库。

**没配发布通道也能跑**：产物留在「本次结果」里，可以下载补丁 JSON，自己应用。草稿不会改代码，刷新就回到原版本。

**发布通道**需要你在「迭代 → 发布通道」填 owner / 仓库名 / 一个只有 `repo` 权限的 GitHub Token。
Token 只存 `sessionStorage`，关掉标签页就没了——它等于把仓库写权限交给这个页面，用不用自己权衡。

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
