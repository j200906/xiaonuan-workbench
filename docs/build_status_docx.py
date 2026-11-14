# -*- coding: utf-8 -*-
"""生成《小暖 · 现状说明（通俗版）》DOCX"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "小暖-现状说明.docx"

FONT = "微软雅黑"
INK = RGBColor(0x1F, 0x2A, 0x37)
MUTED = RGBColor(0x5B, 0x67, 0x77)
ACCENT = RGBColor(0x1D, 0x4E, 0xD8)
WARN = RGBColor(0xB4, 0x53, 0x09)

doc = Document()

# 页面
sec = doc.sections[0]
sec.top_margin = Cm(2.2)
sec.bottom_margin = Cm(2.2)
sec.left_margin = Cm(2.4)
sec.right_margin = Cm(2.4)

# 正文样式
normal = doc.styles["Normal"]
normal.font.name = FONT
normal.font.size = Pt(10.5)
normal.font.color.rgb = INK
normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
normal.paragraph_format.line_spacing = 1.55
normal.paragraph_format.space_after = Pt(8)


def set_font(run, size=10.5, bold=False, color=INK, name=FONT):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = color


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hexcolor)
    tcPr.append(el)


def para(text="", size=10.5, bold=False, color=INK, align=None, space_after=8, italic=False):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    r = p.add_run(text)
    set_font(r, size, bold, color)
    r.italic = italic
    return p


def h1(text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    set_font(r, 15, True, ACCENT)
    # 下边框线
    pPr = p._p.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), "C7D2FE")
    bdr.append(bottom)
    pPr.append(bdr)
    return p


def bullet(text, mark="·"):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Cm(0.6)
    p.paragraph_format.space_after = Pt(5)
    r = p.add_run(mark + " ")
    set_font(r, 10.5, True, ACCENT)
    r2 = p.add_run(text)
    set_font(r2, 10.5)
    return p


def table(headers, rows, widths=None, header_fill="EEF2FF", zebra="F8FAFF"):
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.style = "Table Grid"
    t.autofit = False
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ""
        p = hdr[i].paragraphs[0]
        p.paragraph_format.space_after = Pt(3)
        r = p.add_run(h)
        set_font(r, 10, True, INK)
        shade(hdr[i], header_fill)
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.space_after = Pt(3)
            r = p.add_run(str(val))
            set_font(r, 9.5)
            if ri % 2 == 1:
                shade(cells[i], zebra)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


# ---------------- 封面区 ----------------
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.LEFT
p.paragraph_format.space_after = Pt(2)
r = p.add_run("小暖 · 现在怎么样了")
set_font(r, 26, True, INK)

p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(4)
r = p.add_run("一份写给不看代码的人看的说明")
set_font(r, 12, False, MUTED)

p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(18)
r = p.add_run("2026 年 11 月 12 日　·　版本 3.2.0　·　所有数字均为实测")
set_font(r, 9, False, MUTED)

# ---------------- 一 ----------------
h1("一、这是个什么东西")
para("小暖是一个网页版的 AI 助手。打开浏览器就能用，不用下载、不用注册，"
     "也有一份 Windows 版，一个 11.7 MB 的文件，双击就能跑。")
para("它现在主要干四件事：陪人聊天、当学习台记东西、收集用户反馈、"
     "以及在管理员允许的前提下「自己改自己」——把用户提的意见变成代码改动。")

para("打个比方：", bold=True, color=ACCENT, space_after=2)
para("它像一家不用自己租门面的小店。店面开在 Cloudflare 这个「公共商场」里，"
     "整间店的全部装修加起来 585 KB——比手机里随便一张照片还小。"
     "店里没有仓库、没有服务器要养，客人来了才开机，走了就关掉。", color=MUTED)

# ---------------- 二 ----------------
h1("二、现在能干什么")
table(
    ["入口", "干什么用"],
    [
        ["对话", "和 AI 聊天，可以带上下文"],
        ["学习台", "记笔记、整理知识"],
        ["更新日志", "每次改了什么，都能查到"],
        ["插件中心", "像手机装 App 一样装新功能"],
        ["设置", "换模型、换语言、填自己的 Key"],
        ["（藏在设置里）反馈箱", "用户提意见"],
        ["（藏在管理密码后）自迭代", "AI 按意见改自己的代码"],
    ],
    widths=[5.3, 10.5],
)
para("另外，它能说三种话：简体中文、繁體中文、English，共 235 条文案 × 3 种语言。", color=MUTED)

# ---------------- 三 ----------------
h1("三、跑得怎么样，要花多少钱")
para("三个关键数字，都是刚测的：")
table(
    ["看什么", "实际情况", "换成大白话"],
    [
        ["打开一次要下多少东西", "473 KB", "约等于一张手机照片"],
        ["整个网站多大", "585 KB", "一张照片多一点"],
        ["装到电脑上的那个文件", "11.7 MB", "一首歌的大小"],
        ["页面里的零件数量", "467 个", "算轻的，打开很快"],
        ["写这个产品用的代码", "约 2 万行", "中等规模的小工具"],
        ["请 AI 回答问题的钱", "目前 0 元", "在 Cloudflare 免费额度内"],
    ],
    widths=[5.2, 4.6, 6.0],
)
para("AI 用的是 Cloudflare 自带的 GLM-4.7-Flash 模型，用户不用自己买 Key 就能聊。"
     "如果用户愿意填自己服务商的 Key，也可以走自己的账户。", color=MUTED)
para("结论：按现在的使用量，一分钱不花也能跑；要扩到几千人每天用，才会开始产生费用。",
     bold=True)

# ---------------- 四 ----------------
h1("四、有什么毛病（说人话版）")
para("挑最要紧的五条，按严重程度排：", space_after=4)

para("1. 钥匙一天过期三次（最烦）", bold=True, color=WARN, space_after=2)
para("每次要把新版本送上线，都得重新拿一次「门禁卡」，而且必须人工点一下同意。"
     "今天已经点了四次。这不是产品问题，是流程问题，但最影响进度。", color=MUTED)

para("2. 电话本里还留着一个打不通的号码", bold=True, color=WARN, space_after=2)
para("配置里写着一条备用线路，那个地址早就失效了（连域名都解析不到）。"
     "留着会让以后排查问题的人白费时间，应该删掉。", color=MUTED)

para("3. 门口的登记本只够一个人用", bold=True, color=WARN, space_after=2)
para("现在限制「一个人一天能提多少意见」是记在内存里的。人一多、或者服务重启，"
     "这个计数就清零了，等于限制会失效。", color=MUTED)

para("4. 招来的临时工没发工牌", bold=True, color=WARN, space_after=2)
para("第三方插件装上以后，权限和「店主」一样大——它想看什么、改什么都可以。"
     "现在只靠一层「只准装自己家的」在挡，长期要给它发工牌（声明需要什么权限）。", color=MUTED)

para("5. 有些毛病只有我肉眼发现", bold=True, color=WARN, space_after=2)
para("上一次「插件中心的门被自己关上了」「从商店装插件装不上」，这两个问题自动检查都没抓到，"
     "是我一个个点出来的。这说明体检项目还不够。", color=MUTED)

# ---------------- 五 ----------------
h1("五、接下来建议怎么走")
para("近期（这一周就能做完，成本很低）", bold=True, color=ACCENT, space_after=3)
bullet("换一把不会过期的钥匙，让上线不再需要人工点同意")
bullet("删掉那条打不通的备用线路")
bullet("把已经踩过的两个坑写进自动检查，以后同类问题自动报警")
bullet("官方插件商店补 3–5 个真能用的插件（现在只有 1 个示例，货架是空的）")

para("中期（一两个月）", bold=True, color=ACCENT, space_after=3)
bullet("给插件发工牌：装的时候声明要什么权限，跨来源的插件还要对暗号（校验指纹）")
bullet("限流改成多人共享，不再一重启就清零")
bullet("两套后端（云端一套、本地一套）合并成同一份规则，现在改一处要改两处")
bullet("上线前自动用真浏览器把主要页面点一遍，不靠人眼")

para("远期（三到六个月）", bold=True, color=ACCENT, space_after=3)
bullet("多模型：一个模型挂了自动换另一个，顺便控制成本上限")
bullet("换设备能同步：现在聊天记录只存在本机浏览器里")
bullet("做付费版：授权码 + 按用量计费 + 给企业私有部署（安装包已经有了）")

para("不建议做的两件事", bold=True, color=MUTED, space_after=3)
bullet("不建议为了「看起来像某个开源项目」去硬套它那套复杂结构，我们的东西没那么复杂，套上只会更乱")
bullet("不建议现在就做多用户租户：现在没有登录体系，硬做会把安全问题放大十倍")

# ---------------- 六 ----------------
h1("六、一句话总结")
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(4)
r = p.add_run("东西不大、跑得动、目前不花钱。真正拖后腿的不是功能不够，"
              "而是「钥匙老过期」和「体检不到位」。把这两件补上，它就有持续做下去的地基了。")
set_font(r, 12, True, INK)

# 页脚
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(22)
r = p.add_run("本说明由实测数据整理：仓库代码量、线上接口、浏览器实测、发布记录。"
              "技术细节见 docs/STATUS-2026-11-12.md 与 docs/REDTEAM.md。")
set_font(r, 8.5, False, MUTED)

doc.save(OUT)
print("saved:", OUT)
