"""Collect the ids of every demo record created through the UI (for the ledger)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, login, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402


def main() -> None:
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        out = {}
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        out["workshopRows"] = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href*="taller/ingreso"]')).map(a=>a.getAttribute('href'))"""
        )
        out["workshopVehicles"] = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href*="vehiculos/expediente"]')).map(a=>a.getAttribute('href')+' :: '+a.innerText.replace(/\\s+/g,' ').trim().slice(0,40))"""
        )
        page.goto(f"{BASE}/vehiculos/expediente/?id=a91a78c4-7c23-477a-a660-22e34fc0c684")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)
        page.get_by_role("button", name="Historial de mantenimientos").click()
        page.wait_for_timeout(1200)
        out["order2Vehicle"] = page.evaluate(
            """() => Array.from(document.querySelectorAll('main a')).map(a=>a.getAttribute('href')).filter(h=>h&&h.includes('taller/ingreso'))"""
        )
        page.goto(f"{BASE}/taller")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)
        vehicles = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href*="vehiculos/expediente"]')).map(a=>a.getAttribute('href')+' :: '+a.innerText.replace(/\\s+/g,' ').trim().slice(0,40))"""
        )
        out["vehicles"] = vehicles
        page.goto(f"{BASE}/alquileres")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        out["rentals"] = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href*="alquileres/folio"]')).map(a=>a.getAttribute('href'))"""
        )
        page.goto(f"{BASE}/clientes")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)
        out["customers"] = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href*="clientes/expediente"]')).map(a=>a.getAttribute('href')+' :: '+a.innerText.replace(/\\s+/g,' ').trim().slice(0,30))"""
        )
        Path("test-results/e2e-ui/record-ids.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(out, ensure_ascii=False, indent=2))
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
