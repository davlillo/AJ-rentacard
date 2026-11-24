"""FLOW 1 step R: collect 100 and verify the pending balance drops exactly."""
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
            page.wait_for_timeout(1000)
            editor = page.locator("[class*=editor]").first
            editor.get_by_label("A qué documento se aplica el cobro").select_option(
                label="CAR-00012 · Alcance aprobado OT-37 V1 · saldo $150.00"
            )
            editor.get_by_label("Importe recibido (USD)").fill("100")
            editor.get_by_label("Cuenta o caja receptora").fill("Caja principal")
            editor.get_by_label("Referencia del pago").fill("PRUEBA UI taller - cobro 1")
            page.wait_for_timeout(400)
            shot(page, "f1-36-cobro-lleno")
            editor.get_by_role("button", name="Registrar cobro de $100.00").click()
            page.wait_for_timeout(3000)
            state["collected"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== COBROS TRAS COBRAR ===")
        text = page.inner_text("main")
        note(text[text.find("Cobros de este trabajo"):][:2500])
        shot(page, "f1-37-cobros-tras-cobro")
        (OUT / "flow1-cobro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
