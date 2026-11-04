#!/usr/bin/env python3
"""Staying signed in: the login's "Keep me signed in" box, a reload that
comes back in admin mode without asking, Public view keeping the device
signed in, and Sign out forgetting it.

    python3 tests/remember.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8975
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def is_admin(page):
    return await page.evaluate("!document.getElementById('adminBanner').classList.contains('hidden')")

async def visible(page, sel):
    return await page.evaluate(f"!document.querySelector('{sel}').classList.contains('hidden')")

async def stored(page):
    return await page.evaluate("localStorage.getItem('adminDeviceToken')")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 950})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        # ---- without the box: a reload asks again
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn")
        check("the login offers to keep the device signed in, ticked by default",
              await page.evaluate("document.getElementById('rememberMeInput').checked"))
        await page.evaluate("document.getElementById('rememberMeInput').checked = false")
        await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("signed in", await is_admin(page))
        check("nothing stored when the box is off", await stored(page) is None)
        check("Sign out is offered for a password-only session too", await visible(page, "#signOutBtn"))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(500)
        check("a reload is back to public", not await is_admin(page))

        # ---- with the box: the device remembers
        await page.click("#adminBtn")
        await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("signed in again", await is_admin(page))
        tok = await stored(page)
        check("a token is stored, not the password", tok is not None and '"t"' not in tok and "token" in tok, str(tok))
        check("Sign out is in the profile menu", await visible(page, "#signOutBtn"))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        check("a reload comes back in admin mode with no dialog", await is_admin(page)
              and await page.evaluate("document.getElementById('loginModal').classList.contains('hidden')"))

        # writes work on the token alone
        box = await page.locator(".day-column").nth(2).bounding_box()
        await page.mouse.click(box["x"] + box["width"]/2, box["y"] + 240); await page.wait_for_timeout(400)
        await page.evaluate("""() => { document.getElementById('eventType').value = 'BLOCKED';
            document.getElementById('eventTitle').value = 'Maya - Algebra II'; }""")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(800)
        check("a save works while signed in by token", await page.locator(".event-card").count() == 1)

        # ---- Public view keeps the device; Admin is one click
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(500)
        check("Public view shows the public page", not await is_admin(page))
        check("but the device is still remembered", await stored(page) is not None)
        await page.evaluate("document.getElementById('backToAdminBtn').click()"); await page.wait_for_timeout(700)
        check("Back to admin comes straight back without a password", await is_admin(page)
              and await page.evaluate("document.getElementById('loginModal').classList.contains('hidden')"))

        # ---- Sign out forgets
        await page.evaluate("document.getElementById('signOutBtn').click()"); await page.wait_for_timeout(500)
        check("Sign out returns to public and forgets the device", not await is_admin(page) and await stored(page) is None)
        status = await page.text_content("#status")
        check("and says so", "Signed out" in status, status)
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(500)
        check("a reload after signing out is public", not await is_admin(page))
        await page.click("#adminBtn"); await page.wait_for_timeout(300)
        check("and Admin asks for the password again", not await page.evaluate("document.getElementById('loginModal').classList.contains('hidden')"))

        # ---- a dead token (password changed) falls back quietly
        await page.evaluate("localStorage.setItem('adminDeviceToken', JSON.stringify({ token: 'stale.token', expiresAt: new Date(Date.now() + 86400000).toISOString() }))")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        check("a token the server no longer honours lands on the public page", not await is_admin(page))
        check("and is forgotten", await stored(page) is None)

        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check("no page errors", not real, str(real[:3]))
        print(f"\n{len(oks)} passed, {len(fails)} failed")
        await b.close()
        return 1 if fails else 0

def run():
    subprocess.run(["node", "tests/install-shim.mjs"], check=True, stdout=subprocess.DEVNULL)
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
