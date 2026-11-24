"""FLOW 2 step L: closing stage (Finalizado) content and document download."""
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
        page.get_by_role("button", name="Finalizado", exact=False).first.click()
        page.wait_for_timeout(1500)
        note("=== ETAPA FINALIZADO ===")
        note(page.inner_text("main")[:3500])
        shot(page, "f2-25-finalizado", full=True)
        # download the client document (PDF) through the real control
        with page.expect_download(timeout=30000) as info:
            page.get_by_role("button", name="Descargar detalle (PDF)").first.click()
        download = info.value
        target = OUT / "screens" / "alquiler-PRUEBA-UI-detalle.pdf"
        target.parent.mkdir(parents=True, exist_ok=True)
        download.save_as(str(target))
        note("PDF GUARDADO: " + str(target) + " (" + str(target.stat().st_size) + " bytes)")
        (OUT / "flow2-final.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
