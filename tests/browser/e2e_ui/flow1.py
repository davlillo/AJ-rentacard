"""FLOW 1 (Taller) state machine, resumable via test-results/e2e-ui/flow1-state.json."""
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


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    state = load_state()
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)

        # ---------- Step 1: customer ----------
        page.goto(f"{BASE}/clientes")
        page.wait_for_load_state("networkidle")
        if not state.get("customerId"):
            if page.locator("a", has_text="PRUEBA UI taller").count() == 0:
                page.get_by_role("button", name="Nuevo cliente").click()
                page.wait_for_timeout(500)
                page.get_by_label("Nombre o razón social").fill("PRUEBA UI taller")
                page.get_by_label("Teléfono (opcional)").fill("7000-0001")
                page.get_by_label("DUI / NIT").fill("0000-1111-2222-3")
                page.get_by_label("Correo electrónico").fill("prueba.ui.taller@aj.local")
                shot(page, "f1-01-nuevo-cliente")
                page.get_by_role("button", name="Guardar registro").click()
                page.wait_for_timeout(1500)
            href = page.locator("a", has_text="PRUEBA UI taller").first.get_attribute("href")
            state["customerId"] = (href or "").split("id=")[-1]
            save_state(state)
        note("CUSTOMER_ID: " + state["customerId"])
        shot(page, "f1-02-cliente-creado")

        # ---------- Step 2: intake ----------
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        if not state.get("orderId"):
            page.get_by_role("button", name="Nueva entrada").click()
            page.wait_for_timeout(800)
            page.get_by_label("Cliente del trabajo").select_option(label="PRUEBA UI taller")
            page.wait_for_timeout(300)
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(700)
            note("=== INTAKE STEP 2 ===")
            note(dump(page))
            page.get_by_label("Vehículo del cliente").select_option(
                label="Registrar vehículo nuevo con la entrada"
            )
            page.wait_for_timeout(600)
            note("=== INTAKE STEP 2 (nuevo vehiculo) ===")
            note(dump(page))
            shot(page, "f1-03-intake-vehiculo-nuevo")
            page.get_by_label("Placa (si se conoce)").fill(state.get("plate", "PRUEBA-UI-1"))
            page.get_by_label("Marca").fill("Toyota")
            page.get_by_label("Modelo").fill("Prueba Taller")
            page.get_by_label("Año").fill("2020")
            page.get_by_label("Color (opcional)").fill("Blanco")
            page.get_by_role("button", name="Continuar").click()
            page.wait_for_timeout(800)
            note("=== INTAKE STEP 3 ===")
            note(dump(page))
            shot(page, "f1-04-intake-servicio")
            page.get_by_label("Motivo del ingreso").fill("PRUEBA UI taller - revision general")
            page.get_by_role("button", name="Crear folio OT").click()
            page.wait_for_timeout(2500)
            shot(page, "f1-05-folio-creado")
            note("=== TRAS CREAR FOLIO ===")
            note(dump(page))
            hrefs = page.evaluate(
                "() => Array.from(document.querySelectorAll('a[href*=\"taller/ingreso\"]')).map(a => a.getAttribute('href'))"
            )
            note("ORDER HREFS: " + json.dumps(hrefs))
            if hrefs:
                state["orderId"] = hrefs[0].split("id=")[-1]
                save_state(state)
                note("ORDER_ID: " + state["orderId"])
            (OUT / "flow1-steps.txt").write_text("\n".join(STEPS), encoding="utf-8")
            context.close()
            browser.close()
            note("STOP: creado folio")
            return
        note("ORDER_ID: " + state["orderId"])
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        note("=== FOLIO OT-37 ===")
        note(dump(page))
        note("=== TEXTO ===")
        note(page.inner_text("main")[:6000])
        shot(page, "f1-06-folio-ot37")
        (OUT / "flow1-steps.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
