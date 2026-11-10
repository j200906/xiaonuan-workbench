/* 示例插件：导出当前会话为 Markdown
 *
 * 这个文件就是「一行能力」——它不碰 app.core.js、不改 index.html 的结构，
 * 只往 window.XN_PLUGINS 里塞一个对象，插件运行时负责挂载/卸载。
 */
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
      var doc = root.document;
      if (!doc || doc.getElementById('pluginExportSession')) return;

      var host = doc.querySelector('.composer-btns') || doc.querySelector('.composer-foot');
      if (!host) return;

      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = 'pluginExportSession';
      btn.className = 'btn ghost sm';
      btn.textContent = '导出';
      btn.title = '把当前会话导出成 Markdown';
      btn.addEventListener('click', function () {
        var s = (XN.currentSession && XN.currentSession()) || null;
        if (!s || !s.messages || !s.messages.length) { ctx.toast('这个会话还没有内容'); return; }
        var title = s.title || '对话';
        var lines = ['# ' + title, '', '_导出于 ' + (XN.util ? XN.util.todayStr() : new Date().toISOString().slice(0, 10)) + '_', ''];
        s.messages.forEach(function (m) {
          var who = m.role === 'user' ? '我' : (XN.personaName ? XN.personaName() : '小暖');
          lines.push('**' + who + '**：' + String(m.content || '').trim());
          lines.push('');
        });
        var name = 'xiaonuan-chat-' + (XN.util ? XN.util.todayStr() : Date.now()) + '.md';
        if (XN.download) {
          XN.download(name, lines.join('\n'), 'text/markdown;charset=utf-8');
          ctx.toast('已导出 ' + name, 'ok');
        } else {
          ctx.toast('下载工具不可用', 'error');
        }
      });

      host.appendChild(btn);
      ctx.onDispose(function () { if (btn.parentNode) btn.parentNode.removeChild(btn); });
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
