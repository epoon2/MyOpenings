#!/usr/bin/env python3
"""The public view keeps the past on screen and draws a line at now:
a signed-out visitor sees last week's sessions exactly where they were,
and today's column carries the you-are-here line when the portal's
clock is inside the visible hours.

    python3 tests/publicview.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8944
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        # Seed as admin: last week's Tuesday gets availability with a
        # session inside it; this week's Tuesday gets availability too.
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const shift = (s, n) => { const [y,m,d] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
            const lastTue = shift(tue, -7);
            const post = (body) => fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'Open',
                start: lastTue + 'T15:00', end: lastTue + 'T18:00' });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: lastTue + 'T16:00', end: lastTue + 'T17:00' });
            await post({ type: 'AVAILABLE', title: 'Open',
                start: tue + 'T15:00', end: tue + 'T18:00' });
            // a booked session on a day with no open hours at all, next week
            await post({ type: 'BLOCKED', title: 'Kai - piano',
                start: shift(tue, 8) + 'T10:00', end: shift(tue, 8) + 'T11:00' });
        }""")

        # A fresh signed-out visitor.
        pub = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        pub.on("pageerror", lambda e: errs.append(str(e)))
        pub.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pub.goto(CAL, wait_until="networkidle")
        await pub.wait_for_timeout(700)

        cards_now = await pub.locator(".event-card").count()
        check("visitor sees this week's availability", cards_now >= 1, f"cards={cards_now}")
        await pub.click("#nextWeekBtn"); await pub.wait_for_timeout(700)
        next_cards = await pub.evaluate("[...document.querySelectorAll('.event-card')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())")
        check("a booked session outside any open hours still shows as booked, unnamed",
              len(next_cards) == 1 and "Blocked Session" in next_cards[0] and "Kai" not in next_cards[0], str(next_cards))
        await pub.click("#todayBtn"); await pub.wait_for_timeout(700)

        # The now line: present exactly when the portal clock sits in
        # the visible hours, and always in today's (portal) column.
        expected = await pub.evaluate("""() => {
            const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
                hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit' });
            const parts = Object.fromEntries(fmt.formatToParts(new Date())
                .map(p => [p.type, p.value]));
            const minutes = Number(parts.hour) * 60 + Number(parts.minute);
            return { date: `${parts.year}-${parts.month}-${parts.day}`,
                     inWindow: minutes >= 8 * 60 && minutes <= 24 * 60 };
        }""")
        # The line lives in the column for the PORTAL's today, which may
        # sit in the previous grid week when the visitor's clock runs
        # ahead of Los Angeles. Walk to whichever week holds it.
        has_today = await pub.evaluate(
            """(d) => !!document.querySelector('.day-column[data-date="' + d + '"]')""",
            expected["date"])
        if not has_today:
            await pub.click("#prevWeekBtn"); await pub.wait_for_timeout(700)
            has_today = await pub.evaluate(
                """(d) => !!document.querySelector('.day-column[data-date="' + d + '"]')""",
                expected["date"])
        check("a grid week holds the portal's today", has_today)
        line_count = await pub.locator(".now-line").count()
        if expected["inWindow"]:
            check("now line is drawn", line_count == 1, f"lines={line_count}")
            col_date = await pub.evaluate(
                "document.querySelector('.now-line')?.closest('.day-column')?.dataset.date")
            check("now line sits in today's column", col_date == expected["date"],
                  f"{col_date} vs {expected['date']}")
        else:
            check("now line hidden outside visible hours", line_count == 0, f"lines={line_count}")
        # Put the view back where the walk started before the next block.
        if not await pub.evaluate("document.querySelector('#todayBtn') === null"):
            await pub.click("#todayBtn"); await pub.wait_for_timeout(700)

        # Last week: the past stays visible, session included.
        await pub.click("#prevWeekBtn"); await pub.wait_for_timeout(700)
        past_cards = await pub.locator(".event-card").count()
        check("last week's schedule is still shown", past_cards == 3, f"cards={past_cards}")
        titles = await pub.evaluate(
            "[...document.querySelectorAll('.event-card')].map(c => c.textContent)")
        check("the past session shows as a blocked block",
              any("Blocked" in t for t in titles), str(titles)[:120])
        check("private titles never reach the public past",
              not any("Maya" in t for t in titles), str(titles)[:120])

        # No admin verbs for the public: right-clicking a card opens nothing.
        await pub.locator(".event-card").first.click(button="right")
        await pub.wait_for_timeout(300)
        menus = await pub.locator(".context-menu").count()
        check("no context menu for visitors", menus == 0, f"menus={menus}")

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
