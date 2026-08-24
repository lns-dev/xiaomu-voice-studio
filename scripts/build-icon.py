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
draw = ImageDraw.Draw(background)
font_candidates = [
    Path("C:/Windows/Fonts/seguisb.ttf"),
    Path("C:/Windows/Fonts/arialbd.ttf"),
]
font_path = next(path for path in font_candidates if path.exists())
font = ImageFont.truetype(str(font_path), 278)
box = draw.textbbox((0, 0), "M", font=font)
width, height = box[2] - box[0], box[3] - box[1]
draw.text(((size - width) / 2, (size - height) / 2 - 24), "M", font=font, fill=(250, 252, 255, 255))
background.save(root / "icon.png")
background.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
