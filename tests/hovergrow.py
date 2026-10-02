#!/usr/bin/env python3
"""A card grows under the pointer: a short block that clips its title
opens up to show the whole title with the time on its own line, lifts
over its neighbors, and settles back when the pointer leaves. A long
block never shrinks below its own length. The grid itself does not
move, and with reduced motion nothing animates.

    python3 tests/hovergrow.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8995
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

MEASURE = """(text) => {
    const card = [...document.querySelectorAll('.event-card')].find(c => c.textContent.includes(text));
    const r = card.getBoundingClientRect(), t = card.querySelector('.event-title'), cs = getComputedStyle(card);
    return { top: r.top, height: r.height, width: r.width, z: cs.zIndex, scale: cs.transform,
             clipped: t.scrollWidth > t.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1,
             wraps: getComputedStyle(t).whiteSpace, rows: card.querySelector('.event-time').getBoundingClientRect().top > t.getBoundingClientRect().bottom - 2,
             shadow: cs.boxShadow, transition: cs.transitionProperty }; }"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # ---- a fifteen-minute session with a long name, a two-hour block, and a neighbor right under the short one
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const post = (body) => fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) });
            await post({ type: 'BLOCKED', title: 'Maya Chen - Algebra II makeup, chapter 7 review', start: cols[1] + 'T10:00', end: cols[1] + 'T10:15' });
            await post({ type: 'BLOCKED', title: 'Kai - piano', start: cols[1] + 'T10:15', end: cols[1] + 'T11:00' });
            await post({ type: 'AVAILABLE', title: 'Open', start: cols[3] + 'T13:00', end: cols[3] + 'T15:00' }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)

        before = await page.evaluate(MEASURE, "Maya")
        check("at rest a fifteen-minute card is one short row that clips its title", before["height"] < 24 and before["clipped"] and not before["rows"], str(before))
        long_before = await page.evaluate(MEASURE, "Open")
        check("and a two-hour block is drawn at its full length", 126 <= long_before["height"] <= 130, str(long_before))
        grid_before = await page.evaluate("document.querySelector('.day-column').getBoundingClientRect().height")

        # ---- the pointer rests on the short card
        await page.hover(".event-card:has-text('Maya')"); await page.wait_for_timeout(350)
        during = await page.evaluate(MEASURE, "Maya")
        check("under the pointer it grows to show the whole title, with the time on its own line",
              during["height"] > before["height"] + 12 and not during["clipped"] and during["wraps"] == "normal" and during["rows"], str(during))
        check("it keeps its top edge on its start time", abs(during["top"] - before["top"]) < 2, str((before["top"], during["top"])))
        check("it comes forward a little and casts a shadow", during["width"] > before["width"] * 1.03 and during["shadow"] != "none" and during["scale"] != "none", str(during))
        neighbor = await page.evaluate(MEASURE, "Kai")
        check("and lifts over its neighbor rather than pushing it", int(during["z"]) > int(neighbor["z"]) and abs(neighbor["top"] - (before["top"] + before["height"])) < 3, str((during["z"], neighbor)))
        check("the grid under it has not moved", await page.evaluate("document.querySelector('.day-column').getBoundingClientRect().height") == grid_before)

        # ---- and leaves
        await page.mouse.move(5, 5); await page.wait_for_timeout(350)
        after = await page.evaluate(MEASURE, "Maya")
        check("when the pointer leaves it settles back to its row", abs(after["height"] - before["height"]) < 1 and after["scale"] == "none" and after["z"] == before["z"], str(after))

        # ---- a long block does not shrink to its text
        await page.hover(".event-card:has-text('Open')"); await page.wait_for_timeout(350)
        long_during = await page.evaluate(MEASURE, "Open")
        check("a two-hour block under the pointer keeps its length", abs(long_during["height"] - long_before["height"] * 1.05) < 3 and long_during["scale"] != "none", str((long_before["height"], long_during["height"])))
        await page.mouse.move(5, 5); await page.wait_for_timeout(350)

        # ---- the editor still opens from a grown card
        await page.hover(".event-card:has-text('Maya')"); await page.wait_for_timeout(250)
        await page.click(".event-card:has-text('Maya')"); await page.wait_for_timeout(400)
        check("clicking a grown card opens its editor as before", not await page.evaluate("document.getElementById('eventModal').classList.contains('hidden')")
              and (await page.input_value("#eventTitle")).startswith("Maya Chen"))
        await page.evaluate("document.querySelector('#eventModal [data-close]').click()"); await page.wait_for_timeout(200)

        # ---- reduced motion: the growth still happens, nothing animates
        await page.emulate_media(reduced_motion="reduce"); await page.wait_for_timeout(100)
        check("with reduced motion the card has no transition", (await page.evaluate(MEASURE, "Kai"))["transition"] in ("none", "all"), str(await page.evaluate(MEASURE, "Kai")))
        await page.hover(".event-card:has-text('Kai')"); await page.wait_for_timeout(100)
        check("but still grows under the pointer", (await page.evaluate(MEASURE, "Kai"))["scale"] != "none")

        # ---- a visitor's cards grow the same way
        visitor = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        await visitor.goto(CAL, wait_until="networkidle"); await visitor.wait_for_timeout(500)
        v_before = await visitor.evaluate("document.querySelector('.event-card.blocked').getBoundingClientRect().height")
        await visitor.hover(".event-card.blocked"); await visitor.wait_for_timeout(350)
        v_during = await visitor.evaluate("document.querySelector('.event-card.blocked').getBoundingClientRect().height")
        check("a visitor's short card grows under the pointer too", v_during > v_before + 12, str((v_before, v_during)))

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
