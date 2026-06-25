#!/usr/bin/env python3
# 把一张「桌宠生成器」精灵表切成 app 需要的 37 个命名帧（420×420 透明 PNG）。
#
# 用法:
#   python3 build/cut-spritesheet.py <角色目录或精灵表路径> [输出目录]
# 例:
#   python3 build/cut-spritesheet.py ~/Downloads/桌宠素材/luffy-2-pet
#   → 在该目录下生成 frames/walk/01.png ... frames/expressions/tearful.png
#
# 切完把 frames/ 里的内容拷进项目 assets/ 即可换角色。
#
# 布局是固定的（同款生成器）：8 列 × 9 行，单元格 192×208。
# 行↔状态映射是从已切好的 hema 资产反向匹配确认的（不是猜的）。
# 眼神(eyes/) 暂不处理：生成器没标注 9 个注视方向，需另行人工指定。
#
# 框定规则（已验证能复现现有 hema 帧，视觉无差）：
#   裁出单元格 → 取 alpha 包围盒 → 等比缩放使内容高=350px
#   → 贴到 420×420 透明画布，水平居中(x=210)，底边贴 baseline y=388。

import os
import sys
from PIL import Image

# ---- 画布/框定常量（与 renderer/pet.js 的 SRC=420 / BASELINE=388 一致）----
SIZE = 420
BASELINE = 388
TARGET_H = 350  # 内容目标高度

# ---- 精灵表网格（每格 192×208；列数/行数按图尺寸自动推断）----
CELL_W = 192
CELL_H = 208

# ---- 行↔状态映射 ----
# (子目录, 行号, 列顺序, 文件名列表)；列顺序按"输出帧 1..N"排列。
# walk 在表里是反向排布的（表 c0 = walk 第 8 帧），这里按已确认顺序还原。
CLIP_MAP = [
    ("walk",        2, [7, 6, 5, 4, 3, 2, 1, 0], [f"{i:02d}.png" for i in range(1, 9)]),
    ("scratch",     8, [0, 1, 2, 3, 4, 5],       [f"{i:02d}.png" for i in range(1, 7)]),
    ("wave",        3, [0, 1, 2, 3],             [f"{i:02d}.png" for i in range(1, 5)]),
    ("cheer",       4, [0, 1, 2, 3, 4],          [f"{i:02d}.png" for i in range(1, 6)]),
    ("roll",        6, [0, 1, 2, 3, 4, 5],       [f"{i:02d}.png" for i in range(1, 7)]),
    ("expressions", 5, [0, 1, 2, 3],
     ["tearful.png", "tearful-2.png", "tearful-3.png", "tearful-4.png"]),
]


def load_sheet(path):
    """支持 .webp / .png；webp 直接用 PIL 读。"""
    return Image.open(path).convert("RGBA")


def cut_cell(sheet, row, col, cols, rows):
    cw = sheet.width / cols
    ch = sheet.height / rows
    return sheet.crop((round(col * cw), round(row * ch),
                       round((col + 1) * cw), round((row + 1) * ch)))


def frame_cell(cell):
    """把单元格内容框定进 420×420 透明画布（居中、贴底 baseline）。"""
    bb = cell.split()[3].getbbox()
    if not bb:
        return None  # 空格子
    content = cell.crop(bb)
    scale = TARGET_H / (bb[3] - bb[1])
    nw, nh = round(content.width * scale), round(content.height * scale)
    content = content.resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(content, (round(SIZE / 2 - nw / 2), BASELINE - nh), content)
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src = os.path.expanduser(sys.argv[1])
    if os.path.isdir(src):
        sheet_path = os.path.join(src, "spritesheet.webp")
        out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(src, "frames")
    else:
        sheet_path = src
        out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
            os.path.dirname(src) or ".", "frames")

    if not os.path.exists(sheet_path):
        print(f"找不到精灵表: {sheet_path}")
        sys.exit(1)

    sheet = load_sheet(sheet_path)
    cols = round(sheet.width / CELL_W)
    rows = round(sheet.height / CELL_H)
    print(f"精灵表 {sheet.width}×{sheet.height} → 网格 {cols}列 × {rows}行")
    if (cols, rows) != (8, 9):
        print(f"⚠️ 网格不是预期的 8×9，映射可能不适用，请先肉眼核对。")

    total = 0
    for clip, row, col_order, names in CLIP_MAP:
        d = os.path.join(out_dir, clip)
        os.makedirs(d, exist_ok=True)
        for col, name in zip(col_order, names):
            cell = cut_cell(sheet, row, col, cols, rows)
            framed = frame_cell(cell)
            if framed is None:
                print(f"  ⚠️ row{row}col{col} 空格子，跳过 {clip}/{name}")
                continue
            framed.save(os.path.join(d, name))
            total += 1
        print(f"  {clip}/  ✓ {len(names)} 帧")

    print(f"\n完成：{total} 帧 → {out_dir}")
    print("眼神(eyes/)未处理。拷进项目 assets/ 即可换角色。")


if __name__ == "__main__":
    main()
