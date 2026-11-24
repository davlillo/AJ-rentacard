"""Probe the vehicle dossier administration panel."""
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


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}{state['vehicle2Href']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        note("=== ANTES ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main input,main button,main summary')).map(e=>e.tagName+':'+(e.name||'')+':'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)).join('\\n')"
            )
        )
        page.get_by_role("button", name="Administrar vehículo").click()
        page.wait_for_timeout(1500)
        note("=== DESPUES ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main input,main button,main summary')).map(e=>e.tagName+':'+(e.name||'')+':'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)).join('\\n')"
            )
        )
        shot(page, "f1-48-dossier-admin", full=True)
        (OUT / "flow1-dossier-admin.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
