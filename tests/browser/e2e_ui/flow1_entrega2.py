"""FLOW 1 step T: confirm the delivery review (balance must not block it)."""
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
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Entrega").first.click()
        page.wait_for_timeout(1200)
        if not state.get("delivered"):
            page.get_by_label("Persona que recibe el vehículo").fill("PRUEBA UI taller - receptor")
            page.get_by_label("Evidencia y observaciones de entrega").fill(
                "PRUEBA UI taller - entrega revisada con saldo pendiente"
            )
            page.get_by_label("Autorización de crédito y motivo").fill(
                "PRUEBA UI taller - se entrega con $50.00 pendientes de cobro, autorizado por gerencia"
            )
            box = page.get_by_label("Revisé los datos de recepción pendientes; se conservarán como pendientes en el acta.")
            if box.count():
                box.check()
            page.get_by_role("button", name="Confirmar entrega revisada").click()
            page.wait_for_timeout(3000)
            shot(page, "f1-39-entrega-confirmada")
            body = page.inner_text("main")
            note("=== TRAS CONFIRMAR ENTREGA ===")
            note(body[body.find("Entrega revisada"):][:2500])
            if "Acta" in body:
                state["delivered"] = True
                STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            note("YA ENTREGADO")
        (OUT / "flow1-entrega.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
