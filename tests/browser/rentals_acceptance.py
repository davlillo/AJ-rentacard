"""HU13-HU19 browser acceptance on AJ local only; synthetic records are retained."""
import datetime as dt
import json
import random
import re
import subprocess
import uuid
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    config = dict(line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
                  if line and not line.startswith("#") and "=" in line)
    api = config["NEXT_PUBLIC_SUPABASE_URL"]
    assert api == "http://127.0.0.1:55321", "AJ local only."
    base = "http://127.0.0.1:3030"
    headers = {"Content-Type": "application/json", "apikey": config["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]}

    def post(path: str, body: dict) -> dict:
        request = urllib.request.Request(api + path, data=json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except Exception:
            raise RuntimeError(f"AJ local test setup request failed: {path.split('?')[0]}") from None

    session = post("/auth/v1/token?grant_type=password", {"email": config["AJ_LOCAL_OWNER_EMAIL"], "password": config["AJ_LOCAL_OWNER_PASSWORD"]})
    headers["Authorization"] = "Bearer " + session["access_token"]
    run = uuid.uuid4().hex[:10]

    def rpc(command: str, payload: dict) -> dict:
        return post("/rest/v1/rpc/execute_command", {"command": command, "payload": payload, "idempotency_key": str(uuid.uuid4())})

    name, plate, concept, reference = f"Rental UI {run}", f"RENT-UI-{run}", f"Rental charge {run}", f"Receipt {run}"
    customer = rpc("create_customer", {"name": name, "phone": str(random.randint(10000000, 99999999)), "type": "Personal"})
    rental_car = rpc("create_vehicle", {"plate": plate, "brand": "Test", "model": "Rental", "year": 2026, "category": "Sedán", "color": "White", "daily": 50, "km": 100, "ownership": "Propio"})
    stock_car = rpc("create_vehicle", {"plate": "STOCK-UI-" + run, "brand": "Test", "model": "Stock", "year": 2026, "category": "Sedán", "color": "White", "daily": 0, "km": 100, "ownership": "Propio"})
    stock_order = rpc("receive_vehicle", {"customerId": customer["id"], "vehicleId": stock_car["id"], "area": "Mecánica", "service": "Inventory UI " + run})
    local = dt.timezone(dt.timedelta(hours=-6))
    now = dt.datetime.now(local)
    start, end = now - dt.timedelta(hours=1), now + dt.timedelta(days=1)
    output = Path("test-results")
    output.mkdir(exist_ok=True)
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page = context.new_page()
        page.set_default_timeout(30000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def go(path: str) -> None:
            page.goto(base + path)
            page.wait_for_load_state("networkidle")

        def close_dialog() -> None:
            page.get_by_role("dialog").get_by_role("button", name="Cerrar", exact=True).click()
            expect(page.get_by_role("dialog")).not_to_be_visible()

        try:
            go("/inicio")
            expect(page.get_by_label("Correo electrónico")).to_be_visible()
            page.get_by_label("Correo electrónico").fill(config["AJ_LOCAL_OWNER_EMAIL"])
            page.get_by_label("Contraseña", exact=True).fill(config["AJ_LOCAL_OWNER_PASSWORD"])
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.get_by_role("heading", name="Clientes, vehículos y recepción")).to_be_visible(timeout=60000)
            go("/calendario")
            expect(page.get_by_role("heading", name="Calendario de renta")).to_be_visible()
            page.get_by_role("button", name="Nueva reserva", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Cliente de reserva", exact=True).select_option(value=customer["id"])
            vehicle_option = dialog.get_by_label("Vehículo de reserva").locator("option").filter(has_text=plate)
            dialog.get_by_label("Vehículo de reserva").select_option(value=vehicle_option.get_attribute("value"))
            for label, value in [("Inicio de reserva", start.strftime("%Y-%m-%dT%H:%M")), ("Fin de reserva", end.strftime("%Y-%m-%dT%H:%M")),
                                 ("Tarifa diaria de reserva (USD)", "50"), ("Limpieza posterior (minutos)", "30")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name="Guardar borrador de reserva", exact=True).click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_contain_text("Borrador")
            dialog.get_by_role("button", name="Confirmar reserva", exact=True).click()
            expect(dialog).to_contain_text("Confirmada")
            dialog.get_by_label("Acuerdo o texto de WhatsApp").fill(f"WhatsApp agreement {run}")
            dialog.get_by_role("button", name="Guardar evidencia de WhatsApp").click()
            expect(dialog.get_by_text(f"WhatsApp agreement {run}", exact=True)).to_be_visible()
            contracts = dialog.locator('details:has(> summary:text-is("Contratos versionados y aceptación"))')
            contracts.locator("summary").click()
            contracts.get_by_label("Condiciones completas del contrato").fill("Synthetic rental terms frozen for browser acceptance")
            contracts.get_by_label("Motivo de versión contractual").fill("Initial agreed terms")
            contracts.get_by_role("button", name="Guardar versión de contrato").click()
            expect(contracts).to_contain_text("Contrato V1")
            contracts.get_by_label("Firmante del contrato V1", exact=True).fill("Synthetic customer")
            contracts.get_by_label("Evidencia de aceptación contractual V1", exact=True).fill("Signed acceptance reference retained")
            contracts.get_by_role("button", name="Registrar aceptación contractual").click()
            expect(contracts).to_contain_text("Aceptado por Synthetic customer")
            with page.expect_download() as contract_download:
                contracts.get_by_role("button", name="Descargar contrato V1", exact=True).click()
            contract_path = output / contract_download.value.suggested_filename
            contract_download.value.save_as(str(contract_path))
            assert contract_path.read_bytes().startswith(b"%PDF-"), "Invalid contract PDF."
            for label, value in [("Kilometraje de inspección", "100"), ("Combustible de inspección (%)", "100"),
                                 ("Condición observada", "No damage"), ("Accesorios observados", "Spare tire"), ("Evidencia de inspección", "Synthetic outgoing acceptance")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name="Registrar salida de alquiler", exact=True).click()
            expect(dialog.get_by_role("button", name="Registrar devolución de alquiler", exact=True)).to_be_visible()
            for label, value in [("Kilometraje de inspección", "150"), ("Combustible de inspección (%)", "80"),
                                 ("Condición observada", "New dent"), ("Evidencia de inspección", "Synthetic return acceptance")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name="Registrar devolución de alquiler", exact=True).click()
            expect(dialog).to_contain_text("Propuesto")
            expect(dialog.locator("tbody tr")).to_have_count(2)
            close_dialog()
            timeline_row = page.locator("strong").filter(has_text=re.compile("^" + re.escape(plate) + "$")).locator("..").locator("..")
            expect(timeline_row).to_contain_text("En taller")
            timeline_row.get_by_role("button", name=re.compile(r"^Limpieza")).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Motivo de actualización del bloqueo").fill("Actual return inspected and cleaned")
            dialog.get_by_role("button", name="Finalizar bloqueo y revisar disponibilidad", exact=True).click()
            expect(dialog).not_to_be_visible()
            expect(timeline_row).to_contain_text("Disponible")
            row = page.locator("tbody tr").filter(has_text=name)
            reservation_id = re.search(r"[a-f0-9-]{36}", row.inner_text()).group(0)
            expect(row).to_contain_text("Devuelto")
            page.screenshot(path=str(output / "calendar-desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Calendar mobile overflow."
            page.screenshot(path=str(output / "calendar-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/cobros")
            charge = page.locator('details:has(> summary:text-is("Emitir cargo con vencimiento"))')
            charge.locator("summary").click()
            charge.get_by_label("Operación del cargo").select_option(value="booking:" + reservation_id)
            charge.get_by_label("Concepto del cargo").fill(concept)
            charge.get_by_label("Importe del cargo (USD)").fill("500")
            charge.get_by_role("button", name="Emitir cargo", exact=True).click()
            debt = page.locator("tbody tr").filter(has_text=concept)
            expect(debt).to_contain_text("$500.00")
            receipt = page.locator('details:has(> summary:text-is("Registrar recibo de cliente"))')
            receipt.locator("summary").click()
            receipt.get_by_label("Cliente del recibo").select_option(value=customer["id"])
            receipt.get_by_label("Importe del recibo (USD)").fill("200")
            receipt.get_by_label("Cuenta del recibo").fill("Synthetic cashbox")
            receipt.get_by_label("Referencia del recibo").fill(reference)
            receipt.get_by_role("button", name="Guardar recibo", exact=True).click()
            expect(page.locator("p").filter(has_text=reference)).to_be_visible()
            debt.locator("summary").click()
            option = debt.get_by_label("Recibo a aplicar o reembolsar").locator("option").filter(has_text=reference)
            debt.get_by_label("Recibo a aplicar o reembolsar").select_option(value=option.get_attribute("value"))
            debt.get_by_label("Importe de aplicación o ajuste").fill("200")
            debt.get_by_label("Motivo del ajuste").fill("Customer directed payment application")
            debt.get_by_role("button", name="Confirmar aplicación o ajuste").click()
            expect(debt).to_contain_text("$300.00")
            document_id = re.search(r"[a-f0-9-]{36}", debt.inner_text()).group(0)
            page.reload()
            expect(page.locator("tbody tr").filter(has_text=concept)).to_contain_text("$300.00")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Billing mobile overflow."
            page.screenshot(path=str(output / "billing-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/inventario")
            expect(page.get_by_role("heading", name="Inventario y compras")).to_be_visible()
            create_item = page.locator('details:has(> summary:text-is("Crear artículo"))')
            create_item.locator("summary").click()
            sku = "SKU-UI-" + run
            create_item.get_by_label("SKU del artículo").fill(sku)
            create_item.get_by_label("Nombre del artículo").fill("Synthetic pad " + run)
            create_item.get_by_role("button", name="Guardar artículo", exact=True).click()
            item_row = page.locator("tbody tr").filter(has_text=sku)
            expect(item_row).to_be_visible()
            entry = page.locator('details:has(> summary:text-is("Solicitar compra o registrar apertura"))')
            entry.locator("summary").click()
            option = entry.get_by_label("Artículo de entrada").locator("option").filter(has_text=sku)
            entry.get_by_label("Artículo de entrada").select_option(value=option.get_attribute("value"))
            entry.get_by_label("Cantidad solicitada o inicial").fill("5")
            entry.get_by_label("Costo unitario de entrada (USD)").fill("10")
            supplier = "UI supplier " + run
            entry.get_by_label("Proveedor de entrada").fill(supplier)
            entry.get_by_label("Motivo de entrada").fill("Replenish synthetic stock")
            entry.get_by_role("button", name="Guardar solicitud o apertura").click()
            purchase_row = page.locator("tbody tr").filter(has_text=supplier)
            expect(purchase_row).to_contain_text("Solicitada")
            purchase_row.get_by_role("button", name="Autorizar compra", exact=True).click()
            expect(purchase_row).to_contain_text("Autorizada")
            purchase_row.locator('input[name="quantity"]').fill("3")
            purchase_row.get_by_label("Documento y motivo de recepción").fill("Synthetic invoice partial receipt")
            purchase_row.get_by_role("button", name="Registrar recepción parcial", exact=True).click()
            expect(purchase_row).to_contain_text("5 / 3 / 2")
            purchase_id = re.search(r"[a-f0-9-]{36}", purchase_row.inner_text()).group(0)
            expect(item_row).to_contain_text("3 unidad")
            item_row.locator("summary").click()
            item_row.get_by_label("Orden destino de " + sku).select_option(value=stock_order["id"])
            item_row.get_by_label("Cantidad a despachar de " + sku).fill("2")
            item_row.get_by_label("Motivo de despacho de " + sku).fill("Consumed on workshop job")
            item_row.get_by_role("button", name="Confirmar despacho", exact=True).click()
            expect(item_row).to_contain_text("1 unidad")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Inventory mobile overflow."
            page.screenshot(path=str(output / "inventory-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/reportes")
            expect(page.get_by_role("heading", name="Margen directo y comisiones")).to_be_visible()
            page.get_by_label("Vehículo del reporte").select_option(value=rental_car["id"])
            page.get_by_role("button", name="Calcular contribución y ver fuentes").click()
            expect(page.get_by_role("heading", name=re.compile("Contribución directa"))).to_contain_text("$500.00")
            rule_form = page.locator('details:has(> summary:text-is("Nueva revisión de regla de comisión (gerencia)"))')
            rule_form.locator("summary").click()
            rule_code = "UI-RULE-" + run
            for label, value in [("Código de regla", rule_code), ("Tasa de comisión (%)", "10"), ("Vigente desde", "2020-01-01"), ("Vigente hasta", "2040-01-01")]:
                rule_form.get_by_label(label, exact=True).fill(value)
            rule_form.get_by_role("button", name="Guardar regla versionada").click()
            eligibility = page.locator('details:has(> summary:text-is("Revisar elegibilidad de documento (gerencia)"))')
            eligibility.locator("summary").click()
            eligibility.get_by_label("Documento de comisión").select_option(value=document_id)
            eligibility.get_by_role("checkbox").check()
            eligibility.get_by_label("Motivo de elegibilidad").fill("Commercial service, not a guarantee")
            eligibility.get_by_role("button", name="Guardar decisión de elegibilidad").click()
            page.get_by_label("Reserva a liquidar").select_option(value=reservation_id)
            rule_option = page.get_by_label("Revisión de regla aplicada").locator("option").filter(has_text=rule_code)
            page.get_by_label("Revisión de regla aplicada").select_option(value=rule_option.get_attribute("value"))
            page.get_by_role("button", name="Calcular ajuste de comisión").click()
            expect(page.locator("tbody tr").filter(has_text=reservation_id)).to_contain_text("$20.00")
            go("/asistente")
            expect(page.get_by_role("heading", name="Asistente de AJ")).to_be_visible()
            agent_concept = "Agent browser " + run
            page.get_by_label("Instrucción de gasto").fill(f"gasto de 35.10 en {stock_order['id']} por {agent_concept}")
            page.get_by_label("Categoría indicada").fill("Materials")
            page.get_by_label("Cuenta indicada").fill("Synthetic cashbox")
            page.get_by_role("button", name="Preparar propuesta sin registrar gasto").click()
            expect(page.get_by_role("heading", name="Propuesta exacta por confirmar")).to_be_visible()
            page.get_by_role("button", name="Confirmar exactamente este gasto").click()
            expect(page.get_by_text(re.compile("Gasto registrado una sola vez"))).to_be_visible()
            page.get_by_label("Pregunta operativa").fill(f"¿Cuánto costó el vehículo STOCK-UI-{run} en {stock_order['id']}?")
            page.get_by_role("button", name="Consultar fuentes reales").click()
            expect(page.get_by_text(re.compile("costo directo"))).to_contain_text("$55.10")
            expect(page.get_by_text(re.compile("Fuente .*"))).to_have_count(2)
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Assistant mobile overflow."
            page.screenshot(path=str(output / "assistant-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/configuracion")
            expect(page.get_by_role("heading", name="Control operativo")).to_be_visible()
            plan_name = "UI plan " + run
            plan = page.locator('details:has(> summary:text-is("Crear presupuesto operativo"))')
            plan.locator("summary").click()
            for label, value in [("Nombre del presupuesto", plan_name), ("Área del presupuesto", "Taller"), ("Categoría del presupuesto", "Materials"), ("Importe autorizado del presupuesto", "100")]:
                plan.get_by_label(label, exact=True).fill(value)
            plan.get_by_role("button", name="Guardar presupuesto operativo").click()
            link = page.locator('details:has(> summary:text-is("Vincular compra al presupuesto"))')
            link.locator("summary").click()
            plan_option = link.get_by_label("Plan de la compra").locator("option").filter(has_text=plan_name)
            plan_id = plan_option.get_attribute("value")
            link.get_by_label("Plan de la compra").select_option(value=plan_id)
            link.get_by_label("Compra comprometida").select_option(value=purchase_id)
            link.get_by_role("button", name="Vincular compra planificada").click()
            position = page.locator('details:has(> summary:text-is("Consultar plan, comprometido y ejecutado"))')
            position.locator("summary").click()
            position.get_by_label("Presupuesto a consultar").select_option(value=plan_id)
            position.get_by_role("button", name="Consultar posición presupuestaria").click()
            expect(page.get_by_text(re.compile("^Plan \\$100"))).to_contain_text("Comprometido $20.00 · Ejecutado $30.00")
            schedule = page.locator('details:has(> summary:text-is("Programar reporte periódico"))')
            schedule.locator("summary").click()
            recipient = schedule.get_by_label("Destinatario autorizado").locator("option").filter(has_text=config["AJ_LOCAL_OWNER_EMAIL"])
            schedule.get_by_label("Destinatario autorizado").select_option(value=recipient.get_attribute("value"))
            schedule.get_by_label("Vehículo programado").select_option(value=rental_car["id"])
            schedule.get_by_role("button", name="Guardar programación de reporte").click()
            page.get_by_role("button", name="Preparar reportes vencidos al corte de hoy").click()
            expect(page.locator("p").filter(has_text=re.compile("Pendiente|Enviado")).first).to_be_visible()
            subprocess.run(["node", "scripts/report-worker.mjs", "--once"], capture_output=True, check=True, timeout=60)
            page.reload()
            expect(page.get_by_text("Enviado", exact=True).first).to_be_visible()
            inbox = page.locator('details:has(> summary:text-is("Registrar evento de integración autorizado"))')
            inbox.locator("summary").click()
            center = "ui-recovery-" + run
            event = {"costCenterId": center, "date": now.date().isoformat(), "concept": "Integration browser " + run,
                     "amount": "12", "category": "Materials", "method": "Efectivo", "account": "Synthetic cashbox"}
            inbox.get_by_label("Sistema de origen").fill("UI adapter")
            inbox.get_by_label("Identificador externo del evento").fill(run)
            inbox.get_by_label("Datos del gasto externo (JSON)").fill(json.dumps(event))
            inbox.get_by_role("button", name="Guardar evento en inbox").click()
            event_card = page.locator("article").filter(has_text="UI adapter / " + run)
            event_card.get_by_role("button", name="Procesar o reintentar evento").click()
            expect(event_card).to_contain_text("Error")
            catalog = page.locator('details:has(> summary:text-is("Registrar centro de costo"))')
            catalog.locator("summary").click()
            catalog.get_by_label("Código de centro de costo").fill(center)
            catalog.get_by_label("Nombre del centro de costo").fill("Synthetic recovery center")
            catalog.get_by_label("Motivo del catálogo").fill("Approved integration destination")
            catalog.get_by_role("button", name="Guardar centro de costo").click()
            event_card.get_by_role("button", name="Procesar o reintentar evento").click()
            expect(event_card).to_contain_text("Procesado")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Control mobile overflow."
            page.screenshot(path=str(output / "control-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/cobros")
            imports = page.locator('details:has(> summary:text-is("Importar pagos desde XLSX o CSV"))')
            imports.locator(":scope > summary").click()
            imported_reference = "CSV payment " + run
            header = "cliente_id,fecha,monto,medio,cuenta,referencia,id_origen\n"
            source = f"{customer['id']},{now.date().isoformat()},12.50,Efectivo,Import cashbox,{imported_reference},PAY-{run}\n"
            artifact = {"name": f"payments-{run}.csv", "mimeType": "text/csv", "buffer": (header + source).encode()}
            imports.get_by_label("Archivo de pagos").set_input_files(artifact)
            imports.get_by_role("button", name="Guardar original y preparar lote de pagos").click()
            imports.get_by_role("button", name="Validar vista previa de pagos").click()
            expect(imports.get_by_text(re.compile("Valida: 1"))).to_be_visible()
            imports.get_by_label("Total conciliado de nuevos pagos").fill("12.50")
            imports.get_by_role("button", name="Confirmar publicación atómica de pagos").click()
            expect(imports.locator("strong").filter(has_text=re.compile("payments-.*Publicado"))).to_be_visible()
            imports.get_by_label("Archivo de pagos").set_input_files(artifact)
            imports.get_by_role("button", name="Guardar original y preparar lote de pagos").click()
            expect(imports.locator("strong").filter(has_text=re.compile("payments-.*Publicado"))).to_be_visible()
            expect(page.locator("p").filter(has_text=imported_reference)).to_have_count(1)
            assert not errors, "Browser runtime errors occurred."
            print("PASS: HU05-HU06 payment import/repeat and HU13-HU30 operational calendar, ledger, inventory, contracts/PDF, commissions, reports/local mail, assistant, budgets and inbox recovery.")
        except Exception as error:
            alerts = " | ".join(page.get_by_role("alert").all_text_contents())
            safe = (str(error) + "\nVisible alerts: " + alerts).replace(config["AJ_LOCAL_OWNER_PASSWORD"], "[REDACTED]").replace(config["AJ_LOCAL_OWNER_EMAIL"], "[LOCAL USER]")
            raise RuntimeError(safe) from None
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
