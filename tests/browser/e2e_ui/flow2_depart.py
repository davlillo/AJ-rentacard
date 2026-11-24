"""FLOW 2 step E: departure readings and departure."""
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
        if not state.get("departed"):
            page.get_by_role("button", name="Entregar vehículo").click()
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Iniciar salida").click()
            page.wait_for_timeout(1000)
            km = page.get_by_label("Kilometraje (km)")
            baseline = km.get_attribute("min")
            base_value = int(baseline or 0)
            note("BASELINE KM: " + str(baseline))
            km.fill(str(base_value + 120))
            page.get_by_label("Combustible (%)").fill("75")
            page.get_by_label("Revisión general del vehículo (360°)").fill(
                "PRUEBA UI alquiler - salida: vehículo completo, llanta de repuesto y documentación a la vista."
            )
            shot(page, "f2-09-salida-borrador")
            page.get_by_role("button", name="Registrar entrega").click()
            page.wait_for_timeout(1200)
            note("=== CONFIRMACION ===")
            note(page.inner_text("body")[-1800:])
            shot(page, "f2-10-confirmacion-salida")
            page.get_by_role("button", name="Confirmar salida").click()
            page.wait_for_timeout(3500)
            shot(page, "f2-11-salida-registrada")
            state["departed"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== ESTADO TRAS SALIDA ===")
        note(page.inner_text("main")[:2500])
        (OUT / "flow2-salida.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
