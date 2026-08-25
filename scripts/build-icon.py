from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1] / "build"
root.mkdir(parents=True, exist_ok=True)
size = 512
image = Image.new("RGBA", (size, size), (9, 12, 22, 255))
pixels = image.load()
for y in range(size):
    for x in range(size):
        t = (x + y) / (2 * (size - 1))
        pixels[x, y] = (
            round(139 + (56 - 139) * t),
            round(111 + (215 - 111) * t),
            round(255 + (224 - 255) * t),
            255,
        )
mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle((34, 34, size - 34, size - 34), radius=122, fill=255)
background = Image.new("RGBA", (size, size), (0, 0, 0, 0))
background.paste(image, (0, 0), mask)
font_candidates = [
    Path("C:/Windows/Fonts/seguisb.ttf"),
    Path("C:/Windows/Fonts/arialbd.ttf"),
]
font_path = next(path for path in font_candidates if path.exists())
font = ImageFont.truetype(str(font_path), 278)
# Centre the actual painted glyph rather than its font metrics. Segoe UI's
# ascent/descent box is asymmetric, which made the M look low and off-centre.
glyph = Image.new("RGBA", (size, size), (0, 0, 0, 0))
glyph_draw = ImageDraw.Draw(glyph)
glyph_draw.text((0, 0), "M", font=font, fill=(250, 252, 255, 255))
glyph_box = glyph.getbbox()
if glyph_box is None:
    raise RuntimeError("Failed to render application icon glyph")
glyph = glyph.crop(glyph_box)
glyph_x = round((size - glyph.width) / 2)
glyph_y = round((size - glyph.height) / 2)
background.alpha_composite(glyph, (glyph_x, glyph_y))
background.save(root / "icon.png")
background.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
