"""FLOW 1 step X5: prove the odometer erasure on OT-39 / PRUEBA-UI-1."""
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
    state["order3Id"] = "OT-39"
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/taller/ingreso/?id=OT-39")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        body = page.inner_text("main")
        note("ANTES (RESUMEN): " + body[body.find("Kilometraje actual") - 5:body.find("Kilometraje actual") + 60])
        # confirm the odometer
        page.locator("summary:visible", has_text="Completar o corregir datos").first.click()
        page.wait_for_timeout(600)
        page.locator("input[name=km]:visible").first.fill("45000")
        page.locator("textarea[name=reason]:visible").first.fill(
            "PRUEBA UI taller - se confirma el odometro antes de la recepcion"
        )
        page.locator("main form button[type=submit]:visible").last.click()
        page.wait_for_timeout(2500)
        body = page.inner_text("main")
        note("DESPUES DE CONFIRMAR EL KM: " + body[body.find("Kilometraje actual") - 5:body.find("Kilometraje actual") + 60])
        shot(page, "f1-53-km-confirmado")
        # now save the reception with the current form (no readings fields)
        page.get_by_role("button", name="Ingreso y diagnóstico").first.click()
        page.wait_for_timeout(1500)
        note("INSPECCION FORM: " + str(page.get_by_label("Revisión general del vehículo (360°)").count()))
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI taller - recepcion de prueba con el formulario actual."
        )
        page.get_by_role("button", name="Guardar inspección del ingreso").click()
        page.wait_for_timeout(3500)
        shot(page, "f1-54-recepcion-guardada")
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1500)
        body = page.inner_text("main")
        note("TRAS LA RECEPCION (RESUMEN): " + body[body.find("Kilometraje actual") - 5:body.find("Kilometraje actual") + 60])
        note("PENDIENTES: " + body[body.find("Datos de recepción pendientes") - 5:][:120])
        (OUT / "flow1-odometro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
