"""Branded login layout and real authentication; screenshots never contain credentials."""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    config = dict(line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
                  if line and not line.startswith("#") and "=" in line)
    assert config["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:55321", "AJ local only."
    output = Path("test-results")
    output.mkdir(exist_ok=True)
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        context = browser.new_context(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(30000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto("http://127.0.0.1:3030/inicio")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("heading", name="Ingresar al sistema", exact=True)).to_be_visible()
            expect(page.get_by_role("heading", level=2)).to_contain_text("A toda marcha.")
            for width, height, name in [(1440, 960, "desktop"), (768, 1024, "tablet"), (390, 844, "mobile"), (320, 740, "small-mobile")]:
                page.set_viewport_size({"width": width, "height": height})
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), f"Login overflow: {name}"
                expect(page.get_by_label("Correo electrónico", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="Ingresar", exact=True)).to_be_visible()
                page.screenshot(path=str(output / f"login-{name}.png"), full_page=True)
            password = page.get_by_label("Contraseña", exact=True)
            password.fill("Visibility check only")
            page.get_by_role("button", name="Mostrar contraseña", exact=True).click()
            expect(password).to_have_attribute("type", "text")
            expect(page.get_by_role("button", name="Ocultar contraseña")).to_have_attribute("aria-pressed", "true")
            page.get_by_role("button", name="Ocultar contraseña", exact=True).click()
            expect(password).to_have_attribute("type", "password")
            page.get_by_label("Correo electrónico", exact=True).fill("login-review@aj.local")
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.locator("#aj-login-error")).to_contain_text("No se pudo iniciar sesión")
            expect(page.get_by_role("button", name="Ingresar", exact=True)).to_be_enabled()
            page.get_by_label("Correo electrónico", exact=True).fill(config["AJ_LOCAL_OWNER_EMAIL"])
            password.fill(config["AJ_LOCAL_OWNER_PASSWORD"])
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.get_by_role("heading", name="Resumen del negocio")).to_be_visible(timeout=60000)
            assert not errors, "Login produced browser runtime errors."
            print("PASS: branded login at four sizes, password visibility, invalid credentials and real sign-in.")
        except Exception as error:
            safe = str(error).replace(config["AJ_LOCAL_OWNER_PASSWORD"], "[REDACTED]")
            safe = safe.replace(config["AJ_LOCAL_OWNER_EMAIL"], "[LOCAL USER]")
            raise RuntimeError(safe) from None
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
