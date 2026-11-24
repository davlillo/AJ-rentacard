"""Real UI check: release a returned rental inline from the rental folio.

Writes the release through the real UI (authorized) on the demo rental given by
the ALQ env var (default ALQ-00020). Verifies the folio updates in place.
Never prints credentials or tokens; no SQL, no deletions.
"""
import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20000)
APP = "http://127.0.0.1:3030"
FOLIO = os.environ.get("ALQ", "ALQ-00020")
OUT = Path("test-results/release-inline")
OUT.mkdir(parents=True, exist_ok=True)


def main() -> None:
    config = dict(
        line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-gpu"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(30000)
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. Owner sign-in through the real form.
        page.goto(APP + "/inicio")
        expect(page.get_by_role("heading", name="Ingresar al sistema")).to_be_visible(timeout=120000)
        page.locator("input[type=email]").fill(config["AJ_LOCAL_OWNER_EMAIL"])
        page.locator("input[type=password]").fill(config["AJ_LOCAL_OWNER_PASSWORD"])
        page.get_by_role("button", name="Ingresar", exact=True).click()
        page.wait_for_load_state("networkidle")
        print("PASS: login", flush=True)

        # 2. Open the folio from the rentals list.
        page.goto(APP + "/alquileres")
        row = page.locator("tbody tr").filter(has_text=FOLIO)
        expect(row).to_be_visible(timeout=60000)
        href = row.get_by_role("link", name="Abrir folio").get_attribute("href")
        page.goto(APP + href)
        page.wait_for_load_state("networkidle")
        expect(page.locator("nav").filter(has_text=FOLIO)).to_be_visible()
        pending_label = page.get_by_text(re.compile("pendiente de liberar")).first
        expect(pending_label).to_be_visible()
        page.screenshot(path=str(OUT / "10-folio-before.png"), full_page=True)
        print("PASS: folio shows 'Devuelto - pendiente de liberar' before the release", flush=True)

        # 3. Cierre stage: the release is inline now.
        page.get_by_role("button", name=re.compile("Finalizado:")).click()
        release_panel = page.locator("section", has=page.locator("h2", has_text="Liberar el veh")).first
        expect(release_panel.get_by_text(re.compile("Estado f"))).to_be_visible()
        status_before = release_panel.locator("strong").first.inner_text()
        print("INFO: vehicle status shown before release:", status_before, flush=True)
        release_panel.get_by_label(re.compile("Descripci")).fill(
            "Entrega confirmada en el folio; vehiculo limpio y sin danos.")
        release_panel.get_by_role("button", name=re.compile("Confirmar entrega y liberar el veh")).click()
        dialog = page.locator('section[aria-label^="Confirmaci"]')
        dialog.get_by_role("button", name=re.compile("Confirmar la liberaci")).click()
        notice = page.get_by_text(re.compile("El servidor confirm"))
        try:
            expect(notice).to_be_visible(timeout=20000)
            print("PASS: success feedback states the release was confirmed", flush=True)
        except AssertionError:
            page.screenshot(path=str(OUT / "12b-after-confirm.png"), full_page=True)
            print("INFO: notice not captured verbatim; body snippet follows", flush=True)
            body = page.inner_text("body")
            idx = body.find("liberaci")
            print(body[max(0, idx - 300):idx + 400], flush=True)
        page.screenshot(path=str(OUT / "13-after-confirm.png"), full_page=True)

        # 4. The folio updates in place: no 'pendiente de liberar', vehicle available.
        expect(page.get_by_text(re.compile("pendiente de liberar"))).to_have_count(0, timeout=30000)
        expect(page.get_by_text(re.compile("Alquiler finalizado")).first).to_be_visible()
        status_line = page.locator("dl div").filter(has_text=re.compile("Estado del veh")).first
        expect(status_line).to_contain_text("Disponible")
        page.screenshot(path=str(OUT / "13-folio-after.png"), full_page=True)
        print("PASS: folio now shows 'Alquiler finalizado' and vehicle Disponible, in place", flush=True)

        # 5. Cierre note no longer sends to the dossier.
        expect(page.get_by_text(re.compile("expediente del veh"))).to_have_count(0)

        # 6. Reload hard: the release survives (server-confirmed, not just optimistic).
        page.reload()
        page.wait_for_load_state("networkidle")
        expect(page.get_by_text(re.compile("Alquiler finalizado")).first).to_be_visible(timeout=60000)
        print("PASS: after hard reload the folio still shows the release as confirmed", flush=True)

        if errors:
            print("PAGEERRORS:", errors)
        browser.close()


if __name__ == "__main__":
    main()
