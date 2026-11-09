# Cloudflare Workers 版

一个 Worker 同时托管页面、代理模型请求、收反馈。免费额度：10 万请求/天，不休眠。

## 为什么用它

- 不需要服务器，不用管睡眠和冷启动
- Key 存在 Worker 的 secret 里，访客看不到
- `workers.dev` 域名国内一般能打开

## 部署

1. 注册 <https://dash.cloudflare.com/sign-up>（邮箱即可）
2. 右侧头像 → **My Profile** → **API Tokens** → **Create Token**
   → 模板选 **Edit Cloudflare Workers** → 继续 → 创建 → 复制
3. 回到这个目录，跑：

```bash
node build.mjs
CLOUDFLARE_API_TOKEN=你的token XN_API_KEY=sk-xxx node deploy.mjs
```

跑完会打印 `https://xiaonuan.<你的子域>.workers.dev`。

## 可选：反馈存起来

默认反馈只回执、不落库（前端本来就存了一份在本机）。要真的收起来：

```bash
npx wrangler kv namespace create XN_KV
```

把输出的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`，再部署一次。

## 本地验证

```bash
node test.mjs          # 8 项路由检查，用假上游，不需要联网
npx wrangler deploy --dry-run   # 只校验配置，不发布
```
