"""FLOW 1 step X2: set a known odometer on the demo vehicle and reproduce the erasure."""
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
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        hrefs = page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href*=\"/vehiculos/expediente\"]')).map(a=>a.getAttribute('href')+' :: '+a.innerText.replace(/\\s+/g,' ').trim().slice(0,30))"
        )
        note("HREFS: " + json.dumps(hrefs))
        target = [h.split(" ::")[0] for h in hrefs if "PRUEBA-UI-2" in h]
        if not target:
            note("NO SE ENCONTRO PRUEBA-UI-2")
            context.close()
            browser.close()
            return
        page.goto(f"{BASE}{target[0]}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Administrar vehículo").click()
        page.wait_for_timeout(1200)
        km = page.locator("input[name=km]:visible").first
        note("KM ACTUAL: " + str(km.input_value()))
        km.fill("45000")
        page.locator("button:visible", has_text="Guardar").first.click()
        page.wait_for_timeout(2500)
        note("=== TRAS GUARDAR KM ===")
        note(page.inner_text("main")[:700])
        shot(page, "f1-47-km-45000")
        state["vehicle2Href"] = target[0]
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        (OUT / "flow1-odometro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
