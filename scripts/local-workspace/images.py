"""Prepare reference vehicle images without modifying the original assets."""
from pathlib import Path
from PIL import Image

root = Path('test-results/local-workspace/images')
root.mkdir(parents=True, exist_ok=True)
names = ['aj-silver-sedan', 'aj-silver-sedan', 'aj-red-hatch', 'aj-silver-sedan',
         'aj-red-hatch', 'aj-silver-sedan', 'aj-white-suv']
for index, name in enumerate(names):
    image = Image.open(Path('public/images') / (name + '.png')).convert('RGB')
    image.thumbnail((960, 640))
    image.save(root / f'vehicle-{index + 1}.jpg', quality=84, optimize=True)
