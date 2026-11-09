# Cloudflare 部署说明

主力是 **Pages**，不是 Workers。原因：`workers.dev` 在国内被 DNS 污染，`pages.dev` 正常。

## Pages（推荐）

在仓库根目录：

```bash
# .env 里填 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / XN_ADMIN_PASSWORD / XN_ADMIN_SECRET ...
node cloudflare/deploy_pages.mjs xiaonuan-app
```

脚本会：

1. 组装 `index.html` + `assets` + `_worker.js` + `shared.js` + `rules.js`
2. 写 Pages 环境变量、KV、AI 绑定
3. 给静态资源打内容哈希
4. `wrangler pages deploy`

模块关系：

- `worker.js`：路由、静态托管、聊天/搜索/抓取/反馈/迭代入口
- `shared.js`：白名单、限流、HMAC 令牌、SSRF、安全响应头
- `rules.js`：补丁校验（服务端）
- `iterate.js`：云端自迭代，一次提交 + 打 tag

## Workers（legacy）

`wrangler.toml` 与 `deploy.mjs` 仍保留，但不再作为主路径。需要时：

```bash
cd cloudflare
node build.mjs
CLOUDFLARE_API_TOKEN=... npx wrangler secret put XN_ADMIN_PASSWORD
CLOUDFLARE_API_TOKEN=... npx wrangler deploy
```

## 检查

```bash
node cloudflare/test.mjs       # 16 项路由/鉴权/安全边界，不需要联网
npx wrangler deploy --dry-run  # 只校验配置
```
