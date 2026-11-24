"""FLOW 1 step L: pay the pending 15 of cost B and verify no customer charge was created."""
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
        page.wait_for_timeout(1200)
        if not state.get("costBpaid"):
            page.get_by_text("Registrar pago al proveedor", exact=True).first.click()
            page.wait_for_timeout(1200)
            form = page.locator("form").filter(has_text="Importe del pago (USD)").first
            form.get_by_label("Importe del pago (USD)").fill("15")
            form.get_by_label("Cuenta del pago").fill("Caja principal")
            shot(page, "f1-26-pago-proveedor")
            form.get_by_role("button", name="Guardar pago sin duplicar costo").click()
            page.wait_for_timeout(3000)
            shot(page, "f1-27-pago-guardado")
            state["costBpaid"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            note("=== TRAS PAGO ===")
            note(page.inner_text("main")[-2200:])
            page.get_by_role("button", name="Resumen").first.click()
            page.wait_for_timeout(1500)
            text = page.inner_text("main")
            note("=== PANEL DE IMPORTES (RESUMEN) ===")
            note(text[text.find("Importes de este trabajo"):][:1200])
            shot(page, "f1-28-importes")
            (OUT / "flow1-pay.txt").write_text("\n".join(STEPS), encoding="utf-8")
            note("ERRORS: " + str(errors))
            context.close()
            browser.close()
            return
        note("=== PANEL DE IMPORTES (RESUMEN) ===")
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1200)
        text = page.inner_text("main")
        note(text[text.find("Importes de este trabajo"):][:1200])
        shot(page, "f1-27-importes")
        (OUT / "flow1-pay.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
