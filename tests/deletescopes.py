#!/usr/bin/env python3
"""Walks all three reaches of deleting from a weekly series, in a real
browser, through the in-page dialog: one block, this-and-following, whole
series - from the right-click menu and from the editor.

    python3 tests/deletescopes.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8943
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def menu_items(page):
    return await page.evaluate(
        "[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")

async def click_menu(page, label):
    await page.evaluate(
        """(label) => [...document.querySelectorAll('.context-menu-item')]
            .find(i => i.textContent.trim() === label).click()""", label)

async def click_choice(page, prefix):
    await page.wait_for_selector(".choice-modal")
    await page.evaluate(
        """(prefix) => [...document.querySelectorAll('.choice-modal button')]
            .find(b => b.textContent.trim().startsWith(prefix)).click()""", prefix)
    await page.wait_for_timeout(800)

async def choose_scope(page, label):
    await page.wait_for_selector(".choice-modal")
    await page.evaluate(
        """(label) => [...document.querySelectorAll('.choice-modal .choice-radio-row')]
            .find(r => r.textContent.trim() === label)
            .querySelector('input').click()""", label)
    await page.evaluate(
        """() => [...document.querySelectorAll('.choice-modal button')]
            .find(b => b.textContent.trim() === 'OK').click()""")
    await page.wait_for_timeout(800)

async def cards(page):
    return await page.locator(".event-card").count()

async def card_weekdays(page):
    return await page.evaluate("""() =>
        [...document.querySelectorAll('.event-card')].map(card =>
            new Date(card.closest('.day-column').dataset.date + 'T12:00').getDay())""")

async def rclick_weekday(page, wd):
    await page.evaluate("""(wd) => {
        const card = [...document.querySelectorAll('.event-card')].find(c =>
            new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === wd);
        card.dispatchEvent(new MouseEvent('contextmenu',
            { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    }""", wd)
    await page.wait_for_timeout(250)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # Seed: a Tue/Thu series anchored LAST week's Tuesday, so real
        # history exists before the viewed week, plus one loose Friday
        # event for the plain-delete dialog.
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const fri = cols.find(d => new Date(d + 'T12:00').getDay() === 5);
            const shift = (s, n) => { const [y,m,d] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
            const anchor = shift(tue, -7);
            const post = (body) => fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify(body) });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: anchor + 'T16:00', end: anchor + 'T17:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } });
            await post({ type: 'BLOCKED', title: 'One-off',
                start: fri + 'T15:00', end: fri + 'T16:00' });
        }""")
        await page.reload(wait_until="networkidle")
        # the device was remembered at login, so the reload comes back in admin mode
        await page.wait_for_timeout(800)

        check("this week renders Tue, Thu and the one-off", await cards(page) == 3,
              f"cards={await cards(page)}")

        # ---- plain delete of a one-time event goes through the site dialog
        await rclick_weekday(page, 5)
        items = await menu_items(page)
        check("one-time menu unchanged", items[:5] == ["Edit", "Customize", "Duplicate", "Copy", "Delete"], str(items))
        await click_menu(page, "Delete")
        await page.wait_for_selector(".choice-modal")
        await click_choice(page, "Delete")
        check("one-off deleted through the page's own dialog", await cards(page) == 2,
              f"cards={await cards(page)}")

        # ---- recurring menu offers Delete…, and no Skip item
        await rclick_weekday(page, 4)
        items = await menu_items(page)
        check("series menu reads Edit/Customize/Duplicate/Copy/Delete…",
              items == ["Edit", "Customize", "Duplicate", "Copy", "Delete…"], str(items))
        check("no Skip item remains", not any(i.startswith("Skip") for i in items), str(items))

        # ---- scope: just this block (the Thursday)
        await click_menu(page, "Delete…")
        await page.wait_for_selector(".choice-modal")
        heading = await page.text_content(".choice-modal h2")
        check("the delete dialog is titled like a calendar's",
              heading == "Delete recurring event", heading)
        radios = await page.locator(".choice-modal input[type=radio]").count()
        buttons = await page.evaluate(
            "[...document.querySelectorAll('.choice-modal button')].map(b => b.textContent.trim())")
        # a Tue/Thu series also offers "All Thursdays"
        check("four radio scopes with Cancel and OK", radios == 4
              and buttons == ["Cancel", "OK"], f"radios={radios} buttons={buttons}")
        await choose_scope(page, "This event only")
        wds = await card_weekdays(page)
        check("this week keeps only the Tuesday", wds == [2], str(wds))
        status = await page.text_content("#status")
        check("status says the other weeks survive", "Every other week keeps this session" in status, status)
        await page.click("#prevWeekBtn"); await page.wait_for_timeout(700)
        check("last week still has both", await cards(page) == 2, f"cards={await cards(page)}")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)

        # ---- scope: this and every one after (next week's Tuesday)
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        check("next week still has both before the cut", await cards(page) == 2,
              f"cards={await cards(page)}")
        await rclick_weekday(page, 2)
        await click_menu(page, "Delete…")
        await choose_scope(page, "This and following events")
        check("next week is emptied from the cut", await cards(page) == 0,
              f"cards={await cards(page)}")
        status = await page.text_content("#status")
        check("status protects the earlier weeks", "Earlier weeks are untouched" in status, status)
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        check("the week after stays empty", await cards(page) == 0, f"cards={await cards(page)}")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        wds = await card_weekdays(page)
        check("this week's Tuesday survived the cut", wds == [2], str(wds))
        await page.click("#prevWeekBtn"); await page.wait_for_timeout(700)
        check("history before the cut is untouched", await cards(page) == 2,
              f"cards={await cards(page)}")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)

        # ---- scope: the whole series, reached from the editor
        await rclick_weekday(page, 2)
        await click_menu(page, "Edit")
        await page.wait_for_timeout(400)
        modal_open = await page.evaluate(
            "!document.getElementById('eventModal').classList.contains('hidden')")
        check("editor opens for the series", modal_open)
        await page.click("#deleteEventBtn")
        await choose_scope(page, "All events, past and future")
        modal_gone = await page.evaluate(
            "document.getElementById('eventModal').classList.contains('hidden')")
        check("editor closes after choosing", modal_gone)
        check("this week is empty", await cards(page) == 0, f"cards={await cards(page)}")
        await page.click("#prevWeekBtn"); await page.wait_for_timeout(700)
        check("the past weeks are gone too", await cards(page) == 0, f"cards={await cards(page)}")

        # ---- the reported bug: a weekly AVAILABILITY block wrapping a
        # booked session. Deleting part of it re-saves the shortened
        # series, which used to be refused as "overlaps an existing
        # blocked session" - availability spanning sessions is the
        # normal shape here, not a clash.
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        wed = await page.evaluate(
            "[...document.querySelectorAll('.day-column')].map(c => c.dataset.date)"
            ".find(d => new Date(d + 'T12:00').getDay() === 3)")
        await page.evaluate(
            "async (wed) => {"
            "  const post = (body) => fetch('/api/events', { method: 'POST',"
            "    headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},"
            "    body: JSON.stringify(body) });"
            "  await post({ type: 'AVAILABLE', title: 'Open',"
            "    start: wed + 'T09:00', end: wed + 'T12:00',"
            "    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [3], endType: 'NEVER' } });"
            "  await post({ type: 'BLOCKED', title: 'Noah - Geometry',"
            "    start: wed + 'T10:00', end: wed + 'T11:00',"
            "    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [3], endType: 'NEVER' } });"
            "}", wed)
        await page.click("#todayBtn"); await page.wait_for_timeout(800)

        # Right-click the AVAILABILITY card specifically: blocked cards are
        # drawn first, so "the first card in the column" is the session.
        opened = await page.evaluate(
            "(wed) => {"
            "  const card = document.querySelector("
            "    '.day-column[data-date=\"' + wed + '\"] .event-card.available');"
            "  if (!card) return false;"
            "  card.dispatchEvent(new MouseEvent('contextmenu',"
            "    { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));"
            "  return true;"
            "}", wed)
        await page.wait_for_timeout(300)
        check("the availability block is on screen with its own menu", opened)
        await click_menu(page, "Delete…")
        await choose_scope(page, "This and following events")
        status = await page.text_content("#status")
        check("deleting availability that wraps a session is not refused",
              "overlap" not in status.lower(), status)
        left = await page.evaluate(
            "async (wed) => {"
            "  const r = await fetch('/api/events?start=' + wed + '&end=' + wed,"
            "    { headers: { 'x-admin-password': 't' } });"
            "  const evs = (await r.json()).events;"
            "  return { available: evs.filter(e => e.type === 'AVAILABLE').length,"
            "           blocked: evs.filter(e => e.type === 'BLOCKED').length };"
            "}", wed)
        check("the availability is gone and the session it wrapped survives",
              left["available"] == 0 and left["blocked"] == 1, str(left))

        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check("no console errors", not real, str(real[:3]))

        print(f"\n{len(oks)} passed, {len(fails)} failed")
        await b.close()
        return 1 if fails else 0

def run():
    subprocess.run(["node", "tests/install-shim.mjs"], check=True)
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/index.html", timeout=1).read()
            break
        except Exception:
            time.sleep(0.2)
    else:
        print("server failed:", server.stderr.read().decode()[:400]); return 1
    try:
        return asyncio.run(main())
    finally:
        server.terminate()

sys.exit(run())
