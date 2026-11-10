# 部署（操作步骤）

环境变量的完整清单在 [`.env.example`](.env.example)（逐项带注释）；[README.md](README.md#环境变量) 的表格只列常用项。这里只给命令和“哪一步会出错”。

## 0. 环境矩阵（Q100）

| 环境 | 版本 | 说明 |
| --- | --- | --- |
| 本地开发（Windows 11 实机） | Node 24.14.0 / Python 3.11.9 | `node --test`、`smoke`、`ui-check` 都实测过 |
| CI `guard.yml` | Node **20 / 22** 矩阵 + Python 3.12 | lint、自检、单测、冒烟、Worker 路由 |
| CI `guard.yml` → `ui` | Node **22** + Python 3.12 | `tests/ui-ci.mjs`（预检 + 端到端）；Node 22 才有默认开启的内置 WebSocket |
| CI `release.yml` | Python 3.12 + PyInstaller **6.22.3** | 打 Windows exe |
| Cloudflare Pages 运行时 | Workers runtime，`compatibility_date = 2026-11-01` | `/api/*` 由 `_worker.js` 提供 |
| `package.json` `engines.node` | `>=20` | 低于 20 不保证能跑 |

本地 Node 24 只代表“能跑”，CI 的 20/22 矩阵才是发布门槛。改了 `package.json` 的依赖或
Node API 用法，最好在 20 上也验一次（CI push 后看 guard）。

## 1. 两个线上入口（Q83）

| 入口 | 能力 | 怎么更新 |
| --- | --- | --- |
| `https://xiaonuan-app.pages.dev` | 静态页 + `/api`（聊天、搜索、抓取、反馈、自迭代、管理令牌） | **Direct Upload**：本机跑 `deploy_pages.mjs --apply` |
| GitHub Pages（`j200906.github.io/...`） | 纯静态，**没有 `/api`**；管理、反馈、自迭代都不可用 | push `main`，guard 通过后自动部署 |
| 本地 `start-local.bat` | 全功能 | 改完即生效 |

**push `main` ≠ Cloudflare 线上更新（Q84）**：Cloudflare Pages 是 Direct Upload，不是 Git 集成。
想确认线上到底是哪一版，跑仓库外的 `check-xiaonuan-drift.ps1`（见第 3 节）。

## 2. 本机先跑通

```bash
# 最省事：Windows 双击 start-local.bat；mac/Linux 跑 ./start-local.sh
# 它会问管理密码、接本机 3425 magpie、启动后端并开浏览器。

# 或者手动：
# 新建 .env（完整清单见 .env.example，常用项见 README「环境变量」一节），至少填 XN_ADMIN_PASSWORD
python server/app.py --port 8080

# 发布前四件套（顺序随便，全绿再发）：
npm test                    # 4 个测试文件：unit / pipeline / security / security-adversarial
npm run smoke               # 接口、鉴权、SSRF、413、CORS
node cloudflare/test.mjs    # Worker 路由与安全边界
npm run ui                  # 端到端：真后端 + 假模型 + 无头 Edge/Chrome
```

`tests/ui-check.mjs` 需要本机有 Edge/Chrome（Windows 默认就有 Edge）；CI 里由 ubuntu
runner 自带的 Chrome 跑。Python 控制台编码不是 UTF-8 时脚本会自己设 `PYTHONIOENCODING`。

`node scripts/check.mjs`（语法 + 引用 + 关键控件 + 版本一致性）由 CI 的 guard.yml 每次 push 跑；
本地想提前发现问题，也可以在上面四条之前顺手跑一次。

## 3. Cloudflare Pages（主路径，带后端）

`.env` 里需要：

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=e7b347241186bbcd75e4d92f617dc84f
XN_ADMIN_PASSWORD=...
XN_ADMIN_SECRET=...            # 建议单独一个随机串
XN_REPO_OWNER=j200906
XN_REPO_NAME=xiaonuan-workbench

# 线上要走本机网关（自迭代）时才加这三行。
# 注意：--env 会把前两个同步到 Pages；XN_GATEWAY_VERIFIED 不在同步列表里，
# 必须去 Cloudflare 控制台手工配，否则 /api/config 的 gateway.reachableHint 恒为 false。
XN_GATEWAY_BASE=https://xxxx.trycloudflare.com/v1
XN_GATEWAY_MODEL=...
XN_GATEWAY_VERIFIED=1
```

```bash
# 默认 dry-run：只组装 cloudflare/.pages + 打印计划，不上传、不改环境变量
node cloudflare/deploy_pages.mjs xiaonuan-app

# 真部署（只发文件，不碰线上环境变量）
node cloudflare/deploy_pages.mjs xiaonuan-app --apply

# 连环境变量一起写（危险，见下）
node cloudflare/deploy_pages.mjs xiaonuan-app --apply --env --yes
```

**环境变量闸门（Q85）**：这一步是整表 `PATCH`，而 `secret_text` 用 API 读不回来——少带一个
secret，线上那个就被清空。所以 `--env` 必须同时带 `--yes`，否则脚本直接退出；带 `--env`
时脚本会先 GET 线上配置，把“这次没带、将被清空”的 secret 列出来。日常只想改一个密钥，去
Cloudflare 控制台改，别跑这个脚本。

KV 命名空间（反馈与限流）：

```bash
npx wrangler kv namespace create XN_KV
# 把输出的 id 填到 .env 的 XN_KV_ID
```

### 产物从哪来（Q79/Q80）

| 路径 | 是什么 | 真源 |
| --- | --- | --- |
| `index.html` + `assets/` | 页面 | **真源** |
| `cloudflare/{worker,iterate,rules,shared,lessons}.js` | 边缘代码 | **真源** |
| `cloudflare/.pages/` | Pages 直传产物 | `npm run build` 生成，已 gitignore |
| `cloudflare/public/` | Workers 静态产物（legacy） | `npm run build:worker`，已 gitignore |
| `cloudflare/.dry/` | 旧的 `wrangler deploy --dry-run` 输出 | 已删除，别再入库（Q81） |

```bash
npm run build          # 生成 cloudflare/.pages（会自动给 index.html 打内容哈希）
npm run check:pages    # 只比对：.pages 是否与源码一致（有漂移退出码 1）
node scripts/check.mjs --strict   # 连 .pages 漂移一起算失败
```

`scripts/build-pages.mjs` 会校验 `_worker.js` 里每个 `import './xxx.js'` 都能在同目录找到文件。

### `_worker.js` 的多文件 import（Q86）

`_worker.js`、`iterate.js`、`shared.js`、`rules.js`、`lessons.js` 都放在产物根目录。
`wrangler pages deploy` **默认会打包**（esbuild）`_worker.js` 及其相对 import：

- ✅ 本机跑 `deploy_pages.mjs --apply`（内部就是 `wrangler pages deploy`，不要加 `--no-bundle`）
- ✅ 本地验证（不联网、不上传）：

  ```powershell
  npx wrangler pages functions build --build-output-directory cloudflare/.pages --outdir $env:TEMP\xn-bundle
  # 输出 $env:TEMP\xn-bundle\_worker.js：单个文件、无 import、约 80+ KB
  ```

- ❌ 不要用 Cloudflare 控制台的“拖拽上传”：拖拽不打包相对 import，`_worker.js` 里的
  `import './iterate.js'` 会在线上抛错。真要用拖拽，先把 `_worker.js` 打包成单文件再传。

### 线上漂移检查（Q87）

仓库外脚本会比对 `main` 导出的内容与 `pages.dev`：`index.html`、`index.html` 引用的
`assets/*`、根目录的 `iterate.js / rules.js / shared.js / lessons.js`，以及
`/assets/version.js` 的版本号；`/api/health` 若以后返回 `version` 也会一起核。

```powershell
powershell -NoProfile -File ..\check-xiaonuan-drift.ps1
# 结论行会明确说“线上就是这份 main 打出来的”还是“有实质差异”
```

> 注意：`/api/health` 目前没有 `version` 字段（worker.js 没加），脚本会打印提示并按
> `/assets/version.js` 核对版本；不要因此认为检查失败。

## 4. GitHub Pages（纯静态）

推 `main` 即触发：`校验与护栏` 通过后，`Deploy static site` 才会部署（Q97）。
guard 失败不会先上线再回滚；guard 自己生成的回滚提交（作者 `guard@users.noreply.github.com`
或标题 `Revert "`）会被跳过。

需要在仓库 Settings → Pages → Source 选 **GitHub Actions**。

紧急手动部署：Actions → `Deploy static site` → Run workflow（`workflow_dispatch` 不受 guard 限制）。
注意 `ui` job 失败会挡住自动部署，这是有意的。

## 5. 分支保护（Q96/Q97）

现状：`main` 的保护是关的，guard 是唯一防线；而 guard 失败时会直接 push 回滚提交。
用仓库里的脚本开保护（折中：挡 force-push / 删除，同时放行 owner 的自动化直推）：

```bash
bash scripts/protect-main.sh --dry-run    # 先看要发什么
bash scripts/protect-main.sh              # 对当前仓库 main 生效
```

默认要求三个检查：`check (20)`、`check (22)`、`ui`；`enforce_admins=false` 让 owner 的
自迭代/回滚仍能直推。如果自动化 token 不是 admin、或检查还没跑绿过，先用
`--no-checks` 只挡 force-push/删除，等 guard 稳定后再加检查。

guard 的防连环回滚（Q96）：

- `concurrency` 串行，matrix 两条腿失败也只回滚一次（回滚在独立 job）；
- 回滚前比对 `HEAD == origin/main`，main 已前进就跳过，不覆盖别人的提交；
- 回滚提交作者固定 `guard@...`，下一轮看到作者/标题是回滚就停。

## 6. Docker / Render

```bash
docker build -t xiaonuan .
docker run -p 8080:8080 \
  -e XN_ADMIN_PASSWORD=... \
  -e XN_ADMIN_SECRET=... \
  -v xiaonuan-data:/data \
  xiaonuan
```

`render.yaml` 已给出免费 Web 服务配置；健康检查 `/api/health`。

## 7. Windows exe（Q98）

推 `v*` tag 会自动触发 `.github/workflows/release.yml`：

1. Windows runner 上装**精确 pin** 的 `pyinstaller==6.22.3` + `pyinstaller-hooks-contrib==2026.7`
   （6.22.3 要求 Python `>=3.8,<3.16`，覆盖 CI 的 3.12；`build_exe.py` 用的
   `--onefile/--windowed/--add-data/--hidden-import` 在 6.x 稳定。pin 住 hooks 是为了
   同一个 tag 两次打包结果一致，不再让 pip 每次解析到新 hooks）
2. 校验产物大小、生成 SHA256
3. **打包成功后才**创建/更新 Release，附 `XiaoNuan.exe` 与 `.sha256`

手动补传：

```bash
# Actions → 打包 Windows 程序 → Run workflow → 填 tag
```

本地打包（版本要跟 CI 一致）：

```bash
python -m pip install "pyinstaller==6.22.3" "pyinstaller-hooks-contrib==2026.7"
python build_exe.py
```

## 8. 本机网关公网出口（可选）

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
#    XN_GATEWAY_VERIFIED=1      # 不设的话前端按「未验证」处理
```

填完地址还要把 `XN_GATEWAY_VERIFIED=1` 配上（Cloudflare Pages → Settings → Variables and
Secrets；`deploy_pages.mjs --env` 目前不同步这个键），否则 `/api/config` 里的
`gateway.reachableHint` 是 false，前端按「未验证」处理、不会默认选它。

`/api/config` 对网关有三种态度（v1.5.11 起）：

- **地址有效但没标 verified**：`gateway` 照发，`reachableHint: false`
- **地址是空的 / 解析不出 / 不是 http(s)**：**整块不带 `gateway` 字段**，前端按「服务器未配置」处理
  （`models.js` 的 `gatewayReady` 为 false），不会默认选中它
- **`*.trycloudflare.com` 这类临时隧道**：地址照发，但带 `gateway.stale: true`，前端可以提示隧道可能已过期

所以别再假设 `/api/config` 一定有 `gateway`：读的时候一律 `cfg.gateway || {}`。`gw.reachableHint === true`
只代表「运维已验证过这个地址」，真正能不能用还要看是不是本机回环、或者填过钥匙
（前端按 `ready && (local || key)` 判断）。

不要把钥匙写进仓库；`tools/tunnel-token.txt` 只作为旧文件兼容读取。

## 排障

- **模型拿不到长网页的尾部**：先看 `/api/fetch` 的 `offset` 有没有在递增——单次只回 12000 字，
  响应里的 `nextOffset` 才是下一段起点；`truncated: false`（或 `text` 为空）才说明真的读完了。
  `wrangler pages deployment tail` / Cloudflare 实时日志里能看到每次请求带的 `offset`，
  不递增就是前端没把 `nextOffset` 回填给模型。

## 回滚

- 代码：`git revert <bad-sha>`（不要 `reset --hard`）；guard 失败会自动做一次同样的事
- Cloudflare：Pages 控制台 → Deployments → 选上一个成功的 → Rollback（Direct Upload 的
  回滚只回滚产物，不恢复环境变量）
- GitHub Pages：重跑 `Deploy static site` 并选上一个提交，或 revert 后 push
- 数据：本机 `data/backups/<时间戳>/` 是自迭代前的备份；浏览器数据用「设置 → 本机数据 → 导出全部」先备份
