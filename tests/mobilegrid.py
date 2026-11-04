#!/usr/bin/env python3
"""Phones open in the week grid and a Grid/List toggle flips to the
agenda list, remembered per device. Desktop never sees the toggle.

    python3 tests/mobilegrid.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8946
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def view_state(page):
    return await page.evaluate("""() => ({
        calendar: getComputedStyle(document.getElementById('calendar')).display,
        agenda: getComputedStyle(document.getElementById('agenda')).display,
        toggle: getComputedStyle(document.querySelector('.view-toggle')).display,
        items: document.querySelectorAll('.agenda-item').length,
        cards: document.querySelectorAll('.event-card').length
    })""")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()

        # Seed on a desktop-sized page, and check desktop never sees the toggle.
        seed = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        await seed.goto(CAL, wait_until="networkidle")
        await seed.click("#adminBtn"); await seed.fill("#adminPasswordInput", "t")
        await seed.click("#loginSubmitBtn"); await seed.wait_for_timeout(700)
        await seed.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const post = (body) => fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'Open',
                start: tue + 'T15:00', end: tue + 'T18:00' });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: tue + 'T16:00', end: tue + 'T17:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4],
                              endType: 'NEVER' } });
        }""")
        desk = await view_state(seed)
        check("desktop shows the grid, no toggle, no list",
              desk["calendar"] == "grid" and desk["toggle"] == "none"
              and desk["agenda"] == "none", str(desk))

        # A phone, signed out.
        ctx = await b.new_context(viewport={"width": 390, "height": 844},
                                  is_mobile=True, has_touch=True, device_scale_factor=3)
        phone = await ctx.new_page()
        errs = []
        phone.on("pageerror", lambda e: errs.append(str(e)))
        phone.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await phone.goto(CAL, wait_until="networkidle")
        await phone.wait_for_timeout(700)

        st = await view_state(phone)
        check("phones open in the grid by default",
              st["calendar"] == "grid" and st["agenda"] == "none", str(st))
        check("the toggle is offered on phones", st["toggle"] != "none", str(st))
        # Tuesday: open before, booked, open after; Thursday: the booked session alone
        check("the week's schedule shows as cards", st["cards"] == 4, str(st))

        await phone.click("#viewListBtn"); await phone.wait_for_timeout(300)
        st = await view_state(phone)
        check("List flips to the agenda", st["calendar"] == "none"
              and st["agenda"] == "block", str(st))
        check("the agenda carries the week's entries", st["items"] >= 1, str(st))

        await phone.reload(wait_until="networkidle"); await phone.wait_for_timeout(700)
        st = await view_state(phone)
        check("the choice is remembered on reload", st["calendar"] == "none"
              and st["agenda"] == "block", str(st))

        await phone.click("#viewGridBtn"); await phone.wait_for_timeout(300)
        st = await view_state(phone)
        check("Grid brings the week grid back", st["calendar"] == "grid"
              and st["agenda"] == "none" and st["cards"] == 4, str(st))

        # Admin on the phone still gets the grid with its extra card.
        await phone.click("#adminBtn"); await phone.fill("#adminPasswordInput", "t")
        await phone.click("#loginSubmitBtn"); await phone.wait_for_timeout(700)
        st = await view_state(phone)
        check("admin on the phone sees the grid too", st["cards"] == 4, str(st))

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
