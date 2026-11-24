"""Prepare labeled reference renders locally; never claim these are actual vehicle photos."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path('test-results/showcase/images')
ROOT.mkdir(parents=True, exist_ok=True)
NAMES = ['aj-silver-sedan', 'aj-silver-sedan', 'aj-red-hatch', 'aj-silver-sedan',
         'aj-red-hatch', 'aj-silver-sedan', 'aj-white-suv']
try:
    font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 18)
except OSError:
    font = ImageFont.load_default(size=18)
for index, name in enumerate(NAMES):
    image = Image.open(Path('public/images') / (name + '.png')).convert('RGB')
    image.thumbnail((960, 640))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, image.height - 42, image.width, image.height), fill='#182b42')
    draw.text((18, image.height - 31), 'DEMO  |  ILUSTRACION DE REFERENCIA, NO FOTO DEL VEHICULO', font=font, fill='white')
    image.save(ROOT / f'vehicle-{index + 1}.jpg', quality=84, optimize=True)
print('Prepared seven labeled reference renders; original assets unchanged.')
