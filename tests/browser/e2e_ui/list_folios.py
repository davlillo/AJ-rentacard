"""Inspect the rental list for the draft reservation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from helpers import BASE, login, shot, start  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402


def main() -> None:
    with sync_playwright() as p:
        browser, context, page, errors = start(p)
        login(page)
        page.goto(f"{BASE}/alquileres")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        hrefs = page.evaluate(
            """() => Array.from(document.querySelectorAll('a')).map(a=>(a.getAttribute('href')||'')+' :: '+(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50)).filter(x=>x.includes('folio'))"""
        )
        print("\n".join(hrefs))
        print(page.inner_text("main")[:2000])
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
