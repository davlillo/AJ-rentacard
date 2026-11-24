"""FLOW 1 step J: register cost A ('Todo') and inspect the 'Una parte' form."""
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


def open_costs(page, state):
    page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    page.get_by_role("button", name="Trabajo y costos reales").first.click()
    page.wait_for_timeout(900)
    page.get_by_role("button", name="Costos reales y gastos pagados").click()
    page.wait_for_timeout(900)
    page.get_by_role("button", name="Registrar costo").click()
    page.wait_for_timeout(700)


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        if not state.get("costA"):
            open_costs(page, state)
            page.get_by_text("Todo", exact=True).first.click()
            page.wait_for_timeout(400)
            page.get_by_role("button", name="Registrar el gasto pagado").click()
            page.wait_for_timeout(1200)
            dlg = page.locator("[role=dialog]")
            dlg.get_by_label("Concepto").fill("PRUEBA UI taller - repuesto original")
            dlg.get_by_label("Importe (USD)").fill("40")
            dlg.get_by_label("Vincular gasto a").select_option("workshop")
            page.wait_for_timeout(1200)
            dlg.get_by_label("Trabajo / folio").select_option("OT-37")
            page.wait_for_timeout(400)
            dlg.get_by_label("Categoría").fill("Repuestos")
            dlg.get_by_label("Cuenta o caja").fill("Caja principal")
            dlg.get_by_label("Referencia del soporte (opcional)").fill("PRUEBA UI taller - soporte 1")
            shot(page, "f1-21-gasto-lleno")
            dlg.get_by_role("button", name="Guardar registro").click()
            page.wait_for_timeout(3000)
            shot(page, "f1-22-gasto-guardado")
            state["costA"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            note("=== TRAS GASTO TODO ===")
            note(page.inner_text("main")[-3000:])
        # now inspect the 'Una parte' form
        open_costs(page, state)
        page.get_by_text("Una parte", exact=True).first.click()
        page.wait_for_timeout(900)
        html = page.evaluate(
            "() => Array.from(document.querySelectorAll('main label')).map(l=>l.outerHTML.slice(0,200)).join('\\n---\\n')"
        )
        note("=== FORM UNA PARTE ===")
        note(html)
        note("--- TEXTO ---")
        note(page.inner_text("main")[-3000:])
        shot(page, "f1-23-una-parte")
        (OUT / "flow1-costA.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
