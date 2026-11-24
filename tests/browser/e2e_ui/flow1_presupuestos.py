"""Inspect the budget editor screens (presupuestos)."""
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
        for url in ["/presupuestos/?trabajo=OT-37", "/presupuestos/"]:
            page.goto(f"{BASE}{url}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1200)
            note(f"\n########## {url} ##########")
            note(dump(page))
            note("--- TEXT ---")
            note(page.inner_text("main")[:4000])
            shot(page, "f1-presupuestos-" + str(abs(hash(url)) % 1000))
        (OUT / "flow1-presupuestos.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
