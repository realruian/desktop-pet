# Regenerate build/icon.icns from the dog art (pixel-crisp NEAREST upscale).
# Usage: python3 build/make-icon.py && iconutil -c icns build/icon.iconset -o build/icon.icns
from PIL import Image
import os

src = Image.open('assets/eyes/forward.png').convert('RGBA')
dog = src.crop(src.getbbox())
side = int(max(dog.size) * 1.16)  # ~8% margin around the dog
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(dog, ((side - dog.width) // 2, (side - dog.height) // 2), dog)

os.makedirs('build/icon.iconset', exist_ok=True)
for pt in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        px = pt * scale
        # NEAREST when upscaling keeps the pixel-art look; LANCZOS when shrinking.
        img = canvas.resize(
            (px, px), Image.NEAREST if px >= side else Image.LANCZOS
        )
        suffix = f'{pt}x{pt}' + ('@2x' if scale == 2 else '')
        img.save(f'build/icon.iconset/icon_{suffix}.png')
print('iconset written; now run: iconutil -c icns build/icon.iconset -o build/icon.icns')
