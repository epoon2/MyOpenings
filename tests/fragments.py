#!/usr/bin/env python3
"""A block of open time drawn in pieces around a booked session is
still one block: editing either piece (right-click, Edit) opens the
whole block, and saving keeps the pieces on the other side of the
booking - for a one-off and for a repeating block alike.

    python3 tests/fragments.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8992
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def cards(page):
    return await page.evaluate("[...document.querySelectorAll('.event-card')].map(c => [...c.children].map(n => n.textContent.trim()).join(' '))")

async def edit_piece(page, text):
    await page.evaluate("""(text) => { const card = [...document.querySelectorAll('.event-card')].find(c => [...c.children].map(n => n.textContent.trim()).join(' ').startsWith(text));
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); }""", text)
    await page.wait_for_timeout(250)
    await page.evaluate("[...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.trim() === 'Edit').click()")
    await page.wait_for_timeout(400)

async def stored(page):
    return await page.evaluate("""() => { const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
        return fetch(`/api/events?start=${cols[0]}&end=${cols[6]}`, { headers: { 'x-admin-password': 't' } }).then(r => r.json())
            .then(d => d.events.filter(e => e.type === 'AVAILABLE').map(e => [e.title, e.start.slice(11), e.end.slice(11)])); }""")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # ---- a one-off block of open time, 8 to 1, with a session booked 9:30 to 11 inside it
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const post = (body) => fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'Open', start: cols[1] + 'T08:00', end: cols[1] + 'T13:00' });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II', start: cols[1] + 'T09:30', end: cols[1] + 'T11:00' });
            await post({ type: 'AVAILABLE', title: 'Office hours', start: cols[3] + 'T08:00', end: cols[3] + 'T13:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [3], endType: 'NEVER' } });
            await post({ type: 'BLOCKED', title: 'Kai - piano', start: cols[3] + 'T09:30', end: cols[3] + 'T11:00' }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)
        seen = await cards(page)
        check("the open block is drawn in two pieces around the booking", "Open 8 – 9:30 AM" in seen and "Open 11 AM – 1 PM" in seen, str(seen))

        await edit_piece(page, "Open 8")
        times = await page.evaluate("[document.getElementById('eventStartHour').value, document.getElementById('eventEndHour').value]")
        check("editing the first piece opens the whole block, 8 to 1", times == ["8", "1"], str(times))
        await page.fill("#eventTitle", "Open (renamed)")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(900)
        seen = await cards(page)
        check("renaming it keeps the piece on the other side of the booking", "Open (renamed) 8 – 9:30 AM" in seen and "Open (renamed) 11 AM – 1 PM" in seen, str(seen))
        check("and the stored block still runs 8 to 1", ["Open (renamed)", "08:00", "13:00"] in await stored(page), str(await stored(page)))

        # ---- the same for a repeating block, this week only
        await edit_piece(page, "Office hours 11")
        times = await page.evaluate("[document.getElementById('eventStartHour').value, document.getElementById('eventEndHour').value]")
        check("editing the second piece of a repeating block opens the whole occurrence", times == ["8", "1"], str(times))
        await page.fill("#eventTitle", "Office hours (moved online)")
        await page.click("#saveEventBtn")
        await page.wait_for_selector(".choice-modal")
        await page.evaluate("""() => { [...document.querySelectorAll('.choice-modal .choice-radio-row')].find(r => r.textContent.trim() === 'This event only').querySelector('input').click();
            [...document.querySelectorAll('.choice-modal button')].find(b => b.textContent.trim() === 'OK').click(); }""")
        await page.wait_for_timeout(900)
        seen = await cards(page)
        check("this week's copy keeps both pieces", "Office hours (moved online) 8 – 9:30 AM" in seen and "Office hours (moved online) 11 AM – 1 PM" in seen, str(seen))
        check("as a detached block running 8 to 1", ["Office hours (moved online)", "08:00", "13:00"] in await stored(page), str(await stored(page)))
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        seen = await cards(page)
        check("next week the series is untouched, 8 to 1 in one piece", "Office hours 8 AM – 1 PM" in seen, str(seen))

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
