"""FLOW 1 step K: cost B with 'Una parte' (partial payment) and the pending amount."""
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
        page.get_by_text("Una parte", exact=True).first.click()
        page.wait_for_timeout(800)
        form = page.locator("form").filter(has_text="Proveedor de compra").first
        form.get_by_label("Repuesto o servicio adquirido").fill("PRUEBA UI taller - filtro")
        form.get_by_label("Cantidad adquirida").fill("1")
        form.get_by_label("Costo unitario real (USD)").fill("25")
        form.get_by_label("Proveedor de compra").fill("PRUEBA UI taller - proveedor")
        form.get_by_label("Referencia de factura y línea").fill("PRUEBA UI - factura 2")
        form.get_by_label("Importe pagado ahora (USD)").fill("10")
        form.get_by_label("Cuenta o caja del pago").fill("Caja principal")
        shot(page, "f1-24-una-parte-lleno")
        note("=== FORM LLENO ===")
        note(dump(page))
        page.get_by_role("button", name="Guardar costo y primer pago").click()
        page.wait_for_timeout(3000)
        shot(page, "f1-25-una-parte-guardado")
        note("=== TRAS UNA PARTE ===")
        note(page.inner_text("main")[-4000:])
        state["costB"] = True
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        (OUT / "flow1-costB.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
