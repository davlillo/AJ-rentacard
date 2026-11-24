"""FLOW 1 step F: price and save the additional line; verify the revision and the active scope."""
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
        if not state.get("additionalSaved"):
            page.goto(f"{BASE}/presupuestos/?id={state['quoteId']}&adicional=1")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1500)
            page.get_by_label("Descripción 3").fill("PRUEBA UI taller - adicional")
            page.get_by_label("Costo unitario 3").fill("10")
            page.get_by_label("Precio unitario 3").fill("30")
            page.get_by_placeholder("Alcance del trabajo, condiciones o motivo de esta versión").fill(
                "PRUEBA UI taller - adicional acordado con el cliente"
            )
            page.wait_for_timeout(400)
            shot(page, "f1-14-adicional-preciado")
            page.get_by_role("button", name="Guardar presupuesto").click()
            page.wait_for_timeout(2500)
            shot(page, "f1-15-adicional-guardado")
            state["additionalSaved"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            note("=== TRAS GUARDAR ADICIONAL ===")
            note(page.inner_text("main")[:3000])
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Costos previstos y presupuesto").first.click()
        page.wait_for_timeout(1200)
        note("=== FOLIO TRAS ADICIONAL ===")
        note(page.inner_text("main")[:5000])
        shot(page, "f1-16-folio-tras-adicional")
        (OUT / "flow1-adicional.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
