"""FLOW 1 step O: emit the amount to collect and inspect the collection action."""
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
        if not state.get("emitted"):
            page.get_by_role("button", name="Preparar importe a cobrar").click()
            page.wait_for_timeout(800)
            page.get_by_role("button", name="Emitir importe a cobrar de $150.00").click()
            page.wait_for_timeout(3000)
            shot(page, "f1-31-emitido")
            state["emitted"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== COBROS TRAS EMITIR ===")
        note(page.inner_text("main")[-3000:])
        note("--- BOTONES ---")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button, main a, main summary')).map(e=>e.tagName+':'+(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,70)).join('\\n')"
            )
        )
        shot(page, "f1-32-cobros-emitido")
        (OUT / "flow1-emitir.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
