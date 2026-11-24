"""FLOW 1 step V2: classify cost A (included) and cost B (absorbed)."""
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


def classify(page, cost_label, disposition, estimate_label, reason):
    page.locator("button:visible", has_text=cost_label).first.click()
    page.wait_for_timeout(900)
    page.locator("summary:visible", has_text="Revisar relación con el presupuesto").first.click()
    page.wait_for_timeout(700)
    form = page.locator("form:visible", has=page.locator("select[aria-label='Relación con el presupuesto']")).last
    form.locator("select[aria-label='Relación con el presupuesto']").select_option(label=disposition)
    page.wait_for_timeout(400)
    if estimate_label:
        form.locator("select[aria-label='Presupuesto aprobado de este trabajo']").select_option(
            label=estimate_label
        )
    form.locator("input[name=reason]").fill(reason)
    page.wait_for_timeout(300)
    form.get_by_role("button", name="Guardar relación con el presupuesto").click()
    page.wait_for_timeout(2500)


def main() -> None:
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/taller/ingreso/?id={state['orderId']}")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Trabajo y costos reales").first.click()
        page.wait_for_timeout(900)
        page.get_by_role("button", name="Costos reales y gastos pagados").click()
        page.wait_for_timeout(1500)
        if not state.get("costAclassified"):
            classify(
                page,
                "PRUEBA UI taller - repuesto original",
                "Incluido",
                "PRE-00019 · Versión 1",
                "PRUEBA UI taller - repuesto incluido en el alcance aprobado",
            )
            shot(page, "f1-42-costoA-incluido")
            state["costAclassified"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        if not state.get("costBclassified"):
            classify(
                page,
                "PRUEBA UI taller - filtro",
                "Absorbido",
                None,
                "PRUEBA UI taller - filtro absorbido por el taller, no se cobra al cliente",
            )
            shot(page, "f1-43-costoB-absorbido")
            state["costBclassified"] = True
            STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        note("=== ESTADO COSTOS ===")
        note(page.inner_text("main")[page.inner_text("main").find("Costos registrados"):][:1800])
        (OUT / "flow1-disposition.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
