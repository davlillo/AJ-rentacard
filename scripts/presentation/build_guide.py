"""Build the local presenter guide as self-contained HTML and a paginated PDF."""
import base64
import argparse
import html
import json
import re
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--walkthrough', action='store_true', help='Build the literal menu-order walkthrough.')
args = parser.parse_args()
ROOT = Path('docs/presentacion')
stem = 'RECORRIDO_PANTALLA_POR_PANTALLA' if args.walkthrough else 'GUIA_PRESENTACION_AJ'
SOURCE = ROOT / (stem + '.md')
HTML = ROOT / (stem + '.html')
PDF = ROOT / ('AJ_Rentacar_Recorrido_pantalla_por_pantalla.pdf' if args.walkthrough else 'AJ_Rentacar_Guia_de_presentacion.pdf')
EVIDENCE = Path('test-results/presentation/walkthrough' if args.walkthrough else 'test-results/presentation')
RESOURCES = ROOT / ('recursos-recorrido' if args.walkthrough else 'recursos')
RESOURCES.mkdir(parents=True, exist_ok=True)

image_names = [path.stem for path in EVIDENCE.glob('*.png') if re.match(r'^0[1-8]-', path.stem)] if args.walkthrough else ['inicio', 'diario', 'cobro-folio', 'gantt']
for name in image_names:
    image = Image.open(EVIDENCE / (name + '.png')).convert('RGB')
    if args.walkthrough and name in ['01-inicio', '02-clientes', '03-vehiculos',
                                    '04-calendario', '05-taller', '05-entregados', '05-trabajo',
                                    '06-presupuestos', '06-detalle', '07-cobros', '08-diario']:
        image = image.crop((250, 90, image.width - 15, min(image.height, 730)))
    elif name in ['inicio', 'diario']:
        image = image.crop((255, 92, image.width - 15, min(image.height, 950)))
    elif name == 'cobro-folio':
        image = image.crop((0, 0, image.width, min(image.height, 560)))
    image.save(RESOURCES / (name + '.jpg'), quality=88, optimize=True)


def data_uri(path: Path, mime: str) -> str:
    return 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


def inline(text: str) -> str:
    value = html.escape(text)
    value = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<a href="\2">\1</a>', value)
    value = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', value)
    value = re.sub(r'`([^`]+)`', r'<code>\1</code>', value)
    return value


def blocks(source: str, index: int) -> str:
    lines = source.strip().splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        image = re.fullmatch(r'!\[([^]]+)\]\(recursos(?:-recorrido)?/([a-z0-9-]+)\.jpg\)', line)
        if image:
            alt, name = image.groups()
            uri = data_uri(RESOURCES / (name + '.jpg'), 'image/jpeg')
            result.append(f'<figure><img src="{uri}" alt="{html.escape(alt)}"><figcaption>{inline(alt)}</figcaption></figure>')
            i += 1
            continue
        heading = re.match(r'^(#{1,3}) (.+)$', line)
        if heading:
            level, title = len(heading[1]), heading[2]
            result.append(f'<h{level}>{inline(title)}</h{level}>')
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [cell.strip() for cell in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                    rows.append(cells)
                i += 1
            dense = ' dense' if len(rows[0]) >= 6 else ''
            result.append('<table class="' + dense.strip() + '"><thead><tr>' +
                          ''.join('<th>' + inline(cell) + '</th>' for cell in rows[0]) + '</tr></thead><tbody>' +
                          ''.join('<tr>' + ''.join('<td>' + inline(cell) + '</td>' for cell in row) + '</tr>'
                                  for row in rows[1:]) + '</tbody></table>')
            continue
        if re.match(r'^(?:- |\d+\. )', line):
            ordered = bool(re.match(r'^\d+\. ', line))
            pattern = r'^\d+\. ' if ordered else r'^- '
            items = []
            while i < len(lines) and re.match(pattern, lines[i].strip()):
                item = re.sub(pattern, '', lines[i].strip())
                items.append('<li>' + inline(item) + '</li>')
                i += 1
            tag = 'ol' if ordered else 'ul'
            result.append('<' + tag + '>' + ''.join(items) + '</' + tag + '>')
            continue
        if line.startswith('> '):
            result.append('<blockquote>' + inline(line[2:]) + '</blockquote>')
            i += 1
            continue
        paragraph = []
        while i < len(lines) and lines[i].strip() and not re.match(r'^(?:#|\||!\[|> |\d+\. |- )', lines[i].strip()):
            paragraph.append(lines[i].strip())
            i += 1
        if not paragraph:
            raise ValueError('Unrecognized Markdown block: ' + line)
        result.append('<p>' + inline(' '.join(paragraph)) + '</p>')
    return '\n'.join(result)


pages = SOURCE.read_text(encoding='utf8').split('<!-- page -->')
fonts = Path('node_modules/@fontsource/manrope/files')
regular = data_uri(fonts / 'manrope-latin-400-normal.woff2', 'font/woff2')
bold = data_uri(fonts / 'manrope-latin-700-normal.woff2', 'font/woff2')
style = '''
@font-face{font-family:AJ;src:url(REGULAR) format('woff2');font-weight:400}
@font-face{font-family:AJ;src:url(BOLD) format('woff2');font-weight:700}
:root{--ink:#162b46;--red:#c72b42;--muted:#5d6a7b;--line:#dce2e9}
*{box-sizing:border-box}html{background:#e9edf1;color:var(--ink);font-family:AJ,Arial,sans-serif}
body{margin:0;font-size:10pt;line-height:1.46}strong{font-weight:700}a{color:#174b83;text-decoration:none}
.toolbar{padding:12px 20px;background:var(--ink);color:white;display:flex;gap:20px;justify-content:center;flex-wrap:wrap;position:sticky;top:0;z-index:3;font-size:12px}.toolbar a{color:white}
.sheet{position:relative;width:8.5in;height:11in;margin:22px auto;background:white;padding:.55in .58in .45in;display:flex;flex-direction:column;box-shadow:0 8px 35px #0d284b17;break-after:page}
.sheet:last-child{break-after:auto}.running-header{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid var(--red);padding-bottom:11px;margin-bottom:18px;flex:0 0 auto;font-size:8px;letter-spacing:1.2px;color:var(--muted)}.brand{font-size:19px;font-weight:700;letter-spacing:-1px;color:var(--red)}.brand span{font-size:8px;letter-spacing:1px;color:var(--ink);margin-left:9px}
.content{flex:1;min-height:0}.footer{flex:0 0 auto;display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:8px;margin-top:12px;font-size:8px;color:var(--muted);letter-spacing:.2px}
h1{font-size:21pt;line-height:1.18;letter-spacing:-.6px;margin:0 0 17px;font-weight:700}h2{font-size:16pt;line-height:1.25;margin:16px 0 11px}h3{font-size:11pt;margin:15px 0 7px;line-height:1.3;color:#194e75}
p{margin:8px 0 10px}ul,ol{padding-left:21px;margin:7px 0 11px}li{padding-left:3px;margin:5px 0}blockquote{margin:13px 0;padding:12px 15px;background:#f1f5fa;border-left:3px solid var(--red);font-size:10pt;line-height:1.52}
table{width:100%;border-collapse:collapse;margin:11px 0 14px;font-size:8.5pt;line-height:1.4;table-layout:auto}th{text-align:left;background:var(--ink);color:white;font-weight:700;padding:8px}td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:nth-child(even) td{background:#f5f7fa}.dense{font-size:7.8pt;line-height:1.35}.dense td,.dense th{padding:6px 5px}
figure{margin:12px 0;text-align:center}figure img{max-width:100%;max-height:235px;object-fit:contain;border:1px solid var(--line);border-radius:4px}figcaption{font-size:8px;color:var(--muted);margin-top:4px}code{font-family:Consolas,monospace;font-size:.9em;background:#edf1f6;padding:1px 3px}
.cover .content{padding-top:28px}.cover h1{font-size:36pt;color:var(--red);letter-spacing:-1.5px;margin-bottom:11px}.cover h2{font-size:27pt;color:var(--ink);max-width:550px;margin:0 0 20px}.cover h3{font-size:14pt;max-width:550px}.cover blockquote{padding:20px;font-size:12pt;line-height:1.6;background:var(--ink);color:white;border-left:4px solid var(--red);margin:22px 0}
@page{size:Letter;margin:0}@media print{html,body{background:white}.toolbar{display:none}.sheet{margin:0;box-shadow:none}a{color:inherit}}
'''.replace('REGULAR', regular).replace('BOLD', bold)
if args.walkthrough:
    style += 'figure img{max-height:285px}.cover h2{font-size:25pt}'
sections = []
nav_items = []
for index, source in enumerate(pages):
    heading = re.search(r'^# (0[1-8]) · (.+)$', source, re.MULTILINE)
    if heading:
        nav_items.append(f'<a href="#pagina-{index+1}">{inline(heading[1] + " " + heading[2])}</a>')
    sections.append(f'''<section class="sheet{' cover' if index == 0 else ''}" id="pagina-{index+1}">
      <header class="running-header"><div class="brand">AJ<span>RENT A CAR</span></div><span>GUÍA DE PRESENTACIÓN · 05 NOV 2026</span></header>
      <main class="content">{blocks(source, index)}</main>
      <footer class="footer"><span>{'Recorrido literal · Pantalla, clic, ejemplo y siguiente paso' if args.walkthrough else 'Avance operativo · Casos, secuencias y controles'}</span><span>{index+1:02d} / {len(pages):02d}</span></footer>
    </section>''')
document = f'''<!doctype html><html lang="es-SV"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AJ Rent a Car · {'Recorrido pantalla por pantalla' if args.walkthrough else 'Guía de presentación del avance'}</title><style>{style}</style></head><body>
<nav class="toolbar" aria-label="Accesos de la guía">{''.join(nav_items) if args.walkthrough else '<a href="#pagina-2">Conceptos</a><a href="#pagina-8">Libro diario</a><a href="#pagina-9">Registrar cobro</a><a href="#pagina-14">Caso vivo A</a><a href="#pagina-18">Caso vivo B</a><a href="#pagina-25">Hoja de apoyo</a>'}</nav>
{''.join(sections)}</body></html>'''
HTML.write_text(document, encoding='utf8')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1100, 'height': 1200}, device_scale_factor=1)
        page.route(re.compile(r'^https?://'), lambda route: route.abort())
        page.goto(HTML.resolve().as_uri(), wait_until='networkidle')
        page.emulate_media(media='print')
        page.evaluate('document.fonts.ready')
        overflow = page.evaluate('''() => [...document.querySelectorAll('.sheet')].map((sheet,i) => {
          const c=sheet.querySelector('.content');return {page:i+1,scroll:c.scrollHeight,height:c.clientHeight,
          horizontal:c.scrollWidth-c.clientWidth};}).filter(s=>s.scroll>s.height+2||s.horizontal>2)''')
        if overflow:
            (EVIDENCE / 'document-overflow.json').write_text(json.dumps(overflow, indent=2), encoding='utf8')
            raise RuntimeError('Document page overflow: ' + json.dumps(overflow))
        for number in ([1, 2, 3, 6, 10, 14, len(pages)] if args.walkthrough else [1, 3, 6, 8, 9, 14, 17, 19, 25]):
            page.locator('.sheet').nth(number-1).screenshot(path=str(EVIDENCE / f'guide-page-{number:02d}.png'))
        page.pdf(path=str(PDF), print_background=True, prefer_css_page_size=True,
                 display_header_footer=False, tagged=True, outline=True)
    finally:
        browser.close()

print(json.dumps({'html': str(HTML), 'pdf': str(PDF), 'source': str(SOURCE),
                  'plannedPages': len(pages), 'pageOverflow': 0, 'pdfBytes': PDF.stat().st_size}, indent=2))
