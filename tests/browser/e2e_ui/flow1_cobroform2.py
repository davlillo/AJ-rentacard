"""FLOW 1 step Q: register the collection (cobre) and verify the pending balance."""
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
        page.get_by_role("button", name="Cobros").first.click()
        page.wait_for_timeout(1200)
        if not state.get("collected"):
            page.get_by_role("button", name="Registrar cobro").click()
            page.wait_for_timeout(1200)
            html = page.evaluate(
                "() => {const e=document.querySelector('[class*=editor]');return e?e.outerHTML.slice(0,6000):'NO EDITOR';}"
            )
            note("=== EDITOR DE COBRO ===")
            note(html)
            shot(page, "f1-34-editor-cobro")
            (OUT / "flow1-cobro-form.txt").write_text("\n".join(STEPS), encoding="utf-8")
            context.close()
            browser.close()
            note("STOP")
            return
        note("=== COBROS TRAS COBRAR ===")
        text = page.inner_text("main")
        note(text[text.find("Cobros de este trabajo"):][:2200])
        shot(page, "f1-35-cobros-final")
        (OUT / "flow1-cobro-form.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
