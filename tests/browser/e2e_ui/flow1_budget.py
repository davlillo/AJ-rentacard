"""FLOW 1 step B: create the budget (cost-first editor), price it and save."""
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
        page.goto(f"{BASE}/presupuestos/?trabajo={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)
        page.get_by_label("Descripción 1").fill("PRUEBA UI taller - repuesto original")
        page.get_by_label("Costo unitario 1").fill("40")
        page.get_by_role("button", name="Definir precio al cliente").click()
        page.wait_for_timeout(900)
        note("=== STEP 2 PRECIO ===")
        note(dump(page))
        note("--- TEXT ---")
        note(page.inner_text("main")[:4000])
        shot(page, "f1-07-presupuesto-precio")
        page.get_by_label("Precio unitario 1").fill("100")
        page.get_by_role("button", name="Agregar partida (material o adicional)").click()
        page.wait_for_timeout(700)
        page.get_by_label("Descripción 2").fill("PRUEBA UI taller - mano de obra")
        page.get_by_label("Costo unitario 2").fill("20")
        page.get_by_label("Precio unitario 2").fill("50")
        page.get_by_placeholder("Alcance del trabajo, condiciones o motivo de esta versión").fill(
            "PRUEBA UI taller - alcance inicial"
        )
        page.wait_for_timeout(400)
        shot(page, "f1-08-presupuesto-2-lineas")
        page.get_by_role("button", name="Guardar presupuesto").click()
        page.wait_for_timeout(2500)
        note("=== TRAS GUARDAR PRESUPUESTO ===")
        note(page.inner_text("main")[:4000])
        shot(page, "f1-09-presupuesto-guardado")
        (OUT / "flow1-budget.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
