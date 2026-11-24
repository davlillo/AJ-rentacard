"""FLOW 2 step P: second rental (ALQ-00019) to exercise the 'Rechazado' extra decision."""
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
        # vehicle status check
        page.goto(f"{BASE}/vehiculos")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        note("=== FLOTA ===")
        note(page.inner_text("main")[:1200])
        # create the second reservation on another fleet vehicle
        page.goto(f"{BASE}/alquileres/nuevo")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)
        page.get_by_label("Cliente del alquiler").select_option(label="PRUEBA UI alquiler")
        page.get_by_label("Vehículo del alquiler").select_option(label="P-778BDE · Nissan Pathfinder")
        page.get_by_label("Entrega prevista").fill("2026-11-22T09:00")
        page.get_by_label("Devolución prevista").fill("2026-11-23T09:00")
        page.get_by_label("Tarifa diaria acordada (USD)").fill("40")
        page.get_by_label("Limpieza posterior (minutos)").fill("30")
        page.get_by_role("button", name="Revisar acuerdo", exact=True).click()
        page.wait_for_timeout(800)
        page.get_by_role("button", name="Guardar borrador").click()
        page.wait_for_timeout(2500)
        page.get_by_role("button", name="Confirmar reserva y abrir folio").click()
        page.wait_for_timeout(4000)
        note("URL: " + page.url)
        note(page.inner_text("main")[:1500])
        shot(page, "f2-32-segunda-reserva")
        state["reservation2Id"] = page.url.split("id=")[-1].split("&")[0]
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        (OUT / "flow2-second.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
