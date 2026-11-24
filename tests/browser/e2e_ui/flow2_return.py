"""FLOW 2 step F: return inspection with a difference and the extra decision."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, dump, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path("test-results/e2e-ui")
STATE_FILE = OUT / "flow2-state.json"
STEPS: list[str] = []


def note(text: str) -> None:
    STEPS.append(text)
    print(text.encode("ascii", "replace").decode("ascii"))


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/alquileres/folio/?id={state['reservationId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        if not state.get("returned"):
            page.get_by_role("button", name="Iniciar devolución").click()
            page.wait_for_timeout(1000)
            page.get_by_label("Kilometraje (km)").fill("30320")
            page.get_by_label("Combustible (%)").fill("50")
            page.get_by_label("Revisión general del vehículo (360°)").fill(
                "PRUEBA UI alquiler - devolución: rayón en el guardafango derecho y falta la tapa del depósito de combustible."
            )
            shot(page, "f2-12-devolucion-borrador")
            page.get_by_role("button", name="Registrar devolución").click()
            page.wait_for_timeout(1200)
            note("=== CONFIRMACION DEVOLUCION ===")
            note(page.inner_text("body")[-1600:])
            shot(page, "f2-13-confirmacion-devolucion")
            page.get_by_role("button", name="Confirmar devolución").click()
            page.wait_for_timeout(4000)
            shot(page, "f2-14-devolucion-registrada")
            state["returned"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== ESTADO TRAS DEVOLUCION ===")
        note(page.inner_text("main")[-3000:])
        (OUT / "flow2-devolucion.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
