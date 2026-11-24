"""Browser proof for the rental detail export: synthetic HTTP only, never a business API."""
import http.server
import json
import socketserver
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path('test-results/rental-document')
REPO = Path(__file__).resolve().parents[2]
FONT = REPO / 'public' / 'fonts' / 'manrope-latin-regular.woff'
EXPECTED_BASE = 'detalle-ALQ-99001'
VIEWPORTS = [{'name': 'desktop', 'width': 1440, 'height': 900}, {'name': 'mobile', 'width': 390, 'height': 844}]


def build_bundle():
    """Bundle the real control with the local esbuild so the page runs the shipped source."""
    ROOT.mkdir(parents=True, exist_ok=True)
    entry = ROOT / 'harness.tsx'
    entry.write_text(
        "import {createRoot} from 'react-dom/client';\n"
        "import {rentalDocument} from '@/lib/documents/rental-document';\n"
        "import {rentalSections} from '@/lib/documents/rental-layout';\n"
        "import {RentalDocumentExport} from '@/components/organisms/rental-document-export';\n"
        "const facts={folioNumber:99001,customerName:'Cliente sintetico',vehicleLabel:'Nissan Rogue 2018',\n"
        "  plate:'SYNTH-001',startsOn:'2026-11-01',endsOn:'2026-11-05',days:5,agreedAmount:250,\n"
        "  issuedAmount:150,appliedAmount:100,pendingAmount:50,openEnded:false,statusLabel:'Confirmada',\n"
        "  createdAt:'2026-11-20T10:00:00Z'};\n"
        "const projection=rentalDocument(facts);\n"
        "const plan=rentalSections(projection).map(section=>section.heading+'\\n'+section.lines.join('\\n')).join('\\n');\n"
        "createRoot(document.getElementById('root')!).render(<><RentalDocumentExport document={projection}/>\n"
        "<pre id='plan'>{plan}</pre></>);\n",
        encoding='utf-8')
    subprocess.run([
        'node', str(REPO / 'node_modules' / 'esbuild' / 'bin' / 'esbuild'), str(entry),
        '--bundle', f'--outfile={ROOT / "bundle.js"}', '--format=iife', '--jsx=automatic',
        '--define:process.env.NODE_ENV="production"', f'--tsconfig={REPO / "tsconfig.json"}',
    ], cwd=REPO, check=True, capture_output=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_GET(self):
        if self.path == '/':
            body = ('<!doctype html><html lang="es"><head><meta charset="utf-8">'
                    '<meta name="viewport" content="width=device-width,initial-scale=1">'
                    '<link rel="stylesheet" href="/bundle.css"><script src="/bundle.js" defer></script>'
                    '<title>Detalle de alquiler</title></head>'
                    '<body style="font-family:Manrope,Arial,sans-serif;padding:24px">'
                    '<h1 style="font-size:18px">Folio ALQ-99001</h1><div id="root"></div></body></html>')
            payload = body.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        for name in ('bundle.js', 'bundle.css'):
            if self.path == f'/{name}':
                payload = (ROOT / name).read_bytes()
                kind = 'application/javascript' if name.endswith('.js') else 'text/css'
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
        if self.path == '/fonts/manrope-latin-regular.woff':
            payload = FONT.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'font/woff')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)


def serve():
    server = socketserver.TCPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def assert_download(page, button, expected_suffix, magic, minimum, label):
    with page.expect_download() as info:
        page.get_by_role('button', name=button).click()
    download = info.value
    name = download.suggested_filename
    path = download.path()
    data = Path(path).read_bytes() if path else b''
    assert name.endswith(expected_suffix), f'unexpected filename {name}'
    assert EXPECTED_BASE in name, f'filename without folio {name}'
    assert len(data) > minimum, f'{name} produced {len(data)} bytes'
    assert data.startswith(magic), f'{name} does not start with {magic!r}'
    (ROOT / f'{label}-{name}').write_bytes(data)
    return name, len(data)


def verify_png(path):
    """Pixel proof of the PNG: the canvas is 612x792 CSS pixels exported at twice the size."""
    try:
        from PIL import Image
    except ImportError:
        return {'pixel_check': 'Pillow not installed: only bytes were verified'}
    with Image.open(path) as image:
        size = image.size
        colors = image.convert('RGB').getcolors(maxcolors=200000) or []
        sample = image.convert('RGB')
        header = sample.getpixel((600, 90))
        body = sample.getpixel((60, 1500))
    assert size == (1224, 1584), f'unexpected PNG size {size}'
    assert len(colors) > 40, f'PNG looks blank ({len(colors)} colors)'
    assert header[0] < 80 and header[1] < 90 and header[2] < 120, f'header band is not the brand ink: {header}'
    assert body[0] > 240 and body[1] > 240 and body[2] > 240, f'body is not on paper: {body}'
    return {'pixel_check': f'{size[0]}x{size[1]} with {len(colors)} colors, header {header}, body {body}'}


def main():
    build_bundle()
    server = serve()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    results = []
    try:
        with sync_playwright() as play:
            browser = play.chromium.launch(headless=True)
            for viewport in VIEWPORTS:
                context = browser.new_context(viewport={'width': viewport['width'], 'height': viewport['height']},
                                              accept_downloads=True)
                page = context.new_page()
                page.route('**/*', lambda route: route.abort() if '127.0.0.1' not in route.request.url else route.continue_())
                page.goto(base)
                expect(page.get_by_role('button', name='Descargar detalle (PDF)')).to_be_visible()
                # The projection that feeds the PDF and the PNG states the agreed amount is not a receivable.
                plan = page.locator('#plan').inner_text()
                assert 'Monto acordado: $250.00' in plan, plan
                assert 'no es una cuenta por cobrar emitida' in plan, plan
                pdf_name, pdf_size = assert_download(page, 'Descargar detalle (PDF)', '.pdf', b'%PDF-', 800,
                                                    viewport['name'])
                png_name, png_size = assert_download(page, 'Descargar imagen (PNG)', '.png', b'\x89PNG', 800,
                                                     viewport['name'])
                page.screenshot(path=str(ROOT / f"{viewport['name']}-export.png"), full_page=True)
                results.append({'viewport': viewport['name'], 'pdf': pdf_name, 'pdf_bytes': pdf_size,
                                'png': png_name, 'png_bytes': png_size,
                                'pixels': verify_png(ROOT / f"{viewport['name']}-{png_name}")})
                context.close()

            # Error path: the local font is missing, the control must explain it instead of failing silently.
            context = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page = context.new_page()
            page.route('**/fonts/manrope-latin-regular.woff', lambda route: route.fulfill(status=404, body='missing'))
            page.goto(base)
            page.get_by_role('button', name='Descargar detalle (PDF)').click()
            error = page.get_by_role('alert')
            expect(error).to_be_visible(timeout=15000)
            message = error.inner_text()
            assert 'tipografía' in message, f'unclear error message: {message}'
            page.screenshot(path=str(ROOT / 'error-state.png'), full_page=True)
            results.append({'error_message': message})
            context.close()
            browser.close()
    finally:
        server.shutdown()
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
