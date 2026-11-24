"""FLOW 2 step M: client document download (PDF/PNG) and vehicle release from the dossier."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, dump, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path("test-results/e2e-ui")
STATE_FILE = OUT / "flow2-state.json"
STEPS: list[str] = []


def note(text: str) -> None:
    STEPS.append(text)
    print(text.encode("ascii", "replace").decode("ascii"))


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/alquileres/folio/?id={state['reservationId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="Cuentas", exact=False).first.click()
        page.wait_for_timeout(1500)
        shots = OUT / "screens"
        shots.mkdir(parents=True, exist_ok=True)
        for label, name in [("Descargar detalle (PDF)", "alquiler-PRUEBA-UI-detalle.pdf"),
                            ("Descargar imagen (PNG)", "alquiler-PRUEBA-UI-detalle.png")]:
            with page.expect_download(timeout=30000) as info:
                page.get_by_role("button", name=label).first.click()
            download = info.value
            target = shots / name
            download.save_as(str(target))
            note(f"{label} -> {target} ({target.stat().st_size} bytes)")
        # vehicle dossier
        href = page.evaluate(
            """() => {const a=Array.from(document.querySelectorAll('a[href*="/vehiculos/expediente"]'))[0];return a?a.getAttribute('href'):null;}"""
        )
        note("VEHICLE HREF: " + str(href))
        page.goto(f"{BASE}{href}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== EXPEDIENTE DEL VEHICULO ===")
        note(page.inner_text("main")[:3500])
        note("=== BOTONES ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button, main summary, main a')).map(e=>e.tagName+':'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)).join('\\n')"
            )
        )
        shot(page, "f2-26-expediente-vehiculo", full=True)
        (OUT / "flow2-release.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
