"""HU01-HU06 browser acceptance against AJ LOCAL ONLY; retains synthetic records."""
import os
import random
import re
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    expect.set_options(timeout=30000)
    config = dict(
        line.split("=", 1) for line in Path(".env.local").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )
    assert config.get("NEXT_PUBLIC_DATA_SOURCE") == "supabase", "Enable local Supabase before browser tests."
    assert config.get("NEXT_PUBLIC_SUPABASE_URL") == "http://127.0.0.1:55321", "Refusing non-AJ API."
    base = os.environ.get("AJ_BROWSER_URL", "http://127.0.0.1:3030")
    assert base in ("http://127.0.0.1:3030", "http://localhost:3030"), "Local browser URL required."
    run = uuid.uuid4().hex[:10]
    source_name, target_name = f"UI Source {run}", f"UI Survivor {run}"
    phone = str(random.randint(70000000, 79999999))
    target_phone = str(random.randint(80000000, 89999999))
    source_document, target_document = f"UI-SOURCE-{run}", f"UI-TARGET-{run}"
    plate, service = f"P UI-{run}", f"Browser inspection {run}"
    expense_concept, import_concept = f"Browser expense {run}", f"Browser import {run}"
    output = Path("test-results")
    output.mkdir(exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(30000)

        def login() -> None:
            page.goto(base + "/inicio")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("heading", name="Ingresar al sistema")).to_be_visible()
            # DOM inspection precedes action; credentials are never printed or traced.
            expect(page.get_by_label("Correo electrónico")).to_be_visible()
            page.get_by_label("Correo electrónico").fill(config["AJ_LOCAL_OWNER_EMAIL"])
            page.get_by_label("Contraseña", exact=True).fill(config["AJ_LOCAL_OWNER_PASSWORD"])
            page.get_by_role("button", name="Ingresar", exact=True).click()
            expect(page.get_by_role("heading", name="Clientes, vehículos y recepción")).to_be_visible(timeout=60000)

        def go(path: str) -> None:
            page.goto(base + path)
            page.wait_for_load_state("networkidle")

        def close_dialog() -> None:
            page.get_by_role("dialog").locator('button[aria-label="Cerrar"]').click()
            expect(page.get_by_role("dialog")).not_to_be_visible()

        def add_customer(name: str, number: str, document: str) -> None:
            page.get_by_role("button", name="Nuevo cliente", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Nombre o razón social").fill(name)
            dialog.get_by_label("Teléfono", exact=True).fill(number)
            dialog.get_by_label("DUI / NIT").fill(document)
            dialog.get_by_role("button", name="Guardar registro").click()
            expect(dialog).not_to_be_visible()
            expect(page.locator("tbody tr").filter(has_text=name)).to_be_visible()

        try:
            login()
            print("PASS: local sign-in", flush=True)
            go("/clientes")
            add_customer(source_name, phone, source_document)
            add_customer(target_name, target_phone, target_document)
            page.get_by_role("button", name="Nuevo cliente", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Teléfono", exact=True).fill(phone[:4] + "-" + phone[4:])
            expect(dialog.get_by_role("button", name="Guardar registro")).to_be_disabled()
            expect(dialog.get_by_text(re.compile("Ya hay coincidencias"))).to_be_visible()
            close_dialog()

            print("PASS: customer creation and duplicate warning", flush=True)

            go("/vehiculos")
            page.get_by_role("button", name="Agregar vehículo", exact=True).click()
            dialog = page.get_by_role("dialog")
            for label, value in [("Placa", plate), ("Marca", "Test"), ("Modelo", "Browser"),
                                 ("Año", "2026"), ("Kilometraje", "1200"), ("Color", "Blanco"),
                                 ("Tarifa diaria (USD)", "45")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_label("Relación").select_option(label="Cliente")
            dialog.get_by_label("Propietario", exact=True).select_option(label=source_name)
            dialog.get_by_role("button", name="Guardar registro").click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_text(plate, exact=True)).to_be_visible()
            print("PASS: vehicle registration", flush=True)

            go("/taller")
            page.get_by_role("button", name="Nueva entrada", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Cliente", exact=True).select_option(label=source_name)
            vehicle_option = dialog.get_by_label("Vehículo", exact=True).locator("option").filter(has_text=plate)
            dialog.get_by_label("Vehículo", exact=True).select_option(value=vehicle_option.get_attribute("value"))
            dialog.get_by_label("Motivo del ingreso").fill(service)
            dialog.get_by_role("button", name="Guardar registro").click()
            expect(dialog).not_to_be_visible()
            order = page.locator("tbody tr").filter(has_text=service)
            expect(order).to_contain_text("kilometraje, condición, accesorios, fotos")
            folio = re.search(r"OT-\d+", order.inner_text()).group(0)
            order.get_by_role("button", name="Registrar gasto").click()
            dialog = page.get_by_role("dialog")
            for label, value in [("Concepto", expense_concept), ("Importe (USD)", "35.10"),
                                 ("Categoría", "Materials"), ("Cuenta o caja", f"Browser cashbox {run}")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name="Guardar registro").click()
            expect(dialog).not_to_be_visible()
            expect(order).to_contain_text("$35.10")
            print("PASS: reception and expense", flush=True)
            order.get_by_role("button", name=re.compile(r"^Tareas \(")).click()
            dialog = page.get_by_role("dialog")
            task_names = [f"Brake task {run}", f"Paint task {run}"]
            for task_name in task_names:
                dialog.get_by_label("Nueva tarea", exact=True).fill(task_name)
                dialog.get_by_label("Responsable de la nueva tarea", exact=True).select_option(label=config["AJ_LOCAL_OWNER_EMAIL"])
                dialog.get_by_role("button", name="Crear tarea", exact=True).click()
                expect(dialog.locator("tbody tr").filter(has_text=task_name)).to_be_visible()
            first_task = dialog.locator("tbody tr").filter(has_text=task_names[0])
            first_task.get_by_role("button", name="Iniciar tarea", exact=True).click()
            expect(first_task).to_contain_text("En proceso")
            first_task.locator("summary").filter(has_text="Tiempo de esta tarea").click()
            first_task.get_by_role("button", name="Iniciar cronómetro", exact=True).click()
            first_task.get_by_role("button", name="Pausar cronómetro", exact=True).click()
            expect(first_task).to_contain_text("Pausado")
            first_task.get_by_role("button", name="Reanudar cronómetro", exact=True).click()
            first_task.get_by_role("button", name="Finalizar cronómetro", exact=True).click()
            expect(first_task.get_by_role("button", name="Pausar cronómetro", exact=True)).to_have_count(0)
            correction = first_task.locator('details:has(> summary:text-is("Corregir tramo con motivo"))').first
            correction.locator("summary").click()
            correction.get_by_label("Motivo de corrección de tiempo").fill("Browser reviewed actual interval")
            correction.get_by_role("button", name="Guardar corrección de tiempo").click()
            expect(first_task).to_contain_text("Browser reviewed actual interval")
            first_task.get_by_role("button", name="Finalizar tarea", exact=True).click()
            expect(first_task).to_contain_text("Finalizada")
            expect(dialog.locator("tbody tr").filter(has_text=task_names[1])).to_contain_text("Pendiente")
            close_dialog()
            expect(order).to_contain_text("Diagnóstico")
            print("PASS: HU07 independent assigned tasks", flush=True)
            order.get_by_role("button", name=plate, exact=True).click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_text(source_name, exact=True)).to_be_visible()
            expect(dialog.get_by_text(expense_concept, exact=True)).to_be_visible()
            page.screenshot(path=str(output / "vehicle-desktop.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            expect(dialog.get_by_role("heading", name="Test Browser")).to_be_visible()
            page.screenshot(path=str(output / "vehicle-mobile.png"), full_page=True)
            close_dialog()
            page.set_viewport_size({"width": 1440, "height": 1000})

            go("/clientes")
            page.get_by_role("button", name=f"Ver cliente {source_name}", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("Ficha que se conservará").select_option(label=f"{target_name} · {target_document}")
            dialog.get_by_label("Motivo de la fusión").fill("Browser test identity verified")
            dialog.get_by_role("checkbox").check()
            dialog.get_by_role("button", name="Confirmar fusión").click()
            expect(dialog).not_to_be_visible()
            page.get_by_placeholder("Buscar nombre, teléfono o documento…").fill(phone)
            expect(page.locator("tbody tr").filter(has_text=target_name)).to_be_visible()
            go("/taller")
            order = page.locator("tbody tr").filter(has_text=service)
            expect(order).to_contain_text(target_name)
            expect(order).to_contain_text("$35.10")
            print("PASS: customer merge preserves relations", flush=True)

            go("/libro-diario")
            expect(page.locator("tbody tr").filter(has_text=expense_concept)).to_have_count(1)
            header = "fecha,concepto,monto,categoria,medio,cuenta,operacion,centro_costo,id_origen\n"
            valid = f"2026-10-22,{import_concept},18.75,Materials,Efectivo,Browser cashbox {run},{folio},,IMPORT-{run}\n"
            invalid = f"2026-10-22,Invalid {run},bad,Materials,Efectivo,Browser cashbox {run},{folio},,BAD-{run}\n"
            file = {"name": f"browser-{run}.csv", "mimeType": "text/csv", "buffer": (header + valid + invalid).encode()}

            def stage_file(payload: dict) -> None:
                page.get_by_role("button", name="Importar Excel / CSV").click()
                active = page.get_by_role("dialog")
                active.locator('input[type="file"]').set_input_files(payload)
                active.get_by_role("button", name="Preparar lote privado").click()
                expect(active.get_by_text(re.compile("SHA-256"))).to_be_visible()

            def confirm_import(amount: str) -> None:
                active = page.get_by_role("dialog")
                active.get_by_label(re.compile("Ingresá el total nuevo")).fill(amount)
                active.get_by_role("checkbox").check()
                active.get_by_role("button", name="Confirmar publicación del lote").click()
                expect(active.get_by_text(re.compile(r"Lote .* committed"))).to_be_visible()

            stage_file(file)
            dialog = page.get_by_role("dialog")
            dialog.get_by_role("button", name="Validar y guardar vista previa").click()
            expect(dialog.get_by_text("Rechazadas: 1", exact=True)).to_be_visible()
            expect(page.locator("main tbody tr").filter(has_text=import_concept)).to_have_count(0)
            dialog.get_by_label("Acción fila 3", exact=True).select_option("exclude")
            dialog.get_by_label("Motivo fila 3", exact=True).fill("Invalid synthetic line reviewed")
            dialog.get_by_role("button", name="Validar y guardar vista previa").click()
            expect(dialog.get_by_text("Excluidas: 1", exact=True)).to_be_visible()
            confirm_import("18.75")
            expect(dialog.get_by_text("Publicada", exact=True)).to_be_visible()
            close_dialog()
            expect(page.locator("tbody tr").filter(has_text=import_concept)).to_have_count(1)

            stage_file(file)
            expect(page.get_by_role("dialog").get_by_text("Publicada", exact=True)).to_be_visible()
            expect(page.get_by_role("dialog").get_by_role("button", name="Confirmar publicación del lote")).not_to_be_visible()
            close_dialog()
            expect(page.locator("tbody tr").filter(has_text=import_concept)).to_have_count(1)

            # A different source key for an identical business fact must require human resolution.
            recap = {"name": f"recap-{run}.csv", "mimeType": "text/csv",
                     "buffer": (header + valid.replace(f"IMPORT-{run}", f"RECAP-{run}")).encode()}
            stage_file(recap)
            dialog = page.get_by_role("dialog")
            dialog.get_by_role("button", name="Validar y guardar vista previa").click()
            expect(dialog.get_by_text("Ambiguas: 1", exact=True)).to_be_visible()
            dialog.get_by_label("Acción fila 2", exact=True).select_option("link")
            dialog.get_by_label("Gasto existente fila 2", exact=True).select_option(index=1)
            dialog.get_by_label("Motivo fila 2", exact=True).fill("Same expense verified across sources")
            dialog.get_by_role("button", name="Validar y guardar vista previa").click()
            expect(dialog.get_by_text("Duplicadas: 1", exact=True)).to_be_visible()
            confirm_import("0")
            close_dialog()
            page.reload()
            expect(page.locator("tbody tr").filter(has_text=import_concept)).to_have_count(1)
            page.set_viewport_size({"width": 390, "height": 844})
            expect(page.get_by_role("heading", name="Gastos registrados")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Mobile document overflows."
            page.screenshot(path=str(output / "ledger-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/presupuestos")
            expect(page.get_by_role("heading", name="Presupuestos versionados")).to_be_visible()
            catalog = page.locator("details").filter(has_text="Catálogo de tarifas")
            if catalog.get_attribute("open") is None:
                catalog.locator("summary").click()
            tariff_code = f"UI-RATE-{run}".upper()
            for label, value in [("Código de tarifa", tariff_code), ("Descripción de tarifa", "Synthetic repair"),
                                 ("Costo unitario interno", "250"), ("Precio unitario comercial", "350")]:
                catalog.get_by_label(label, exact=True).fill(value)
            catalog.get_by_role("button", name="Guardar revisión de tarifa").click()
            expect(page.get_by_label("Tarifa de línea 1").locator("option").filter(has_text=tariff_code)).to_have_count(1)
            page.get_by_label("Orden de servicio", exact=True).select_option(value=folio)
            tariff_option = page.get_by_label("Tarifa de línea 1").locator("option").filter(has_text=tariff_code)
            page.get_by_label("Tarifa de línea 1").select_option(value=tariff_option.get_attribute("value"))
            page.get_by_label("Método de precio", exact=True).select_option("margin")
            page.get_by_label("Proporción de precio (%)", exact=True).fill("25")
            page.get_by_label("Motivo y alcance de la versión").fill("Initial scope verified in browser")
            page.get_by_role("button", name="Calcular en servidor", exact=True).click()
            expect(page.locator(".budget-totals")).to_contain_text("$333.33")
            page.get_by_role("button", name="Guardar nueva versión", exact=True).click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_contain_text("Borrador")
            dialog.get_by_label("Persona que decide el alcance").fill("Synthetic customer")
            dialog.get_by_label("Evidencia de la decisión").fill("Synthetic customer authorized V1 by phone")
            dialog.get_by_role("button", name="Registrar decisión", exact=True).click()
            expect(dialog).to_contain_text("Aprobado")
            with page.expect_download() as download_info:
                dialog.get_by_role("button", name="Descargar PDF de esta versión").click()
            download = download_info.value
            pdf_path = output / download.suggested_filename
            download.save_as(str(pdf_path))
            assert pdf_path.read_bytes().startswith(b"%PDF-"), "Invalid client PDF."
            close_dialog()
            page.reload()
            quote_row = page.locator("tbody tr").filter(has_text=folio)
            expect(quote_row).to_contain_text("Aprobado")
            quote_row.get_by_role("button", name="Ver versión").click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_role("button", name="Preparar nueva versión").click()
            page.get_by_label("Cantidad de línea 1").fill("2")
            page.get_by_label("Motivo y alcance de la versión").fill("Additional complete scope")
            page.get_by_role("button", name="Calcular en servidor", exact=True).click()
            page.get_by_role("button", name="Guardar nueva versión", exact=True).click()
            expect(page.get_by_role("dialog")).to_contain_text("Borrador")
            close_dialog()
            expect(page.locator("tbody tr").filter(has_text=folio)).to_have_count(2)
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Estimates mobile overflows."
            page.screenshot(path=str(output / "estimates-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1000})
            go("/taller")
            order = page.locator("tbody tr").filter(has_text=service)
            order.get_by_role("button", name="Costos y clasificación").click()
            dialog = page.get_by_role("dialog")
            dialog.locator("summary").filter(has_text="Registrar compra directa inesperada").click()
            for label, value in [("Repuesto o servicio adquirido", f"Unexpected part {run}"), ("Cantidad adquirida", "2"),
                                 ("Costo unitario real (USD)", "17.555"), ("Proveedor de compra", f"Supplier {run}"),
                                 ("Referencia de factura y línea", "invoice-1/line-1"), ("Fecha de compra", "2026-10-22")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name=f"Asignar compra a {folio}", exact=True).click()
            cost_row = dialog.locator("tbody tr").filter(has_text=f"Unexpected part {run}")
            expect(cost_row).to_contain_text("Pendiente")
            expect(cost_row).to_contain_text("$35.11")
            cost_row.locator("summary").filter(has_text="Pagar compra directa").click()
            cost_row.get_by_label(f"Importe a pagar de Unexpected part {run}", exact=True).fill("35.11")
            cost_row.get_by_label(f"Cuenta del pago de Unexpected part {run}", exact=True).fill(f"Linked purchase cashbox {run}")
            cost_row.get_by_role("button", name="Guardar pago sin duplicar costo", exact=True).click()
            expect(cost_row).to_contain_text("Pagado: $35.11 · Pendiente: $0.00")
            expect(dialog).to_contain_text("Costo real total: $88.96")
            cost_row.locator("summary").filter(has_text="Clasificar costo").click()
            cost_row.get_by_label(f"Disposición de Unexpected part {run}", exact=True).select_option("Absorbido")
            cost_row.get_by_label(f"Motivo de disposición de Unexpected part {run}").fill("Warranty cost authorized")
            cost_row.get_by_role("button", name="Guardar disposición", exact=True).click()
            expect(cost_row.locator("strong").filter(has_text="Absorbido")).to_be_visible()
            close_dialog()
            order.get_by_role("button", name="Revisar entrega", exact=True).click()
            dialog = page.get_by_role("dialog")
            expect(dialog.get_by_label("Pendientes de entrega")).to_contain_text("Costos sin disposición: 2")
            dialog.get_by_label("Persona que recibe el vehículo", exact=True).fill("Synthetic customer")
            dialog.get_by_label("Evidencia y observaciones de entrega", exact=True).fill("Synthetic browser delivery acceptance")
            dialog.get_by_role("checkbox", name=re.compile("Revisé los datos de recepción pendientes")).check()
            dialog.get_by_role("button", name="Confirmar entrega revisada", exact=True).click()
            expect(dialog.get_by_role("alert")).to_contain_text("Hay costos pendientes")
            dialog.get_by_role("checkbox", name=re.compile("Solicitar entrega por excepción")).check()
            dialog.get_by_label("Motivo de excepción", exact=True).fill("Owner assumes the pending classification review")
            dialog.get_by_label("Autorización de crédito y motivo", exact=True).fill("Owner authorizes synthetic customer credit")
            dialog.get_by_role("button", name="Confirmar entrega revisada", exact=True).click()
            expect(dialog.get_by_role("heading", name=re.compile("^Acta "))).to_be_visible()
            close_dialog()
            expect(order).to_contain_text("Entregado")
            order.get_by_role("button", name="Costos y clasificación").click()
            dialog = page.get_by_role("dialog")
            expect(dialog).to_contain_text("solo gerencia puede registrar ajustes")
            dialog.locator("summary").filter(has_text="Registrar compra directa inesperada").click()
            for label, value in [("Repuesto o servicio adquirido", f"Late part {run}"), ("Cantidad adquirida", "1"),
                                 ("Costo unitario real (USD)", "12"), ("Proveedor de compra", f"Supplier {run}"),
                                 ("Referencia de factura y línea", "late-invoice/line-1"), ("Fecha de compra", "2026-10-22"),
                                 ("Motivo del ajuste posterior", "Supplier sent the invoice after delivery")]:
                dialog.get_by_label(label, exact=True).fill(value)
            dialog.get_by_role("button", name=f"Asignar compra a {folio}", exact=True).click()
            expect(dialog.locator("tbody tr").filter(has_text=f"Late part {run}")).to_contain_text("Pendiente")
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Cost review mobile overflows."
            page.screenshot(path=str(output / "workshop-costs-mobile.png"), full_page=True)
            close_dialog()
            assert not errors, f"Browser runtime errors: {errors}"
            print("PASS: HU01-HU04 desktop/mobile, imports/deduplication, HU07 tasks, HU08-HU09 quotes/PDF, HU10 costs, HU11 timers and HU12 reviewed delivery.")
        except Exception as error:
            try:
                page.screenshot(path=str(output / "failure.png"), full_page=True, timeout=5000, animations="disabled")
            except Exception:
                pass  # Preserve the acceptance failure rather than masking it with screenshot failure.
            safe_error = str(error).replace(config["AJ_LOCAL_OWNER_PASSWORD"], "[REDACTED]")
            safe_error = safe_error.replace(config["AJ_LOCAL_OWNER_EMAIL"], "[LOCAL USER]")
            raise RuntimeError(safe_error) from None
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
