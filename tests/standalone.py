#!/usr/bin/env python3
"""A series whittled down to one block is a standalone session: its Delete
is a plain confirmation, not the three scopes. And a standalone block
that sits exactly where a newly added series lands joins that series.

    python3 tests/standalone.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8971
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def rclick_day(page, date):
    await page.evaluate("""(d) => {
        const card = document.querySelector('.day-column[data-date="' + d + '"] .event-card');
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); }""", date)
    await page.wait_for_timeout(250)

async def menu(page):
    return await page.evaluate("[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")

async def click_menu(page, label):
    await page.evaluate("""(label) => [...document.querySelectorAll('.context-menu-item')]
        .find(i => i.textContent.trim() === label).click()""", label)

async def dialog(page):
    await page.wait_for_selector(".choice-modal", timeout=5000)
    return await page.evaluate("""() => ({
        title: document.querySelector('.choice-modal h2').textContent.trim(),
        message: (document.querySelector('.choice-modal .choice-message') || {}).textContent || '',
        radios: document.querySelectorAll('.choice-modal input[type=radio]').length,
        buttons: [...document.querySelectorAll('.choice-modal button')].map(b => b.textContent.trim()) })""")

async def choose_scope(page, label):
    await page.evaluate("""(label) => { [...document.querySelectorAll('.choice-modal .choice-radio-row')]
        .find(r => r.textContent.trim() === label).querySelector('input').click();
        [...document.querySelectorAll('.choice-modal button')].find(b => b.textContent.trim() === 'OK').click(); }""", label)
    await page.wait_for_timeout(900)

async def click_button(page, label):
    await page.evaluate("""(label) => [...document.querySelectorAll('.choice-modal button')]
        .find(b => b.textContent.trim() === label).click()""", label)
    await page.wait_for_timeout(900)

async def cards_on(page, date):
    return await page.evaluate("(d) => document.querySelectorAll('.day-column[data-date=\"' + d + '\"] .event-card').length", date)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 1100})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        d = await page.evaluate("""() => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const shift = (s, n) => { const [y,m,dd] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, dd+n)).toISOString().slice(0,10); };
            const tue = cols.find(x => new Date(x + 'T12:00').getDay() === 2);
            return { tue, tue1: shift(tue, 7), tue2: shift(tue, 14), tue3: shift(tue, 21) }; }""")

        # The reported sequence: Tuesdays from this week; "this and following"
        # from the third week; "this event only" on the first. One block left.
        await page.evaluate("""async (tue) => fetch('/api/events', { method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
            body: JSON.stringify({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: tue + 'T16:00', end: tue + 'T17:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2], endType: 'NEVER' } }) })""", d["tue"])
        await page.click("#nextWeekBtn"); await page.click("#nextWeekBtn"); await page.wait_for_timeout(800)
        await rclick_day(page, d["tue2"])
        await click_menu(page, "Delete…")
        dlg = await dialog(page)
        check("a series block says it is part of a repeating series, then offers the three scopes",
              dlg["title"] == "Delete recurring event" and "part of a repeating series" in dlg["message"] and dlg["radios"] == 3, str(dlg))
        await choose_scope(page, "This and following events")
        await page.click("#todayBtn"); await page.wait_for_timeout(800)
        await rclick_day(page, d["tue"])
        await click_menu(page, "Delete…")
        await dialog(page)
        await choose_scope(page, "This event only")
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(800)
        check("only the second Tuesday is left", await cards_on(page, d["tue1"]) == 1)

        # ---- it is a standalone now: plain Delete, plain confirmation
        await rclick_day(page, d["tue1"])
        items = await menu(page)
        check("its menu says Delete, not Delete…", "Delete" in items and "Delete…" not in items, str(items))
        await click_menu(page, "Delete")
        dlg = await dialog(page)
        check("Delete asks for a plain yes, no scopes", dlg["radios"] == 0 and dlg["title"].startswith("Delete this event")
              and "Delete" in dlg["buttons"], str(dlg))
        await click_button(page, "Cancel")
        check("cancelled: still there", await cards_on(page, d["tue1"]) == 1)

        # the editor agrees: it is "Edit event", and its Delete is the plain kind
        await page.locator(f'.day-column[data-date="{d["tue1"]}"] .event-card').click(); await page.wait_for_timeout(400)
        title = await page.text_content("#eventModalTitle")
        check("the editor opens it as a one-time session", title.strip() == "Edit event", title)
        await page.click("#deleteEventBtn")
        dlg = await dialog(page)
        check("the editor's Delete is a plain confirmation too", dlg["radios"] == 0, str(dlg))
        await click_button(page, "Cancel")
        await page.click("[data-close='eventModal']"); await page.wait_for_timeout(300)

        # ---- now add a matching series from the fourth Tuesday: the block joins it
        await page.evaluate("""async (tue3) => fetch('/api/events', { method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-password': 't', 'x-action-label': 'add session'},
            body: JSON.stringify({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: tue3 + 'T16:00', end: tue3 + 'T17:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2], endType: 'NEVER' } }) })""", d["tue3"])
        await page.click("#todayBtn"); await page.click("#nextWeekBtn"); await page.wait_for_timeout(800)
        check("the standalone week is still there", await cards_on(page, d["tue1"]) == 1)
        await rclick_day(page, d["tue1"])
        items = await menu(page)
        check("and it is now part of the series: Delete… again", "Delete…" in items, str(items))
        await click_menu(page, "Delete…")
        dlg = await dialog(page)
        check("with the three scopes and the series note", dlg["radios"] == 3 and "part of a repeating series" in dlg["message"], str(dlg))
        await click_button(page, "Cancel")
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        check("the week that was deleted in between stays empty", await cards_on(page, d["tue2"]) == 0)
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        check("the series runs from its own start as well", await cards_on(page, d["tue3"]) == 1)
        stored = await page.evaluate("""async (dates) => {
            const r = await fetch(`/api/events?start=${dates.tue1}&end=${dates.tue3}`, { headers: { 'x-admin-password': 't' } });
            const evs = (await r.json()).events; return { n: evs.length, masters: [...new Set(evs.map(e => e.masterId || e.id))].length }; }""", d)
        check("one series behind both blocks, not a series plus a standalone", stored["n"] == 2 and stored["masters"] == 1, str(stored))

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
