"""Verify the workshop fixes through the UI: reception readings, single navigation, no raw ids."""
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
        # --- new demo vehicle + order to exercise the reception form ---
        if not state.get("order4Id"):
            page.goto(f"{BASE}/taller")
            page.wait_for_load_state("networkidle")
            page.get_by_role("button", name="Nueva entrada").click()
            page.wait_for_timeout(900)
            page.get_by_label("Cliente del trabajo").select_option(label="PRUEBA UI taller")
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(800)
            page.get_by_label("Vehículo del cliente").select_option(
                label="Registrar vehículo nuevo con la entrada"
            )
            page.wait_for_timeout(600)
            page.get_by_label("Placa (si se conoce)").fill("PRUEBA-UI-4")
            page.get_by_label("Marca").fill("Toyota")
            page.get_by_label("Modelo").fill("Prueba Lectura")
            page.get_by_label("Año").fill("2023")
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(800)
            page.get_by_label("Motivo del ingreso").fill("PRUEBA UI taller - lecturas de recepcion")
            page.get_by_role("button", name="Crear folio OT").click()
            page.wait_for_timeout(3000)
            hrefs = page.evaluate(
                "() => Array.from(document.querySelectorAll('a[href*=\"taller/ingreso\"]')).map(a => a.getAttribute('href'))"
            )
            state["order4Id"] = sorted({h.split("id=")[-1].split("&")[0] for h in hrefs})[-1]
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            shot(page, "f1-60-ot-nuevo")
        note("ORDER4: " + state["order4Id"])
        page.goto(f"{BASE}/taller/ingreso/?id={state['order4Id']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1800)
        note("=== NAVEGACION DEL FOLIO ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main nav, main ol')).map(n=>n.getAttribute('aria-label')+' :: '"
                " + Array.from(n.querySelectorAll('button')).map(b=>(b.getAttribute('aria-label')||b.innerText).replace(/\\s+/g,' ').trim()).join(' | ')).join('\\n')"
            )
        )
        shot(page, "f1-61-navegacion")
        # --- reception with the readings ---
        page.get_by_role("button", name="Ingreso y diagnóstico").first.click()
        page.wait_for_timeout(1200)
        note("=== FORMULARIO DE RECEPCION ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main label')).map(l=>l.outerHTML.replace(/\\s+/g,' ').slice(0,160)).join('\\n')"
            )
        )
        shot(page, "f1-62-recepcion-nueva")
        page.get_by_label("Kilometraje de ingreso (km)").fill("45120")
        page.get_by_label("Combustible de ingreso (%)").fill("70")
        page.get_by_label("Accesorios de ingreso").fill("PRUEBA UI taller - llave de repuesto yaires")
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI taller - unidad sin danos, documentos y herramientas a la vista."
        )
        page.get_by_role("button", name="Guardar inspección del ingreso").click()
        page.wait_for_timeout(3500)
        shot(page, "f1-63-recepcion-guardada")
        body = page.inner_text("main")
        note("=== LECTURAS REGISTRADAS ===")
        note(body[body.find("Inspección de ingreso"):body.find("Inspección de ingreso") + 600])
        # --- summary: price of the approved scope ---
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1500)
        body = page.inner_text("main")
        note("=== RESUMEN (IMPORTES) ===")
        note(body[body.find("Importes de este trabajo"):body.find("Importes de este trabajo") + 900])
        note("=== PENDIENTES DE RECEPCION ===")
        note(body[body.find("Datos de recepción pendientes") - 5:][:120])
        shot(page, "f1-64-resumen")
        (OUT / "verify-workshop.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
