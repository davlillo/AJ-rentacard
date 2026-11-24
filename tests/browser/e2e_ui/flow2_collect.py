"""FLOW 2 step K: collect the pending balance and verify the final state."""
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
        page.goto(f"{BASE}/alquileres/folio/?id={state['reservationId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        if not state.get("collected"):
            page.get_by_role("button", name="Cuentas", exact=False).first.click()
            page.wait_for_timeout(1200)
            page.get_by_role("button", name="Cobrar saldo pendiente").click()
            page.wait_for_timeout(1500)
            dlg = page.locator("[role=dialog]")
            note("=== MODAL COBRO ===")
            note(dlg.inner_text()[:2500] if dlg.count() else "NO DIALOG")
            shot(page, "f2-21-modal-cobro")
            amount = dlg.get_by_label("Importe recibido (USD)")
            amount.fill("60")
            dlg.get_by_label("Cuenta o caja receptora").fill("Caja principal")
            dlg.get_by_label("Referencia del pago").fill("PRUEBA UI alquiler - cobro del alquiler")
            page.wait_for_timeout(400)
            shot(page, "f2-22-cobro-lleno")
            dlg.get_by_role("button", name="Guardar cobro y aplicar al documento").click()
            page.wait_for_timeout(4000)
            shot(page, "f2-23-cobrado")
            state["collected"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        page.wait_for_timeout(1000)
        note("=== ESTADO FINAL ===")
        note(page.inner_text("main")[:3000])
        note("=== BOTONES ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button, main summary')).map(e=>e.tagName+':'+(e.getAttribute('aria-label')||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80)).join('\\n')"
            )
        )
        shot(page, "f2-24-final")
        (OUT / "flow2-cobro.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
