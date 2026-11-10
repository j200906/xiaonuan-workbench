# 长期记忆：海马体（dsh-hippocampus）

小暖有两种记忆，各管一段，不互相冒充：

| | 页面记忆 `assets/memory.js` | 海马体（DSH 插件） |
| --- | --- | --- |
| 存在哪 | 浏览器 localStorage（`xn.v2.*`） | 本机 `~/.dsh/hippocampus/<工作区名>-<哈希>/` |
| 记什么 | 你明确让它记住的事、它自己归纳的印象、承诺、关系等级 | 每一轮对话与工具调用的**原话**，只增不改 |
| 谁能看见 | 只有这台设备的这个浏览器 | 工作区里跑的所有 DSH 会话 |
| 跨会话 | 靠 localStorage 残留 | 是，按线索现算召回 |
| 用途 | 小暖"记得你说过" | 我们改小暖时"上次那事是怎么定的" |

页面记忆是产品能力（用户装到手机上就有）；海马体是**开发侧**能力——它让接手小暖的人（或 agent）不必从零回忆。

---

## 它解决什么

文件式记忆（`MEMORY.md` 那种）的三个死结：

1. **靠自觉**：只有想起来才写，忙起来就不写；
2. **摘要吃掉证据**：留下的是「结论」，事后答不出「我当时到底怎么说的」；
3. **压缩后不自知**：长会话被压掉一段，模型不知道自己缺一块，开始拿「像的东西」凑。

海马体的做法很笨但有效：**原话全部落盘、只增不改；检索按线索现算；要证据就给原话**。

---

## 装（三步）

```powershell
# 1) 放：clone 到任意本地目录（不要放进 DSH 的 profile 目录）
git clone --depth 1 https://github.com/coner13/dsh-hippocampus.git C:\Users\<你>\dsh-plugins\dsh-hippocampus

# 2) 挂：作为本地 bundle 安装（用 DSH 的插件管理；CLI 见下）
#    在 DSH 里：插件 → 安装本地 bundle → 选上面这个目录
#    或者用 MCP/工具：plugin_manager install_bundle target=<该目录>
```

**3) 写配置** `~/.dsh/hippocampus/config.json`：

```json
{
  "enabled": true,
  "workspaces": ["C:\\Users\\<你>\\Documents\\deepseek-harness\\default-workspace"],
  "humanName": "human"
}
```

两个必须踩对的点：

- `workspaces` 要写**绝对路径**，且要包含小暖仓库所在的工作区。空数组 = 全关，装了也一点反应没有。
- 接了群聊相关的插件时，`humanName` 要和那边「人」的显示名一致，否则人的话会被当成别人说的跳过，**不报错、只是少记**。

装完重启 DSH，然后看 `~/.dsh/hippocampus/diag.log` 有没有：

```
apply 跑完 · v0.2.40-r8 · code=xxxxxxxx · 工作区 ["C:\\...\\default-workspace"]
```

有这行就说明挂上了。

---

## 用

模型侧有两个工具（装好后自动可用）：

- `recall`：给一句话、日期或编号，返回那段的**原话**。分「想起来了」和「有点像是」两档，后者不算确认。
- `trace`：一字不差查某句在不在库里，给出会话号 + 行号；并分成「你说的 / 你转发的 / 我说的 / 只是手上的操作」四类。

不装插件也能用 CLI 查库（只读）：

```bash
node cli.mjs stats   "<工作区绝对路径>"
node cli.mjs recall  "<工作区绝对路径>" "上次那个回滚点放哪了"
node cli.mjs trace   "<工作区绝对路径>" "原话里的一整句"
node cli.mjs episodes "<工作区绝对路径>" 20
node cli.mjs pack    "<工作区绝对路径>" --out 记忆.zip
```

自检（在临时目录跑，不碰真实库）：

```bash
node selftest.mjs   # 340 项
node smoke.mjs      # 74 项
```

---

## 数据与隐私

```
~/.dsh/hippocampus/
├─ config.json
├─ diag.log                    每次挂载、注入多少字节、索引复用还是重建
└─ <工作区名>-<哈希>/
   ├─ stream.jsonl             真相：原话，只增不改
   ├─ state.json               切段的缓存（删了会重建）
   ├─ marks.jsonl              remember 写下的
   ├─ thoughts.jsonl           抽出来的判断，明确标「不是原话」
   └─ rehearsals.jsonl         用进废退的账
```

- 全部落在**本机**，不上传任何服务；DSH 只在你 `workspaces` 里列出的目录生效。
- 想清空：删掉对应的 `<工作区名>-<哈希>` 目录即可；插件会重建空库。
- 换机器：把整个 `~/.dsh/hippocampus/` 拷过去，或 `cli.mjs pack` 打包。

---

## 和小暖自迭代的关系

小暖的自迭代（`cloudflare/iterate.js` 的教训机制）管的是**代码怎么改**，写进仓库的 `ITERATE-LESSONS.md`；
海马体管的是**我们怎么讨论、怎么决定**，留在本机。

两者不重叠：仓库里的教训是给人 review 的；海马体里的原话是给下一次接手的人查「当时为什么这么定」的。

---

## 排障

| 现象 | 八成原因 |
| --- | --- |
| 装完毫无反应 | `workspaces` 没写或路径不对（默认空数组 = 全关） |
| diag.log 有「跳过(非X)」 | `humanName` 和群聊插件的显示名对不上 |
| 库是空的但会话很多 | 装之前的历史不会自动补；新会话才记（本仓库装好后回填过一次） |
| 注入体积异常大 | 看 diag.log 的字节数；正常每轮「预激活」300–550 B |

上游仓库：<https://github.com/coner13/dsh-hippocampus>（PolyForm Noncommercial 1.0.0）
