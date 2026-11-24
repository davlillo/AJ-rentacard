"""FLOW 1 step V: classify the two costs (disposition) so the delivery can proceed."""
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
        page.wait_for_timeout(1500)
        # cost A: included in the approved scope
        page.locator("button:visible", has_text="PRUEBA UI taller - repuesto original").first.click()
        page.wait_for_timeout(900)
        page.locator("summary:visible", has_text="Revisar relación con el presupuesto").first.click()
        page.wait_for_timeout(700)
        note("=== FORM RELACION COSTO A ===")
        note(
            page.evaluate(
                "() => {const d=document.querySelector('[class*=detail]')||document.querySelector('main');"
                "return Array.from(d.querySelectorAll('select')).map(s=>s.getAttribute('aria-label')+' :: '+Array.from(s.options).map(o=>o.text).join(' | ')).join('\\n');}"
            )
        )
        shot(page, "f1-41-relacion-costo")
        (OUT / "flow1-disposition.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
