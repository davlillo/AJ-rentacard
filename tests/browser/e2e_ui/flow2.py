"""FLOW 2 (Alquiler): customer + reservation creation."""
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
    state = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        # customer
        if not state.get("customerId"):
            page.goto(f"{BASE}/clientes")
            page.wait_for_load_state("networkidle")
            if page.locator("a", has_text="PRUEBA UI alquiler").count() == 0:
                page.get_by_role("button", name="Nuevo cliente").click()
                page.wait_for_timeout(500)
                page.get_by_label("Nombre o razón social").fill("PRUEBA UI alquiler")
                page.get_by_label("Teléfono (opcional)").fill("7000-0002")
                page.get_by_label("Correo electrónico").fill("prueba.ui.alquiler@aj.local")
                page.get_by_role("button", name="Guardar registro").click()
                page.wait_for_timeout(1500)
            href = page.locator("a", has_text="PRUEBA UI alquiler").first.get_attribute("href")
            state["customerId"] = (href or "").split("id=")[-1]
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("CUSTOMER_ID: " + state["customerId"])
        # reservation
        page.goto(f"{BASE}/alquileres/nuevo")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)
        page.get_by_label("Cliente del alquiler").select_option(label="PRUEBA UI alquiler")
        page.get_by_label("Vehículo del alquiler").select_option(label="P-901XYZ · Toyota Hilux")
        page.get_by_label("Entrega prevista").fill("2026-11-22T09:00")
        page.get_by_label("Devolución prevista").fill("2026-11-23T09:00")
        page.get_by_label("Tarifa diaria acordada (USD)").fill("60")
        page.get_by_label("Limpieza posterior (minutos)").fill("30")
        shot(page, "f2-01-nuevo-alquiler")
        page.get_by_role("button", name="Revisar acuerdo", exact=True).click()
        page.wait_for_timeout(1000)
        note("=== REVISAR ACUERDO ===")
        note(page.inner_text("main")[:2500])
        shot(page, "f2-02-revisar")
        page.get_by_role("button", name="Guardar borrador").click()
        page.wait_for_timeout(2500)
        note("=== TRAS GUARDAR BORRADOR ===")
        note(page.inner_text("main")[:2500])
        shot(page, "f2-03-borrador")
        (OUT / "flow2-steps.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
