"""FLOW 1 step I: 'Registrar el gasto pagado' modal."""
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
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Trabajo y costos reales").first.click()
        page.wait_for_timeout(900)
        page.get_by_role("button", name="Costos reales y gastos pagados").click()
        page.wait_for_timeout(900)
        page.get_by_role("button", name="Registrar costo").click()
        page.wait_for_timeout(700)
        page.get_by_text("Todo", exact=True).first.click()
        page.wait_for_timeout(500)
        page.get_by_role("button", name="Registrar el gasto pagado").click()
        page.wait_for_timeout(1500)
        note("=== MODAL GASTO ===")
        html = page.evaluate(
            "() => {const d=document.querySelector('[role=dialog]');return d?d.outerHTML.slice(0,6000):'NO DIALOG';}"
        )
        note(html)
        note("--- TEXTO DIALOG ---")
        dlg = page.locator("[role=dialog]")
        note(dlg.inner_text()[:4000] if dlg.count() else "none")
        shot(page, "f1-20-modal-gasto")
        (OUT / "flow1-gastodalog.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
