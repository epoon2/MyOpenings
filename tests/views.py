#!/usr/bin/env python3
"""Day, week and month views: one switcher drives the span, the
navigation, the heading, and the screenshot button's wording.

    python3 tests/views.py
"""
import asyncio, re, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8949
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 950}, accept_downloads=True)
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        tue = await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const shift = (s, n) => { const [y,m,d] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
            await fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Maya - Algebra II',
                    start: shift(tue, -7) + 'T16:00', end: shift(tue, -7) + 'T17:00',
                    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4],
                                  endType: 'NEVER' } }) });
            return tue;
        }""")
        await page.reload(wait_until="networkidle")
        # the device was remembered at login, so the reload comes back in admin mode
        await page.wait_for_timeout(800)

        # ---- default week view
        label = await page.get_attribute("#saveWeekBtn", "title")
        check("week is the default; the download icon's tooltip says so",
              label == "Download the weekly schedule as an image" and await page.evaluate("!!document.querySelector('#saveWeekBtn svg')"), label)
        cols = await page.locator(".day-column").count()
        check("week view shows seven columns", cols == 7, f"cols={cols}")

        # ---- day view
        await page.click("#viewDayBtn"); await page.wait_for_timeout(700)
        cols = await page.locator(".day-column").count()
        check("day view shows one wide column", cols == 1, f"cols={cols}")
        label = await page.get_attribute("#saveWeekBtn", "title")
        check("the tooltip says daily now", label == "Download the daily schedule as an image", label)
        heading = await page.text_content("#weekLabel")
        expected = await page.evaluate(
            "new Date().toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric', year:'numeric'})")
        check("the heading names the single day", heading == expected, f"{heading} vs {expected}")

        # walk to the seeded Tuesday and prove the day still has its verbs
        steps = await page.evaluate("""(tue) => {
            const today = new Date(); today.setHours(0,0,0,0);
            const target = new Date(tue + 'T12:00'); target.setHours(0,0,0,0);
            return Math.round((target - today) / 86400000);
        }""", tue)
        btn = "#nextWeekBtn" if steps > 0 else "#prevWeekBtn"
        for _ in range(abs(steps)):
            await page.click(btn)
        await page.wait_for_timeout(800)
        cards = await page.locator(".event-card").count()
        check("stepping day by day reaches the session", cards == 1, f"cards={cards}")
        # scroll first and let the scroll event pass - the menu closes on scroll
        await page.evaluate("document.querySelector('.event-card').scrollIntoView({ block: 'center' })")
        await page.wait_for_timeout(300)
        await page.evaluate("""() => { const card = document.querySelector('.event-card');
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 400 })); }""")
        await page.wait_for_timeout(300)
        items = await page.evaluate(
            "[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")
        check("day view keeps the full menu", items == ["Edit", "Customize", "Duplicate", "Copy", "Delete…"], str(items))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)

        # ---- day screenshot
        async with page.expect_download() as dl_info:
            await page.click("#saveWeekBtn")
        dl = await dl_info.value
        today = await page.evaluate("(() => { const d = new Date(document.querySelector('.day-column').dataset.date + 'T12:00'); return (d.getMonth() + 1) + '.' + d.getDate(); })()")
        check("the daily download is named calendar + day, e.g. ethans_tutoring_availability 9.15.png",
              dl.suggested_filename == f"ethans_tutoring_availability {today}.png", dl.suggested_filename)

        # ---- month view
        await page.click("#viewMonthBtn"); await page.wait_for_timeout(800)
        counts = await page.evaluate("""() => ({
            dows: document.querySelectorAll('.month-dow').length,
            cells: document.querySelectorAll('.month-cell').length,
            chips: document.querySelectorAll('.month-chip').length,
            summaryHidden: getComputedStyle(document.getElementById('weekSummary')).display === 'none'
        })""")
        check("month view lays out the full grid", counts["dows"] == 7 and counts["cells"] == 42, str(counts))
        check("the month carries the series as chips", counts["chips"] >= 6, str(counts))
        check("the weekly summary sits out of month view", counts["summaryHidden"], str(counts))
        label = await page.get_attribute("#saveWeekBtn", "title")
        check("the tooltip says monthly now", label == "Download the monthly schedule as an image", label)
        heading = await page.text_content("#weekLabel")
        check("the heading names the month", any(ch.isdigit() for ch in heading) and "–" not in heading, heading)

        # ---- month screenshot
        async with page.expect_download() as dl_info:
            await page.click("#saveWeekBtn")
        dl = await dl_info.value
        data = open(await dl.path(), "rb").read()
        check("the monthly screenshot is a real PNG named for the view",
              re.fullmatch(r"ethans_tutoring_availability \d{1,2}\.\d{4}\.png", dl.suggested_filename) and data[:8] == b"\x89PNG\r\n\x1a\n"
              and len(data) > 20000, dl.suggested_filename + f" {len(data)}b")

        # ---- month nav steps by month, and a cell click opens the day
        before = await page.text_content("#weekLabel")
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        after = await page.text_content("#weekLabel")
        check("month navigation steps a whole month", before != after, f"{before} -> {after}")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        await page.evaluate("""(tue) => {
            [...document.querySelectorAll('.month-cell')].find(c =>
                [...c.querySelectorAll('.month-chip')].length &&
                c.querySelector('.month-num').textContent === String(Number(tue.slice(8, 10)))
            )?.click();
        }""", tue)
        await page.wait_for_timeout(800)
        state = await page.evaluate("""() => ({
            day: document.body.classList.contains('view-day'),
            cards: document.querySelectorAll('.event-card').length
        })""")
        check("clicking a month day opens it in day view with its card",
              state["day"] and state["cards"] == 1, str(state))

        # ---- back to week, everything restored
        await page.click("#viewWeekBtn"); await page.wait_for_timeout(700)
        cols = await page.locator(".day-column").count()
        summary_back = await page.evaluate(
            "getComputedStyle(document.getElementById('weekSummary')).display !== 'none'")
        check("week view comes back whole", cols == 7 and summary_back, f"cols={cols}")

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
