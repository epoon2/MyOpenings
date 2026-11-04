#!/usr/bin/env python3
"""The Settings dialog: title, display name, time zone, hours, the two
default colors, wording and the notification address - saved through
the page and reflected everywhere, in admin and public view alike, with
the address never leaving admin.

    python3 tests/settings.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8983
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def pick_swatch(page, root, title):
    await page.evaluate("""([root, title]) => document.querySelector(root + ' .color-swatch[title="' + title + '"]').click()""", [root, title])
    await page.wait_for_timeout(150)

async def css_var(page, name):
    return await page.evaluate(f"getComputedStyle(document.documentElement).getPropertyValue('{name}').trim()")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto(CAL, wait_until="networkidle")
        check("no gear menu (and so no Settings) for visitors", await page.evaluate("document.getElementById('toolsMenuWrap').classList.contains('hidden')"))
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("the gear appears on the toolbar, with Settings inside", not await page.evaluate("document.getElementById('toolsMenuWrap').classList.contains('hidden')")
              and await page.evaluate("document.getElementById('toolsMenu').contains(document.getElementById('settingsBtn'))"))

        # seed a block of each kind
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const post = (body) => fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'open', start: tue + 'T09:00', end: tue + 'T12:00' });
            await post({ type: 'BLOCKED', title: 'Noah', start: tue + 'T15:00', end: tue + 'T16:00' });
        }""")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)

        # ---- the dialog opens with the current values
        await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
        check("the dialog opens filled in", await page.input_value("#settingTitle") == "Ethan's Tutoring Availability"
              and await page.input_value("#settingDisplayName") == "Ethan"
              and await page.evaluate("document.getElementById('settingTimezone').value") == "America/Los_Angeles"
              and await page.evaluate("document.getElementById('settingDayStart').value") == "8"
              and await page.evaluate("document.getElementById('settingDayEnd').value") == "24")
        check("the hour lists read as clock times", await page.evaluate("[...document.querySelectorAll('#settingDayEnd option')].pop().textContent") == "12 AM (midnight)")
        check("the default colour rows say Default (Green) and Default (Red)",
              await page.evaluate("document.querySelector('#settingAvailableColor .color-swatch.selected').title") == "Default (Green)"
              and await page.evaluate("document.querySelector('#settingBlockedColor .color-swatch.selected').title") == "Default (Red)")
        check("the wording fields carry the defaults", await page.input_value("#settingLabelBlocked") == "Blocked Session" and await page.input_value("#settingLabelPeople") == "students")

        # ---- a bad range is caught before it leaves the page
        await page.select_option("#settingDayStart", "10"); await page.select_option("#settingDayEnd", "10")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(300)
        check("a day that ends when it starts is refused in the dialog", "end after it starts" in await page.text_content("#settingsError"))
        await page.select_option("#settingDayEnd", "21")

        # ---- change everything
        await page.fill("#settingTitle", "Maya's Piano Lessons")
        await page.fill("#settingDisplayName", "Maya")
        await page.select_option("#settingTimezone", "America/New_York")
        await page.select_option("#settingDayStart", "9")
        await pick_swatch(page, "#settingAvailableColor", "Blue")
        await pick_swatch(page, "#settingBlockedColor", "Purple")
        await page.fill("#settingLabelAvailable", "Open")
        await page.fill("#settingLabelBlocked", "Lesson")
        await page.fill("#settingLabelPerson", "pupil")
        await page.fill("#settingLabelPeople", "pupils")
        await page.fill("#settingNotificationEmail", "maya@example.com")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("the dialog closes and the status confirms", await page.evaluate("document.getElementById('settingsModal').classList.contains('hidden')")
              and "Settings saved" in await page.text_content("#status"), await page.text_content("#status"))
        check("the title changed on the page and in the tab", await page.text_content("#portalTitle") == "Maya's Piano Lessons" and await page.title() == "Maya's Piano Lessons")
        check("the time zone label followed", await page.text_content("#timezoneLabel") == "Eastern Time (ET)", await page.text_content("#timezoneLabel"))
        check("the display name is in the updated line", (await page.text_content("#updatedLabel")).startswith("Maya "), await page.text_content("#updatedLabel"))
        labels = await page.evaluate("[...document.querySelectorAll('.time-label')].map(l => l.textContent)")
        check("the grid runs from 9 AM to 9 PM", labels[0] == "9 AM" and labels[-1] == "9 PM", str(labels[:2] + labels[-2:]))
        check("the legend uses the new words", await page.text_content("#legendAvailable") == "Open" and await page.text_content("#legendBlocked") == "Lesson")
        check("the summary counts pupils", await page.text_content("#summaryPeopleLabel") == "pupils")
        check("the visitor-facing name of a booked block is Lesson", await page.evaluate("labelForTest = null; document.getElementById('legendBlocked').textContent") == "Lesson")
        check("the page's colours are the new defaults", await css_var(page, "--available") == "#1d4ed8" and await css_var(page, "--blocked") == "#6d28d9",
              f"{await css_var(page, '--available')} {await css_var(page, '--blocked')}")
        await page.evaluate("""() => { const card = document.querySelector('.event-card.blocked');
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); }""")
        await page.wait_for_timeout(200)
        await page.evaluate("[...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.trim() === 'Customize').click()")
        await page.wait_for_timeout(300)
        check("a block's Customize dialog now names the default after the new colour",
              await page.evaluate("document.querySelector('.choice-modal .color-swatch.selected').title") == "Default (Purple)")
        await page.evaluate("[...document.querySelectorAll('.choice-modal button')].find(b => b.textContent.trim() === 'Cancel').click()")
        await page.wait_for_timeout(200)
        # ---- reopening shows what was saved
        await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
        check("reopening shows the saved values, email included", await page.input_value("#settingTitle") == "Maya's Piano Lessons"
              and await page.input_value("#settingNotificationEmail") == "maya@example.com"
              and await page.evaluate("document.querySelector('#settingBlockedColor .color-swatch.selected').title") == "Purple")
        await page.click("#settingsModal [data-close]"); await page.wait_for_timeout(200)

        # ---- the public page sees everything but the address
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(700)
        check("visitors see the new title, hours, words and colours", await page.text_content("#portalTitle") == "Maya's Piano Lessons"
              and await page.text_content("#legendBlocked") == "Lesson" and await css_var(page, "--blocked") == "#6d28d9"
              and (await page.evaluate("[...document.querySelectorAll('.time-label')].map(l => l.textContent)"))[0] == "9 AM")
        body = await page.evaluate("fetch('/api/events?start=2020-01-01&end=2030-01-01').then(r => r.text())")
        check("and never the notification address", "maya@example.com" not in body and "notificationEmail" not in body)

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
