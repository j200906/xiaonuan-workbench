/* 示例：一个「DSH 风格」插件（ESM + apply(ctx)）
 *
 * 它不是小暖原生的写法的，而是照 DSH（cordis）习惯写的：
 *   export function apply(ctx) { ... }
 * 用来验证 assets/lib/dsh-compat.js 的兼容层。
 *
 * 在插件中心里「从地址安装（DSH 兼容）」填这个文件地址即可加载。
 */
export function apply(ctx) {
  const log = ctx.logger('dsh-hello');
  const count = { n: 0 };

  ctx.command('hello', '打个招呼（DSH 兼容示例）').action(() => {
    count.n += 1;
    log.info('被调用 ' + count.n + ' 次');
    if (typeof window !== 'undefined' && window.XN && window.XN.toast) {
      window.XN.toast('你好，这是 DSH 风格插件（第 ' + count.n + ' 次）', 'ok');
    }
    return { ok: true, count: count.n };
  });

  ctx.view({
    id: 'dsh-hello',
    title: 'DSH 示例',
    version: '1.0.0',
    onShow() {
      const pane = document.querySelector('#view-dsh-hello .board');
      if (!pane) return;
      pane.innerHTML =
        '<header class="pane-head"><h1>DSH 示例插件</h1>' +
        '<p class="sub">用 <code>export function apply(ctx)</code> 写的插件，由兼容层跑起来。</p></header>' +
        '<article class="card wide"><header class="card-head"><h2>能做什么</h2></header>' +
        '<div class="kv">' +
        '<div class="kv-row"><span>注册命令</span><span><code>ctx.command("hello")</code></span></div>' +
        '<div class="kv-row"><span>注册视图</span><span><code>ctx.view({ id, onShow })</code></span></div>' +
        '<div class="kv-row"><span>副作用登记</span><span><code>ctx.effect(fn)</code></span></div>' +
        '<div class="kv-row"><span>服务替换</span><span><code>ctx.set("fetch", impl)</code></span></div>' +
        '</div>' +
        '<div class="arch-btns"><button class="btn sm" id="dshHelloBtn" type="button">调用 hello 命令</button></div>' +
        '</article>';
      const btn = pane.querySelector('#dshHelloBtn');
      if (btn) btn.addEventListener('click', () => {
        if (window.XN && window.XN.dsh) window.XN.dsh.runCommand('hello');
      });
    }
  });

  ctx.effect(() => {
    log.info('插件已挂载');
    return () => log.info('插件已卸载');
  });
}

export default { apply };
