"""Final sanity pass over both folios after the fixes."""
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
        for route, label in [("/taller/ingreso/?id=OT-37", "taller"),
                             ("/taller/ingreso/?id=OT-40", "taller-recepcion"),
                             ("/alquileres/folio/?id=7f676707-2f14-457b-b2a9-0997214edc92", "alquiler"),
                             ("/cobros", "cobros"),
                             ("/clientes", "clientes"),
                             ("/vehiculos", "vehiculos")]:
            page.goto(f"{BASE}{route}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1500)
            body = page.inner_text("main")
            note(f"=== {route} ({len(body)} chars) ===")
            note(body[:700])
            shot(page, f"final-{label}", full=True)
        (OUT / "final-pass.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("BROWSER ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
