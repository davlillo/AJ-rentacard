"""FLOW 1 step D: approve the budget as the client, then verify the active scope."""
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
        page.wait_for_timeout(1000)
        if state.get("approved"):
            note("YA APROBADO")
        else:
            page.get_by_text("Registrar aprobación o rechazo").first.click()
            page.wait_for_timeout(400)
            page.get_by_label("Quién autoriza").fill("PRUEBA UI taller - cliente")
            page.get_by_label("Acuerdo con el cliente (escrito o mensaje)").fill(
                "PRUEBA UI taller - aceptado por mensaje del cliente"
            )
            page.get_by_role("button", name="Guardar decisión").click()
            page.wait_for_timeout(2500)
            shot(page, "f1-12-aprobado")
        note("=== FOLIO TRAS APROBACION ===")
        note(page.inner_text("main")[:5000])
        (OUT / "flow1-approved.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
