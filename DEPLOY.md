# 部署（操作步骤）

环境变量的完整说明在 [README.md](README.md#环境变量)。这里只给命令。

## 0. 本机先跑通

```bash
# 最省事：Windows 双击 start-local.bat；mac/Linux 跑 ./start-local.sh
# 它会问管理密码、接本机 3425 magpie、启动后端并开浏览器。

# 或者手动：
cp .env.example .env        # 至少填 XN_ADMIN_PASSWORD
python server/app.py --port 8080
npm run check && npm test && npm run smoke
```

## 1. Cloudflare Pages（推荐，带后端）

```bash
# .env 里需要：
#   CLOUDFLARE_API_TOKEN=...
#   CLOUDFLARE_ACCOUNT_ID=e7b347241186bbcd75e4d92f617dc84f
#   XN_ADMIN_PASSWORD=...
#   XN_ADMIN_SECRET=...            # 建议单独一个随机串
#   XN_REPO_OWNER=j200906
#   XN_REPO_NAME=xiaonuan-workbench
node cloudflare/deploy_pages.mjs xiaonuan-app
```

脚本会写环境变量、KV 绑定、AI 绑定，给静态资源打内容哈希，然后上传。

KV 命名空间（反馈与限流）：

```bash
npx wrangler kv namespace create XN_KV
# 把输出的 id 填到 .env 的 XN_KV_ID
```

## 2. GitHub Pages（纯静态）

推 `main` 即自动部署。工作流会先跑 `scripts/stamp.mjs`，所以资源缓存不会错乱。

需要在仓库 Settings → Pages → Source 选 **GitHub Actions**。

## 3. Docker / Render

```bash
docker build -t xiaonuan .
docker run -p 8080:8080 \
  -e XN_ADMIN_PASSWORD=... \
  -e XN_ADMIN_SECRET=... \
  -v xiaonuan-data:/data \
  xiaonuan
```

`render.yaml` 已给出免费 Web 服务配置；健康检查 `/api/health`。

## 4. Windows exe

推 `v*` tag 会自动触发 `.github/workflows/release.yml`：

1. Windows runner 上 `python build_exe.py`
2. 校验产物大小、生成 SHA256
3. **打包成功后才**创建/更新 Release，附 `XiaoNuan.exe` 与 `.sha256`

手动补传：

```bash
# Actions → 打包 Windows 程序 → Run workflow → 填 tag
```

本地打包：

```bash
python -m pip install pyinstaller
python build_exe.py
```

## 5. 本机网关公网出口（可选）

只给「自迭代走本机 magpie」用。

```bash
# 1) 生成/轮换钥匙，默认写到 %APPDATA%\xiaonuan\tunnel-key.txt
python tools/tunnel_proxy.py --rotate-key

# 2) 起代理：只放行 /v1/models 与 /v1/chat/completions
python tools/tunnel_proxy.py --port 8790 --target http://127.0.0.1:3425

# 3) 起 cloudflared 隧道，把公网地址填进 .env
#    XN_GATEWAY_BASE=https://xxxx.trycloudflare.com/v1
#    XN_GATEWAY_MODEL=...
#    XN_EXTRA_HOSTS=xxxx.trycloudflare.com
```

不要把钥匙写进仓库；`tools/tunnel-token.txt` 只作为旧文件兼容读取。

## 回滚

- 代码：`git revert <bad-sha>`（不要 `reset --hard`）
- 云端：Pages 控制台 → Deployments → 选上一个成功的 → Rollback
- 数据：本机 `data/backups/<时间戳>/` 是自迭代前的备份；浏览器数据用「设置 → 本机数据 → 导出全部」先备份
