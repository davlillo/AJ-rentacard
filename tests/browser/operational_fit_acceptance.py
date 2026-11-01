"""Real browser acceptance for connected cases; synthetic records are retained for audit."""
import base64
import hashlib
import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright


ROOT = "http://127.0.0.1:3030"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def main() -> None:
    config = dict(line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
                  if "=" in line and not line.startswith("#"))
    api = config["NEXT_PUBLIC_SUPABASE_URL"]
    assert api == "http://127.0.0.1:55321", "AJ local only."
    key = config["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]

    def request(path: str, payload: dict, token: str | None = None):
        headers = {"Content-Type": "application/json", "apikey": key}
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            with urlopen(Request(api + path, json.dumps(payload).encode(), headers), timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            detail = json.load(error)
            raise AssertionError(detail.get("message", "Local API request failed")) from None

    session = request("/auth/v1/token?grant_type=password", {
        "email": config["AJ_LOCAL_OWNER_EMAIL"], "password": config["AJ_LOCAL_OWNER_PASSWORD"]})
    token = session["access_token"]

    def command(function: str, action: str, payload: dict):
        return request("/rest/v1/rpc/" + function, {
            "command": action, "payload": payload, "idempotency_key": str(uuid.uuid4())}, token)

    run = uuid.uuid4().hex[:10]
    customer = command("execute_command", "create_customer", {
        "name": "Browser acceptance " + run, "phone": str(random.randint(10000000, 99999999)), "type": "Personal"})
    common = {"brand": "Nissan", "model": "Rogue", "year": 2018, "category": "SUV", "color": "White", "daily": "40", "km": "0"}
    client_car = command("execute_command", "create_vehicle", {
        **common, "plate": "CLIENT-" + run, "ownership": "Cliente", "ownerCustomerId": customer["id"], "inRentalFleet": False})
    fleet_car = command("execute_command", "create_vehicle", {
        **common, "plate": "FLEET-" + run, "ownership": "Propio", "inRentalFleet": True})
    job = command("execute_command", "receive_vehicle", {
        "vehicleId": client_car["id"], "customerId": customer["id"], "area": "Pintura", "service": "Browser workbook acceptance " + run})
    today = datetime.now(timezone(timedelta(hours=-6))).date().isoformat()
    booking = command("execute_reservation_command", "create", {
        "vehicleId": fleet_car["id"], "customerId": customer["id"], "startsAt": today + "T00:00:00-06:00",
        "openEnded": True, "dailyRate": "40", "cleaningMinutes": 30})
    grouped_car = command("execute_command", "create_vehicle", {
        **common, "plate": "GROUP-" + run, "ownership": "Propio", "inRentalFleet": True})
    grouped_booking = command("execute_reservation_command", "create", {
        "vehicleId": grouped_car["id"], "customerId": customer["id"], "startsAt": today + "T00:00:00-06:00",
        "openEnded": True, "dailyRate": "40", "cleaningMinutes": 30})
    cash = "Browser cash " + run
    screenshot_dir = Path("test-results")
    screenshot_dir.mkdir(exist_ok=True)
    expect.set_options(timeout=30000)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def save(function: str, action: str | None, button: str, root=None):
            def matches(response):
                if not response.url.endswith("/rpc/" + function) or response.request.method != "POST":
                    return False
                return action is None or response.request.post_data_json.get("command") == action
            with page.expect_response(matches) as response:
                (page if root is None else root).get_by_role("button", name=button, exact=True).click()
            result = response.value.json()
            assert response.value.ok, str(result)
            return result

        def tab(name: str):
            page.get_by_role("button", name=name, exact=True).click()

        def approve_quote(price: str, revision: int):
            if revision > 1:
                page.locator("summary").filter(has_text="Preparar presupuesto o revisión completa").click()
                page.get_by_role("button", name=f"Copiar V{revision - 1} como base", exact=True).click()
            page.get_by_label("Descripción de partida 1", exact=True).fill("Full approved repair scope")
            page.get_by_label("Clase de partida 1", exact=True).select_option("Trabajo")
            page.get_by_label("Cantidad · 1", exact=True).fill("1")
            page.get_by_label("Precio unitario USD · 1", exact=True).fill(price)
            page.get_by_label("Motivo y alcance de esta versión", exact=True).fill(f"Reviewed complete scope V{revision}")
            quote = save("execute_case_command", "quote", f"Guardar versión {revision} sin modificar anteriores")
            page.get_by_label("Persona que decide el alcance", exact=True).fill("Synthetic customer")
            page.get_by_label("Evidencia de aceptación o rechazo", exact=True).fill("Written approval for complete scope")
            save("execute_estimate_command", "approve", "Registrar decisión con evidencia")
            return quote

        try:
            page.goto(ROOT, wait_until="networkidle")
            page.get_by_label("Correo electrónico", exact=True).fill(config["AJ_LOCAL_OWNER_EMAIL"])
            page.get_by_label("Contraseña", exact=True).fill(config["AJ_LOCAL_OWNER_PASSWORD"])
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.get_by_role("heading", name="Resumen del negocio", exact=True)).to_be_visible()

            page.goto(ROOT + "/vehiculos", wait_until="networkidle")
            page.get_by_label("Buscar vehículo", exact=True).fill(run)
            expect(page.locator(".vehicle-card")).to_have_count(2)
            expect(page.locator(".vehicle-grid")).to_contain_text("FLEET-" + run)
            expect(page.locator(".vehicle-grid")).not_to_contain_text("CLIENT-" + run)

            page.goto(ROOT + "/taller/ingreso/?id=" + job["id"], wait_until="networkidle")
            tab("Recepción")
            page.get_by_label("Kilometraje de ingreso", exact=True).fill("100")
            page.get_by_label("Combustible de ingreso (%)", exact=True).fill("50")
            page.get_by_label("Condición y daños al recibir", exact=True).fill("Front damage recorded")
            page.get_by_label("Accesorios y observaciones", exact=True).fill("Spare tire and keys")
            save("execute_case_command", "intake", "Guardar inspección del ingreso")
            tab("Fotos y documentos")
            page.get_by_label("Archivo privado (hasta 2 MB)", exact=True).set_input_files({
                "name": "actual-browser-intake.png", "mimeType": "image/png", "buffer": PNG})
            save("save_vehicle_file", None, "Guardar archivo en este expediente")
            expect(page.get_by_role("heading", name="actual-browser-intake.png", exact=True)).to_be_visible()

            tab("Presupuestos")
            approve_quote("1856", 1)
            tab("Cargos y abonos")
            save("execute_case_command", "bill_scope", "Emitir solamente la diferencia pendiente")
            page.get_by_label("Abono USD", exact=True).fill("750")
            page.get_by_label("Cuenta o caja receptora", exact=True).fill(cash)
            page.get_by_label("Referencia del recibo", exact=True).fill("Browser receipt " + run)
            save("execute_case_command", "collect", "Guardar un recibo y su aplicación")
            tab("Presupuestos")
            quote2 = approve_quote("2190", 2)
            tab("Cargos y abonos")
            save("execute_case_command", "bill_scope", "Emitir solamente la diferencia pendiente")
            tab("Resumen")
            expect(page.locator(".budget-totals")).to_contain_text("$1,440.00")
            page.screenshot(path=str(screenshot_dir / "case-summary-desktop.png"), full_page=True)

            tab("Costos")
            page.locator("summary").filter(has_text="Registrar compra directa inesperada").click()
            cost_description = "Browser single receipt " + run
            page.get_by_label("Repuesto o servicio adquirido", exact=True).fill(cost_description)
            page.get_by_label("Cantidad adquirida", exact=True).fill("1")
            page.get_by_label("Costo unitario real (USD)", exact=True).fill("120")
            page.get_by_label("Proveedor de compra", exact=True).fill("Synthetic supplier")
            page.get_by_label("Referencia de factura y línea", exact=True).fill("BROWSER-120-" + run)
            save("execute_cost_command", "purchase", "Asignar compra a " + job["id"])
            page.locator("summary").filter(has_text="Clasificar costo").click()
            page.get_by_label("Disposición de " + cost_description, exact=True).select_option("Incluido")
            page.get_by_label("Alcance aprobado de " + cost_description, exact=True).select_option(quote2["id"])
            page.get_by_label("Motivo de disposición de " + cost_description, exact=True).fill("Included in approved complete scope")
            save("execute_cost_command", "classify", "Guardar disposición")
            expect(page.get_by_role("button", name="Guardar disposición", exact=True)).to_be_enabled()
            page.get_by_text(cost_description + " · $120.00", exact=True).click()
            for index, amount in enumerate(("75", "25", "20"), start=1):
                if index > 1:
                    page.get_by_role("button", name="Agregar concepto al mismo comprobante", exact=True).click()
                page.get_by_label(f"Concepto desglosado {index}", exact=True).fill(f"Part {index}")
                page.get_by_label(f"Importe desglosado {index}", exact=True).fill(amount)
                page.get_by_label(f"Partida relacionada {index}", exact=True).select_option(quote2["id"] + ":0")
            page.get_by_label("Motivo del desglose", exact=True).fill("One receipt split75/25/20")
            def case_refreshed(response):
                return response.url.endswith("/rpc/vehicle_case_file") and response.request.method == "POST"
            with page.expect_response(case_refreshed) as opening_refresh:
                page.get_by_role("button", name="Registrar gasto en este ingreso", exact=True).click()
            assert opening_refresh.value.ok
            dialog = page.get_by_role("dialog", name="Registrar gasto", exact=True)
            expect(dialog).to_be_visible()
            with page.expect_response(case_refreshed) as closing_refresh:
                dialog.get_by_role("button", name="Cancelar", exact=True).click()
            assert closing_refresh.value.ok
            expect(dialog).not_to_be_visible()
            page.wait_for_load_state("networkidle")
            for index, amount in enumerate(("75", "25", "20"), start=1):
                expect(page.get_by_label(f"Concepto desglosado {index}", exact=True)).to_be_visible()
                expect(page.get_by_label(f"Concepto desglosado {index}", exact=True)).to_have_value(f"Part {index}")
                expect(page.get_by_label(f"Importe desglosado {index}", exact=True)).to_have_value(amount)
                expect(page.get_by_label(f"Partida relacionada {index}", exact=True)).to_have_value(quote2["id"] + ":0")
            expect(page.get_by_label("Motivo del desglose", exact=True)).to_have_value("One receipt split75/25/20")
            print("PASS: unsaved receipt split survives opening/cancelling the global expense dialog and both case refreshes.")
            save("execute_case_command", "allocate_cost", "Guardar desglose sin duplicar costo")
            page.locator("summary").filter(has_text="Pagar compra directa").click()
            page.get_by_label("Importe a pagar de " + cost_description, exact=True).fill("120")
            page.get_by_label("Cuenta del pago de " + cost_description, exact=True).fill(cash)
            save("pay_direct_purchase", None, "Guardar pago sin duplicar costo")
            expect(page.get_by_text("Costo real total: $120.00", exact=True)).to_be_visible()

            tab("Salida")
            expect(page.get_by_text("Datos de recepción pendientes: Ninguno", exact=True)).to_be_visible()
            page.get_by_label("Persona que recibe el vehículo", exact=True).fill("Synthetic customer")
            page.get_by_label("Evidencia y observaciones de entrega", exact=True).fill("Received repaired vehicle")
            page.get_by_label("Autorización de crédito y motivo", exact=True).fill("Owner-approved remaining balance1440")
            save("deliver_workshop_order", None, "Confirmar entrega revisada")
            expect(page.get_by_text("Entrega ordinaria · Synthetic customer", exact=True)).to_be_visible()
            print("PASS: browser workshop intake/photo, versioned1856+334-750=1440, single120cost split75/25/20, payment and ordinary delivery.")

            page.goto(ROOT + "/libro-diario", wait_until="networkidle")
            page.get_by_role("button", name="Gestión", exact=True).click()
            page.get_by_label("Cuenta del diario", exact=True).select_option(cash)
            expect(page.locator(".budget-totals")).to_contain_text("$630.00")
            print("PASS: browser diary records750receipt minus120payment once; documents/applications add no cash.")

            page.goto(ROOT + "/vehiculos/alquiler/?id=" + booking["id"], wait_until="networkidle")
            save("execute_reservation_command", "confirm", "Confirmar reserva del pliego")
            expect(page.get_by_text("Sin total final acordado; documentar por períodos", exact=True)).to_be_visible()
            tab("Períodos y abonos")
            page.locator("summary").filter(has_text="Documentar otro período de alquiler").click()
            for label in ("Período desde (inclusive)", "Período hasta (inclusive)"):
                page.get_by_label(label, exact=True).fill(today)
            page.get_by_label("Importe acordado del período USD", exact=True).fill("40")
            page.get_by_label("Acuerdo del período", exact=True).fill("One agreed day, no final return date")
            save("execute_reservation_command", "period", "Emitir cargo del período (no registra cobro)")
            page.get_by_role("button", name="Actualizar alquiler", exact=True).click()
            page.get_by_label("Abono USD", exact=True).fill("40")
            page.get_by_label("Cuenta o caja receptora", exact=True).fill("Rental browser " + run)
            page.get_by_label("Referencia del recibo", exact=True).fill("Paid one rental period")
            save("collect_document", None, "Guardar un recibo y su aplicación")
            expect(page.get_by_text(today, exact=True).first).to_be_visible()
            tab("Salida y devolución")
            for label, value in (("Kilometraje de inspección", "0"), ("Combustible de inspección (%)", "100"),
                                 ("Condición observada", "Normal"), ("Accesorios observados", "Keys"), ("Evidencia de inspección", "Agreed handover")):
                page.get_by_label(label, exact=True).fill(value)
            save("execute_rental_command", "depart", "Registrar salida de alquiler")
            page.get_by_label("Kilometraje de inspección", exact=True).fill("50")
            save("execute_rental_command", "return", "Registrar devolución de alquiler")
            expect(page.get_by_role("cell", name="Retorno", exact=False)).to_be_visible()
            print("PASS: browser open-ended rental, paid period, atomic receipt, departure and physical return.")

            page.goto(ROOT + "/cobros", wait_until="networkidle")
            page.get_by_role("button", name="Gestión", exact=True).click()
            page.locator("summary").filter(has_text="Emitir un documento para varios vehículos / períodos").click()
            page.get_by_label("Cliente del documento agrupado", exact=True).select_option(customer["id"])
            page.get_by_label("Referencia externa única (tipo, año y número)", exact=True).fill("TEST CCF " + run)
            group_title = "Browser grouped CCF " + run
            page.get_by_label("Concepto del documento agrupado", exact=True).fill(group_title)
            for index, rental_id, gross, discount in ((1, booking["id"], "100", "10"), (2, grouped_booking["id"], "200", "0")):
                if index > 1:
                    page.get_by_role("button", name="Agregar vehículo / período al documento", exact=True).click()
                page.get_by_label(f"Operación de línea {index}", exact=True).select_option("booking:" + rental_id)
                page.get_by_label(f"Descripción de línea {index}", exact=True).fill(f"Browser CCF line {index} " + run)
                page.get_by_label(f"Importe bruto USD · {index}", exact=True).fill(gross)
                page.get_by_label(f"Deducción autorizada USD · {index}", exact=True).fill(discount)
                if discount != "0":
                    page.get_by_label(f"Motivo de deducción de línea {index}", exact=True).fill("Owner-approved GPS deduction")
            save("issue_grouped_document", None, "Emitir un único documento desglosado")
            page.locator("summary").filter(has_text="Registrar recibo de cliente").click()
            page.get_by_label("Cliente del recibo", exact=True).select_option(customer["id"])
            page.get_by_label("Importe del recibo (USD)", exact=True).fill("150")
            page.get_by_label("Cuenta del recibo", exact=True).fill("Grouped browser " + run)
            page.get_by_label("Referencia del recibo", exact=True).fill("Grouped browser receipt " + run)
            receipt = save("execute_billing_command", "pay", "Guardar recibo")
            row = page.get_by_role("row").filter(has_text=group_title)
            row.locator("summary").filter(has_text="Ver pagos y ajustes").click()
            row.get_by_label("Recibo del mismo cliente", exact=True).select_option(receipt["id"])
            row.get_by_label("Asignar USD a Browser CCF line 1 " + run, exact=True).fill("90")
            row.get_by_label("Asignar USD a Browser CCF line 2 " + run, exact=True).fill("60")
            row.get_by_label("Motivo del reparto", exact=True).fill("Explicit90/60 allocation of one150receipt")
            save("execute_billing_command", "apply", "Confirmar importe repartido por línea", row)
            expect(row.locator("article").filter(has_text="Browser CCF line 1 " + run)).to_contain_text("Saldo $0.00")
            expect(row.locator("article").filter(has_text="Browser CCF line 2 " + run)).to_contain_text("Saldo $140.00")
            print("PASS: browser one290groupedCCF with GPS deduction and explicit90/60allocation of one150receipt.")

            page.goto(ROOT + "/archivos", wait_until="networkidle")
            book = page.get_by_label("Libro conservado", exact=True)
            expect(book.locator("option")).to_have_count(5)
            book.select_option(label="Presupuesto de taller · Ejemplo presupuesto taller.xlsx")
            page.get_by_label("Sección del libro", exact=True).select_option("Abono por revisar")
            expect(page.get_by_role("cell", name="C55: $750.00", exact=False)).to_be_visible()
            page.get_by_role("button", name="Hoja1!A55:C55 · Ver celdas", exact=True).click()
            expect(page.get_by_role("rowheader", name="55", exact=True)).to_be_visible()
            with page.expect_download() as pending_download:
                page.get_by_role("button", name="Descargar original sin modificaciones", exact=True).click()
            downloaded = Path(pending_download.value.path()).read_bytes()
            original = Path("docs/excels/Ejemplo presupuesto taller.xlsx").read_bytes()
            assert hashlib.sha256(downloaded).digest() == hashlib.sha256(original).digest()
            print("PASS: browser actual workbook organized/original views,750abono warning and byte-identical original download.")

            page.set_viewport_size({"width": 390, "height": 844})
            for path, name in (("/taller/ingreso/?id=" + job["id"], "case-mobile"),
                               ("/vehiculos/alquiler/?id=" + booking["id"], "rental-case-mobile"), ("/archivos", "source-books-mobile")):
                page.goto(ROOT + path, wait_until="networkidle")
                page.screenshot(path=str(screenshot_dir / (name + ".png")), full_page=True)
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), name + " horizontal overflow"
            assert not errors, "Browser runtime errors: " + str(errors)
            print("PASS: new routes readable at390px; no browser runtime errors.")
        except Exception:
            page.screenshot(path=str(screenshot_dir / "operational-fit-failure.png"), full_page=True)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
