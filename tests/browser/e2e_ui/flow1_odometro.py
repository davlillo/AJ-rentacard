"""FLOW 1 step X: reproduce the odometer erasure of the workshop reception."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, dump, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path("test-results/e2e-ui")
STATE_FILE = OUT / "flow1-state.json"
STEPS: list[str] = []


def note(text: str) -> None:
    STEPS.append(text)
    print(text.encode("ascii", "replace").decode("ascii"))


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        # 1. give the demo vehicle a known odometer through the UI
        page.goto(f"{BASE}/vehiculos")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)
        link = page.locator("a[href*='/vehiculos/expediente']").nth(2)
        note("VEHICLE HREF: " + str(link.get_attribute("href")))
        page.goto(f"{BASE}{link.get_attribute('href')}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Administrar vehículo").click()
        page.wait_for_timeout(1200)
        note("=== FORMULARIO DE ADMINISTRACION ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main label')).map(l=>l.outerHTML.replace(/\\s+/g,' ').slice(0,200)).join('\\n')"
            )
        )
        km = page.get_by_label("Kilometraje confirmado")
        km.fill("45000")
        page.get_by_role("button", name="Guardar").first.click()
        page.wait_for_timeout(2500)
        shot(page, "f1-47-km-45000")
        note("=== DESPUES DE GUARDAR EL KM ===")
        note(page.inner_text("main")[:900])
        (OUT / "flow1-odometro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
