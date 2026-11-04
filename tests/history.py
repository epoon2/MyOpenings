#!/usr/bin/env python3
"""The Version history drawer: the schedule at every save, newest first,
"Restore this version" making an earlier one current again as a new
save, and "Restore just this" putting one deleted session back.

    python3 tests/history.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8967
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def cards(page):
    return await page.locator(".event-card").count()

async def steps(page):
    return await page.evaluate("""() => [...document.querySelectorAll('#historyList .history-step')].map(s => ({
        label: s.querySelector('.history-step-label').textContent.trim(),
        when: s.querySelector('.history-step-when').textContent.trim(),
        lines: [...s.querySelectorAll('.history-change')].map(l => l.textContent.replace(/\\s+/g, ' ').trim()),
        buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()) }))""")

async def post(page, body, label):
    return await page.evaluate("""async ([body, label]) => {
        const r = await fetch('/api/events', { method: 'POST',
            headers: {'Content-Type': 'application/json', 'x-admin-password': 't', 'x-action-label': label},
            body: JSON.stringify(body) });
        return (await r.json()).id; }""", [body, label])

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 1000})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # ---- empty history reads as such
        await page.evaluate("document.getElementById('historyBtn').click()"); await page.wait_for_timeout(500)
        shown = await page.evaluate("!document.getElementById('historyDrawerBackdrop').classList.contains('hidden')")
        empty = await page.text_content("#historyList")
        check("Version history opens and says only the current version exists", shown and "Only the current version" in empty, empty[:80])
        await page.click("#closeHistoryDrawerBtn"); await page.wait_for_timeout(300)

        # ---- three steps: a series, a one-off, and a delete of the series
        dates = await page.evaluate("""() => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            return { tue: cols.find(d => new Date(d + 'T12:00').getDay() === 2),
                     wed: cols.find(d => new Date(d + 'T12:00').getDay() === 3) }; }""")
        maya = await post(page, { "type": "BLOCKED", "title": "Maya - Algebra II",
            "start": dates["tue"] + "T16:00", "end": dates["tue"] + "T17:00",
            "recurrence": { "frequency": "WEEKLY", "interval": 1, "weekdays": [2, 4], "endType": "NEVER" } }, "add session")
        noah = await post(page, { "type": "BLOCKED", "title": "Noah", "notes": "",
            "start": dates["wed"] + "T10:00", "end": dates["wed"] + "T11:00", "recurrence": None }, "add session")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        check("three cards on the week (Tue, Thu, Wed)", await cards(page) == 3, f"cards={await cards(page)}")

        # delete the series through the UI so the label is the real one
        await page.evaluate("""() => {
            const card = [...document.querySelectorAll('.event-card')].find(c =>
                new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === 2);
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); }""")
        await page.wait_for_timeout(250)
        await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.trim() === 'Delete…').click()""")
        await page.wait_for_selector(".choice-modal")
        await page.evaluate("""() => { [...document.querySelectorAll('.choice-modal .choice-radio-row')]
            .find(r => r.textContent.trim() === 'All events, past and future').querySelector('input').click();
            [...document.querySelectorAll('.choice-modal button')].find(b => b.textContent.trim() === 'OK').click(); }""")
        await page.wait_for_timeout(900)
        check("the series is gone, Noah stays", await cards(page) == 1, f"cards={await cards(page)}")

        # ---- the version list: current on top, then the schedule at each earlier save
        await page.evaluate("document.getElementById('historyBtn').click()"); await page.wait_for_timeout(600)
        rows = await steps(page)
        check("four rows: the current version, one per save, and the state before it all",
              [r["label"] for r in rows][:1] == ["Current version"] and len(rows) == 4
              and rows[3]["label"] == "Before recorded history", str([r["label"] for r in rows]))
        check("each version says what its save changed, in the corner",
              [r["when"] for r in rows] == ["Delete the whole series", "Add session", "Add session", ""], str([r["when"] for r in rows]))
        check("earlier versions are timestamped", all(r["label"].startswith("Today,") for r in rows[1:3]), str([r["label"] for r in rows]))
        top = rows[0]
        check("the current version lists the deletion that made it, with the series' days and rule",
              len(top["lines"]) == 1 and "removed" in top["lines"][0] and "Maya - Algebra II" in top["lines"][0]
              and "4 – 5 PM" in top["lines"][0] and "weekly on Tue, Thu" in top["lines"][0], str(top["lines"]))
        check("the current version cannot be restored; the others can",
              top["buttons"] == ["Restore just this"]
              and all(r["buttons"] == ["Restore this version"] for r in rows[1:]), str([r["buttons"] for r in rows]))

        # ---- restore the version before the delete: the row right below
        await page.click("#historyList .history-step:nth-child(2) .history-step-actions button"); await page.wait_for_timeout(1200)
        check("restoring the earlier version brings the series back beside Noah", await cards(page) == 3, f"cards={await cards(page)}")
        status = await page.text_content("#status")
        check("the status names the version", status.startswith("Restored the version from Today,"), status)
        rows = await steps(page)
        check("the restore is the newest save, and nothing was unwound: the delete is still in the list",
              rows[0]["when"].startswith("Restore the version from") and rows[1]["when"] == "Delete the whole series"
              and len(rows) == 5, str([(r["label"], r["when"]) for r in rows]))
        check("the current version shows the series coming back as added",
              len(rows[0]["lines"]) == 1 and "added" in rows[0]["lines"][0] and "Maya - Algebra II" in rows[0]["lines"][0], str(rows[0]["lines"]))
        check("the delete version no longer offers to restore just that session - it is back",
              rows[1]["buttons"] == ["Restore this version"], str(rows[1]["buttons"]))

        # ---- restoring the version that matches the present is a no-op
        await page.click("#historyList .history-step:nth-child(3) .history-step-actions button"); await page.wait_for_timeout(1200)
        status = await page.text_content("#status")
        check("a version identical to now says so instead of adding a step", "already the current schedule" in status, status)
        check("nothing changed", await cards(page) == 3 and len(await steps(page)) == 5)

        # ---- "Restore just this" on a removed session
        await page.evaluate("""() => {
            const card = [...document.querySelectorAll('.event-card')].find(c => c.textContent.includes('Noah'));
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); }""")
        await page.wait_for_timeout(250)
        await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.trim() === 'Delete').click()""")
        await page.wait_for_selector(".choice-modal")
        await page.evaluate("""() => [...document.querySelectorAll('.choice-modal button')].find(b => b.textContent.trim() === 'Delete').click()""")
        await page.wait_for_timeout(900)
        check("Noah deleted", await cards(page) == 2)
        rows = await steps(page)
        check("the current version offers to restore just Noah", rows[0]["buttons"] == ["Restore just this"] and "Noah" in rows[0]["lines"][0], str(rows[0]))
        await page.click("#historyList .history-step:nth-child(1) .history-inline-restore"); await page.wait_for_timeout(1200)
        check("and he is back, as a new save", await cards(page) == 3 and (await steps(page))[0]["when"] == "Restore Noah", str((await steps(page))[0]))

        # ---- Ctrl+Z while the drawer is open keeps the list current
        await page.keyboard.press("Control+z"); await page.wait_for_timeout(1000)
        rows = await steps(page)
        check("a keyboard undo with the drawer open refreshes the list", rows[0]["when"] == "Delete session" and await cards(page) == 2,
              str([r["when"] for r in rows[:2]]))

        await page.click("#closeHistoryDrawerBtn"); await page.wait_for_timeout(300)
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(400)
        check("leaving admin hides the gear menu that holds Version history",
              await page.evaluate("document.getElementById('toolsMenuWrap').classList.contains('hidden')"))

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
