"""Dump every section of the workshop folio (read-only inspection)."""
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
    order_id = json.loads((OUT / "flow1-state.json").read_text(encoding="utf-8"))["orderId"]
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/taller/ingreso/?id={order_id}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        for label in [
            "Ingreso y diagnóstico",
            "Costos previstos y presupuesto",
            "Trabajo y costos reales",
            "Cobros",
            "Entrega",
            "Fotos y documentos",
        ]:
            btn = page.get_by_role("button", name=label, exact=False).first
            if btn.count() == 0:
                note(f"### NO BUTTON {label}")
                continue
            btn.click()
            page.wait_for_timeout(1200)
            note(f"\n########## SECTION {label} ##########")
            note(dump(page))
            shot(page, "f1-sec-" + label.split()[0].lower())
        (OUT / "flow1-sections.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
