"""FLOW 1 step W: reproduce the broken workshop reception (intake inspection)."""
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
        if not state.get("order2Id"):
            page.goto(f"{BASE}/taller")
            page.wait_for_load_state("networkidle")
            page.get_by_role("button", name="Nueva entrada").click()
            page.wait_for_timeout(800)
            page.get_by_label("Cliente del trabajo").select_option(label="PRUEBA UI taller")
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(700)
            page.get_by_label("Vehículo del cliente").select_option(
                label="Registrar vehículo nuevo con la entrada"
            )
            page.wait_for_timeout(600)
            page.get_by_label("Placa (si se conoce)").fill("PRUEBA-UI-2")
            page.get_by_label("Marca").fill("Toyota")
            page.get_by_label("Modelo").fill("Prueba Recepcion")
            page.get_by_label("Año").fill("2021")
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(800)
            page.get_by_label("Motivo del ingreso").fill("PRUEBA UI taller - prueba de recepcion")
            page.get_by_role("button", name="Crear folio OT").click()
            page.wait_for_timeout(3000)
            hrefs = page.evaluate(
                "() => Array.from(document.querySelectorAll('a[href*=\"taller/ingreso\"]')).map(a => a.getAttribute('href'))"
            )
            state["order2Id"] = (hrefs[0].split("id=")[-1] if hrefs else "").split("&")[0]
            state["vehicle2Plate"] = "PRUEBA-UI-2"
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            shot(page, "f1-44-ot38-creado")
        note("ORDER2: " + state["order2Id"])
        page.goto(f"{BASE}/taller/ingreso/?id={state['order2Id']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Ingreso y diagnóstico").first.click()
        page.wait_for_timeout(1200)
        note("=== FORMULARIO DE RECEPCION (ACTUAL) ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main label')).map(l=>l.outerHTML.replace(/\\s+/g,' ').slice(0,220)).join('\\n')"
            )
        )
        shot(page, "f1-45-recepcion-actual")
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI taller - recepcion de prueba, sin danos visibles."
        )
        page.get_by_role("button", name="Guardar inspección del ingreso").click()
        page.wait_for_timeout(3000)
        note("=== RESULTADO DE GUARDAR LA INSPECCION (SIN KILOMETRAJE NI COMBUSTIBLE) ===")
        note(page.inner_text("main")[-1600:])
        shot(page, "f1-46-recepcion-error")
        (OUT / "flow1-recepcion.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
