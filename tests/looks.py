#!/usr/bin/env python3
"""Looks: the week can start on Monday, the clock can be 24-hour (labels,
cards and the time fields follow), the typeface is a choice, and a
wording preset fills in the names.

    python3 tests/looks.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8994
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def day_names(page):
    return await page.evaluate("[...document.querySelectorAll('.day-column')].map(c => new Date(c.dataset.date + 'T12:00').getDay())")

async def hour_labels(page):
    return await page.evaluate("[...document.querySelectorAll('.time-label')].map(l => l.textContent.trim()).filter(Boolean)")

async def open_settings(page):
    await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)

async def save_settings(page):
    await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            await fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Noah', start: tue + 'T15:00', end: tue + 'T16:30' }) });
        }""")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)

        check("the week starts on Sunday by default", (await day_names(page))[:2] == [0, 1])
        labels = await hour_labels(page)
        check("hour labels read as 12-hour times", "8 AM" in labels and "3 PM" in labels, str(labels[:5]))
        card = await page.evaluate("document.querySelector('.event-card').textContent")
        check("a card reads 3 – 4:30 PM", "3 – 4:30 PM" in card, card)
        check("the page uses the default typeface", await page.evaluate("document.documentElement.getAttribute('data-font')") is None)

        # ---- Monday, 24-hour, serif
        await open_settings(page)
        check("the dialog offers the week start, the clock and the typeface",
              await page.evaluate("document.getElementById('settingWeekStart').value") == "0"
              and await page.evaluate("document.getElementById('settingHourFormat').value") == "12"
              and await page.evaluate("document.getElementById('settingFont').value") == "system")
        await page.select_option("#settingWeekStart", "1")
        await page.select_option("#settingHourFormat", "24")
        await page.select_option("#settingFont", "serif")
        await save_settings(page)
        check("the week now starts on Monday and ends on Sunday", (await day_names(page)) == [1, 2, 3, 4, 5, 6, 0], str(await day_names(page)))
        labels = await hour_labels(page)
        check("hour labels read as 24-hour times", "08:00" in labels and "15:00" in labels and "3 PM" not in labels, str(labels[:5]))
        card = await page.evaluate("document.querySelector('.event-card').textContent")
        check("the card reads 15:00 – 16:30", "15:00 – 16:30" in card, card)
        check("the serif typeface is on", await page.evaluate("document.documentElement.getAttribute('data-font')") == "serif"
              and "Georgia" in await page.evaluate("getComputedStyle(document.body).fontFamily"))
        check("the status line says Settings saved", (await page.text_content("#status")).startswith("Settings saved"))

        # the editor's time fields follow the clock
        await page.click(".event-card"); await page.wait_for_timeout(400)
        check("the editor shows 15:00 with no AM/PM segment",
              await page.input_value("#eventStartHour") == "15" and await page.input_value("#eventStartMinute") == "00"
              and not await page.is_visible("#eventStartMeridiem"))
        await page.focus("#eventStartHour"); await page.keyboard.press("Control+A"); await page.keyboard.type("14"); await page.wait_for_timeout(100)
        check("typing 14 moves on to the minutes and keeps the value", await page.evaluate("document.activeElement.id") == "eventStartMinute"
              and await page.evaluate("document.getElementById('eventStartTime').value") == "14:00",
              await page.evaluate("document.activeElement.id + ' ' + document.getElementById('eventStartTime').value + ' ' + document.getElementById('eventStartHour').value"))
        await page.evaluate("document.querySelector('#eventModal [data-close]').click()")

        # the hour lists in Settings follow too
        await open_settings(page)
        check("the hour lists read as 24-hour times", await page.evaluate("[...document.querySelectorAll('#settingDayEnd option')].pop().textContent") == "24:00 (midnight)"
              and await page.evaluate("document.querySelector('#settingDayStart option[value=\"8\"]').textContent") == "08:00")

        # ---- a wording preset
        await page.select_option("#settingPreset", "lessons"); await page.wait_for_timeout(100)
        check("a preset fills in the four names", await page.input_value("#settingLabelAvailable") == "Open" and await page.input_value("#settingLabelBlocked") == "Lesson"
              and await page.input_value("#settingLabelPerson") == "pupil" and await page.input_value("#settingLabelPeople") == "pupils")
        await page.fill("#settingLabelBlocked", "Piano lesson")
        await save_settings(page)
        check("edited after the preset, the names are what was typed", await page.text_content("#legendBlocked") == "Piano lesson" and await page.text_content("#legendAvailable") == "Open")

        # ---- back to Sunday and 12-hour
        await open_settings(page)
        await page.select_option("#settingWeekStart", "0"); await page.select_option("#settingHourFormat", "12"); await page.select_option("#settingFont", "system")
        await save_settings(page)
        check("and back again", (await day_names(page))[:2] == [0, 1] and "8 AM" in await hour_labels(page)
              and await page.evaluate("document.documentElement.getAttribute('data-font')") is None)

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
