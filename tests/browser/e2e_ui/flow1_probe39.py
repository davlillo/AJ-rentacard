"""Probe OT-39: reception form presence and the vehicle odometer."""
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
        page.goto(f"{BASE}/taller/ingreso/?id={state['order3Id']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== HEADINGS ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main h1,main h2')).map(h=>h.innerText.replace(/\\s+/g,' ').trim()).join(' | ')"
            )
        )
        note("=== INSPECCION? ===")
        note(str(page.get_by_label("Revisión general del vehículo (360°)").count()))
        body = page.inner_text("main")
        note("RESUMEN: " + body[body.find("Kilometraje actual") - 10:body.find("Kilometraje actual") + 120])
        note("PENDIENTES: " + body[body.find("Datos de recepción pendientes") - 10:][:140])
        shot(page, "f1-52-ot39")
        (OUT / "flow1-ot39.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
