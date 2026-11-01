"""Real technician session: direct cash/assistant/configuration URLs stay denied."""
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


def main() -> None:
    config = dict(line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
                  if line and not line.startswith("#") and "=" in line)
    assert config["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:55321", "AJ local only."
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        page = browser.new_page()
        try:
            page.goto("http://127.0.0.1:3030/inicio")
            page.wait_for_load_state("networkidle")
            page.get_by_label("Correo electrónico").fill(os.environ["AJ_TEST_TECH_EMAIL"])
            page.get_by_label("Contraseña", exact=True).fill(os.environ["AJ_TEST_TECH_PASSWORD"])
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.get_by_role("heading", name="Resumen del negocio")).to_be_visible(timeout=60000)
            for route in ("/cobros", "/libro-diario", "/asistente", "/configuracion", "/archivos",
                          "/vehiculos/expediente?id=unauthorized", "/taller/ingreso?id=unauthorized",
                          "/vehiculos/alquiler?id=unauthorized", "/vehiculos/reservas", "/vehiculos/bloqueos"):
                page.goto("http://127.0.0.1:3030" + route)
                page.wait_for_load_state("networkidle")
                expect(page.get_by_role("heading", name="Acceso restringido")).to_be_visible()
            page.goto("http://127.0.0.1:3030/tareas")
            expect(page.get_by_role("heading", name="Tareas de taller")).to_be_visible()
            print("PASS: technician direct cash, ledger, assistant and administration URLs denied; assigned-task route allowed.")
        except Exception:
            raise RuntimeError("Technician browser authorization check failed; credentials redacted.") from None
        finally:
            browser.close()


if __name__ == "__main__":
    main()
