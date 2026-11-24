"""FLOW 2 step O: select the rental in the dossier and release the vehicle."""
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
        page.goto(f"{BASE}/vehiculos/expediente/?id=888dfc48-c520-491e-a307-db67c748571e")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="Historial de alquileres").click()
        page.wait_for_timeout(1200)
        page.get_by_role("button", name="Ver detalle").first.click()
        page.wait_for_timeout(2000)
        note("=== RESUMEN DEL ALQUILER EN EL EXPEDIENTE ===")
        note(page.inner_text("main")[-3000:])
        shot(page, "f2-29-scoped", full=True)
        if not state.get("released"):
            box = page.get_by_label("Descripción de la entrega y la condición del vehículo")
            if box.count():
                box.fill(
                    "PRUEBA UI alquiler - vehículo devuelto en el taller con el rayón informado en la devolución."
                )
                page.get_by_role("button", name="Confirmar entrega y liberar el vehículo").click()
                page.wait_for_timeout(1500)
                note("=== CONFIRMACION ===")
                note(page.inner_text("main")[-1800:])
                shot(page, "f2-30-confirmacion-liberacion")
                page.get_by_role("button", name="Confirmar la liberación del vehículo").click()
                page.wait_for_timeout(4000)
                shot(page, "f2-31-liberado")
                state["released"] = True
                STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            else:
                note("NO HAY FORMULARIO DE LIBERACION")
        note("=== TRAS LIBERAR ===")
        note(page.inner_text("main")[-2000:])
        (OUT / "flow2-release2.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
