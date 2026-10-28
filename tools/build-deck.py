import json
"""Build the FOREIGN project report deck.

Run with the bundled Python:

    <deps>/python/python.exe tools/build-deck.py

Every number and every screenshot in here comes from the repository: the
acceptance logs, the anchor scan, and the pictures the headless harness wrote.
Nothing is illustrative.
"""

import os
import sys

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

# The assertion counts come from the file the suite generates, so a new check
# cannot leave the deck quoting a number that no longer exists.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(_ROOT, "data", "assertions.json"), encoding="utf-8") as _f:
    ASSERTIONS = json.load(_f)
_BY_STEP = {s["step"]: s["count"] for s in ASSERTIONS["steps"]}


def by_step(step):
    return _BY_STEP[step]


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "artifacts", "report", "FOREIGN-report.pptx")

W, H = Inches(13.333), Inches(7.5)
INK = RGBColor(0xE8, 0xE4, 0xDC)
DIM = RGBColor(0x9A, 0x94, 0x88)
ACCENT = RGBColor(0xC2, 0x3B, 0x2E)
BG = RGBColor(0x0B, 0x0B, 0x0D)
PANEL = RGBColor(0x16, 0x15, 0x18)
GOOD = RGBColor(0x6F, 0xA8, 0x6B)
# For a status that is honest but not done. Distinct from ACCENT, which is used for "needs
# the author" -- this one needs a decision from the repository owner, not more work.
WARN = RGBColor(0xD8, 0xA6, 0x4A)

MARGIN = Inches(0.72)
CONTENT_W = W - MARGIN * 2


def deck():
    p = Presentation()
    p.slide_width, p.slide_height = W, H
    return p


def slide(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.shapes.add_shape(1, 0, 0, W, H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = BG
    bg.line.fill.background()
    bg.shadow.inherit = False
    return s


def text(s, x, y, w, h, runs, size=16, color=INK, bold=False, space=6, align=PP_ALIGN.LEFT):
    """One text frame. `runs` is a list of strings, or of (string, dict) tuples."""
    box = s.shapes.add_textbox(x, y, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    for i, item in enumerate(runs):
        body, opts = item if isinstance(item, tuple) else (item, {})
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.alignment = opts.get("align", align)
        para.space_after = Pt(opts.get("space", space))
        run = para.add_run()
        run.text = body
        run.font.size = Pt(opts.get("size", size))
        run.font.bold = opts.get("bold", bold)
        run.font.color.rgb = opts.get("color", color)
        run.font.name = "Segoe UI"
    return box


def rule(s, y, x=None, w=None):
    """A one-pixel-feeling divider."""
    x = MARGIN if x is None else x
    w = CONTENT_W if w is None else w
    bar = s.shapes.add_shape(1, x, y, w, Emu(9525))
    bar.fill.solid()
    bar.fill.fore_color.rgb = RGBColor(0x2C, 0x2A, 0x2E)
    bar.line.fill.background()
    bar.shadow.inherit = False


def panel(s, x, y, w, h, fill=PANEL):
    box = s.shapes.add_shape(5, x, y, w, h)
    box.fill.solid()
    box.fill.fore_color.rgb = fill
    box.line.color.rgb = RGBColor(0x2C, 0x2A, 0x2E)
    box.shadow.inherit = False
    return box


def picture(s, rel, x, y, w, h):
    """Fit an image inside the box, preserving its aspect ratio."""
    path = os.path.join(ROOT, rel)
    with Image.open(path) as im:
        iw, ih = im.size
    scale = min(w / iw, h / ih)
    dw, dh = int(iw * scale), int(ih * scale)
    left = int(x + (w - dw) / 2)
    top = int(y + (h - dh) / 2)
    frame = s.shapes.add_shape(1, left - Emu(19050), top - Emu(19050),
                               dw + Emu(38100), dh + Emu(38100))
    frame.fill.solid()
    frame.fill.fore_color.rgb = RGBColor(0x22, 0x20, 0x24)
    frame.line.fill.background()
    frame.shadow.inherit = False
    s.shapes.add_picture(path, left, top, dw, dh)


def footer(s, n, label=""):
    text(s, MARGIN, H - Inches(0.62), CONTENT_W, Inches(0.3),
         [f"FOREIGN / 异物    ·    {label}    ·    {n}"],
         size=10, color=RGBColor(0x5A, 0x55, 0x50), space=0)


def head(s, title, kicker=None, n=0, label=""):
    y = Inches(0.46)
    if kicker:
        text(s, MARGIN, y, CONTENT_W, Inches(0.3), [kicker], size=11, color=ACCENT, bold=True, space=0)
        y += Inches(0.34)
    text(s, MARGIN, y, CONTENT_W, Inches(0.72), [title], size=29, bold=True, space=0)
    rule(s, y + Inches(0.84))
    footer(s, n, label)
    return y + Inches(1.16)


# --------------------------------------------------------------------------

def build():
    prs = deck()
    R = os.path.join(ROOT, "artifacts")

    # 1 — cover
    s = slide(prs)
    text(s, MARGIN, Inches(2.0), CONTENT_W, Inches(1.35),
         ["FOREIGN"], size=66, bold=True, space=0)
    text(s, MARGIN, Inches(3.05), CONTENT_W, Inches(0.78),
         ["异物"], size=30, color=DIM, space=10)
    text(s, MARGIN, Inches(3.86), CONTENT_W, Inches(0.5),
         ["这间屋子里有东西不该在"], size=20, space=0)
    rule(s, Inches(4.42))
    text(s, MARGIN, Inches(4.66), CONTENT_W, Inches(1.35),
         ["第一人称恐怖找异常 · 发生在 3D 重建的真实房间里",
          "Manycore Aholo Global 3D AI Hackathon  ·  2026"],
         size=13, color=DIM, space=5)

    # 2 — what it is
    s = slide(prs)
    y = head(s, "是什么", "一句话", 2, "概览")
    text(s, MARGIN, y, Inches(7.4), Inches(2.4),
         ["走进一间被 3DGS 重建的真实公寓。它看起来就是一个普通的家 ——",
          "问题恰恰在这里：每一层都有东西不属于这里。",
          "",
          "在计时结束前找出全部。标记正确不扣任何东西；每层 3 次失手额度，标错扣 8 秒。",
          "全部找到就下潜一层：同一个房间，重新洗牌。"],
         size=15, space=9)
    picture(s, "artifacts/splat/01-ready.png", Inches(8.4), y - Inches(0.1), Inches(4.2), Inches(3.6))
    text(s, MARGIN, Inches(5.9), CONTENT_W, Inches(0.8),
         [("上面这张是游戏里的原始画面，不是概念图 —— 房间是重建出来的，"
           "不是建模出来的。", {"size": 11, "color": DIM})], space=0)

    # 3 — the bet
    s = slide(prs)
    y = head(s, "我们把重建当成可玩，而不是可浏览", "核心判断", 3, "设计")
    left = Inches(6.3)
    for i, (t, d) in enumerate([
        ("房间只重建一次", "美术成本是固定的。它是一件资产，不是一个关卡。"),
        ("所有变化来自生成的 3D 内容", "每层的不同不是重新布置家具，而是放进新的东西。"),
        ("没有 Lux3D，这个游戏不成立", "异物只能来自文生 3D。工具是内容引擎，不是点缀。"),
    ]):
        box_y = y + Inches(i * 1.28)
        panel(s, MARGIN, box_y, left, Inches(1.1))
        text(s, MARGIN + Inches(0.24), box_y + Inches(0.14), left - Inches(0.48), Inches(0.9),
             [(t, {"size": 15, "bold": True, "space": 3}), (d, {"size": 12, "color": DIM})], space=0)
    picture(s, "artifacts/splat/03-foreign-object.png", MARGIN + left + Inches(0.3), y,
            CONTENT_W - left - Inches(0.3), Inches(3.9))

    # 4 — the rule
    s = slide(prs)
    y = head(s, "只看它做什么，不看它是什么", "玩法 · 一条规则", 4, "玩法")
    text(s, MARGIN, y, Inches(6.6), Inches(1.3),
         ["不需要背房间，不需要和上一层对比 —— 一眼就要能判。",
          "甚至不需要判断这东西该不该在这儿：房间里本来就摆着同样奇怪的模型。",
          "凡是「和上一层不一样」才算的异常，都被砍掉了。"],
         size=13, color=DIM, space=8)
    text(s, MARGIN, Inches(3.25), Inches(6.6), Inches(0.4),
         [("所以：异常一定在「动」", {"size": 15, "bold": True, "color": ACCENT})], space=4)
    text(s, MARGIN, Inches(3.65), Inches(6.6), Inches(0.8),
         ["在看你、浮起来、变了形、多了几个、倒过来、成群 —— 摆着不动的都是无辜的。"],
         size=12, color=DIM, space=0)
    kinds = ["注视", "悬浮", "变形", "复制", "倒挂", "成群"]
    text(s, MARGIN, Inches(4.55), Inches(6.6), Inches(0.4),
         [("现有 7 种异常", {"size": 15, "bold": True})], space=6)
    for i, k in enumerate(kinds):
        col, row = i % 4, i // 4
        bx = MARGIN + Inches(col * 1.62)
        by = Inches(5.0) + Inches(row * 0.62)
        panel(s, bx, by, Inches(1.46), Inches(0.5))
        text(s, bx, by + Inches(0.1), Inches(1.46), Inches(0.32), [k],
             size=12, align=PP_ALIGN.CENTER, space=0)
    text(s, MARGIN, Inches(6.25), Inches(6.6), Inches(0.5),
         ["删掉了「异物闯入」：房间里站着同类无辜物件之后，「它不该在这儿」就不再可判。"],
         size=10, color=DIM, space=0)
    picture(s, "artifacts/shots/10-horror-stare.png", Inches(7.6), y - Inches(0.1), Inches(5.0), Inches(4.4))

    # 5 — Manycore tools
    s = slide(prs)
    y = head(s, "用到的 Manycore / Aholo 工具", "工具使用", 5, "技术")
    rows = [
        ("Aholo Lux3D", "文生 3D · 必需", "异物资产的唯一来源。两条接入路径：Open API 批处理，或网页版导出后导入。"),
        ("Aholo Open API", "REST · 已对真实接口验证", "创建 → 轮询 → 立刻下载（结果 URL 2 小时过期）。认证头与错误映射已实测。"),
        ("@manycore/aholo-viewer", "3DGS 渲染", "在浏览器里渲染真实重建的房间，第一人称行走。"),
        ("官方开源 3DGS 场景", "scene.7c26e842.spz", "63,022,215 字节的室内高斯泼溅场景，运行时流式加载。"),
        ("官方体素碰撞场", "collision.voxel.bin", "304,628 字节，八叉树 + 叶位。地板、墙体、天花板都是它。"),
    ]
    for i, (name, tag, desc) in enumerate(rows):
        by = y + Inches(i * 0.95)
        panel(s, MARGIN, by, CONTENT_W, Inches(0.82))
        text(s, MARGIN + Inches(0.26), by + Inches(0.09), Inches(3.5), Inches(0.36),
             [(name, {"size": 14, "bold": True})], space=0)
        text(s, MARGIN + Inches(0.26), by + Inches(0.46), Inches(3.5), Inches(0.3),
             [(tag, {"size": 10, "color": ACCENT})], space=0)
        text(s, MARGIN + Inches(4.0), by + Inches(0.2), CONTENT_W - Inches(4.3), Inches(0.6),
             [(desc, {"size": 12, "color": DIM})], space=0)

    # 6 — architecture
    s = slide(prs)
    y = head(s, "两个渲染后端，一套玩法", "架构", 6, "技术")
    for i, (t, d, c) in enumerate([
        ("真实房间（默认入口）",
         "@manycore/aholo-viewer + 官方 3DGS 场景 + 体素碰撞。\n"
         "相机、行走、胶囊碰撞全部自己接管，才能控制手感。", ACCENT),
        ("程序化房间（classic.html）",
         "three.js 搭建的同一套房间，用于对比与回退。\n"
         "它证明玩法不依赖某一个渲染器。", DIM),
    ]):
        by = y + Inches(i * 1.5)
        panel(s, MARGIN, by, Inches(7.0), Inches(1.3))
        text(s, MARGIN + Inches(0.24), by + Inches(0.14), Inches(6.5), Inches(1.0),
             [(t, {"size": 15, "bold": True, "color": c, "space": 4}),
              (d, {"size": 12, "color": DIM})], space=0)
    panel(s, MARGIN, y + Inches(3.15), Inches(7.0), Inches(1.0))
    text(s, MARGIN + Inches(0.24), y + Inches(3.3), Inches(6.5), Inches(0.75),
         [("共享层：规则 / 目录 / 类型", {"size": 15, "bold": True, "color": GOOD, "space": 3}),
          (f"不含任何渲染依赖，所以同一套关卡生成逻辑被两个后端使用，也被 {by_step('test')} 个单测覆盖。",
           {"size": 12, "color": DIM})], space=0)
    picture(s, "artifacts/shots/02-living-room.png", Inches(8.3), y, Inches(4.3), Inches(4.15))

    # 7 — asset iteration
    s = slide(prs)
    y = head(s, "占位模型 → 相机实测锚点 → Lux3D 生成 → 运行时替换", "资产迭代", 7, "资产")
    steps = [
        ("1 · 占位", "21 个程序化 GLB 烘焙进构建，688 KB。任何时候都可玩，不依赖网络。"),
        ("2 · 锚点", "0.25 m 网格向下投射得 219 个候选面 → 楼层带筛到 112 → 胶囊可站立 97 → "
                     "排除离入口 1.6 m 内 → 最远点贪心取 9 个。"),
        ("3 · 生成", "Lux3D text-to-3D。有 API key 时 npm run assets:generate 一条命令跑完；"
                     "没有 key 时用网页版导出，assets:import 校验并归位。"),
        ("4 · 替换", "同一个 key 放回 public/assets/foreign/ 即自动生效，不改动任何玩法逻辑。"
                     "来源记在 manifest，assets:check 断言真假。"),
    ]
    for i, (t, d) in enumerate(steps):
        by = y + Inches(i * 0.86)
        panel(s, MARGIN, by, Inches(6.5), Inches(0.74))
        text(s, MARGIN + Inches(0.24), by + Inches(0.1), Inches(6.0), Inches(0.6),
             [(t, {"size": 13, "bold": True, "space": 2}), (d, {"size": 10, "color": DIM})], space=0)
    picture(s, "artifacts/probe/room-glb.png", Inches(7.8), y, Inches(4.8), Inches(2.3))
    picture(s, "artifacts/splat/05-watcher.png", Inches(7.8), y + Inches(2.5), Inches(4.8), Inches(2.3))

    # 8 — engineering rigour
    s = slide(prs)
    y = head(s, "验收不是「我看过了」", "工程严谨性", 8, "质量")
    text(s, MARGIN, y, Inches(7.3), Inches(0.6),
         [f"npm run verify  =  类型检查 → 单测 → 构建 → 验收，共 {ASSERTIONS['total']} 项断言，全部通过"],
         size=14, color=INK, space=8)
    stats = [(str(by_step("test")), "单元测试"), (str(by_step("voxel:check")), "体素"),
             (str(by_step("assets:check")), "资产"), (str(by_step("splat:shoot")), "真实房间"),
             (str(by_step("shoot")), "程序化"), (str(by_step("search:time")), "可通关性"),
             (str(by_step("deploy:check")), "部署")]
    for i, (v, k) in enumerate(stats):
        bx = MARGIN + Inches(i * 1.42)
        panel(s, bx, Inches(2.5), Inches(1.28), Inches(1.05))
        text(s, bx, Inches(2.62), Inches(1.28), Inches(0.45), [v], size=20, bold=True,
             align=PP_ALIGN.CENTER, space=0)
        text(s, bx, Inches(3.1), Inches(1.28), Inches(0.34), [k], size=10, color=DIM,
             align=PP_ALIGN.CENTER, space=0)
    for i, (t, d) in enumerate([
        ("每条移动断言都带双边界限",
         "「能停住」和「根本没动」无法区分。所以同时断言：有碰撞时走不远，"
         "关掉碰撞后必须走得很远。"),
        ("对照是必需项",
         "「异常朝向玩家」只有在「地面物体不转头」也成立时才有意义，"
         "否则整个房间一起转也会通过。"),
        ("静默失效比崩溃更危险",
         "「文件存在 = 已生成」让整个 Lux3D 环节变成空操作，且不报错。"
         "现在由来源记录判定，并配一条「真资产必须被跳过」的反向断言。"),
        ("同一症状出现两次，就该去量而不是再猜",
         "玩家两遍都说「第一关走完了没找到东西」。四个假设全被测量否掉，最后指向 height："
         "渲染器当它是缩放目标所以永远对，过滤器却当它是真实尺寸。"),
        ("性能也要被量，而且量错了两次",
         "先猜瓶颈在 CPU 排序 —— 方法不可靠。改用每档 90 秒重测：重建占 99%，"
         "分辨率 0.40x 省 29%。但同一套方法又报了四个「有效旋钮」，重跑全部落空"
         "（基线自己漂了 60%）；工具这次拒绝出结论，四个都没进代码。"),
        ("开局那二十秒也是性能问题",
         "画质控制器原本从满分辨率起步，注释自己写着代价是「二十秒的幻灯片」。"
         "唯一玩过的人报的正是这个。改成从中间档起步：最坏下降从四步减到两步，"
         "快机器一两秒内爬回去。"),
    ]):
        # Six rows, and the block has to end above 7.5 in. At the original 0.80 in pitch the
        # sixth landed at 8.3; this pitch puts the last panel's bottom edge at 7.22.
        by = Inches(3.06) + Inches(i * 0.68)
        panel(s, MARGIN, by, Inches(7.3), Inches(0.62))
        text(s, MARGIN + Inches(0.22), by + Inches(0.04), Inches(6.9), Inches(0.56),
             [(t, {"size": 11, "bold": True, "space": 1}), (d, {"size": 9, "color": DIM})], space=0)
    panel(s, Inches(8.4), Inches(2.5), Inches(4.2), Inches(3.6), RGBColor(0x1C, 0x12, 0x12))
    text(s, Inches(8.65), Inches(2.66), Inches(3.75), Inches(3.35),
         [("实测抓到的真 bug", {"size": 14, "bold": True, "color": ACCENT, "space": 5}),
          ("?autostart=1 直接崩溃：let plan 声明在 autostart 块之后，"
           "而这条路径是同步调用，变量还在暂时性死区。菜单路径永远碰不到它 —— "
           "按钮回调跑得晚。", {"size": 10, "color": DIM, "space": 4}),
          ("而演示链接正是评审会点开的东西。", {"size": 11, "bold": True, "space": 5}),
          ("另一个相反的例子：低帧率下 setTension 每帧重新锚定指数曲线，"
           "收敛变成按帧数而不是按时间，音效滞后好几秒。"
           "测试一直红，但红的不是测试写错了。", {"size": 10, "color": DIM})], space=0)

    # 9 — depth
    s = slide(prs)
    y = head(s, "恐怖来自放进来的东西，不是房间本身", "玩法深度", 9, "玩法")
    for i, (t, d) in enumerate([
        ("它会看着你",
         "stare 异常每帧朝玩家转向，并带轻微的呼吸浮动。\n"
         "这是唯一一个不需要任何参照物就成立的异常 —— 你看着它的时候它就是错的。"),
        ("四种惊吓，不是一种吓四次",
         "脸闪 150 ms / 慢慢逼近 420 ms / 全黑并掐掉手电筒 620 ms / 连环两次。\n"
         "一个效果换六张脸仍然只是一种惊吓；学乖了的玩家不会再缩脖子。"),
        ("声音先于视线",
         "两个失谐振荡器拍频，经低通滤波。靠近最近异常时音量收紧、滤波打开。\n"
         "标记命中是上行音，失手是下行 —— 不用看 HUD 就能分辨。"),
        ("它会自己冲过来",
         "第 3 层起，一个真实模型穿过房间向你逼近，窗口按层收紧（2200 ms → 1000 ms）。\n"
         "点鼠标解除；没解除就撞上你，并触发一次扑脸。这是唯一一个必须动手的机制。"),
        ("脚步是距离，不是定时器",
         "站在原地不动时一声不响（0.78 m 一步，且两步之间有下限间隔）。\n"
         "定时器版本会在你屏住呼吸的时候一直响 —— 那是恐怖游戏最不能犯的错。"),
    ]):
        by = y + Inches(i * 0.80)
        panel(s, MARGIN, by, Inches(7.0), Inches(0.74))
        text(s, MARGIN + Inches(0.24), by + Inches(0.06), Inches(6.5), Inches(0.64),
             [(t, {"size": 13, "bold": True, "space": 3}), (d, {"size": 9.5, "color": DIM})], space=0)
    panel(s, MARGIN, y + Inches(4.06), Inches(7.0), Inches(0.86))
    text(s, MARGIN + Inches(0.24), y + Inches(4.16), Inches(6.5), Inches(0.68),
         [("音效是测出来的，不是「我写了」", {"size": 14, "bold": True, "color": GOOD, "space": 3}),
          ("读的是 AnalyserNode 的实际信号：7 m 处 gain 0.789、0.5 m 处 0.909，"
           "平均 RMS 近处响 21–31%。脚步则断言「走路有声、站着无声」两半。",
           {"size": 11, "color": DIM})], space=0)
    picture(s, "artifacts/splat/04-marked.png", Inches(8.3), y, Inches(4.3), Inches(4.15))

    # 10 — status
    s = slide(prs)
    y = head(s, "现在到哪了", "状态", 10, "进度")
    for i, (t, st, d, c) in enumerate([
        ("A · 真实 3DGS 房间", "完成", "默认入口就是重建房间，行走、碰撞、玩法闭环全部实测通过。", GOOD),
        ("C · 玩法深化", "完成", "异常类型 5 → 7 种；四种惊吓；冲锋；脚步与逐层加深的音乐床。", GOOD),
        ("可通关性", "已实测", "8/8 层都留出扫视时间；最难的第 8 层剩 92.9 秒。npm run search:time。", GOOD),
        ("D · 部署 / 报告", "已上线",
         "https://cyn-nya.github.io/foreign/ 返回 200。站点是靠两步手工操作才存在的："
         "改仓库为 public，再用 JSON body 开启 Pages —— gh api -f 撑不起嵌套对象，"
         "这一点失败过一次。", GOOD),
        ("demo 视频", "完成", "100 秒 720p、10 个真实镜头。本机每秒不足一帧，录不了实机，故用真实截图合成。", GOOD),
        ("B · Lux3D 资产", "已完成", "55/55 全部由 Lux3D 生成：21 个异物、鬼影、伪人与冲刺体，13 件写实家具。", GOOD),
        ("已知风险 · 首屏体量", "需注意",
         "启动时一次性加载 55 个模型、约 254 MB。缺资产会退回占位模型不会崩，"
         "所以流式加载可行，但会改变 ready 的含义并牵动验收链。", WARN),
        ("X 发帖", "待发", "文案已备好，对传播分（5%）。需要账号。", ACCENT),
    ]):
        by = y + Inches(i * 0.665)
        panel(s, MARGIN, by, CONTENT_W, Inches(0.68))
        text(s, MARGIN + Inches(0.24), by + Inches(0.17), Inches(4.4), Inches(0.36),
             [(t, {"size": 13, "bold": True})], space=0)
        text(s, MARGIN + Inches(4.7), by + Inches(0.16), Inches(1.2), Inches(0.38),
             [(st, {"size": 11, "bold": True, "color": c})], space=0)
        text(s, MARGIN + Inches(6.0), by + Inches(0.14), CONTENT_W - Inches(6.3), Inches(0.44),
             [(d, {"size": 9.5, "color": DIM})], space=0)

    # 11 — closing
    s = slide(prs)
    text(s, MARGIN, Inches(2.5), CONTENT_W, Inches(0.9),
         ["FOREIGN / 异物"], size=40, bold=True, space=0)
    rule(s, Inches(3.6))
    text(s, MARGIN, Inches(3.85), CONTENT_W, Inches(1.4),
         ["一次重建，无限内容。",
          "房间是真实的，多出来的东西是生成的。"],
         size=17, color=DIM, space=8)
    text(s, MARGIN, Inches(5.4), CONTENT_W, Inches(0.5),
         ["#Manycorehackathon"], size=14, color=ACCENT, bold=True, space=0)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    prs.save(OUT)
    print(f"wrote {OUT}")
    print(f"slides: {len(prs.slides.__iter__.__self__._sldIdLst)}")


if __name__ == "__main__":
    sys.exit(build())
