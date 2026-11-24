"""Re-verify the fixes through the UI: workshop folio and rental folio."""
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
        # --- workshop folio OT-37 ---
        page.goto(f"{BASE}/taller/ingreso/?id=OT-37")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1800)
        note("=== NAVEGACION UNICA DEL FOLIO ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main nav, main section[aria-label=\"Fases del trabajo\"]')).map(n=>"
                "(n.getAttribute('aria-label')||'nav')+' :: '+Array.from(n.querySelectorAll('button')).map(b=>"
                "(b.getAttribute('aria-label')||b.innerText).replace(/\\s+/g,' ').trim()).join(' | ')).join('\\n')"
            )
        )
        page.get_by_role("button", name="Resumen").first.click()
        page.wait_for_timeout(1500)
        body = page.inner_text("main")
        note("=== IMPORTES (ALCANCE APROBADO) ===")
        note(body[body.find("Importes de este trabajo"):body.find("Importes de este trabajo") + 900])
        shot(page, "v-01-ot37-resumen")
        page.get_by_role("button", name="Entrega").first.click()
        page.wait_for_timeout(1500)
        body = page.inner_text("main")
        note("=== ENTREGA (SIN IDENTIFICADORES INTERNOS) ===")
        note(body[body.find("Entrega revisada"):body.find("Entrega revisada") + 1200])
        shot(page, "v-02-ot37-entrega")
        # --- rental folio ALQ-00018 ---
        page.goto(f"{BASE}/alquileres/folio/?id=7f676707-2f14-457b-b2a9-0997214edc92")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        note("=== ALQUILER: BOTONES DE LA CABECERA Y DE CUENTAS ===")
        note(
            page.evaluate(
                "() => Array.from(document.querySelectorAll('main button')).map(b=>"
                "(b.getAttribute('aria-label')||b.innerText).replace(/\\s+/g,' ').trim()).filter(Boolean).join(' | ')"
            )
        )
        note("=== JERGA ===")
        note(
            page.evaluate(
                "() => {const text=document.body.innerText;const hits=['cargo','abono','limpieza'].filter(w=>new RegExp(w,'i').test(text));return hits.join(', ')||'sin jerga';}"
            )
        )
        page.get_by_role("button", name="Cuentas", exact=False).first.click()
        page.wait_for_timeout(1500)
        shot(page, "v-03-alq18-cuentas")
        page.get_by_role("button", name="Realizar cobro", exact=True).click()
        page.wait_for_timeout(2000)
        note("=== DIALOGO DE COBRO (PALABRAS PLANAS) ===")
        note(page.locator("[role=dialog]").inner_text()[:1200])
        shot(page, "v-04-alq18-cobro")
        page.keyboard.press("Escape")
        # --- rental ALQ-00019: rejected extra ---
        page.goto(f"{BASE}/alquileres")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        href = page.evaluate(
            "() => {const rows=Array.from(document.querySelectorAll('a[href*=\"alquileres/folio\"]'));"
            "const row=rows.find(a=>a.closest('tr')?.innerText?.includes('ALQ-00019'));return row?row.getAttribute('href'):null;}"
        )
        note("ALQ19 HREF: " + str(href))
        if href:
            page.goto(f"{BASE}{href}")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1800)
            page.get_by_role("button", name="Devolución", exact=False).first.click()
            page.wait_for_timeout(1500)
            page.locator("summary:visible", has_text="Diferencias detectadas").first.click()
            page.wait_for_timeout(600)
            body = page.inner_text("main")
            note("=== EXTRA RECHAZADO ===")
            note(body[body.find("Diferencias detectadas"):body.find("Diferencias detectadas") + 700])
            shot(page, "v-05-alq19-extra")
        (OUT / "verify-fixes.txt").write_text("\n".join(STEPS), encoding="utf-8")
        note("ERRORS: " + str(errors))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
