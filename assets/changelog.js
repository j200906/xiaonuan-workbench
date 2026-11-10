/* 版本记录（最近 12 条）。 */
window.XN_CHANGELOG = [
  {
    "version": "1.5.12",
    "date": "2026-11-10",
    "title": "输入框右下角不再挂模型名",
    "fixes": [
      "删掉输入框右下角的模型名（#modelPill 整块移除：HTML、JS 引用、CSS 规则、相关断言一起清）",
      "底栏只剩「提示语 / 联网 / 模型下拉 / 发送」，布局不变；模型下拉仍显示友好名（GLM-4.7-Flash）",
      "文档同步 v1.5.11 的迭代页与网关约定（XN_GATEWAY_VERIFIED、/api/config 可能不下发 gateway）"
    ],
    "features": [],
    "source": "manual",
    "feedbackCount": 0,
    "notes": "只改展示，不动对话与迭代逻辑。"
  },
  {
    "version": "1.5.11",
    "date": "2026-11-10",
    "title": "迭代页终于能用了",
    "fixes": [
      "点侧栏「迭代」不再被弹回设置页（删掉前端残留的 admin 门，刷新也能停在迭代页）",
      "默认模型改为跟随模型条；网关不可用时自动回落，并标注「服务器未配置/需要钥匙」",
      "/api/config 不再把失效的 trycloudflare 隧道当可用：空/坏地址不下发，临时隧道标 stale，只有 XN_GATEWAY_VERIFIED=1 才标 reachableHint",
      "结果区补提交链接（真跑给 GitHub commit 链接，试跑显示「试运行，未提交」）",
      "「停止」改为「停止等待」，说明服务端那一轮可能仍在跑",
      "窄屏（≤335px）底栏不再溢出，模型条点击高度补到 24px",
      "新增 tests/iterate.test.mjs（公开模式/网关回落/试跑分支），ui-check 与 Worker 测试各补断言"
    ],
    "features": [],
    "source": "manual",
    "feedbackCount": 0,
    "notes": "服务端兜底不变：未解锁的迭代请求仍只落 iterate/public 试跑分支。"
  },
  {
    "version": "1.5.10",
    "date": "2026-11-10",
    "title": "背景小暖 + 模型名说人话",
    "fixes": [
      "聊天区背景加一个很淡的小暖水印（内联 SVG，暗色更淡，窄屏缩小，打印隐藏，不参与点击）",
      "模型条与模型下拉不再显示 @cf/zai-org/... 这种原始 id，改为 GLM-4.7-Flash 这样的友好名",
      "侧栏连接状态与切换模型的提示也一并改用友好名",
      "修窄屏（≤330px）流式态下底栏溢出、模型条越界的问题，并把模型条点击区补到 24px",
      "文档修正：Token 只在服务端、迭代入口始终可见、发布前检查改为 npm test"
    ],
    "features": [],
    "source": "manual",
    "feedbackCount": 0,
    "notes": "只改前端展示与样式，未动对话与迭代逻辑。"
  },
  {
    "version": "1.5.9",
    "date": "2026-11-10",
    "title": "主页更干净",
    "fixes": [
      "新对话不再播「早上好/晚上好」这类问候",
      "不再显示建议条",
      "模型名常驻输入框右下角",
      "删掉「小暖会犯错」那句免责声明"
    ],
    "features": [],
    "source": "manual",
    "notes": "只改了前端展示，没动对话逻辑"
  },
  {
    "version": "1.5.8",
    "date": "2026-11-10",
    "title": "并入自迭代批次（AUDIT #61–#100）",
    "fixes": [
      "c60 · #61–#65：拉取云端按钮认本地后端——127.0.0.1/localhost 页面也显示并可用（assets/views.feedback.js）",
      "c65 · #66–#70：Markdown 图片独立白名单，只放行 http(s) 与站内 /、./ 路径（assets/lib/md.js）",
      "c70 · #71–#75：工具循环收尾请求透传 AbortSignal，停止后不再多发一次请求（assets/tools.js）",
      "c75 · #76–#80：修迁移日志死条件（XN.console 不存在），迁移日志恢复输出（assets/lib/store.js）",
      "c80 · #81–#85：旧键迁移补 locale 与 xn.chat.v1 并在模块末尾真正执行；旧管理令牌只丢弃、绝不搬进 localStorage，补回归单测（assets/lib/store.js、tests/unit.test.mjs）",
      "c85 · #86–#90：笔记分页上限改读 cfg.limits.notesPage（5–200 夹取、坏值回落 20），「还剩 N 条」补单位（assets/views.study.js）",
      "c90 · #91–#95：加深次要文字 --ink-3/--ink-4，浅色/暗色对比度都过 AA 4.5:1（assets/theme.css）",
      "c95 · #96–#100：defer 脚本统一等 DOMContentLoaded 再 boot，index.html 标注脚本顺序即依赖（assets/app.core.js、index.html）",
      "收口修复：删掉 assets/iterate.js 里指向已删除 dropToken 的悬空引用——930d0e1 移除浏览器 Token 时漏删，UI 检查的「页面无 JS 异常」会拦到 ReferenceError"
    ],
    "features": [],
    "source": "batch",
    "feedbackCount": 40,
    "notes": "7 个并行成员跑 8 个 offset（b90 连跑 #91–#100），iterate/c60–c95 各自四项自测全绿后由合并官按批 3-way apply 到 930d0e1（v1.5.7）基线；版本统一收到 1.5.8，v1.5.7「并入 Q61–Q100 收口工作」记录保留。未发现与 AUDIT 原意相反、需要拒绝的改动。"
  },
  {
    "version": "1.5.7",
    "date": "2026-11-10",
    "title": "并入 Q61–Q100 收口工作",
    "fixes": [
      "合入另一条线（fdbfc18）的收口：.env 样例、CI 护栏、部署文档、隐私与安全说明、发布链路脚本",
      "新增 scripts/build-pages.mjs 与 npm run build，部署前先产出 Pages 产物再比对",
      "反馈条目带上服务器真 id（serverId），云端条目才允许删除",
      "check.mjs 增加 tag 与 Pages 产物的一致性检查",
      "冲突解决：版本号统一取高（1.5.6→1.5.7）；浏览器内 GH Token 仍只存内存、离开即清；反馈字段清洗与长度截断保留"
    ],
    "features": [],
    "source": "merge",
    "feedbackCount": 0,
    "notes": "这次是把两条并行线合到一起，没有新增用户可见功能。合并后 check / 单测 / 冒烟 / Worker / UI / security 六套全绿。"
  },
  {
    "version": "1.5.6",
    "date": "2026-11-10",
    "title": "六项体检问题一起修",
    "fixes": [
      "反馈正文与联系方式去标签并按长度截断（#26/#29 前端部分）",
      "服务商下拉收敛到模型清单，不再出现空分组（#33–#35）",
      "情绪判定默认 auto：关键词拿不准时才问一次模型，并做节流（#36–#38）",
      "搜索工具要求回答注明来源（DuckDuckGo / 维基百科）（#46）",
      "迭代失败时把补丁文件与原因摆出来（#54）",
      "没显式给版本类型时，按建议版本自动推断（#56–#60）"
    ],
    "features": [],
    "source": "batch",
    "feedbackCount": 30,
    "notes": "六项由 6 个并行批次各自产出、队长合并。b40 曾把「记忆缓冲写盘」当 bug 改掉，与 AUDIT #41 原意相反，已丢弃。#26–#28/#30/#31/#32 需要改 server/ 或 cloudflare/，不在白名单内。"
  },
  {
    "version": "1.5.5",
    "date": "2026-11-10",
    "title": "令牌只留内存，离开即清空",
    "fixes": [
      "GitHub Token 仍只存在 iterate.js 的内存变量 GH_TOKEN，注释改为「绝不写进任何持久化存储」，避免以后被误改成 sessionStorage",
      "新增 dropToken()，在 pagehide / beforeunload 时主动清空内存里的 Token，关页或切走即失效",
      "把 dropToken 挂到 XN.IT 上，方便其它模块或测试在退出登录时同步清理"
    ],
    "features": [],
    "source": "cloud",
    "feedbackCount": 5,
    "notes": "没在真实浏览器里验证 pagehide / beforeunload 的触发时机和顺序，也没验证 bfcache 恢复后 GH_TOKEN 是否确实保持为空；没跑 npm run ui 的无头点击流程；没检查 iterate.js 中除本次改动外的其它位置是否仍有 Token 落盘路径（节选中段看不到）。"
  },
  {
    "version": "1.5.4",
    "date": "2026-11-10",
    "title": "反馈输入加长度硬上限",
    "fixes": [
      "反馈正文输入框加 maxlength=2000，粘贴超长内容自动截断，计数器与实际内容同步",
      "联系方式输入框加 maxlength=80，和 normalize 里的截断长度对齐，避免提交超长字段"
    ],
    "features": [],
    "source": "cloud",
    "feedbackCount": 5,
    "notes": "服务端 5 次/分钟/IP 限流、16KB 请求体上限、CORS 白名单回显、/api/iterate 与 /api/chat 的配额和 256KB/512KB 上限都在 server/ 与 cloudflare/ 里，不在本次可改白名单，未在真实后端验证；也没在移动端软键盘下试过 maxlength 行为。"
  },
  {
    "version": "1.5.3",
    "date": "2026-11-10",
    "title": "修更新日志对比漏版本",
    "fixes": [
      "更新日志版本对比的区间漏掉较旧一端，选首尾版本时少显示一条",
      "摘要文案改成「v旧 到 v新」，与列表实际范围一致"
    ],
    "features": [],
    "source": "cloud",
    "feedbackCount": 5,
    "notes": "没在真实浏览器里点两个下拉，也没在移动端窄屏检查；本次不升版本号，发布时仍需按惯例同步四处版本。"
  },
  {
    "version": "1.5.2",
    "date": "2026-11-10",
    "title": "网关地址每次下发都生效",
    "fixes": [
      "/api/config 再次下发网关地址时，模型清单里的 gateway 地址会跟着更新，不再只认第一次"
    ],
    "features": [],
    "source": "cloud",
    "feedbackCount": 5,
    "notes": "没有真实 /api/config 下发流程和 Cloudflare Pages 部署环境可验证；也没有在真机多浏览器上点模型下拉。"
  },
  {
    "version": "1.5.1",
    "date": "2026-11-09",
    "title": "本地版能用了：人格可见、网关直连、迭代写本地",
    "fixes": [
      "设置页人设不再空白：直接显示当前真正发给模型的那份（含记忆、目标、时间、情绪）",
      "本机后端支持 .env 与无 Key 的本机 3425 网关；本地模式跳过仓库锁和 GitHub Token",
      "本地迭代改完先备份到 data/backups/，再写回工作区",
      "magpie/deepseek-v4 请求加 reasoning_effort=low，正文不再被思考吃光",
      "修复本机网关判断正则被转义写坏、导致本地模式失效的问题"
    ],
    "features": [
      "start-local.bat / start-local.sh 一键启动本地版：设管理密码、连 3425、自动开浏览器"
    ],
    "source": "manual",
    "notes": "Cloudflare 仍是云端模式；要用本机网关和本地迭代，请用 start-local 启动。"
  },
  {
    "version": "1.5.0",
    "date": "2026-11-09",
    "title": "100 条体检全部处理",
    "fixes": [
      "管理密码不再写在前端：改为服务器校验 + 12 小时会话令牌，前端只存令牌",
      "搜索、抓网页、反馈、迭代全部加限流、体积上限与同源校验；CORS 不再放 *",
      "SSRF 防护改为解析 IP 字面量并逐跳校验重定向，挡住 0x7f/十进制/DNS 重绑定",
      "自迭代改为一次提交（Git Data API），不再产生 4 个半套 commit",
      "补丁校验重写：字符串/注释感知的括号扫描、重复定义检测、最多 8 补丁/3 重写",
      "版本号支持 patch/minor/major；更新日志拆成 recent + archive，不再无限增长",
      "Markdown 支持表格、嵌套列表、代码块语言标记；链接与图片过协议白名单",
      "流式中断标记「未完成」；停止键对工具循环也生效；上下文按 token 预算裁剪",
      "记忆：缓冲落盘、睡眠巩固有触发点、关系等级可达、隐式记忆去重与停用词扩充",
      "本机后端补齐 search / fetch / iterate，和云端功能对齐",
      "测试可运行：node:test 单测 + 无浏览器冒烟 + 重写后的 CDP UI 检查",
      "资源改为内容哈希引用，不再手改 ?v=；脚本全部 defer"
    ],
    "features": [
      "设置页合并外观/导航/人设/模型/管理，普通设置不再需要密码",
      "侧栏新增「对话」入口；模型清单收敛为单一来源，并支持键盘操作",
      "中英双语框架（data-i18n + t()），设置里可切换",
      "本机网关地址由服务器下发，不再写死 trycloudflare 域名",
      "索引页增加 CSP/X-Frame-Options/Referrer-Policy 等安全响应头",
      "README 成为唯一事实来源，DEPLOY/AUDIT 只做索引与台账"
    ],
    "source": "manual",
    "notes": "这一版重点是安全边界与可维护性，界面行为尽量保持不变。"
  },
  {
    "version": "1.4.8",
    "date": "2026-11-09",
    "title": "修设置页无限递归",
    "fixes": [
      "设置页一打开就栈溢出：arch.onShow 与 settings.onShow 互相调用，导致导航、人设、外观控件全是空的",
      "解锁后云端自迭代卡片不刷新"
    ],
    "features": [],
    "source": "manual"
  },
  {
    "version": "1.4.7",
    "date": "2026-11-09",
    "title": "迭代页可直接选「自迭代模型」",
    "fixes": [
      "迭代页还留着一整套发布通道配置（仓库/token），仓库早已锁在服务器，纯属多余"
    ],
    "features": [
      "新增「自迭代模型（本机网关）」预设，设置里选中后自迭代默认就用它",
      "迭代页多了模型下拉：自迭代模型 / 跟随模型条",
      "发布通道那块配置已删除"
    ],
    "source": "manual"
  },
  {
    "version": "1.4.6",
    "date": "2026-11-09",
    "title": "自迭代改为仓库锁定 + 云端执行",
    "fixes": [
      "浏览器里那套旧迭代器：读文件靠猜、find 对不上就整轮作废，连续 3 轮 0 产出",
      "自迭代只收 Key 不收服务商，选 Moonshot 也照样打 DeepSeek"
    ],
    "features": [
      "发布仓库锁死在服务器（XN_REPO_OWNER / XN_REPO_NAME），客户端传别的仓库会被忽略",
      "「迭代」页直接调用云端接口，走同一套校验、README 更新与自动发版",
      "自迭代使用模型条里选的模型与服务商"
    ],
    "source": "manual"
  },
  {
    "version": "1.4.5",
    "date": "2026-11-09",
    "title": "自迭代用你选的模型",
    "fixes": [
      "云端自迭代只收 Key、不收服务商，选 Moonshot 也照样打 DeepSeek"
    ],
    "features": [
      "自迭代现在用模型条里选的那个模型，并带上对应的服务商地址",
      "选云端模型时自动走服务器自带推理，不传你的 Key"
    ],
    "source": "manual"
  },
  {
    "version": "1.4.4",
    "date": "2026-11-09",
    "title": "GLM 关掉思考，25 秒变 14 秒",
    "fixes": [
      "GLM 默认先想一大段（25 秒），中间界面全白，看着像调用失败",
      "关掉思考（enable_thinking:false）后 14 秒出首字、16 秒完成，且不再输出大段思考",
      "等待期间显示「正在想…」，不再一片空白"
    ],
    "features": [],
    "source": "manual"
  },
  {
    "version": "1.4.3",
    "date": "2026-11-09",
    "title": "云端只留 GLM，其余用自己的 Key",
    "fixes": [
      "GLM 思考吃掉一千多 token 导致正文为空：额度提到 2400，空正文再放大到 4000 重试"
    ],
    "features": [
      "云端模型只保留 GLM-4.7-Flash 一个；其它模型一律走自己的 API"
    ],
    "source": "manual"
  }
];
