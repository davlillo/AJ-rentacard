"""FLOW 2 step C: confirm the reservation in the folio, then inspect the stages."""
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
        if not state.get("confirmed"):
            page.goto(f"{BASE}/alquileres/folio/?id=7f676707-2f14-457b-b2a9-0997214edc92")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(2000)
            page.get_by_role("button", name="Confirmar reserva").click()
            page.wait_for_timeout(3500)
            shot(page, "f2-06-confirmada")
            state["confirmed"] = True
            state["reservationId"] = "7f676707-2f14-457b-b2a9-0997214edc92"
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        page.goto(f"{BASE}/alquileres/folio/?id={state['reservationId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== FOLIO CONFIRMADO ===")
        note(page.inner_text("main")[:3000])
        note("=== BOTONES ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button, main a, main summary')).map(e=>e.tagName+':'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)).join('\\n')"
            )
        )
        shot(page, "f2-07-folio-confirmado")
        (OUT / "flow2-steps.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
