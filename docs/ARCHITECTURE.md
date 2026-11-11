# 架构对照：DSH 为什么更自由，小暖要怎么学

> 本文是学习笔记 + 改造路线图。对照对象是 DeepSeek Harness（DSH，基于 cordis）的 profile 组合方式。

## 一、DSH 是怎么组织的（读 profile 得到的结论）

```
~/.dsh/profiles/desktop/
├─ cordis.yml          # 根：一个空数组 []
├─ cordis.patch.yml    # 用户层：按 id 覆盖/禁用/新增行
├─ package.json        # dsh.profile.bundles：按顺序叠的 bundle 列表
└─ node_modules/       # 每个插件就是一个 npm 包
```

要点四条：

1. **根是空的**。`cordis.yml` 里只有 `[]`。整棵能力树不是写好的，是**一层层 patch 叠出来的**。
2. **bundle 就是一层 patch**。每个 bundle 自带 `cordis.patch.yml`，里面是一串「行」：
   ```yaml
   - id: web
     name: "@deepseek-ai/dsh-web"
     config:
       searchProvider: ddg
       fetchProvider: http
   ```
   `id` 是身份，`name` 是模块，`config` 是这一行的参数。
3. **用户层最后覆盖**。`cordis.patch.yml` 按 `id` 就能改配置、`disabled: true` 关掉、插新行，还能写 `!!js` 表达式。
4. **连核心能力也是行**：模型路由（`llm-pi-ai`）、搜索（`web`）、UI（`ui-chat`/`ui-theme`）、定时器、HMR、类型注册表——全是行。所以换个模型网关、换搜索源，**不改代码，改 YAML**。

一句话：**组合是数据，能力是行，用户层可覆盖。**

## 二、小暖以前为什么局限

| | DSH | 小暖（改造前） |
| --- | --- | --- |
| 能力从哪来 | bundle 的 patch 行 | `index.html` 里手写的 `<script>` 列表 |
| 加一个功能 | 装一个包 + 写一行 | 改 index.html + app.core + 样式 + 测试，4–5 个文件 |
| 开关某个能力 | 行上 `disabled: true` | 没有开关，代码写死 |
| 配置从哪来 | 行内 `config` | 全局 `cfg` 大对象，字段散落 |
| 边界 | 每个插件是独立包，只依赖契约 | 全在一个 `window.XN` 命名空间里，谁都能碰谁 |
| 替换实现 | 换 `name` 指向另一个包 | 改源码 |

结果就是：功能越多，`app.core.js` 越胖，加东西越慢——这也是之前「越做越慢」的一个结构性原因。

## 三、已经落地的最小版（v1.10.0）

不追求一次到位，先有「行」这个概念：

### 1. 插件运行时 `assets/lib/plugin.js`

```js
XN.plugin.register({
  id: 'export-session',
  name: '导出当前会话',
  version: '1.0.0',
  defaultEnabled: true,
  mount(ctx) { /* 挂 UI、注册工具 */ },
  unmount(ctx) { /* 清理 */ }
});
```

- `XN.plugin.boot()`：启动时按 `window.XN_PLUGINS` 清单挂载
- `XN.plugin.setEnabled(id, on)`：开关，持久化在 `cfg.plugins[id]`
- `XN.plugin.list()`：给设置页列插件
- `ctx` 提供 `XN / toast / onDispose / addSettingsCard`，插件不需要直接摸全局

### 2. 清单 `window.XN_PLUGINS`

每个插件文件只做一件事：往清单里 push 一个对象。

```html
<script defer src="assets/lib/plugin.js" data-asset></script>
<script defer src="assets/plugins/export-session.js" data-asset></script>
<script defer src="assets/app.core.js" data-asset></script>
```

`plugin.js` 必须在 `app.core.js` 之前，插件文件紧随其后。

### 3. 设置页「插件」卡

列出 `XN.plugin.list()`，带开关；关掉即 `unmount`，按钮/UI 立刻消失，再打开就回来。
状态存在 `cfg.plugins`，刷新保持。

### 4. 示例插件 `assets/plugins/export-session.js`

在输入框按钮组里加一个「导出」，把当前会话存成 Markdown。
它**没有改** `app.core.js`、没有改布局、没有新增全局函数——这就是「一行能力」。

## 四、路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 插件运行时 + 清单 + 设置开关 + 一个示例插件 | ✅ v1.10.0 |
| P1 | 把六个视图（对话/学习/反馈/更新/设置/迭代）各迁成一个插件，`app.core` 只留路由与会话 | ✅ v2.2.0（六个视图全部注册为插件；会话数据抽到 `assets/lib/session.js`） |
| P2 | 设置项声明式：插件自带 `settings: [{key,type,label}]`，设置页按 schema 生成 | ✅ v2.1.0 |
| P3 | 能力接口化：模型调用、搜索、存储各定义一个接口，插件可替换实现（对应 DSH 的 `llm-pi-ai` / `web` 行） | ✅ v2.1.0（`XN.services`） |
| P4 | 安装式扩展：插件清单改为可远程拉取的 manifest，配 `enabled/version`，支持禁用与回滚 | ✅ v2.3.0（`loadManifest` / `pin` / `rollback` / `status`） |

约束两条：

- **每个插件必须能单独卸载**（`onDispose` 清干净），否则就不是插件，是新的耦合。
- **插件之间不直接互相调用**，只通过 `XN` 的公共接口；要联动就发事件（`XN.emit`）。

## 五、和 DSH 的差距（诚实版）

DSH 的「自由」还依赖两样本项目暂时没有的东西：

1. **模块系统**：DSH 每个插件是 ESM 包，有 `package.json`、可版本化、可 `import`。小暖是经典 `<script>`，没有模块边界。
2. **依赖注入容器**（cordis）：行与行之间靠服务注册表解析依赖，谁先谁后由容器排。小暖只能靠加载顺序。

所以小暖的插件化是「够用版」：先拿到**可插拔、可开关、可卸载**这三件事；真要往 ESM + 容器走，得先上打包器，那是另一场改造。
