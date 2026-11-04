#!/usr/bin/env python3
"""Light and dark: the header button switches, the choice survives a
reload without a flash, the device's own preference applies when
nothing was chosen, and block colours are redrawn for the dark surface.

    python3 tests/theme.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8990
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def theme_attr(page):
    return await page.evaluate("document.documentElement.getAttribute('data-theme')")

async def bg(page):
    return await page.evaluate("getComputedStyle(document.body).backgroundColor")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1300, "height": 900}, color_scheme="light")
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")
        light_bg = await bg(page)
        check("a light device starts light, nothing chosen", await theme_attr(page) is None and await page.text_content("#themeIcon") == "☾")

        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(600)
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            await fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Noah', start: tue + 'T15:00', end: tue + 'T16:00', color: '#1d4ed8' }) });
        }""")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        light_ink = await page.evaluate("document.querySelector('.event-card.tinted').style.getPropertyValue('--card-ink')")

        await page.click("#themeBtn"); await page.wait_for_timeout(300)
        dark_bg = await bg(page)
        check("the button switches to dark", await theme_attr(page) == "dark" and dark_bg != light_bg and await page.text_content("#themeIcon") == "☀", f"{light_bg} -> {dark_bg}")
        dark_ink = await page.evaluate("document.querySelector('.event-card.tinted').style.getPropertyValue('--card-ink')")
        check("a coloured block is redrawn with light text on a deep tint", dark_ink != light_ink and dark_ink.lower() != "#1d4ed8", f"{light_ink} -> {dark_ink}")
        check("the choice is stored", await page.evaluate("localStorage.getItem('theme')") == "dark")

        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(500)
        check("a reload comes back dark", await theme_attr(page) == "dark" and await bg(page) == dark_bg)
        check("before the stylesheet even loads", await page.evaluate("document.querySelector('head script') !== null && document.querySelector('head script').textContent.includes('localStorage')"))

        await page.click("#themeBtn"); await page.wait_for_timeout(300)
        check("and back to light", await theme_attr(page) == "light" and await bg(page) == light_bg)

        # a dark device with nothing chosen
        await page.evaluate("localStorage.removeItem('theme')")
        dark_ctx = await b.new_context(viewport={"width": 1300, "height": 900}, color_scheme="dark")
        dark_page = await dark_ctx.new_page()
        await dark_page.goto(CAL, wait_until="networkidle")
        check("a dark device starts dark with nothing chosen", await theme_attr(dark_page) is None and await bg(dark_page) == dark_bg and await dark_page.text_content("#themeIcon") == "☀")
        await dark_page.click("#themeBtn"); await dark_page.wait_for_timeout(300)
        check("and can be switched to light explicitly", await theme_attr(dark_page) == "light" and await bg(dark_page) == light_bg)

        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check("no page errors", not real, str(real[:3]))
        print(f"\n{len(oks)} passed, {len(fails)} failed")
        await b.close()
        return 1 if fails else 0

def run():
    subprocess.run(["node", "tests/install-shim.mjs"], check=True, stdout=subprocess.DEVNULL)
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/index.html", timeout=1).read(); break
        except Exception:
            time.sleep(0.2)
    else:
        print("server failed:", server.stderr.read().decode()[:400]); return 1
    try:
        return asyncio.run(main())
    finally:
        server.terminate()

sys.exit(run())
