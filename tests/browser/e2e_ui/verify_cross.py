"""Cross-cutting checks: fleet status, /cobros rows, client document amounts."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, dump, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path("test-results/e2e-ui")
STEPS: list[str] = []


def note(text: str) -> None:
    STEPS.append(text)
    print(text.encode("ascii", "replace").decode("ascii"))


def main() -> None:
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/vehiculos")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        note("=== FLOTA ===")
        note(page.inner_text("main")[:1200])
        shot(page, "v-06-flota", full=True)
        page.goto(f"{BASE}/cobros")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== COBROS (TALLER Y ALQUILER) ===")
        note(page.inner_text("main")[:2500])
        shot(page, "v-07-cobros", full=True)
        (OUT / "verify-cross.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
