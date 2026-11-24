"""FLOW 1 step U: decide the pending revision and classify the two costs."""
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
        page.get_by_role("button", name="Costos previstos y presupuesto").first.click()
        page.wait_for_timeout(1200)
        if not state.get("v2decided"):
            note("=== ESTADO CITAS ===")
            note(page.inner_text("main")[page.inner_text("main").find("Presupuestos del trabajo"):][:1500])
            page.get_by_text("Registrar aprobación o rechazo").first.click()
            page.wait_for_timeout(500)
            page.get_by_label("Quién autoriza").fill("PRUEBA UI taller - cliente")
            page.get_by_label("Acuerdo con el cliente (escrito o mensaje)").fill(
                "PRUEBA UI taller - el adicional no se acepta en esta visita"
            )
            page.get_by_label("Decisión del presupuesto").select_option("reject")
            page.get_by_role("button", name="Guardar decisión").click()
            page.wait_for_timeout(3000)
            shot(page, "f1-40-v2-rechazada")
            state["v2decided"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            note("=== TRAS RECHAZAR V2 ===")
            note(page.inner_text("main")[page.inner_text("main").find("Presupuestos del trabajo"):][:1800])
        (OUT / "flow1-decision.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
