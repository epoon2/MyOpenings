#!/usr/bin/env python3
"""The profile chip and its menu: a visitor sees Log in; a signed-in
admin sees a circle with the first letter of the display name and the
name beside it; the menu switches between admin and visitor view
without signing out, and offers Settings, Version history and Sign out.

    python3 tests/profile.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8986
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def hidden(page, sel):
    return await page.evaluate(f"document.querySelector('{sel}').classList.contains('hidden')")

async def menu_items(page):
    return await page.evaluate("[...document.querySelectorAll('#profileDropdown .menu-item')].filter(b => !b.classList.contains('hidden')).map(b => b.textContent.trim())")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")

        check("a visitor sees Log in, no chip", not await hidden(page, "#adminBtn") and (await page.text_content("#adminBtn")).strip() == "Log in" and await hidden(page, "#profileMenu"))
        check("the banner carries no buttons, only how to edit", await page.evaluate("document.querySelectorAll('#adminBanner button').length") == 0
              and "How to edit" in (await page.text_content("#adminBanner")))
        check("a visitor sees no Edit/Public switch and no gear", await hidden(page, "#modeSwitch") and await hidden(page, "#toolsMenuWrap"))

        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("signed in, the chip replaces Log in", await hidden(page, "#adminBtn") and not await hidden(page, "#profileMenu"))
        check("the chip shows the initial and the display name", await page.text_content("#profileInitial") == "E" and await page.text_content("#profileName") == "Ethan")
        check("the menu is closed until clicked", await hidden(page, "#profileDropdown"))
        await page.click("#profileBtn"); await page.wait_for_timeout(200)
        check("clicking the chip opens the menu", not await hidden(page, "#profileDropdown") and await page.evaluate("document.getElementById('profileBtn').getAttribute('aria-expanded')") == "true")
        check("the menu offers Sign out, not Settings", await menu_items(page) == ["Sign out"], str(await menu_items(page)))
        check("the Edit view / Public view switch is in the header, Edit pressed", not await hidden(page, "#modeSwitch")
              and await page.evaluate("document.getElementById('modeSwitch').closest('header, .app-header, .topbar') !== null")
              and await page.evaluate("document.getElementById('backToAdminBtn').getAttribute('aria-pressed')") == "true"
              and await page.evaluate("document.getElementById('exitAdminBtn').getAttribute('aria-pressed')") == "false")
        check("and the menu names the role, Admin", await page.text_content("#profileMenuMode") == "Admin", await page.text_content("#profileMenuMode"))
        check("the gear is on the toolbar, its menu closed", not await hidden(page, "#toolsMenuWrap") and await hidden(page, "#toolsMenu"))
        await page.click("#portalTitle"); await page.wait_for_timeout(100)
        await page.click("#gearBtn"); await page.wait_for_timeout(200)
        check("the gear opens Undo, Redo, Version history and Settings", not await hidden(page, "#toolsMenu")
              and await page.evaluate("[...document.querySelectorAll('#toolsMenu .menu-item')].map(b => b.id)") == ["undoBtn", "redoBtn", "historyBtn", "settingsBtn"]
              and await page.evaluate("document.getElementById('gearBtn').getAttribute('aria-expanded')") == "true")
        check("Undo and Redo show their shortcuts", await page.evaluate("[...document.querySelectorAll('#toolsMenu kbd')].map(k => k.textContent)") == ["Ctrl+Z", "Ctrl+Y"])
        await page.click("#portalTitle"); await page.wait_for_timeout(100)
        check("a click elsewhere closes the gear menu", await hidden(page, "#toolsMenu"))
        await page.click("#profileBtn"); await page.wait_for_timeout(200)
        await page.click("#portalTitle"); await page.wait_for_timeout(200)
        check("a click elsewhere closes it", await hidden(page, "#profileDropdown"))
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        await page.keyboard.press("Escape"); await page.wait_for_timeout(100)
        check("so does Escape", await hidden(page, "#profileDropdown"))

        # ---- switch to the public view and back, without signing out
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        await page.evaluate("""async () => { const wed = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date)[3];
            await fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'AVAILABLE', title: 'Available', start: wed + 'T09:00', end: wed + 'T12:00' }) });
            await fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Kai - piano', start: wed + 'T10:00', end: wed + 'T11:00' }) }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)
        check("in Edit view a booked block carries the student's name", "Kai - piano" in (await page.text_content("#calendar")))
        await page.click("#exitAdminBtn"); await page.wait_for_timeout(900)
        check("Public view shows the public page, gear gone", await hidden(page, "#adminBanner") and await hidden(page, "#toolsMenuWrap"))
        check("and really is what a visitor sees: the name is gone, the block is just booked", "Kai - piano" not in (await page.text_content("#calendar"))
              and await page.evaluate("document.querySelectorAll('.event-card').length") >= 2, await page.text_content("#calendar"))
        check("the switch stays, now with Public pressed", not await hidden(page, "#modeSwitch")
              and await page.evaluate("document.getElementById('exitAdminBtn').getAttribute('aria-pressed')") == "true")
        check("and the chip stays, because the device is remembered", not await hidden(page, "#profileMenu") and await hidden(page, "#adminBtn"))
        await page.click("#profileBtn"); await page.wait_for_timeout(200)
        check("the menu now offers Sign out only", await menu_items(page) == ["Sign out"], str(await menu_items(page)))
        check("and says Public view", await page.text_content("#profileMenuMode") == "Public view")
        await page.click("#portalTitle"); await page.wait_for_timeout(100)
        await page.click("#backToAdminBtn"); await page.wait_for_timeout(900)
        check("Edit view returns without a password, names back", not await hidden(page, "#adminBanner") and await hidden(page, "#loginModal")
              and "Kai - piano" in (await page.text_content("#calendar")))

        # ---- Settings changes the name on the chip
        await page.click("#gearBtn"); await page.wait_for_timeout(100)
        await page.click("#settingsBtn"); await page.wait_for_timeout(500)
        check("Settings opens from the gear menu, menu closed", not await hidden(page, "#settingsModal") and await hidden(page, "#toolsMenu"))
        await page.fill("#settingDisplayName", "Maya")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("the chip follows the display name", await page.text_content("#profileInitial") == "M" and await page.text_content("#profileName") == "Maya")

        # ---- Sign out
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        await page.click("#signOutBtn"); await page.wait_for_timeout(700)
        check("Sign out returns to Log in", not await hidden(page, "#adminBtn") and await hidden(page, "#profileMenu") and await hidden(page, "#adminBanner"))

        # ---- a password-only session (box unticked) still gets the chip while in admin
        await page.click("#adminBtn")
        await page.evaluate("document.getElementById('rememberMeInput').checked = false")
        await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("a session without a remembered device shows the chip in admin mode", not await hidden(page, "#profileMenu"))
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        check("its menu offers Sign out, and the gear is back", await menu_items(page) == ["Sign out"] and not await hidden(page, "#toolsMenuWrap"))
        await page.click("#portalTitle"); await page.wait_for_timeout(100)
        await page.click("#exitAdminBtn"); await page.wait_for_timeout(700)
        check("Public view without a remembered device is a plain Log in again, switch gone", not await hidden(page, "#adminBtn") and await hidden(page, "#profileMenu") and await hidden(page, "#modeSwitch"))

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
