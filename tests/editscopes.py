#!/usr/bin/env python3
"""Editing a repeating block through the editor asks the same radio
scope question saving does at Google: change one week's time alone,
change from here on, or change the whole series without re-anchoring
its history.

    python3 tests/editscopes.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8947
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def rclick_weekday(page, wd):
    await page.evaluate("""(wd) => {
        const card = [...document.querySelectorAll('.event-card')].find(c =>
            new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === wd);
        card.dispatchEvent(new MouseEvent('contextmenu',
            { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    }""", wd)
    await page.wait_for_timeout(250)

async def click_menu(page, label):
    await page.evaluate(
        """(label) => [...document.querySelectorAll('.context-menu-item')]
            .find(i => i.textContent.trim() === label).click()""", label)
    await page.wait_for_timeout(400)

async def set_time(page, which, hour, rest):
    await page.click(f"#event{which}Hour")
    await page.keyboard.type(hour)
    await page.keyboard.type(rest)
    await page.wait_for_timeout(200)

async def choose_scope(page, label):
    await page.wait_for_selector(".choice-modal")
    await page.evaluate(
        """(label) => [...document.querySelectorAll('.choice-modal .choice-radio-row')]
            .find(r => r.textContent.trim() === label)
            .querySelector('input').click()""", label)
    await page.evaluate(
        """() => [...document.querySelectorAll('.choice-modal button')]
            .find(b => b.textContent.trim() === 'OK').click()""")
    await page.wait_for_timeout(900)

async def fetch_week(page, start, end):
    return await page.evaluate("""async ([start, end]) => {
        const r = await fetch(`/api/events?start=${start}&end=${end}`,
            { headers: { 'x-admin-password': 't' } });
        return (await r.json()).events;
    }""", [start, end])

def starts(evs):
    return sorted(e["start"] for e in evs)

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

        dates = await page.evaluate("""() => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const shift = (s, n) => { const [y,m,d] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const thu = cols.find(d => new Date(d + 'T12:00').getDay() === 4);
            return { tue, thu, lastTue: shift(tue, -7), lastThu: shift(thu, -7),
                     nextTue: shift(tue, 7), nextThu: shift(thu, 7),
                     weekStart: cols[0], weekEnd: cols[6],
                     nextStart: shift(cols[0], 7), nextEnd: shift(cols[6], 7),
                     lastStart: shift(cols[0], -7), lastEnd: shift(cols[6], -7) };
        }""")
        await page.evaluate("""async (anchor) => {
            await fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Maya - Algebra II',
                    start: anchor + 'T16:00', end: anchor + 'T17:00',
                    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4],
                                  endType: 'NEVER' } }) });
        }""", dates["lastTue"])
        await page.reload(wait_until="networkidle")
        # the device was remembered at login, so the reload comes back in admin mode
        await page.wait_for_timeout(800)

        # ---- This event only: Thursday 4 PM becomes 5-6 PM for one week.
        await rclick_weekday(page, 4)
        items = await page.evaluate(
            "[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")
        check("series menu says plain Edit now",
              items == ["Edit", "Customize", "Duplicate", "Copy", "Delete…"], str(items))
        # Close the menu and reach the editor the short way instead: a
        # left-click on the session itself, which must carry the same
        # occurrence the right-click menu would have.
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)
        await page.evaluate("""() => {
            const card = [...document.querySelectorAll('.event-card')].find(c =>
                new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === 4);
            card.click();
        }""")
        await page.wait_for_timeout(400)
        opened = await page.evaluate("""() => ({
            open: !document.getElementById('eventModal').classList.contains('hidden'),
            title: document.getElementById('eventModalTitle').textContent.trim() })""")
        check("left-clicking a recurring session opens the series editor",
              opened["open"] and opened["title"] == "Edit recurring event", str(opened))
        form_date = await page.evaluate("document.getElementById('eventStartDate').value")
        check("the editor opens on the clicked week's date", form_date == dates["thu"], form_date)
        await set_time(page, "Start", "5", "00p")
        await set_time(page, "End", "6", "00p")
        await page.click("#saveEventBtn")
        await page.wait_for_selector(".choice-modal")
        heading = await page.text_content(".choice-modal h2")
        check("saving a series asks with the calendar dialog",
              heading == "Edit recurring event", heading)
        await choose_scope(page, "This event only")
        status = await page.text_content("#status")
        check("status says one week changed alone", "changed on its own" in status, status)
        ev = await fetch_week(page, dates["weekStart"], dates["weekEnd"])
        loose = [e for e in ev if not e.get("recurrence")]
        check("the week's Thursday runs 5-6 as a one-off", len(loose) == 1
              and loose[0]["start"] == dates["thu"] + "T17:00"
              and loose[0]["end"] == dates["thu"] + "T18:00", str(starts(ev)))
        check("Tuesday this week is untouched", any(
              e["start"] == dates["tue"] + "T16:00" for e in ev), str(starts(ev)))
        ev = await fetch_week(page, dates["nextStart"], dates["nextEnd"])
        check("next week keeps 4 PM on both days",
              starts(ev) == [dates["nextTue"] + "T16:00", dates["nextThu"] + "T16:00"],
              str(starts(ev)))

        # ---- This and following: from next Tuesday the series runs 3-4 PM.
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        await rclick_weekday(page, 2)
        await click_menu(page, "Edit")
        await set_time(page, "Start", "3", "00p")
        await set_time(page, "End", "4", "00p")
        await page.click("#saveEventBtn")
        await choose_scope(page, "This and following events")
        ev = await fetch_week(page, dates["nextStart"], dates["nextEnd"])
        check("next week runs 3 PM on both days",
              starts(ev) == [dates["nextTue"] + "T15:00", dates["nextThu"] + "T15:00"],
              str(starts(ev)))
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        ev = await fetch_week(page, dates["weekStart"], dates["weekEnd"])
        check("this week still runs 4 PM plus the one-off", sorted(
              e["start"][11:] for e in ev) == ["16:00", "17:00"], str(starts(ev)))

        # ---- All events: the old series moves to 2-3 PM, history included.
        await rclick_weekday(page, 2)
        await click_menu(page, "Edit")
        await set_time(page, "Start", "2", "00p")
        await set_time(page, "End", "3", "00p")
        await page.click("#saveEventBtn")
        await choose_scope(page, "All events, past and future")
        status = await page.text_content("#status")
        check("status owns the whole series", "whole series changed" in status, status)
        ev = await fetch_week(page, dates["weekStart"], dates["weekEnd"])
        series_now = [e for e in ev if e.get("recurrence")]
        check("this week's Tuesday runs 2 PM, Thursday stays skipped",
              starts(series_now) == [dates["tue"] + "T14:00"], str(starts(ev)))
        ev = await fetch_week(page, dates["lastStart"], dates["lastEnd"])
        check("last week moved with it - the anchor never re-anchored",
              starts(ev) == [dates["lastTue"] + "T14:00", dates["lastThu"] + "T14:00"],
              str(starts(ev)))

        # ---- Adding a weekday that clashes with another session warns, and Save anyway goes through.
        this_wed = await page.evaluate("""(tue) => { const [y,m,d] = tue.split('-').map(Number);
            return new Date(Date.UTC(y, m-1, d+1)).toISOString().slice(0,10); }""", dates["tue"])
        await page.evaluate("""async (wed) => {
            await fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Leo - piano', start: wed + 'T14:00', end: wed + 'T15:00' }) });
        }""", this_wed)
        await rclick_weekday(page, 2)
        await click_menu(page, "Edit")
        await page.click("#weekdayPicker .weekday-btn[data-day='3']"); await page.wait_for_timeout(100)
        await page.click("#saveEventBtn")
        await choose_scope(page, "All events, past and future")
        warned = await page.evaluate("""() => ({
            open: !document.getElementById('eventModal').classList.contains('hidden'),
            warning: !document.getElementById('conflictWarning').classList.contains('hidden'),
            summary: document.getElementById('conflictWarningSummary').textContent.trim(),
            items: [...document.querySelectorAll('#conflictWarningList .conflict-item')].map(i => i.textContent.replace(/\s+/g, ' ').trim()),
            saveHidden: document.getElementById('saveEventBtn').classList.contains('hidden'),
            anyway: !document.getElementById('saveAnywayBtn').classList.contains('hidden'),
            error: document.getElementById('eventError').textContent.trim() })""")
        check("a series edit that would overlap is a warning in the form, not a refusal",
              warned["open"] and warned["warning"] and warned["error"] == "" and "overlaps" in warned["summary"], str(warned))
        check("which names the session it clashes with and when", len(warned["items"]) == 1
              and warned["items"][0].startswith("Leo - piano") and "2" in warned["items"][0] and "3" in warned["items"][0], str(warned["items"]))
        check("and offers Save anyway in place of Save", warned["saveHidden"] and warned["anyway"], str(warned))
        await page.click("#saveAnywayBtn"); await page.wait_for_timeout(1200)
        status = await page.text_content("#status")
        check("Save anyway saves the whole series with the new weekday", "whole series changed" in status
              and await page.evaluate("document.getElementById('eventModal').classList.contains('hidden')"), status)
        ev = await fetch_week(page, dates["weekStart"], dates["weekEnd"])
        check("this week has the series on Tue and Wed at 2 PM (Thu still the 5 PM one-off), and Leo still on Wednesday",
              starts(ev) == [dates["tue"] + "T14:00", this_wed + "T14:00", this_wed + "T14:00", dates["thu"] + "T17:00"], str(starts(ev)))

        # the 409 the overlap check answers with is the browser logging a response, not a fault
        real = [e for e in errs if "fonts" not in e and "favicon" not in e and "409" not in e]
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
