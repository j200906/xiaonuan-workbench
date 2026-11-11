/* 对话页视图插件（P1 收尾）
 *
 * 对话的渲染逻辑仍在 app.core（与会话状态、流式、工具循环强耦合），
 * 但**视图身份**通过宿主注册，这样六个视图在注册表里是一致的：
 * 路由统一走 XN.plugin.view('chat')，也不再需要 app.core 自己认定这个视图。
 *
 * 迁移路线：等渲染逻辑也搬出去，这里把 render 换成自己的实现即可，
 * 调用方（路由/侧栏）不用改。
 */
(function (root) {
  'use strict';
  var XN = root.XN = root.XN || {};
  root.XN_PLUGINS = root.XN_PLUGINS || [];

  root.XN_PLUGINS.push({
    id: 'view-chat',
    name: '对话',
    version: '2.2.0',
    description: '主对话界面（渲染仍由核心提供）',
    defaultEnabled: true,
    nav: { order: 10 },
    view: {
      id: 'chat',
      title: 'nav.chat',
      init: function () {
        /* 核心在 boot 里已经完成首屏渲染，这里不重复承担 */
      },
      onShow: function () {
        if (XN.renderSessions) { try { XN.renderSessions(); } catch (e) {} }
        if (XN.renderThread) { try { XN.renderThread(); } catch (e) {} }
      }
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
