"""FLOW 1 step X4: reproduce the odometer erasure with the demo vehicle PRUEBA-UI-1."""
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
        # 1. confirm the odometer of PRUEBA-UI-1 through the folio registry form
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1200)
        page.locator("summary:visible", has_text="Completar o corregir datos").first.click()
        page.wait_for_timeout(600)
        km = page.locator("input[name=km]:visible").first
        km.fill("45000")
        page.locator("textarea[name=reason]:visible").first.fill(
            "PRUEBA UI taller - se confirma el odometro de la unidad de prueba"
        )
        page.locator("main form button[type=submit]:visible").last.click()
        page.wait_for_timeout(2500)
        body = page.inner_text("main")
        note("=== RESUMEN TRAS CONFIRMAR KM ===")
        note(body[body.find("Kilometraje actual") - 20:body.find("Kilometraje actual") + 90])
        shot(page, "f1-50-km-45000")
        # 2. new work order on the same vehicle
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="Nueva entrada").click()
        page.wait_for_timeout(900)
        page.get_by_label("Cliente del trabajo").select_option(label="PRUEBA UI taller")
        page.get_by_role("button", name="Continuar").click()
        page.wait_for_timeout(800)
        page.get_by_label("Vehículo del cliente").select_option(label="Seleccionar vehículo registrado")
        page.wait_for_timeout(500)
        page.get_by_label("Vehículo registrado del taller").select_option(
            label="PRUEBA-UI-1 · Toyota Prueba Taller"
        )
        page.get_by_role("button", name="Continuar").click()
        page.wait_for_timeout(800)
        page.get_by_label("Motivo del ingreso").fill("PRUEBA UI taller - odometro de la unidad")
        page.get_by_role("button", name="Crear folio OT").click()
        page.wait_for_timeout(3000)
        hrefs = page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href*=\"taller/ingreso\"]')).map(a => a.getAttribute('href'))"
        )
        note("ORDENES: " + json.dumps(hrefs))
        order3 = (hrefs[0].split("id=")[-1] if hrefs else "").split("&")[0]
        state["order3Id"] = order3
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        # 3. save the reception with the current form (only the free text)
        page.goto(f"{BASE}/taller/ingreso/?id={order3}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Ingreso y diagnóstico").first.click()
        page.wait_for_timeout(1200)
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI taller - recepcion de prueba con el formulario actual."
        )
        page.get_by_role("button", name="Guardar inspección del ingreso").click()
        page.wait_for_timeout(3500)
        shot(page, "f1-51-recepcion-guardada")
        body = page.inner_text("main")
        note("=== TRAS GUARDAR LA RECEPCION ===")
        note(body[body.find("Kilometraje actual") - 20:body.find("Kilometraje actual") + 90])
        note("PENDIENTES: " + body[body.find("Datos de recepción pendientes") - 20:][:120])
        (OUT / "flow1-odometro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
