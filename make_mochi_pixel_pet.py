#!/usr/bin/env python3
"""Generate a pixel-art Codex custom pet spritesheet for Mochi."""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


COLS = 8
ROWS = 9
CELL_W = 192
CELL_H = 208
PX_W = 48
PX_H = 52
SCALE = 4
ATLAS_W = COLS * CELL_W
ATLAS_H = ROWS * CELL_H

PET_ID = "mochi-corgi"
DISPLAY_NAME = "Pixel Mochi"
DESCRIPTION = "A pixel corgi desk pet with cozy builder energy."

ROOT = Path.cwd()
RUN_DIR = ROOT / "mochi_pixel_pet_run"
FINAL_DIR = RUN_DIR / "final"
QA_DIR = RUN_DIR / "qa"
PREVIEW_DIR = QA_DIR / "previews"
PET_DIR = Path.home() / ".codex" / "pets" / PET_ID

FUR = (194, 111, 43, 255)
FUR_DARK = (127, 67, 31, 255)
FUR_LIGHT = (224, 143, 73, 255)
CREAM = (255, 232, 185, 255)
WHITE = (255, 249, 226, 255)
BLACK = (36, 32, 34, 255)
SHINE = (255, 255, 255, 255)
TONGUE = (230, 83, 111, 255)
BLUE = (98, 190, 218, 255)
YELLOW = (250, 225, 92, 255)
MINT = (133, 211, 151, 255)
PEACH = (246, 167, 143, 255)
PINK = (235, 128, 174, 255)
GRAY = (113, 109, 103, 255)
LAPTOP = (86, 142, 211, 255)


def frames_for(state: str) -> int:
    return {
        "idle": 6,
        "running-right": 8,
        "running-left": 8,
        "waving": 4,
        "jumping": 5,
        "failed": 8,
        "waiting": 6,
        "running": 6,
        "review": 6,
    }[state]


def px_rect(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, color) -> None:
    draw.rectangle((x, y, x + w - 1, y + h - 1), fill=color)


def px_poly(draw: ImageDraw.ImageDraw, points, color) -> None:
    draw.polygon(points, fill=color)


def px_line(draw: ImageDraw.ImageDraw, points, color, width: int = 1) -> None:
    draw.line(points, fill=color, width=width)


def draw_tail(draw: ImageDraw.ImageDraw, x: int, y: int, flip: int, wag: int) -> None:
    tx = x - flip * 14
    ty = y + 19 + wag
    px_rect(draw, tx - 2, ty - 3, 4, 7, FUR_DARK)
    px_rect(draw, tx - 3, ty - 2, 6, 5, FUR)
    px_rect(draw, tx - 1, ty - 1, 2, 3, CREAM)


def draw_body(draw: ImageDraw.ImageDraw, x: int, y: int, step: int, state: str) -> None:
    px_rect(draw, x - 11, y + 24, 22, 15, FUR_DARK)
    px_rect(draw, x - 10, y + 22, 20, 18, FUR)
    px_rect(draw, x - 9, y + 25, 18, 12, BLUE)
    for stripe_x, color in [(-9, YELLOW), (-4, MINT), (2, YELLOW), (7, MINT)]:
        px_rect(draw, x + stripe_x, y + 25, 3, 12, color)
    px_rect(draw, x - 6, y + 27, 12, 12, CREAM)

    if state == "running":
        px_rect(draw, x - 8, y + 39, 16, 5, LAPTOP)
        px_rect(draw, x - 6, y + 38, 12, 1, SHINE)
        px_rect(draw, x - 10, y + 35 + step, 4, 5, CREAM)
        px_rect(draw, x + 6, y + 35 - step, 4, 5, CREAM)
    else:
        px_rect(draw, x - 9 + step, y + 38, 6, 4, CREAM)
        px_rect(draw, x + 3 - step, y + 38, 6, 4, CREAM)
        px_rect(draw, x - 8, y + 42, 5, 3, CREAM)
        px_rect(draw, x + 3, y + 42, 5, 3, CREAM)


def draw_bandana(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    px_poly(draw, [(x - 11, y + 21), (x + 11, y + 21), (x + 2, y + 30), (x - 2, y + 30)], PEACH)
    px_rect(draw, x - 7, y + 22, 2, 2, YELLOW)
    px_rect(draw, x + 2, y + 23, 2, 2, YELLOW)
    px_rect(draw, x - 1, y + 27, 2, 2, YELLOW)


def draw_head(draw: ImageDraw.ImageDraw, x: int, y: int, blink: bool, mood: str, flip: int, tongue: bool) -> None:
    px_poly(draw, [(x - 13, y + 4), (x - 9, y - 11), (x - 3, y + 5)], FUR_DARK)
    px_poly(draw, [(x - 12, y + 3), (x - 9, y - 8), (x - 5, y + 5)], FUR)
    px_poly(draw, [(x - 10, y + 2), (x - 8, y - 5), (x - 6, y + 4)], FUR_LIGHT)

    px_poly(draw, [(x + 13, y + 4), (x + 9, y - 11), (x + 3, y + 5)], FUR_DARK)
    px_poly(draw, [(x + 12, y + 3), (x + 9, y - 8), (x + 5, y + 5)], FUR)
    px_poly(draw, [(x + 10, y + 2), (x + 8, y - 5), (x + 6, y + 4)], FUR_LIGHT)

    px_rect(draw, x - 13, y + 2, 26, 17, FUR_DARK)
    px_rect(draw, x - 12, y + 1, 24, 18, FUR)
    px_rect(draw, x - 4, y + 1, 8, 14, WHITE)
    px_rect(draw, x - 8, y + 12, 16, 10, CREAM)
    px_rect(draw, x - 6, y + 17, 12, 5, CREAM)

    if blink:
        px_rect(draw, x - 8, y + 9, 4, 1, BLACK)
        px_rect(draw, x + 4, y + 9, 4, 1, BLACK)
    elif mood == "sad":
        px_line(draw, [(x - 8, y + 9), (x - 5, y + 11)], BLACK)
        px_line(draw, [(x + 5, y + 11), (x + 8, y + 9)], BLACK)
    elif mood == "focus":
        px_rect(draw, x - 8, y + 8, 5, 4, BLACK)
        px_rect(draw, x + 3, y + 8, 5, 4, BLACK)
        px_rect(draw, x - 8, y + 7, 5, 1, FUR_DARK)
        px_rect(draw, x + 3, y + 7, 5, 1, FUR_DARK)
    else:
        px_rect(draw, x - 8, y + 7, 5, 5, BLACK)
        px_rect(draw, x + 3, y + 7, 5, 5, BLACK)
        px_rect(draw, x - 7, y + 8, 1, 1, SHINE)
        px_rect(draw, x + 4, y + 8, 1, 1, SHINE)

    px_rect(draw, x - 2, y + 14, 4, 3, BLACK)
    if mood == "sad":
        px_line(draw, [(x - 4, y + 20), (x, y + 18), (x + 4, y + 20)], FUR_DARK)
    else:
        px_line(draw, [(x - 4, y + 19), (x, y + 21), (x + 4, y + 19)], FUR_DARK)
    if tongue:
        px_rect(draw, x + (2 if flip > 0 else -5), y + 19, 4, 5, TONGUE)


def draw_sprite(state: str, frame: int, count: int) -> Image.Image:
    img = Image.new("RGBA", (PX_W, PX_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    phase = frame / count
    wave = math.sin(phase * math.tau)
    alt = math.sin(phase * math.tau * 2)

    x = 24
    y = 13
    flip = 1
    step = 0
    blink = False
    mood = "happy"
    tongue = True
    tail_wag = 0

    if state == "idle":
        y += int(round(wave))
        blink = frame == 4
        tail_wag = int(round(wave))
    elif state == "running-right":
        x = 21 + frame // 2
        y -= abs(int(round(alt)))
        step = int(math.copysign(2, alt)) if abs(alt) > 0.2 else 0
        tail_wag = step
    elif state == "running-left":
        flip = -1
        x = 27 - frame // 2
        y -= abs(int(round(alt)))
        step = int(math.copysign(2, alt)) if abs(alt) > 0.2 else 0
        tail_wag = -step
    elif state == "waving":
        step = 0
    elif state == "jumping":
        y += [3, 0, -7, -5, 2][frame]
        step = [0, 1, 2, 1, 0][frame]
    elif state == "failed":
        y += [1, 2, 3, 4, 4, 3, 2, 1][frame]
        mood = "sad"
        tongue = False
    elif state == "waiting":
        y += int(round(wave))
        step = [0, 1, 2, 1, 0, 0][frame]
        tongue = frame in {0, 3}
    elif state == "running":
        y += int(round(alt))
        step = 1 if frame % 2 else -1
        mood = "focus"
        tongue = False
    elif state == "review":
        mood = "focus"
        tongue = False
        blink = frame == 3
        x += [-1, 0, 1, 1, 0, -1][frame]

    draw_tail(draw, x, y, flip, tail_wag)
    draw_body(draw, x, y, step, state)
    draw_bandana(draw, x, y)
    draw_head(draw, x, y, blink, mood, flip, tongue)

    if state == "waving":
        lifts = [0, 5, 8, 4]
        px_rect(draw, x + 10, y + 25 - lifts[frame], 4, 8, CREAM)
        px_rect(draw, x + 12, y + 22 - lifts[frame], 4, 3, CREAM)
    if state == "failed":
        px_rect(draw, x + 9, y + 11 + frame % 2, 3, 3, GRAY)
        px_rect(draw, x + 11, y + 9 + frame % 2, 2, 2, GRAY)
    if state == "waiting":
        px_rect(draw, x + 11, y + 18, 3, 3, PINK)
        px_rect(draw, x + 14, y + 15, 2, 2, PINK)

    return img.resize((CELL_W, CELL_H), Image.Resampling.NEAREST)


def main() -> None:
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    QA_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    PET_DIR.mkdir(parents=True, exist_ok=True)

    states = [
        "idle",
        "running-right",
        "running-left",
        "waving",
        "jumping",
        "failed",
        "waiting",
        "running",
        "review",
    ]

    atlas = Image.new("RGBA", (ATLAS_W, ATLAS_H), (0, 0, 0, 0))
    previews: dict[str, list[Image.Image]] = {}
    for row, state in enumerate(states):
        count = frames_for(state)
        sprites = [draw_sprite(state, frame, count) for frame in range(count)]
        previews[state] = sprites
        for col, sprite in enumerate(sprites):
            atlas.alpha_composite(sprite, (col * CELL_W, row * CELL_H))

    png = FINAL_DIR / "spritesheet.png"
    webp = FINAL_DIR / "spritesheet.webp"
    atlas.save(png)
    atlas.save(webp, "WEBP", lossless=True, quality=100, method=6)

    contact = Image.new("RGBA", (ATLAS_W, ATLAS_H), (245, 247, 250, 255))
    contact.alpha_composite(atlas)
    grid = ImageDraw.Draw(contact)
    for x in range(0, ATLAS_W + 1, CELL_W):
        grid.line((x, 0, x, ATLAS_H), fill=(214, 220, 226, 255))
    for y in range(0, ATLAS_H + 1, CELL_H):
        grid.line((0, y, ATLAS_W, y), fill=(214, 220, 226, 255))
    contact.save(QA_DIR / "contact-sheet.png")

    for state, frames in previews.items():
        frames[0].save(
            PREVIEW_DIR / f"{state}.gif",
            save_all=True,
            append_images=frames[1:],
            duration=150,
            loop=0,
            disposal=2,
        )

    (PET_DIR / "spritesheet.webp").write_bytes(webp.read_bytes())
    (PET_DIR / "pet.json").write_text(
        json.dumps(
            {
                "id": PET_ID,
                "displayName": DISPLAY_NAME,
                "description": DESCRIPTION,
                "spritesheetPath": "spritesheet.webp",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    summary = {
        "ok": True,
        "run_dir": str(RUN_DIR),
        "package": str(PET_DIR),
        "spritesheet": str(webp),
        "contact_sheet": str(QA_DIR / "contact-sheet.png"),
        "previews": str(PREVIEW_DIR),
    }
    (QA_DIR / "run-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
