"""FLOW 2 step N: open the rental history in the dossier and select ALQ-00018."""
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
        page.wait_for_timeout(1500)
        note("=== HISTORIAL DE ALQUILERES ===")
        note(
            page.evaluate(
                """() => Array.from(document.querySelectorAll('main button, main a, main li')).map(e=>(e.tagName+'|'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,90))).join('\\n')"""
            )
        )
        note("=== TEXTO ===")
        note(page.inner_text("main")[:2500])
        shot(page, "f2-28-historial", full=True)
        (OUT / "flow2-dossier.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
