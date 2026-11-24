"""Discovery of dialogs: nuevo cliente, nueva entrada taller, registrar vehiculo de cliente."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, dump, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402


def main() -> None:
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        out = []

        page.goto(f"{BASE}/clientes")
        page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="Nuevo cliente").click()
        page.wait_for_timeout(700)
        out.append("=== DIALOG NUEVO CLIENTE ===")
        out.append(dump(page))
        shot(page, "disc-cliente-dialog")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="Nueva entrada").click()
        page.wait_for_timeout(900)
        out.append("=== DIALOG NUEVA ENTRADA ===")
        out.append(dump(page))
        shot(page, "disc-entrada-dialog")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        page.get_by_role("button", name="Registrar vehículo de cliente").click()
        page.wait_for_timeout(900)
        out.append("=== DIALOG REGISTRAR VEHICULO CLIENTE ===")
        out.append(dump(page))
        shot(page, "disc-vehiculo-dialog")

        Path("test-results/e2e-ui/discovery.txt").write_text("\n".join(out), encoding="utf-8")
        print("\n".join(out).encode("ascii", "replace").decode("ascii"))
        print("ERRORS:", errors)
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
