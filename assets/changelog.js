/* 版本记录（最近 12 条）。 */
window.XN_CHANGELOG = [
  {
    "version": "1.5.7",
    "date": "2026-11-10",
    "title": "修迁移日志的死条件",
    "fixes": [
      "store.js 迁移旧键成功后永远不打印提示：条件里判断的是从未定义过的 XN.console",
      "改成 root.console && root.console.info，迁移真发生时控制台能看到搬了哪些键"
    ],
    "features": [],
    "source": "cloud",
    "feedbackCount": 5,
    "notes": "没在真实浏览器跑完整 migrate + 隐私模式 + 配额满的组合；没跑 npm test / npm run smoke / npm run ui"
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
  }
];
