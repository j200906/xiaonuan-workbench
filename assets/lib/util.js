/* 小暖 · 基础工具（无依赖）
 * 统一 DOM/格式化/提示/下载/事件总线，避免各文件各写一份。 */
(function (root) {
  'use strict';

  var XN = root.XN = root.XN || {};

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var uidSeq = 0;
  function uid(prefix) {
    uidSeq = (uidSeq + 1) % 1679616;
    var rand;
    try {
      if (root.crypto && root.crypto.getRandomValues) {
        var buf = new Uint32Array(1);
        root.crypto.getRandomValues(buf);
        rand = buf[0].toString(36);
      }
    } catch (e) { /* 忽略，走下面的兜底 */ }
    if (!rand) rand = Math.random().toString(36).slice(2);
    return (prefix || '') + Date.now().toString(36) + '-' + uidSeq.toString(36) + '-' + rand.slice(0, 6);
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDate(ts) {
    var d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  /* 本地日历日。刻意不用 toISOString()：那是 UTC，跨时区会在半夜跳错天。 */
  function dayKey(ts) {
    var d = ts == null ? new Date() : new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayStr() { return dayKey(); }

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* 只允许 http/https/mailto 和站内相对路径，挡掉 javascript: data: 之类 */
  function safeUrl(raw, allowRelative) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    if (allowRelative !== false && /^(\/|\.\/|#|\?)/.test(u)) return u;
    if (/^(https?:|mailto:)/i.test(u)) return u;
    return '';
  }

  function debounce(fn, wait) {
    var timer = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
    };
  }

  function throttle(fn, wait) {
    var last = 0, timer = 0, lastArgs = null, lastSelf = null;
    return function () {
      var now = Date.now();
      lastArgs = arguments; lastSelf = this;
      var remain = wait - (now - last);
      if (remain <= 0) {
        clearTimeout(timer); timer = 0; last = now;
        fn.apply(lastSelf, lastArgs);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = 0; last = Date.now();
          fn.apply(lastSelf, lastArgs);
        }, remain);
      }
    };
  }

  /* ---------- 事件总线 ---------- */
  var listeners = {};
  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] = listeners[name] || []).push(fn);
    return function off() {
      listeners[name] = (listeners[name] || []).filter(function (x) { return x !== fn; });
    };
  }
  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { if (root.console) console.error('[xn] listener', name, e); }
    });
  }

  /* ---------- 提示队列 ---------- */
  var toastQueue = [];
  var toastBusy = false;
  var TOAST_MS = 2200;

  function ensureToastHost() {
    var host = $('#toastStack');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'toastStack';
    host.className = 'toast-stack';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function drainToast() {
    if (toastBusy) return;
    var next = toastQueue.shift();
    if (!next) return;
    toastBusy = true;
    var host = ensureToastHost();
    var item = document.createElement('div');
    item.className = 'toast-item' + (next.kind ? ' ' + next.kind : '');
    item.textContent = next.msg;
    host.appendChild(item);
    /* 强制回流，保证进场动画生效 */
    void item.offsetWidth;
    item.classList.add('show');
    setTimeout(function () {
      item.classList.remove('show');
      setTimeout(function () {
        item.remove();
        toastBusy = false;
        drainToast();
      }, 180);
    }, next.ms || TOAST_MS);
  }

  function toast(msg, kind, ms) {
    var text = String(msg == null ? '' : msg).trim();
    if (!text) return;
    if (toastQueue.length > 6) toastQueue.shift();
    toastQueue.push({ msg: text, kind: kind || '', ms: ms });
    drainToast();
  }

  /* ---------- 下载 / 复制 ---------- */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 600);
  }

  function copyText(text) {
    if (navigator.clipboard && root.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  }

  /* ---------- 可访问性 ---------- */
  function trapFocus(container) {
    var focusables = $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', container)
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
    if (!focusables.length) return function () {};
    var first = focusables[0], last = focusables[focusables.length - 1];
    function onKey(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    container.addEventListener('keydown', onKey);
    first.focus();
    return function release() { container.removeEventListener('keydown', onKey); };
  }

  XN.util = {
    $: $, $$: $$, esc: esc, uid: uid, clamp: clamp, pad2: pad2,
    fmtTime: fmtTime, fmtDate: fmtDate, dayKey: dayKey, todayStr: todayStr,
    bytes: bytes, isPlainObject: isPlainObject, safeUrl: safeUrl,
    debounce: debounce, throttle: throttle, on: on, emit: emit,
    toast: toast, download: download, copyText: copyText, trapFocus: trapFocus
  };

  /* 兼容旧代码：这些名字以前直接挂在 XN 上 */
  Object.keys(XN.util).forEach(function (k) { if (!XN[k]) XN[k] = XN.util[k]; });
})(typeof window !== 'undefined' ? window : globalThis);
