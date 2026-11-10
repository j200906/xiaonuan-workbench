# 插件开发指南

> 一句话版：一个插件就是一个普通对象，`id` 必填；宿主负责挂载、卸载、开关和视图路由。

本文描述**插件宿主 v2**（`assets/lib/plugin.js`，`XN.plugin.version === 2`）的契约。加一个能力不再需要改 `index.html`、`app.core.js`、样式和测试四处，而是加一个文件、在设置页点一下开关。

## 目录

1. [插件是什么](#1-插件是什么)
2. [契约表](#2-契约表)
3. [两类插件](#3-两类插件)
4. [ctx 提供什么](#4-ctx-提供什么)
5. [错误隔离约定](#5-错误隔离约定)
6. [完整示例：导出当前会话](#6-完整示例导出当前会话)
7. [调试](#7-调试)
8. [从 XN.views 迁移](#8-从-xnviews-迁移)

---

## 1. 插件是什么

一个对象。最少只要 `{ id: 'my-plugin' }` —— 它不会做任何事，但已经是一个合法插件。

`id` 必填且全局唯一；重复注册会被忽略（保留第一个，`console.warn` 一条）。`id` 同时也是 `cfg.plugins[id]` 的开关存储键。

### 登记方式

**A. 清单式（推荐）**：插件文件只往 `window.XN_PLUGINS` 里 push 一个对象，宿主启动时统一挂载。插件文件不需要知道谁先加载。

```js
window.XN_PLUGINS = window.XN_PLUGINS || [];
window.XN_PLUGINS.push({
  id: 'hello',
  name: '打个招呼',
  mount: function (ctx) { ctx.toast('hi'); }
});
```

**B. 运行时式**：`XN.plugin.register({...})`。`XN.state.cfg` 已就绪时会立刻挂载，适合按需注册或在控制台调试。

```js
XN.plugin.register({
  id: 'hello',
  name: '打个招呼',
  mount: function (ctx) { ctx.toast('hi'); }
});
```

两种方式等价；区别只是「谁来 push 这份清单」。

### 宿主接口速查

| 调用 | 作用 |
| --- | --- |
| `XN.plugin.version` | 宿主版本（v2） |
| `XN.plugin.register(p)` | 注册一个插件；没有 `id` 直接抛错，重复 `id` 忽略并返回已有对象 |
| `XN.plugin.boot()` | 把 `window.XN_PLUGINS` 里还没注册的插件收进来并全量挂载；宿主启动时自动调一次，可重复调（幂等） |
| `XN.plugin.mount(id)` / `unmount(id)` | 手动挂载 / 卸载某一个插件 |
| `XN.plugin.setEnabled(id, on)` | 开 / 关；关 = `unmount` + 跑完所有 `onDispose` + 注销视图，状态存进 `cfg.plugins[id]` |
| `XN.plugin.isEnabled(p)` | 读当前开关（`defaultEnabled` 是兜底） |
| `XN.plugin.view(viewId)` | 取视图对象（视图插件注册之后） |
| `XN.plugin.views()` | 所有已注册视图：`[{ id, title, plugin }]` |
| `XN.plugin.mounted()` | 已挂载的插件 id 数组 |
| `XN.plugin.list()` | 设置页用的列表：`{id, name, version, description, enabled, mounted, view}` |
| `XN.plugin.cards()` | 插件用 `ctx.addSettingsCard` 声明的设置卡 |

### 加载顺序

`index.html` 里：

```html
<script defer src="assets/lib/plugin.js" data-asset></script>
<script defer src="assets/plugins/export-session.js" data-asset></script>
<script defer src="assets/app.core.js" data-asset></script>
```

`plugin.js` 必须在 `app.core.js` 之前，插件文件紧随其后。全部 `defer`，**顺序即依赖**。

## 2. 契约表

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `id` | `string` | ✅ | 唯一标识。重复注册只保留第一个；也是 `cfg.plugins[id]` 的开关键 |
| `name` | `string` | – | 展示名；缺省用 `id` |
| `version` | `string` | – | 语义化版本，只用于展示与排障 |
| `description` | `string` | – | 一句话说明，显示在设置页插件卡里 |
| `defaultEnabled` | `boolean` | – | 默认是否启用，缺省 `true`；写 `false` 表示必须手动打开（此时挂载会发 `plugin:skip`，`reason: 'disabled'`） |
| `requires` | `string[]` | – | 依赖的**插件 id**。缺任何一个就不挂载，并发 `plugin:skip`（`reason: 'missing-requires'`，带 `missing` 列表） |
| `view` | `object` | – | 视图插件：视图对象（`init` / `onShow` / `render` …），宿主负责注册、路由与生命周期 |
| `nav` | `{ order?: number, icon?: string }` | – | 视图在侧栏 / 路由里的位置与图标提示；`order` 小的靠前 |
| `mount` | `(ctx) => void` | – | 挂载：加按钮、绑事件、注册工具 |
| `unmount` | `(ctx) => void` | – | 卸载钩子（可选）；清理优先用 `ctx.onDispose` |
| `settings` | `Array<object>` | – | 声明式设置项 schema：`[{ key, type, label, default? }]`，由设置页按 schema 渲染（P2 落地） |

补充说明：

- `view` 和 `mount` 可以同时存在：视图插件也能顺手挂个按钮。
- `nav.order` 建议值：对话 `10`、学习台 `20`、更新日志 `30`、设置 `40`、反馈箱 `50`、迭代 `60`。宿主 v2 先把这个字段留在契约里，侧栏顺序仍由 `cfg.nav` 决定，后续版本接上。
- `requires` 只认**已注册插件的 id**（写在前面的插件先注册，所以依赖要按加载顺序排）；宿主不会去猜能力名。
- `settings` 是声明式设置项（路线图接口，P2 落地）；宿主还不支持 schema 时，用 `ctx.addSettingsCard({ title, render })` 自己渲染，效果一样。

### 生命周期事件

宿主会发这些事件（用 `XN.on(名称, fn)` 监听）：

| 事件 | payload | 时机 |
| --- | --- | --- |
| `plugin:registered` | `{ id }` | 运行时注册且配置还没就绪，暂时没挂载 |
| `plugin:mounted` | `{ id }` | 挂载成功 |
| `plugin:unmounted` | `{ id }` | 卸载完成（含清理与视图注销） |
| `plugin:skip` | `{ id, reason, missing? }` | `reason` 为 `'disabled'` 或 `'missing-requires'`，后者带 `missing` 列表 |
| `plugin:error` | `{ id, phase: 'mount', error }` | 挂载抛错（已隔离，不影响其它插件） |
| `plugins:change` | `{ id, enabled }` | `setEnabled` 之后 |

## 3. 两类插件

### 3.1 视图插件（`view`）

- 提供一个 `view` 对象，协议与老的 `XN.views.*` 完全一致：`init()`（首次进入前调一次）、`onShow()`（每次进入调）、可选 `render()` / `onHide()`。
- 宿主负责：注册到 `XN.views.<viewId>`、记录标题、`switchView()` 路由、生命周期调用、卸载时注销。
- `viewId` 取值顺序：`view.id` → 插件 `id` 去掉 `view-` 前缀（`view-study` → `study`）。
- `view.title` 会登记进 `XN_VIEW_TITLES`，侧栏 / 标题栏用它显示中文名。
- 同一 `viewId` 只能属于一个插件：后来者被拒绝（`console.warn`，不影响它自己的 `mount`）。

```js
XN.plugin.register({
  id: 'view-study',
  name: '学习台',
  version: '2.0.0',
  view: study,                 // study = { title: '学习台', init, onShow, render, ... }
  nav: { order: 20 }
});
```

路由侧（`app.core.js`）的取法：

```js
var view = (XN.plugin && XN.plugin.view) ? (XN.plugin.view(id) || XN.views[id]) : XN.views[id];
```

也就是说：**插件视图优先，老 `XN.views` 兜底**。

### 3.2 能力插件（`mount` / `unmount`）

- 不提供视图，只在 `mount(ctx)` 里往现有界面挂东西：加按钮、绑事件、注册工具。
- 清理写在 `unmount(ctx)` 或 `ctx.onDispose(fn)`；后者更省事，宿主在卸载时统一跑。
- 例：下一节的导出会话插件。

## 4. ctx 提供什么

| 字段 | 说明 |
| --- | --- |
| `ctx.XN` | 全局命名空间（等价 `window.XN`），方便但不强制 |
| `ctx.root` | `window` |
| `ctx.id` | 当前插件 id |
| `ctx.toast(msg, kind)` | 统一提示；`kind` 可传 `'ok'` / `'error'` |
| `ctx.onDispose(fn)` | 注册卸载清理；宿主卸载时逐个 `try/catch` 执行 |
| `ctx.addSettingsCard({ title, render })` | 往设置页塞一张插件卡；`render(el)` 自己渲染内容 |

约定：插件之间**不直接互相调用**。要联动就发事件——`XN.emit('事件名', payload)`，对方用 `XN.on('事件名', fn)` 接。

## 5. 错误隔离约定

- `mount` 抛错：宿主捕获、`console.error`、toast 提示，并发 `plugin:error`（`{ id, phase: 'mount', error }`），`mount` 返回 `false`。**其它插件照常挂载。**
- `unmount` 抛错：同样捕获；`onDispose` 里每个函数单独 `try/catch`，**保证都跑到**，并且视图注销照常进行。
- `requires` 缺失 / `defaultEnabled: false`：不挂载，发 `plugin:skip` 说明原因，不当错误处理。
- `id` 重复：忽略后注册的那个，不发事件、不抛错（一个坏插件不该拖垮整页）。
- `register` 没给 `id`：直接抛 `Error('插件必须有 id')` —— 这是开发者错误，早点暴露。
- **卸载一定跑清理**：`setEnabled(id, false)`、`XN.plugin.unmount(id)` 都会走 `unmount` 钩子 → 所有 `onDispose` → 注销视图 → 从 `mounted()` 移除。

## 5.5 声明式设置（P2）

插件只要声明 `settings`，设置页会自动生成表单项，值存在 `cfg.pluginConfig[id]`：

```js
settings: [
  { key: 'prefix', type: 'text', label: '文件名前缀', default: 'xiaonuan-chat' },
  { key: 'withDate', type: 'checkbox', label: '文件名带日期', default: true }
]
```

插件内读取：`ctx.config('prefix', 'xiaonuan-chat')`；写入：`ctx.setConfig('prefix', v)`。

## 5.6 能力接口（P3）

模型、抓网页、搜索、存储都是具名服务，默认实现指向原模块，可整块替换：

```js
XN.services.use('llm').chatRaw(messages, opts);
XN.services.register('fetch', { get: async (url, offset) => ({ ok: true, text: '...' }), ready: () => true });
XN.services.reset('fetch');
XN.services.list();  // [{name, builtin, ready, methods}]
```

## 5.7 安装式加载（P4，雏形）

```js
await XN.plugin.install('/assets/plugins/foo.js');  // 注入脚本，插件自己 register
```

## 6. 完整示例：导出当前会话

`assets/plugins/export-session.js`（能力插件，约 30 行）：

```js
/* 把当前会话导出成 Markdown —— 一个最小的能力插件 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};
  root.XN_PLUGINS = root.XN_PLUGINS || [];

  root.XN_PLUGINS.push({
    id: 'export-session',
    name: '导出当前会话',
    version: '1.0.0',
    description: '把正在聊的这个会话导出成 Markdown 文件',
    defaultEnabled: true,

    mount: function (ctx) {
      var host = root.document.querySelector('.composer-btns');
      if (!host) return;
      var btn = root.document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm';
      btn.textContent = '导出';
      btn.title = '把当前会话导出成 Markdown';
      btn.addEventListener('click', function () {
        var s = XN.currentSession();
        if (!s || !s.messages || !s.messages.length) return ctx.toast('这个会话还没有内容');
        var lines = ['# ' + (s.title || '对话'), ''];
        s.messages.forEach(function (m) {
          lines.push('**' + (m.role === 'user' ? '我' : '小暖') + '**：' + String(m.content || '').trim(), '');
        });
        XN.download('xiaonuan-chat-' + XN.util.todayStr() + '.md', lines.join('\n'), 'text/markdown;charset=utf-8');
        ctx.toast('已导出', 'ok');
      });
      host.appendChild(btn);
      ctx.onDispose(function () { if (btn.parentNode) btn.parentNode.removeChild(btn); });
    }
  });
})(window);
```

关键点：

- 只 push 一个对象：没有改 `app.core.js`、没有改布局、没有新增全局函数。
- 按钮用 `ctx.onDispose` 挂清理，关掉插件按钮就消失。
- 数据走公共接口（`XN.currentSession()`、`XN.download()`），不碰内部状态。

## 7. 调试

1. **设置页 →「插件」卡**：列出名字、版本、说明和开关。关掉立刻卸载、按钮消失；再打开就回来。状态存在 `cfg.plugins`，刷新保持。
2. **控制台**：
   - `XN.plugin.list()` → 全部插件（含 `enabled` / `mounted` / `view`）
   - `XN.plugin.mounted()` → `['export-session']`
   - `XN.plugin.view('study')` → 视图对象；`XN.plugin.views()` → `[{ id, title, plugin }]`
   - `XN.plugin.cards()` → 插件声明的设置卡
3. **事件**：`XN.on('plugin:error', function (e) { ... })`、`XN.on('plugin:skip', ...)`、`XN.on('plugin:mounted', ...)`、`XN.on('plugins:change', ...)`。
4. **插件没出现？** 按顺序查：脚本是否在 `app.core.js` 之前、`id` 是否重复、`requires` 里的插件 id 是否真的注册了（控制台会看到 `plugin:skip`）。

## 8. 从 XN.views 迁移

老写法仍然可用：

```js
XN.views.study = study;   /* v2 起这是兼容别名：宿主注册视图时同样写 XN.views */
```

新代码一律走注册：

```js
XN.plugin.register({ id: 'view-study', name: '学习台', view: study, nav: { order: 20 } });
```

迁移步骤：

1. 文件末尾的 `XN.views.<viewId> = view;` 换成 `register`（宿主不在时保留 `else` 分支，见下）。
2. `view` 对象本身一行不动（`init` / `onShow` / `render` 原样）。
3. 跑 `node --check` 和 `node tests/ui-check.mjs`。
4. 有按钮 / 事件的，顺手补 `ctx.onDispose`，保证能关干净。

宿主不在时的兼容写法：

```js
if (XN.plugin) {
  XN.plugin.register({ id: 'view-study', name: '学习台', version: '2.0.0', view: study, nav: { order: 20 } });
} else {
  XN.views.study = study;
}
```

迁移不会丢用户设置：开关状态在 `cfg.plugins[id]`，默认值由 `defaultEnabled` 决定。
