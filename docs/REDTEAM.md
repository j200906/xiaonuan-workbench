# 网络攻防演练报告 · 小暖

> 演练对象：小暖自己的后端（`server/app.py` 本地实例 + Cloudflare Worker 同契约）与前端插件系统。
> 演练方式：脚本化攻击，可复跑。**这不是渗透别人的站，是打自己**。
>
> 复跑：`npm run redteam`（服务端 28 项）、`npm run redteam:client`（客户端 5 类注入）

## 一、结论速览

| 面 | 项数 | 结果 |
|---|---|---|
| 服务端（SSRF / 穿越 / 鉴权 / CSRF / 请求体 / 限流 / 泄漏 / XSS 存储） | 28 | **28 通过** |
| 客户端（插件供应链注入） | 5 类 | **0 可利用** |
| 演练中发现并修掉的缺口 | 1 类 | 插件地址策略缺失（见 §四） |

## 二、服务端演练明细

### SSRF（10/10 拦住）

`/api/fetch` 对以下目标一律 403「不给内网地址」，非 http(s) 协议 400：

`127.0.0.1` · `localhost` · `2130706433`（十进制） · `0x7f000001`（十六进制） ·
`0177.0.0.1`（八进制） · `[::1]` · `169.254.169.254`（云元数据） · `10.0.0.1` ·
`file://` · `gopher://`

关键点：**先解析再判断**（DNS 也查），不是只做字符串黑名单——否则十进制/十六进制 IP 直接绕过。

### 路径穿越（5/5 拦住）

`/assets/../../server/app.py`、`..%2f`、`%2e%2e%2f`、`....//`、直接 `/server/app.py` 全部 404。

### 鉴权与越权（4/4）

| 攻击 | 期望 | 实际 |
|---|---|---|
| 未登录调 `/api/iterate` 且要求真跑 | 只给试运行 | 200 + `dryRun:true` |
| 伪造 `X-Admin-Token` | 只给试运行 | 200 + `dryRun:true` |
| 把管理令牌塞进 `Authorization` 当模型 Key | 拒绝 | 401 |
| 错误管理密码 `/api/admin/verify` | 拒绝 | 401 |

### CSRF / CORS（3/3）

跨站 `Origin` + `Sec-Fetch-Site: cross-site` → 403；预检不回 `*`；只读健康检查不要求 Origin。

### 请求体与限流（3/3）

300KB 请求体 → 413；坏 JSON → 400；连续提交反馈触发 429。

### 泄漏与存储 XSS（2/2）

`/api/config` 不含 `secret/password/bearer/sk-` 等字样；提交 `<img onerror>` 不会影响配置输出。

## 三、客户端演练：插件供应链

攻击假设：攻击者诱导用户点「安装插件」，或污染一条索引源，把恶意脚本塞进页面——一旦执行就能读
`localStorage` 里的模型 API Key。

| 载荷 | 结果 |
|---|---|
| `data:text/javascript,...` | 拒绝（协议不在白名单） |
| `javascript:...` | 拒绝 |
| `file:///C:/Windows/win.ini` | 拒绝 |
| 跨源 `https://raw.githubusercontent.com/...` | 拒绝（域名未信任） |
| 协议相对 `//evil.example/payload.js` | 拒绝 |
| 插件名/描述里塞 `<img onerror>` | 按文本渲染，不执行 |

两层防线：

1. **CSP**：`script-src 'self'`（响应头 + `index.html` 里的 meta 双份，覆盖没有响应头的静态托管）
2. **代码级地址策略**（本次新增）：协议白名单 + 同源默认 + 跨源需显式信任

## 四、演练发现并修复的缺口

**插件安装没有地址校验**（已修）。

- 现象：`XN.plugin.install/clone` 接受任意 URL；`XN.dsh.load` 直接 `import()` 任意地址。
- 为什么危险：CSP 能挡跨源脚本，但**同源**恶意插件挡不住；而且策略一旦被绕过（旧浏览器、托管差异）
  就是页面内任意代码执行，可窃取 API Key。
- 修复：`XN.plugin.resolveUrl()`
  - 只允许 `http:` / `https:`（`data:`/`javascript:`/`file:`/`blob:` 一律拒绝）
  - 默认**只允许同源**
  - 跨源必须在 `cfg.pluginTrustedHosts` 里显式列出域名
  - 索引源拉取走同一策略
- 回归：`tests/plugin.test.mjs` 新增 2 条（协议拒绝 / 同源与信任矩阵），全绿。

## 五、残余风险（诚实清单）

1. **信任域名 = 完全信任**：加进 `pluginTrustedHosts` 的域，其脚本能跑任意代码。建议后续加
   SRI/哈希固定（`integrity`）与插件权限声明（能访问哪些能力）。
2. **限流是内存态**：单实例有效，多实例部署要换共享存储。
3. **管理员令牌是自签 HMAC**：换了 `XN_ADMIN_SECRET` 才能吊销全部会话；没有滚动过期。
4. **演练未覆盖**：真实 DNS 重绑定（需要可控域名）、慢速攻击（Slowloris）、Cloudflare 侧 WAF 规则。

## 六、如何复跑

```bash
npm run redteam          # 服务端 28 项（自动起后端 + 假模型）
npm run redteam:client   # 客户端插件注入 5 类（自动起 headless 浏览器）
```

两者都用临时目录与随机端口，不改动仓库数据；退出码非 0 表示有缺口。
