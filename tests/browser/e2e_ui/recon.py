"""Recon: dump the interactive inventory of the key screens."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, body_text, dump, headings, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

ROUTES = ["/inicio", "/taller", "/taller/ingreso", "/alquileres", "/alquileres/nuevo", "/cobros", "/clientes", "/vehiculos"]


def main() -> None:
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        out = []
        for route in ROUTES:
            page.goto(f"{BASE}{route}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(800)
            out.append(f"\n=========== {route} ===========")
            out.append("HEADINGS: " + " / ".join(headings(page)))
            out.append(dump(page))
            shot(page, f"recon{route.replace('/', '_')}")
        Path("test-results/e2e-ui/recon.txt").write_text("\n".join(out), encoding="utf-8")
        print("\n".join(out).encode("ascii", "replace").decode("ascii"))
        print("\nERRORS:", errors)
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
