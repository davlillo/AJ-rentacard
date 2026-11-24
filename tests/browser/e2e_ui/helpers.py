"""Shared helpers for the UI test-and-fix worker (login, screenshots, DOM dumps)."""
from __future__ import annotations

import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:3030"
RESULTS = Path("test-results/e2e-ui")
SHOTS = RESULTS / "screens"


def local_config() -> dict[str, str]:
    cfg = {}
    for line in Path(".env.local").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def start(playwright):
    browser = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
    context = browser.new_context(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
    page = context.new_page()
    page.set_default_timeout(30000)
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    return browser, context, page, errors


def login(page) -> None:
    cfg = local_config()
    page.goto(f"{BASE}/inicio")
    page.wait_for_load_state("networkidle")
    if page.get_by_role("heading", name="Ingresar al sistema", exact=True).count():
        page.get_by_label("Correo electrónico", exact=True).fill(cfg["AJ_LOCAL_OWNER_EMAIL"])
        page.get_by_label("Contraseña", exact=True).fill(cfg["AJ_LOCAL_OWNER_PASSWORD"])
        page.get_by_role("button", name="Ingresar", exact=True).click()
        expect(page.get_by_role("heading", name="Resumen del negocio")).to_be_visible(timeout=60000)


def shot(page, name: str, full: bool = True) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)


def dump(page, limit: int = 200) -> str:
    """Return a compact text inventory of interactive elements on the page."""
    items = page.evaluate(
        """() => {
      const out = [];
      const sel = 'a,button,[role=button],[role=tab],input,select,textarea,summary,th,label';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        const txt = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 90);
        out.push([el.tagName.toLowerCase(), el.getAttribute('name') || el.id || '', txt].join(' | '));
      }
      return out;
    }"""
    )
    return "\n".join(items[:limit])


def headings(page) -> list[str]:
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('h1,h2,h3')).map(h => (h.tagName + ': ' + h.innerText.replace(/\\s+/g,' ').trim()).slice(0,120))"""
    )


def body_text(page) -> str:
    return page.evaluate("() => document.body.innerText.replace(/[ \\t]+/g,' ')")


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
