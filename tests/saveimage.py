#!/usr/bin/env python3
"""The Save image button hands over a PNG of the whole week, drawn at
full size from the data - a screenshot that always fits.

    python3 tests/saveimage.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8948
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
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const post = (body) => fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'Open', start: tue + 'T15:00', end: tue + 'T18:00' });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II',
                start: tue + 'T16:00', end: tue + 'T17:00',
                recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } });
        }""")
        await page.reload(wait_until="networkidle")
        # the device was remembered at login, so the reload comes back in admin mode
        await page.wait_for_timeout(800)

        async with page.expect_download() as dl_info:
            await page.click("#saveWeekBtn")
        dl = await dl_info.value
        name = dl.suggested_filename
        path = await dl.path()
        data = open(path, "rb").read()
        expected = await page.evaluate("""(() => { const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const md = (s) => { const d = new Date(s + 'T12:00'); return (d.getMonth() + 1) + '.' + d.getDate(); };
            return 'ethans_tutoring_availability ' + md(cols[0]) + '-' + md(cols[cols.length - 1]) + '.png'; })()""")
        check("the download is a png named calendar + week, e.g. ethans_tutoring_availability 9.13-9.19.png",
              name == expected, f"{name} != {expected}")
        check("it really is a PNG", data[:8] == b"\x89PNG\r\n\x1a\n", str(data[:8]))
        check("it is a full-size image, not a thumbnail", len(data) > 20000, f"{len(data)} bytes")
        status = await page.text_content("#status")
        check("status confirms the save", "schedule image is saved" in status, status)

        # Signed out, the button still works and draws the public view.
        pub = await (await b.new_context(viewport={"width": 390, "height": 844},
                                          accept_downloads=True)).new_page()
        pub.on("pageerror", lambda e: errs.append(str(e)))
        await pub.goto(CAL, wait_until="networkidle")
        await pub.wait_for_timeout(700)
        async with pub.expect_download() as dl_info:
            await pub.click("#saveWeekBtn")
        dl2 = await dl_info.value
        data2 = open(await dl2.path(), "rb").read()
        check("a phone visitor gets the full-week image too",
              data2[:8] == b"\x89PNG\r\n\x1a\n" and len(data2) > 15000, f"{len(data2)} bytes")

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
