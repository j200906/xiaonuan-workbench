# 小暖 · 安全边界与钥匙轮换

这份文档回答「哪些地方会碰钥匙、泄露了怎么办、多久换一次」。
代码里的边界只有一处：`cloudflare/shared.js`（同源 / 令牌 / 限流 / SSRF），
`worker.js` 与 `iterate.js` 都从那里取，避免只改了一边。

## 1. 管理会话（`/api/admin/verify`）

- 密码只在验证那一次用：`POST /api/admin/verify` → HMAC 会话令牌（12 小时）。
- 令牌 = `base64url(payload) + "." + HMAC-SHA256(secret, payload)`，payload 里带
  `scope=admin`、`iat`、`exp`、`jti` 和 **`ver`（令牌版本）**。
- **一次吊销所有会话**：把 Pages/Worker 环境变量 `XN_ADMIN_TOKEN_VERSION` 从 `1` 改成 `2`。
  老令牌的 `ver` 对不上，下一次请求就 401；不用等 12 小时，也不用量 KV 存撤销列表。
  （升级到带 `ver` 的版本后，旧格式令牌本来就会全部失效，重新解锁一次即可。）
- **换密码**：改 `XN_ADMIN_PASSWORD` 会同时换 HMAC 密钥，等于吊销全部会话；
  如果还配了 `XN_ADMIN_SECRET`，只改密码不会吊销会话，要一起 bump `XN_ADMIN_TOKEN_VERSION`。
- 会话令牌存 `sessionStorage`，关标签页即丢；服务端不落库、不写日志。

## 2. GitHub Token（`XN_GH_TOKEN`）

- 只存在服务端环境变量里，**不进浏览器**：前端既没有输入框，也不读 `localStorage`/`sessionStorage`。
- 权限：经典 PAT 只需 `repo`（Git Data API 要写 blob/tree/commit/ref）；
  细粒度 PAT 只需目标仓库的 **Contents: Read and write**，不要给 `workflow`、`admin`、`delete_repo`。
- 轮换：
  1. 在 GitHub 建新 token（同样的最小权限）；
  2. 更新 Cloudflare Pages 项目的 `XN_GH_TOKEN` 环境变量（**只改这一项**，别整表覆盖——见 DEPLOY.md 的 dry-run 闸）；
  3. 重新部署 Worker/Pages 让新值生效；
  4. 在 GitHub 撤销旧 token；
  5. 顺手 bump `XN_ADMIN_TOKEN_VERSION`，确认没有旧会话还在用。
- 建议 90 天轮换一次；怀疑泄露时立即执行第 3、4 步。
- 自迭代只把 token 用在 `api.github.com`，不发给模型，也不写进日志/提交信息。

## 3. 用户自带模型 Key（`/api/chat`）

- 客户端把 Key 放在 `Authorization: Bearer …` 里；`authOnly()` 只认这个头，
  **`X-Admin-Token` 绝不会被当模型 Key 转发给上游**。
- 代理是「透传」：请求进来 → 直接发给白名单里的上游，不落 KV、不写日志、不回显。
- 服务端自己的 `XN_API_KEY` 只在请求没带 Key 时使用；错误信息只包含上游状态码，不包含 Key。
- 记住 Key 是可选项：不勾「记住」只存 `sessionStorage`；勾了才进本机 `localStorage`。

## 4. 同源 / CSRF

- 有 `Origin` 就必须同源或在 `XN_ALLOWED_ORIGINS` 白名单里；
- 浏览器明确标 `Sec-Fetch-Site: cross-site` 的请求一律 403（JS 改不了这个头）；
- 没有 `Origin` 的是非浏览器客户端（curl / 桌面壳 / 本地后端），默认放行以兼容本机版；
- 只想让浏览器访问的部署，设 `XN_REQUIRE_ORIGIN=1`：缺 `Origin` 也拒绝。
- 管理写接口（`/api/iterate`、`GET/DELETE /api/feedback`）除了同源，还要管理员令牌。
- 注意：同源不是身份认证。真正的闸是令牌 + 限流。

## 5. 反馈数据

- 只存 KV：正文（≤2000 字）、类型、可选联系方式、UA、按天加盐的 IP 哈希、时间。
- 保留期默认 **180 天**（`XN_FEEDBACK_TTL_DAYS`，1–365），到期 KV 自动删。
- 管理员可随时删：`DELETE /api/feedback?all=1`、`?id=<记录id>`、`?before=YYYY-MM-DD`。
- 说明见 [PRIVACY.md](PRIVACY.md)。

## 6. 已知未做（说清楚，不装作有）

- 没有 WAF / 人机验证；限流是 KV + 内存两级，KV 最终一致，极端并发下会略超
  （`/api/iterate` 额外用 in-flight 排他，同一 IP 同时只跑一个，避免并发放大额度）。
- 限流的 IP 取自 `CF-Connecting-IP`：真实 Cloudflare 边缘会覆盖这个头，所以线上可信；
  自建反代 / 本地后端只有在 `XN_TRUST_PROXY=1` 时才信 `X-Forwarded-For`，否则用连接地址。
- 没有单会话撤销（只有 `XN_ADMIN_TOKEN_VERSION` 一次吊销全部；`jti` 只用于审计，不做黑名单）。
- 没有审计日志（避免把 Key/正文写进日志是刻意取舍）。
- Pages 是 Direct Upload，`push main` 不会自动更新线上；部署脚本才有 `XN_*` 环境变量。

## 7. 报告问题

发现漏洞请开 issue 或直接联系仓库 owner，别在公开 issue 里贴 token / 密码。
