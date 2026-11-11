/* 小暖 · 本地默认插件清单（P4 安装式扩展）
 *
 * 这个文件只做一件事：把默认清单挂到 window.XN_PLUGIN_MANIFEST 上。
 * 宿主通过 XN.plugin.loadManifest() 读它（不传 url 时优先用这份本地清单），
 * 再按清单逐个 install(url) 动态注入 —— 不碰 app.core.js、不改 index.html 结构。
 *
 * 清单结构（version 是清单格式版本，不是某个插件的版本）：
 * {
 *   version: 1,
 *   plugins: [{ id, url, version, enabled, description }]
 * }
 *   id            必填，插件唯一 id（和插件自己 register 的 id 一致）
 *   url           必填，插件脚本地址（相对路径按页面地址解析）
 *   version       插件版本，用来和已注册版本比对 → 不同就记 pendingUpdate，不热替换
 *   enabled       false 表示跳过；其余（true / 不写）都算启用
 *   description   可选，给设置页展示
 *
 * 以后要换成远程清单，只需要 XN.plugin.loadManifest('https://.../manifest.json')，
 * 本文件的默认清单就退化成兜底。
 */
(function (root) {
  'use strict';

  root.XN_PLUGIN_MANIFEST = {
    version: 1,
    plugins: [
      {
        id: 'export-session',
        url: 'assets/plugins/export-session.js',
        version: '1.0.0',
        enabled: true,
        description: '把正在聊的这个会话导出成 Markdown 文件'
      }
    ]
  };
})(typeof window !== 'undefined' ? window : globalThis);
