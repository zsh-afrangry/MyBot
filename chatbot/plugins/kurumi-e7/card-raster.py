"""Rasterize a fixed E7 card inside the networkless render workspace."""
import io
import json
import os
from pathlib import Path


# The sandbox mounts system fonts but has no host /etc or HOME.
fonts = Path('/tmp/kurumi-card-fonts.conf')
fonts.write_text('<fontconfig><dir>/usr/share/fonts</dir><cachedir>/tmp/fontcache</cachedir></fontconfig>')
os.environ['FONTCONFIG_FILE'] = str(fonts)

import cairo
import gi
from PIL import Image, ImageOps

gi.require_version('Rsvg', '2.0')
from gi.repository import Rsvg

LANCZOS = getattr(Image, 'Resampling', Image).LANCZOS


def render():
    layout = json.loads(Path('card.json').read_text(encoding='utf-8'))
    width, height = layout['width'], layout['height']
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, width, height)
    viewport = Rsvg.Rectangle()
    viewport.x = viewport.y = 0
    viewport.width, viewport.height = width, height
    Rsvg.Handle.new_from_data(Path('card.svg').read_bytes()).render_document(cairo.Context(surface), viewport)
    png = io.BytesIO()
    surface.write_to_png(png)
    png.seek(0)
    with Image.open(png, formats=['PNG']) as base:
        canvas = base.convert('RGBA')
    Image.MAX_IMAGE_PIXELS = 8_000_000
    for layer in layout['layers']:
        box = (layer['width'], layer['height'])
        try:
            with Image.open(layer['filename'], formats=['PNG', 'JPEG', 'GIF', 'WEBP']) as src:
                if src.width * src.height > Image.MAX_IMAGE_PIXELS:
                    continue
                asset = ImageOps.contain(src.convert('RGBA'), box, LANCZOS)
            canvas.alpha_composite(asset, dest=(layer['left'] + (box[0] - asset.width) // 2,
                                                layer['top'] + (box[1] - asset.height) // 2))
        except (OSError, ValueError, Image.DecompressionBombError):
            # Bad optional art does not invalidate the text rendered from the verified record.
            continue
    canvas.convert('RGB').save('card.png', format='PNG')


if __name__ == '__main__':
    render()
