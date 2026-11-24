"""FLOW 1 step C: approve the budget from the folio."""
import json
import re
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
        page.get_by_role("button", name="Costos previstos y presupuesto").first.click()
        page.wait_for_timeout(1200)
        href = page.evaluate(
            "() => {const a=Array.from(document.querySelectorAll('a')).find(x=>x.getAttribute('href')?.includes('/presupuestos/?id='));return a?a.getAttribute('href'):null;}"
        )
        note("QUOTE HREF: " + str(href))
        if href:
            state["quoteId"] = href.split("id=")[-1].split("&")[0]
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note(dump(page))
        shot(page, "f1-10-folio-presupuestos")
        # open the decision details
        page.get_by_text("Registrar aprobación o rechazo").first.click()
        page.wait_for_timeout(500)
        note("=== FORM DECISION ===")
        note(dump(page))
        shot(page, "f1-11-decision")
        (OUT / "flow1-approve.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
