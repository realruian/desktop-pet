#!/usr/bin/env python3
"""Generate a Codex custom pet spritesheet for Mochi."""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


COLS = 8
ROWS = 9
CELL_W = 192
CELL_H = 208
ATLAS_W = COLS * CELL_W
ATLAS_H = ROWS * CELL_H

PET_ID = "mochi-corgi"
DISPLAY_NAME = "Mochi"
DESCRIPTION = "A cozy corgi desk pet with pastel maker energy."

ROOT = Path.cwd()
RUN_DIR = ROOT / "mochi_pet_run"
FINAL_DIR = RUN_DIR / "final"
QA_DIR = RUN_DIR / "qa"
PREVIEW_DIR = QA_DIR / "previews"
PET_DIR = Path.home() / ".codex" / "pets" / PET_ID


COLORS = {
    "fur": (198, 116, 45, 255),
    "fur_dark": (155, 79, 36, 255),
    "cream": (255, 244, 220, 255),
    "white": (255, 255, 252, 255),
    "eye": (35, 34, 38, 255),
    "shine": (255, 255, 255, 255),
    "nose": (37, 34, 35, 255),
    "tongue": (231, 92, 113, 255),
    "sweater_a": (148, 205, 221, 255),
    "sweater_b": (250, 232, 116, 255),
    "sweater_c": (174, 223, 178, 255),
    "bandana": (250, 181, 153, 255),
    "bandana_line": (239, 213, 119, 255),
    "pink": (238, 150, 186, 255),
    "blue": (95, 149, 211, 255),
    "soft_gray": (120, 126, 135, 255),
    "steam": (136, 125, 116, 255),
}


def ellipse(draw: ImageDraw.ImageDraw, box, fill, outline=None, width=1) -> None:
    x0, y0, x1, y1 = box
    draw.ellipse(
        (round(min(x0, x1)), round(min(y0, y1)), round(max(x0, x1)), round(max(y0, y1))),
        fill=fill,
        outline=outline,
        width=width,
    )


def rect(draw: ImageDraw.ImageDraw, box, fill, outline=None, width=1, radius=0) -> None:
    box = tuple(round(v) for v in box)
    if radius:
        draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    else:
        draw.rectangle(box, fill=fill, outline=outline, width=width)


def poly(draw: ImageDraw.ImageDraw, points, fill, outline=None) -> None:
    draw.polygon([(round(x), round(y)) for x, y in points], fill=fill, outline=outline)


def line(draw: ImageDraw.ImageDraw, points, fill, width=1) -> None:
    draw.line([(round(x), round(y)) for x, y in points], fill=fill, width=width, joint="curve")


def paste_cell(atlas: Image.Image, row: int, col: int, sprite: Image.Image) -> None:
    atlas.alpha_composite(sprite, (col * CELL_W, row * CELL_H))


def draw_tail(draw: ImageDraw.ImageDraw, cx: float, cy: float, flip: int, wag: float) -> None:
    x = cx - flip * 49
    y = cy + 8 + wag
    ellipse(draw, (x - 13, y - 13, x + 14, y + 14), COLORS["fur"])
    ellipse(draw, (x - 7, y - 7, x + 9, y + 9), COLORS["cream"])


def draw_paw(draw: ImageDraw.ImageDraw, x: float, y: float, lift: float = 0, wave: float = 0) -> None:
    ellipse(draw, (x - 10, y - 7 - lift, x + 12, y + 11 - lift), COLORS["cream"])
    if wave:
        line(draw, [(x - 4, y + 1 - lift), (x + 6, y - 6 - lift - wave)], COLORS["fur_dark"], 3)


def draw_face(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    blink: float,
    mood: str,
    flip: int,
    tongue: bool,
) -> None:
    ear_l = [(cx - 44, cy - 26), (cx - 29, cy - 88), (cx - 7, cy - 26)]
    ear_r = [(cx + 44, cy - 26), (cx + 29, cy - 88), (cx + 7, cy - 26)]
    poly(draw, ear_l, COLORS["fur"], COLORS["fur_dark"])
    poly(draw, ear_r, COLORS["fur"], COLORS["fur_dark"])
    poly(draw, [(cx - 32, cy - 33), (cx - 27, cy - 69), (cx - 13, cy - 33)], (221, 145, 103, 255))
    poly(draw, [(cx + 32, cy - 33), (cx + 27, cy - 69), (cx + 13, cy - 33)], (221, 145, 103, 255))

    ellipse(draw, (cx - 49, cy - 48, cx + 49, cy + 45), COLORS["fur"])
    poly(draw, [(cx - 13, cy - 49), (cx + 12, cy - 50), (cx + 5, cy + 1), (cx - 5, cy + 1)], COLORS["white"])
    ellipse(draw, (cx - 36, cy - 6, cx + 36, cy + 48), COLORS["cream"])

    eye_y = cy - 14
    eye_dx = 25
    if blink > 0.65:
        line(draw, [(cx - eye_dx - 8, eye_y), (cx - eye_dx + 8, eye_y + 1)], COLORS["eye"], 4)
        line(draw, [(cx + eye_dx - 8, eye_y + 1), (cx + eye_dx + 8, eye_y)], COLORS["eye"], 4)
    else:
        if mood == "sad":
            line(draw, [(cx - eye_dx - 8, eye_y - 1), (cx - eye_dx + 8, eye_y + 5)], COLORS["eye"], 4)
            line(draw, [(cx + eye_dx - 8, eye_y + 5), (cx + eye_dx + 8, eye_y - 1)], COLORS["eye"], 4)
        elif mood == "focus":
            line(draw, [(cx - eye_dx - 8, eye_y - 5), (cx - eye_dx + 9, eye_y - 1)], COLORS["eye"], 4)
            line(draw, [(cx + eye_dx - 9, eye_y - 1), (cx + eye_dx + 8, eye_y - 5)], COLORS["eye"], 4)
            ellipse(draw, (cx - eye_dx - 5, eye_y - 1, cx - eye_dx + 6, eye_y + 10), COLORS["eye"])
            ellipse(draw, (cx + eye_dx - 6, eye_y - 1, cx + eye_dx + 5, eye_y + 10), COLORS["eye"])
        else:
            ellipse(draw, (cx - eye_dx - 8, eye_y - 8, cx - eye_dx + 9, eye_y + 10), COLORS["eye"])
            ellipse(draw, (cx + eye_dx - 9, eye_y - 8, cx + eye_dx + 8, eye_y + 10), COLORS["eye"])
            ellipse(draw, (cx - eye_dx - 3, eye_y - 4, cx - eye_dx + 2, eye_y + 1), COLORS["shine"])
            ellipse(draw, (cx + eye_dx - 4, eye_y - 4, cx + eye_dx + 1, eye_y + 1), COLORS["shine"])

    ellipse(draw, (cx - 9, cy + 6, cx + 10, cy + 18), COLORS["nose"])
    if mood == "sad":
        line(draw, [(cx - 12, cy + 31), (cx, cy + 24), (cx + 12, cy + 31)], COLORS["fur_dark"], 3)
    else:
        line(draw, [(cx - 14, cy + 28), (cx, cy + 35), (cx + 14, cy + 28)], COLORS["fur_dark"], 3)
    if tongue:
        ellipse(draw, (cx + 5 * flip, cy + 27, cx + 24 * flip, cy + 47), COLORS["tongue"])


def draw_bandana(draw: ImageDraw.ImageDraw, cx: float, cy: float, tilt: float) -> None:
    poly(draw, [(cx - 42, cy + 34), (cx + 42, cy + 34), (cx + 8 + tilt, cy + 67)], COLORS["bandana"])
    for off in range(-28, 36, 16):
        line(draw, [(cx + off, cy + 36), (cx + off + 18, cy + 53)], COLORS["bandana_line"], 2)
        line(draw, [(cx + off + 12, cy + 34), (cx + off - 6, cy + 55)], COLORS["bandana_line"], 2)


def draw_body(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    flip: int,
    bob: float,
    step: float,
    mode: str,
    paw_lift: float,
) -> None:
    body_box = (cx - 54, cy + 34 + bob, cx + 54, cy + 113 + bob)
    ellipse(draw, body_box, COLORS["fur"])
    rect(draw, (cx - 48, cy + 50 + bob, cx + 44, cy + 104 + bob), COLORS["sweater_a"], radius=22)
    for i, color in enumerate([COLORS["sweater_b"], COLORS["sweater_c"], COLORS["sweater_a"], COLORS["sweater_b"]]):
        rect(draw, (cx - 48 + i * 23, cy + 50 + bob, cx - 35 + i * 23, cy + 105 + bob), color)
    ellipse(draw, (cx - 35, cy + 51 + bob, cx + 35, cy + 113 + bob), COLORS["cream"])

    if mode == "work":
        draw_paw(draw, cx - 31, cy + 99 + bob, lift=8 + step * 3)
        draw_paw(draw, cx + 31, cy + 99 + bob, lift=3 - step * 2)
        rect(draw, (cx - 24, cy + 106 + bob, cx + 26, cy + 124 + bob), COLORS["blue"], radius=5)
        line(draw, [(cx - 14, cy + 111 + bob), (cx + 12, cy + 111 + bob)], COLORS["shine"], 2)
    else:
        draw_paw(draw, cx - 29 + step * 5, cy + 106 + bob, lift=max(0, paw_lift))
        draw_paw(draw, cx + 30 - step * 5, cy + 106 + bob, lift=max(0, -paw_lift))

    ellipse(draw, (cx - 39, cy + 103 + bob, cx - 15, cy + 124 + bob), COLORS["cream"])
    ellipse(draw, (cx + 15, cy + 103 + bob, cx + 39, cy + 124 + bob), COLORS["cream"])


def draw_sprite(
    frame: int,
    state: str,
    count: int,
) -> Image.Image:
    sprite = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sprite)

    phase = frame / max(1, count)
    wobble = math.sin(phase * math.tau)
    alt = math.sin(phase * math.tau * 2)
    cx = 96
    cy = 72
    flip = 1
    mood = "happy"
    tongue = True
    mode = "normal"
    paw_lift = 0
    wave = 0
    lean = 0
    body_bob = 0
    blink = 0
    tail_wag = 0

    if state == "idle":
        body_bob = wobble * 2
        blink = 1 if frame == 4 else 0
        tail_wag = wobble * 2
    elif state == "running-right":
        flip = 1
        cx = 86 + frame * 2.0
        body_bob = abs(alt) * -4
        paw_lift = alt * 9
        tail_wag = alt * 3
    elif state == "running-left":
        flip = -1
        cx = 106 - frame * 2.0
        body_bob = abs(alt) * -4
        paw_lift = alt * 9
        tail_wag = alt * 3
    elif state == "waving":
        body_bob = [0, -2, -2, 0][frame]
        wave = [0, 12, 20, 8][frame]
        paw_lift = [0, 28, 35, 18][frame]
    elif state == "jumping":
        body_bob = [9, 0, -23, -18, 5][frame]
        paw_lift = [0, 7, 12, 8, 0][frame]
        tail_wag = -body_bob * 0.1
    elif state == "failed":
        body_bob = [2, 5, 9, 12, 10, 12, 9, 5][frame]
        mood = "sad"
        tongue = False
    elif state == "waiting":
        body_bob = wobble * 2
        tongue = frame % 3 == 0
        paw_lift = [0, 8, 13, 8, 0, 0][frame]
        lean = wobble * 3
    elif state == "running":
        body_bob = alt * 2
        mode = "work"
        mood = "focus"
        tongue = False
    elif state == "review":
        body_bob = wobble
        mood = "focus"
        tongue = False
        lean = [0, -3, -5, -3, 0, 2][frame]
        blink = 1 if frame == 3 else 0

    cx += lean
    cy += body_bob

    draw_tail(draw, cx, cy, flip, tail_wag)
    draw_body(draw, cx, cy, flip, body_bob, alt, mode, paw_lift)
    draw_bandana(draw, cx, cy, lean)
    draw_face(draw, cx, cy, blink, mood, flip, tongue)

    if state == "waving":
        draw_paw(draw, cx + 42, cy + 60, lift=paw_lift, wave=wave)

    if state == "failed":
        smoke_x = cx + 36 + (frame % 2) * 2
        smoke_y = cy + 8 + min(frame, 4)
        ellipse(draw, (smoke_x - 8, smoke_y - 8, smoke_x + 8, smoke_y + 8), COLORS["steam"])
        ellipse(draw, (smoke_x - 3, smoke_y - 12, smoke_x + 11, smoke_y + 2), COLORS["steam"])

    if state == "waiting":
        ellipse(draw, (cx + 36, cy + 18, cx + 50, cy + 32), COLORS["pink"])

    return sprite


def used_frames_for_state(state: str) -> int:
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


def save_outputs() -> None:
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
    all_sprites: dict[str, list[Image.Image]] = {}
    for row, state in enumerate(states):
        count = used_frames_for_state(state)
        sprites = [draw_sprite(frame, state, count) for frame in range(count)]
        all_sprites[state] = sprites
        for col, sprite in enumerate(sprites):
            paste_cell(atlas, row, col, sprite)

    spritesheet_png = FINAL_DIR / "spritesheet.png"
    spritesheet_webp = FINAL_DIR / "spritesheet.webp"
    atlas.save(spritesheet_png)
    atlas.save(spritesheet_webp, "WEBP", lossless=True, quality=100, method=6)

    contact = Image.new("RGBA", (ATLAS_W, ATLAS_H), (246, 248, 250, 255))
    contact.alpha_composite(atlas)
    grid = ImageDraw.Draw(contact)
    for x in range(0, ATLAS_W + 1, CELL_W):
        line(grid, [(x, 0), (x, ATLAS_H)], (218, 223, 229, 255), 1)
    for y in range(0, ATLAS_H + 1, CELL_H):
        line(grid, [(0, y), (ATLAS_W, y)], (218, 223, 229, 255), 1)
    contact.save(QA_DIR / "contact-sheet.png")

    for state, sprites in all_sprites.items():
        frames = []
        for sprite in sprites:
            frame = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
            frame.alpha_composite(sprite)
            frames.append(frame)
        frames[0].save(
            PREVIEW_DIR / f"{state}.gif",
            save_all=True,
            append_images=frames[1:],
            duration=140,
            loop=0,
            disposal=2,
        )

    (PET_DIR / "spritesheet.webp").write_bytes(spritesheet_webp.read_bytes())
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
        "spritesheet": str(spritesheet_webp),
        "contact_sheet": str(QA_DIR / "contact-sheet.png"),
        "previews": str(PREVIEW_DIR),
    }
    (QA_DIR / "run-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    save_outputs()
