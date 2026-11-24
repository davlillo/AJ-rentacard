"""FLOW 2 step Q: ALQ-00019 departure, return with difference and 'Rechazado' extra."""
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
    rid = state["reservation2Id"]
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/alquileres/folio/?id={rid}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        # departure
        page.get_by_role("button", name="Entregar vehículo").click()
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Iniciar salida").click()
        page.wait_for_timeout(1000)
        km = page.get_by_label("Kilometraje (km)")
        base = int(km.get_attribute("min") or 0)
        km.fill(str(base + 60))
        page.get_by_label("Combustible (%)").fill("80")
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI alquiler - salida del segundo alquiler, vehículo completo."
        )
        page.get_by_role("button", name="Registrar entrega").click()
        page.wait_for_timeout(1200)
        page.get_by_role("button", name="Confirmar salida").click()
        page.wait_for_timeout(3500)
        shot(page, "f2-33-segunda-salida")
        note("=== TRAS SALIDA 2 ===")
        note(page.inner_text("main")[-900:])
        # return
        page.get_by_role("button", name="Iniciar devolución").click()
        page.wait_for_timeout(1000)
        page.get_by_label("Kilometraje (km)").fill(str(base + 130))
        page.get_by_label("Combustible (%)").fill("70")
        page.get_by_label("Revisión general del vehículo (360°)").fill(
            "PRUEBA UI alquiler - devolución del segundo alquiler, sin daños nuevos."
        )
        page.get_by_role("button", name="Registrar devolución").click()
        page.wait_for_timeout(1200)
        page.get_by_role("button", name="Confirmar devolución").click()
        page.wait_for_timeout(4000)
        shot(page, "f2-34-segunda-devolucion")
        # decide the extra as rejected
        page.get_by_role("button", name="Devolución", exact=False).first.click()
        page.wait_for_timeout(1500)
        page.locator("summary:visible", has_text="Diferencias detectadas").first.click()
        page.wait_for_timeout(700)
        note("=== EXTRAS 2 ===")
        note(page.inner_text("main")[-1200:])
        form = page.locator("form:visible", has=page.locator("select[aria-label='Decisión del extra']")).last
        form.locator("select[aria-label='Decisión del extra']").select_option("Rechazado")
        form.locator("input[name=amount]").fill("")
        form.locator("input[name=reason]").fill(
            "PRUEBA UI alquiler - diferencia de combustible ya incluida en el alquiler, no se cobra"
        )
        form.get_by_role("button", name="Guardar decisión del extra").click()
        page.wait_for_timeout(3000)
        shot(page, "f2-35-extra-rechazado")
        note("=== EXTRAS TRAS RECHAZAR ===")
        note(page.inner_text("main")[-1200:])
        (OUT / "flow2-second.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
