"""FLOW 2 step H: decide the extra (approved with an amount)."""
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
        page.goto(f"{BASE}/alquileres/folio/?id={state['reservationId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="Devolución").first.click()
        page.wait_for_timeout(1200)
        if not state.get("extraDecided"):
            page.locator("summary:visible", has_text="Diferencias detectadas").first.click()
            page.wait_for_timeout(700)
            note("=== EXTRAS ===")
            note(page.inner_text("main")[-1600:])
            shot(page, "f2-16-extra-form")
            form = page.locator("form:visible", has=page.locator("select[aria-label='Decisión del extra']")).last
            form.locator("select[aria-label='Decisión del extra']").select_option("Aprobado")
            form.locator("input[name=amount]").fill("25")
            form.locator("input[name=reason]").fill(
                "PRUEBA UI alquiler - rayón en guardafango y tapa de depósito faltante, acordado con el cliente"
            )
            form.get_by_role("button", name="Guardar decisión del extra").click()
            page.wait_for_timeout(3000)
            shot(page, "f2-17-extra-aprobado")
            state["extraDecided"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== EXTRAS TRAS DECIDIR ===")
        note(page.inner_text("main")[-1400:])
        (OUT / "flow2-extra.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
