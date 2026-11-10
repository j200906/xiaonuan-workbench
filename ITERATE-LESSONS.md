<!-- reviewed-through: v1.5.6 -->
# 自迭代教训

这份文件由自迭代自己维护：每失败一次记一笔，同一规则踩够 3 次升级成【硬规则】。
改代码前先读；硬规则等同于 code standards，不许绕过。

- （seen 1）升版本要同步 package.json、assets/changelog.js、assets/version.js、README.md 四处。
  为什么：只改 changelog 不改 package.json，check.mjs 直接报「版本不一致」，CI 必挂。

- （seen 1）find 必须从正文里逐字复制（含缩进、标点和引号），不能照着结构列表自己编。
  为什么：小模型实测会编出 `$$('#chatMsgTxt')`、`<footer class="note-more">` 这种仓库里根本不存在的原文。

- （seen 1）改完的代码要能通过括号与字符串扫描：不要省略结尾，也不要在字符串里留未闭合的引号。
  为什么：扫描器不执行代码，只数结构；少一个 } 整份就会被拒。

- （seen 1）只想描述「禁止 javascript: 这类伪协议」时写在注释里，不要写成 URL 形式。
  为什么：校验器现在只认 href/src/action 这类真正会被当 URL 的位置，注释里提到不会误伤。
