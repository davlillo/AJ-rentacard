"""FLOW 1 step X3: set the odometer through the folio and reproduce the erasure."""
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
        # 1. set the odometer of PRUEBA-UI-2 through the folio registry form
        page.goto(f"{BASE}/taller/ingreso/?id={state['order2Id']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1200)
        page.locator("summary:visible", has_text="Completar o corregir datos").first.click()
        page.wait_for_timeout(600)
        km = page.locator("input[name=km]:visible").first
        note("KM FORM VALUE: " + str(km.input_value()))
        km.fill("45000")
        page.locator("textarea[name=reason]:visible").first.fill(
            "PRUEBA UI taller - se confirma el odometro de la prueba de recepcion"
        )
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button')).map(e=>(e.innerText||e.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim()).filter(Boolean).join(' | ')"
            )
        )
        page.locator("main form button[type=submit]:visible").last.click()
        page.wait_for_timeout(2500)
        shot(page, "f1-49-km-confirmado")
        note("=== RESUMEN TRAS GUARDAR KM ===")
        note(page.inner_text("main")[page.inner_text("main").find("Kilometraje actual") - 40:][:200])
        # 2. new work order for the same vehicle
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="Nueva entrada").click()
        page.wait_for_timeout(900)
        page.get_by_label("Cliente del trabajo").select_option(label="PRUEBA UI taller")
        page.get_by_role("button", name="Continuar").click()
        page.wait_for_timeout(800)
        page.get_by_label("Vehículo del cliente").select_option(
            label="Seleccionar vehículo registrado"
        )
        page.wait_for_timeout(500)
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('select')).map(s=>s.getAttribute('aria-label')+': '+Array.from(s.options).map(o=>o.text).join(' / ')).join(' || ')"
            )
        )
        page.get_by_label("Vehículo registrado del taller").select_option(
            label="PRUEBA-UI-2 · Toyota Prueba Recepcion"
        )
        page.wait_for_timeout(400)
        page.get_by_role("button", name="Continuar").click()
        page.wait_for_timeout(800)
        page.get_by_label("Motivo del ingreso").fill("PRUEBA UI taller - odometro de la unidad")
        page.get_by_role("button", name="Crear folio OT").click()
        page.wait_for_timeout(3000)
        hrefs = page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href*=\"taller/ingreso\"]')).map(a => a.getAttribute('href'))"
        )
        note("ORDENES: " + json.dumps(hrefs))
        (OUT / "flow1-odometro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
