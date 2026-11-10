/* 小暖 · 更新日志 */
(function (root) {
  'use strict';

  var XN = root.XN;
  var $ = XN.$;

  function versionTuple(v) {
    return String(v || '0.0.0').split('.').map(function (n) { return Number(n) || 0; });
  }

  /* 日志列表默认只展开最近 5 条，其余折叠；「展开全部 / 收起」按钮由 JS 注入，index.html 不用改。
     展开状态只放内存：换个比较区间就回到「只看最近 5 条」。 */
  var PAGE = 5;
  var expanded = false;

  function itemHtml(c) {
    return '<article class="cl-item">' +
      '<div class="cl-head"><strong>v' + XN.esc(c.version) + '</strong>' +
      '<span class="cl-title">' + XN.esc(c.title || '') + '</span>' +
      '<span class="cl-date">' + XN.esc(c.date || '') + '</span></div>' +
      ((c.fixes && c.fixes.length) ? '<div class="cl-sec"><h4>修掉的</h4><ul>' +
        c.fixes.map(function (x) { return '<li>' + XN.esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      ((c.features && c.features.length) ? '<div class="cl-sec"><h4>新增的</h4><ul>' +
        c.features.map(function (x) { return '<li>' + XN.esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      (c.notes ? '<p class="cl-note">' + XN.esc(c.notes) + '</p>' : '') +
      '</article>';
  }

  function toggleHtml(collapsed, rest) {
    var label = collapsed
      ? '展开全部（还有 ' + rest + ' 条）'
      : '收起（只看最近 ' + PAGE + ' 条）';
    return '<div class="cl-more" style="display:flex;justify-content:center;padding-top:2px">' +
      '<button type="button" class="btn ghost sm" id="clToggle" aria-controls="clList" aria-expanded="' +
      (collapsed ? 'false' : 'true') + '">' + XN.esc(label) + '</button></div>';
  }

  var changelog = {
    init() {
      $('#clFrom').addEventListener('change', () => { expanded = false; this.render(); });
      $('#clTo').addEventListener('change', () => { expanded = false; this.render(); });
    },

    onShow() {
      this.fill();
      this.render();
    },

    list() {
      var recent = (root.XN_CHANGELOG || []).slice();
      var archive = (root.XN_CHANGELOG_ARCHIVE || []).slice();
      var seen = {};
      return recent.concat(archive).filter(function (c) {
        if (!c || !c.version || seen[c.version]) return false;
        seen[c.version] = 1;
        return true;
      }).sort(function (a, b) {
        var A = versionTuple(a.version), B = versionTuple(b.version);
        for (var i = 0; i < 3; i++) if (A[i] !== B[i]) return B[i] - A[i];
        return 0;
      });
    },

    fill() {
      var list = this.list();
      var from = $('#clFrom'), to = $('#clTo');
      if (!list.length) return;
      var opts = list.map(function (c) {
        return '<option value="' + XN.esc(c.version) + '">v' + XN.esc(c.version) + '</option>';
      }).join('');
      if (from.dataset.filled !== '1') {
        from.innerHTML = opts;
        to.innerHTML = opts;
        from.value = list[list.length - 1].version;
        to.value = list[0].version;
        from.dataset.filled = '1';
        to.dataset.filled = '1';
      }
      var meta = $('#clMeta');
      if (meta) meta.textContent = '当前 v' + (root.XN_VERSION || '?') + ' · 共 ' + list.length + ' 个版本';
    },

    render() {
      var list = this.list();
      var fromV = $('#clFrom').value || (list[list.length - 1] || {}).version;
      var toV = $('#clTo').value || (list[0] || {}).version;
      var iFrom = list.findIndex(function (c) { return c.version === fromV; });
      var iTo = list.findIndex(function (c) { return c.version === toV; });
      if (iFrom < 0) iFrom = list.length - 1;
      if (iTo < 0) iTo = 0;
      if (iFrom < iTo) { var tmp = iFrom; iFrom = iTo; iTo = tmp; }

      var range = iFrom === iTo ? [list[iTo]] : list.slice(iTo, iFrom + 1);
      var fixes = range.reduce(function (n, c) { return n + (c.fixes || []).length; }, 0);
      var feats = range.reduce(function (n, c) { return n + (c.features || []).length; }, 0);
      var scope = iFrom === iTo ? 'v' + toV + ' 这一个版本' : 'v' + fromV + ' 到 v' + toV + ' · ' + range.length + ' 个版本';
      $('#clSum').textContent = scope + ' · 修复 ' + fixes + ' 项 · 新增 ' + feats + ' 项';

      var box = $('#clList');
      if (!range.length) {
        box.innerHTML = '<p class="it-empty">这段区间没有记录。</p>';
        return;
      }
      var collapsed = !expanded && range.length > PAGE;
      var shown = collapsed ? range.slice(0, PAGE) : range;
      box.innerHTML = shown.map(itemHtml).join('') +
        (range.length > PAGE ? toggleHtml(collapsed, range.length - shown.length) : '');
      var toggle = $('#clToggle');
      if (toggle) {
        toggle.addEventListener('click', function () {
          expanded = !expanded;
          changelog.render();
        });
      }
    }
  };

  XN.views = XN.views || {};
  XN.views.changelog = changelog;
})(window);
