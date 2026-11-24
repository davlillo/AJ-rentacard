"""Probe the vehicle dossier for the rental selection and the release review."""
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
        page.goto(f"{BASE}/vehiculos")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        href = page.evaluate(
            """() => {const a=Array.from(document.querySelectorAll('a[href*="/vehiculos/expediente"]')).find(x=>x.getAttribute('href'));return a?a.getAttribute('href'):null;}"""
        )
        note("HREF: " + str(href))
        page.goto(f"{BASE}{href}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== ELEMENTOS CLICKEABLES CON ALQ ===")
        note(
            page.evaluate(
                """() => Array.from(document.querySelectorAll('button,a,li,[role=button]')).map(e=>(e.tagName+'|'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,70))).filter(x=>/ALQ|Prueba|alquiler/i.test(x)).join('\\n')"""
            )
        )
        note("=== SCOPED SUMMARY? ===")
        note(str(page.locator("[data-testid=scoped-summary]").count()))
        shot(page, "f2-27-dossier-completo", full=True)
        (OUT / "flow2-dossier.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
