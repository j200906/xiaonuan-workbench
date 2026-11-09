# 部署

四条路，按你要的东西挑：

| 你想要 | 走哪条 | 代价 |
| --- | --- | --- |
| 只给人看、给人用 | GitHub Pages（已在跑） | 纯静态，Key 在访客浏览器里 |
| 服务器替你保管 Key、集中收反馈 | Render / Hugging Face / 自己的 VPS | 需要一个账号或一台机器 |
| 自己电脑上用 | 下载 `XiaoNuan.exe` | 只有本机能访问 |
| 局域网内多人用 | `python server/app.py --port 8080` | 同一网络才能访问 |

---

## A. 桌面版（已经做好，公开可下载）

- 下载：<https://github.com/j200906/xiaonuan-workbench/releases/latest>
- 双击打开一个小窗口，点「打开小暖」会用 Edge/Chrome 的 app 模式起一个独立窗口（没有地址栏）。
- 数据在 `%APPDATA%\xiaonuan\data`；换机器拷这个目录就行。
- 没签名，Windows 会提示「未知发布者」→ 更多信息 → 仍要运行。
- 重新打包：`python build_exe.py`（需要 `pip install pyinstaller`）。

## B. Render（免费档，能托管 Key）

1. Render → New → **Blueprint** → 选这个仓库（`render.yaml` 已写好）
2. 填三个环境变量：`XN_API_KEY`、`XN_BASE`、`XN_ADMIN_PASSWORD`
3. 部署完把前端「设置 → 接口 → Base URL」改成 `/api`，Key 留空

免费档会睡：15 分钟没请求就停机，下一次打开等约 1 分钟；磁盘是临时的，反馈可能丢。

## C. Hugging Face Spaces（免费、公开、Docker）

需要一个 HF 账号 + 一个 write token：

```bash
# 1. 在 huggingface.co 建一个 Docker Space，名字随便
# 2. 把这个仓库推上去（HF 用 README 的 front matter 识别 SDK）
git remote add hf https://<用户名>:<token>@huggingface.co/spaces/<用户名>/xiaonuan
git push hf main
```

Space 的 `README.md` 开头需要：

```yaml
---
title: Xiaonuan
sdk: docker
app_port: 8080
---
```

容器里跑 `server/app.py`，环境变量同上（`XN_API_KEY` 等）。免费 Space 闲置一段时间会休眠，唤醒要几十秒。

## D. 自己的 VPS（最稳，不睡）

一台 1 核 1G 的机器就够。

```bash
# 机器上
git clone https://github.com/j200906/xiaonuan-workbench.git
cd xiaonuan-workbench
XN_API_KEY=sk-xxx XN_ADMIN_PASSWORD=换成你的 python3 server/app.py --port 8080
```

systemd（开机自启、挂了自动拉起来）：

```ini
# /etc/systemd/system/xiaonuan.service
[Unit]
Description=xiaonuan
After=network.target

[Service]
WorkingDirectory=/opt/xiaonuan-workbench
Environment=XN_API_KEY=sk-xxx
Environment=XN_ADMIN_PASSWORD=换成你的
Environment=XN_DATA_DIR=/var/lib/xiaonuan
ExecStart=/usr/bin/python3 server/app.py --port 8080
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now xiaonuan
```

再用 Caddy 挂个域名（自动 HTTPS）：

```
xiaonuan.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

---

 | --- | --- | --- |
| A. GitHub Pages | 整站静态 | 公开仓库免费 | 国内访问时快时慢 |
| B. Cloudflare Pages | 整站静态 | 静态请求与带宽免费，500 次构建/月 | 需要 Cloudflare 账号 |
| C. Render Web Service | 静态 + `server/app.py` | 免费实例 750 小时/月 | 15 分钟无请求休眠，冷启动约 1 分钟；磁盘是临时的 |

> 额度随时会变，以上来自 2026-11-09 检索到的公开说明，落地前以官网为准。

---

## A. GitHub Pages（推荐先做这个）

前提：一个 GitHub 账号，仓库设为 Public（私有仓库的 Pages 要付费）。

```bash
cd xiaonuan-workbench
git init -b main
git add .
git commit -m "小暖工作台 v1"

# 换成你的用户名和仓库名
git remote add origin https://github.com/<用户名>/xiaonuan-workbench.git
git push -u origin main
```

推上去之后，仓库里已经有 `.github/workflows/pages.yml`，它会自动把 `index.html` 和 `assets/`
打包发布。第一次需要手动开一下：

1. 仓库 → Settings → Pages
2. Source 选 **GitHub Actions**
3. 等 Actions 里那次 `Deploy static site` 跑完

地址：`https://<用户名>.github.io/xiaonuan-workbench/`

**认证**：`git push` 会弹 Git Credential Manager。选 "Sign in with your browser"，
浏览器里已经登录的那个账号点一下就行，不用手输密码。也可以去
Settings → Developer settings → Personal access tokens 建一个只勾 `repo` 的 token 当密码用。

### 如果 Actions 不跑

仓库 → Actions → 左侧 `Deploy static site` → 右侧 `Run workflow`。
或者手动：Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。

---

## B. Cloudflare Pages（国内访问通常更稳一点）

1. 打开 <https://dash.cloudflare.com/> → Workers & Pages → Create → Pages → **Upload assets**
2. 把 `index.html` 和 `assets/` 拖进去（不要拖 `server/` 和 `tests/`）
3. 得到 `https://xxx.pages.dev`

命令行也行（需要 `npm i -g wrangler` 并 `wrangler login`）：

```bash
wrangler pages deploy . --project-name xiaonuan-workbench
```

---

## C. Render：把后端也放上去

只有这个方案能：Key 留在服务器、访客不用自带 Key、反馈统一收在服务器的 `data/feedback.jsonl`。

仓库里已经有 `Dockerfile` 和 `render.yaml`。

1. Render → New → **Blueprint**，选你的 GitHub 仓库
2. 它会读 `render.yaml`，让你填三个环境变量：

   | 变量 | 作用 | 例子 |
   | --- | --- | --- |
   | `XN_API_KEY` | 上游模型的 Key，只有服务器知道 | `sk-...` |
   | `XN_BASE` | 上游地址 | `https://api.deepseek.com/v1` |
   | `XN_ADMIN_PASSWORD` | 管理密码，服务端校验 | 自己想一个，别用 `xiaonuanai` |

3. Deploy，等构建完，拿到 `https://xxx.onrender.com`

**前端怎么切过去**：进「设置 → 接口」，把 Base URL 改成 `/api`，Key 留空，保存。
这样请求走同源后端，浏览器里不再有 Key。

**注意两件事**：

- 免费实例 15 分钟没人访问就睡，下一次打开要等约 1 分钟。这是免费档的设定，不是 bug。
- 免费实例的磁盘是临时的，重新部署或重启后 `data/feedback.jsonl` 可能没了。
  要长期收反馈，挂持久盘（付费）或换数据库。

### 直接跑 Docker

```bash
docker build -t xiaonuan .
docker run -p 8080:8080 -e XN_API_KEY=sk-xxx -e XN_ADMIN_PASSWORD=改掉我 xiaonuan
```

没有 Key 也能起，只是 `/api/chat` 返回 503，前端请自带 Key 直连。

---

## 部署完的验收清单

- [ ] 打开首页**直接是对话**，没有登录页或 Key 墙
- [ ] 没配 Key 时发一条，输入框上方出现 Key 提示，原话不会丢
- [ ] 填完 Key 自动把刚才那句发出去，回复是一个字一个字出来的
- [ ] 侧栏底部状态从「未配置 Key」变成模型名
- [ ] 设置 → 管理模式 输密码后侧栏出现「架构」，输错则不解锁
- [ ] 改一次主色，刷新页面颜色还在
- [ ] 学习台加一条目标、写一条笔记、投一条反馈，刷新都还在
- [ ] 手机宽度打开，侧栏收成抽屉，不出现横向滚动条

## 常见问题

**打不开 / 白屏**
路径错了。Pages 项目地址要带仓库名：`/xiaonuan-workbench/`，不是根路径。

**发消息报「请求没发出去」**
三种可能：断网；服务商的接口不允许浏览器直连（跨域被拦）；Base URL 少写或多写了 `/v1`。
DeepSeek 的 `https://api.deepseek.com/v1` 实测允许跨域；OpenAI 官方接口不允许，得走 `/api` 代理。

**401 / 403**
Key 复制不全，或者这个 Key 没有该模型的权限。

**404**
Base URL 或模型名不对。检查是不是 `.../v1` 结尾，模型名是否拼错。

**402 或提示余额不足**
去服务商后台充值。

**改了配置想回到最初**
架构页底部「全部恢复默认」，或者清掉浏览器里 `xn.*` 开头的 localStorage。
