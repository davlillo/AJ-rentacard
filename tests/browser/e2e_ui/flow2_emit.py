"""FLOW 2 step I: 'Emitir importe a cobrar' modal and issue."""
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
        if not state.get("issued"):
            page.get_by_role("button", name="Cuentas", exact=False).first.click()
            page.wait_for_timeout(1200)
            page.get_by_role("button", name="Emitir importe a cobrar", exact=True).first.click()
            page.wait_for_timeout(2500)
            dlg = page.locator("[role=dialog]")
            note("=== MODAL EMITIR ===")
            note(dlg.inner_text()[:3000] if dlg.count() else "NO DIALOG")
            shot(page, "f2-18-modal-emitir")
            (OUT / "flow2-emitir.txt").write_text("\n".join(STEPS), encoding="utf-8")
            context.close()
            browser.close()
            note("STOP")
            return
        note("=== CUENTAS TRAS EMITIR ===")
        note(page.inner_text("main")[-2200:])
        shot(page, "f2-19-emitido")
        (OUT / "flow2-emitir.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
