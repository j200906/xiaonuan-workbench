/**
 * 小暖 · 自迭代教训（借 magpie 的 LESSONS.md 机制）
 *
 * 核心就三条：
 *   1. 改代码前先把教训读进提示词 —— 同一个坑不该踩第二次；
 *   2. 每次失败都记账：同一条规则被踩到就 +1（seen）；
 *   3. 踩够 3 次升级成硬规则（【硬规则】），从「提醒」变成「必须」。
 *
 * 存两份：
 *   - KV（iterate:lessons）：跑得快，失败当场就能记账，不用等提交；
 *   - 仓库 ITERATE-LESSONS.md：随版本一起入库，人和模型都能读，可 review。
 */

const KV_KEY = 'iterate:lessons';
const HARD_AT = 3;
const MAX_LESSONS = 24;

/* 失败原因 → 能长期复用的一条规则。不认识的就把原文当规则。 */
const RULES = [
  {
    match: /找不到原文|没有任何可应用/,
    rule: 'find 必须从正文里逐字复制（含缩进、标点、引号）；只依据结构列表去猜，一定会编出不存在的原文。',
    why: '小模型经常照着 outline 编代码，实测连 `$$(\'#chatMsgTxt\')` 这种不存在的写法都能编出来。'
  },
  {
    match: /看不见的中段|省略区间|看不到的/,
    rule: '节选里标了「中间省略」的段落、以及没给正文的文件都看不到，不许对它们下 patch；只改给了正文的那几行。',
    why: '提示词里的 digest 只给每个文件头尾两段（Q62/Q63），对着看不见的中段猜 find 一定失败。'
  },
  {
    match: /重复定义/,
    rule: '新增函数/方法前先在正文里搜同名定义；结构列表只是提示，箭头函数和对象方法也在其中，重名就换个名字。',
    why: 'outline 以前漏掉箭头函数和对象方法，模型以为「不存在」就重复定义了一份（Q64）。'
  },
  {
    match: /没给出可解析的 JSON|不是 JSON|不完整/,
    rule: '只输出一个紧凑的 JSON 对象：优先 patches，最多 2 处；不要整份 rewrite，它会超长被截断。',
    why: '整份重写一个 30KB 文件必然超出输出上限，JSON 从中间断掉，解析直接失败。'
  },
  {
    match: /原文不唯一/,
    rule: 'find 要带足上下文（至少包含相邻一两行），保证在整个文件里只命中一次。',
    why: '只写 `</div>` 这类片段会在文件里命中多处，服务端无法确定改哪个。'
  },
  {
    match: /括号不配平|模板字符串没有闭合|字符串没有闭合/,
    rule: '改完的代码要能通过括号/字符串扫描：不要省略结尾、不要在字符串里留未闭合的引号。',
    why: '扫描器不执行代码，只数结构；少一个 `}` 就整份被拒。'
  },
  {
    match: /被禁止的写法/,
    rule: '改动里不许出现 eval / new Function / document.write / 外链脚本；描述「禁止 javascript:」请写在注释里别写成 URL。',
    why: '这些是前端注入的常见入口，属于硬红线。'
  },
  {
    match: /不允许改|不允许重写/,
    rule: '只能改白名单里的文件；server、cloudflare、.github、tests 一律不动。',
    why: '自迭代不能给自己改规则，也不能改发布链路。'
  },
  {
    match: /版本不一致|package\.json/,
    rule: '升版本时必须同步 package.json、assets/changelog.js、assets/version.js、README.md 四处，少一处 check 和单测就挂。',
    why: '实测只改 changelog 不改 package.json，check.mjs 直接报「版本不一致」。'
  }
];

function canonical(reason) {
  const text = String(reason || '');
  const hit = RULES.find((r) => r.match.test(text));
  if (hit) return { rule: hit.rule, why: hit.why, hit: true };
  return { rule: text.slice(0, 160) || '未知失败', why: '来自一次真实失败。', hit: false };
}

export function parseLessons(text) {
  /* 从 ITERATE-LESSONS.md 里读回教训：每条以 `- （seen N）规则` 开头，why 在下一行。 */
  const out = [];
  const re = /^- （seen (\d+)）(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tail = String(text).slice(m.index + m[0].length);
    const why = (tail.match(/^\s*\n\s*为什么：(.+)$/m) || [])[1] || '';
    out.push({ rule: m[2].trim(), seen: Number(m[1]) || 1, why: why.trim() });
  }
  return out;
}

export function renderLessons(lessons, reviewedThrough) {
  const list = (lessons || []).slice(0, MAX_LESSONS);
  const head = [
    '<!-- reviewed-through: ' + (reviewedThrough || '未标注') + ' -->',
    '# 自迭代教训',
    '',
    '这份文件由自迭代自己维护：每失败一次记一笔，同一规则踩够 ' + HARD_AT + ' 次升级成【硬规则】。',
    '改代码前先读；硬规则等同于 code standards，不许绕过。',
    ''
  ].join('\n');
  const body = list.map((l) => {
    const hard = Number(l.seen) >= HARD_AT ? '【硬规则】' : '';
    return '- （seen ' + (Number(l.seen) || 1) + '）' + hard + l.rule +
      (l.why ? '\n  为什么：' + l.why : '');
  }).join('\n\n');
  /* 这段是补充说明，不是教训条目：每次重建文件都要带上，否则会丢 */
  const tail = '\n---\n\n' +
    '## 改代码前先查原话（海马体）\n\n' +
    '上面的规则回答不了「上次为什么这么定」。那种问题去查原话：\n\n' +
    '- recall：给一句话、日期或编号，返回那一段的原话。分「想起来了」和「有点像是」两档，后者不当证据用。\n' +
    '- trace：一字不差查某句在不在库里，给出会话号 + 行号，并区分「你说的 / 你转发的 / 我说的 / 只是手上的操作」。\n\n' +
    '硬线：trace 说没有，就是这条线的库里没有——别拿 recall 里「很像的一段」顶替。\n' +
    '不装插件也能查：node cli.mjs recall "<工作区>" "<线索>"。详见 docs/HIPPOCAMPUS.md。\n';
  return head + '\n' + (body || '（还没有教训）') + '\n' + tail;
}

async function readKv(env) {
  if (!env || !env.XN_KV) return null;
  try {
    const raw = await env.XN_KV.get(KV_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

async function writeKv(env, lessons) {
  if (!env || !env.XN_KV) return;
  try {
    await env.XN_KV.put(KV_KEY, JSON.stringify(lessons.slice(0, MAX_LESSONS)));
  } catch (e) { /* 记账失败不影响主流程 */ }
}

/** 取教训：KV 优先，其次仓库里的 Markdown。 */
export async function loadLessons(env, fileText) {
  const fromKv = await readKv(env);
  if (fromKv && fromKv.length) return fromKv;
  return parseLessons(fileText);
}

/** 记一笔失败；同规则 seen+1。返回最新列表。 */
export async function recordFailure(env, reason) {
  const { rule, why } = canonical(reason);
  const lessons = (await readKv(env)) || [];
  const existing = lessons.find((l) => l.rule === rule);
  if (existing) {
    existing.seen = (Number(existing.seen) || 1) + 1;
  } else {
    lessons.push({ rule, why, seen: 1 });
  }
  lessons.sort((a, b) => (Number(b.seen) || 0) - (Number(a.seen) || 0));
  await writeKv(env, lessons);
  return lessons;
}

/** 给提示词用的一小段，硬规则排前面。 */
export function lessonsForPrompt(lessons) {
  const list = (lessons || []).slice(0, 10);
  if (!list.length) return '（还没有积累教训）';
  return list.map((l) => {
    const hard = Number(l.seen) >= HARD_AT ? '【硬规则，必须遵守】' : '';
    return '- ' + hard + l.rule;
  }).join('\n');
}

export const LESSONS_FILE = 'ITERATE-LESSONS.md';
export const HARD_THRESHOLD = HARD_AT;
