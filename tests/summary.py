#!/usr/bin/env python3
"""Checks the admin week summary: total blocked hours, student count, and the
per-student session breakdown."""
import asyncio, json, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8902
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
ok, fail = [], []
def check(name, cond, extra=""):
    (ok if cond else fail).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width":1400,"height":1000})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput","t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(600)

        # The week starts on Sunday, so these are just "first day" and "second day".
        day1 = await page.evaluate("document.querySelectorAll('.day-column')[0].dataset.date")
        day2 = await page.evaluate("document.querySelectorAll('.day-column')[1].dataset.date")
        label1 = await page.evaluate(
            "new Date(document.querySelectorAll('.day-column')[0].dataset.date + 'T12:00')"
            ".toLocaleDateString(undefined,{weekday:'short'}).toLowerCase()")
        label2 = await page.evaluate(
            "new Date(document.querySelectorAll('.day-column')[1].dataset.date + 'T12:00')"
            ".toLocaleDateString(undefined,{weekday:'short'}).toLowerCase()")

        # Maya: 1.5h Mon + 1h Tue. Devon: 2h Mon. Plus availability (must not count).
        seed = [
            {"type":"BLOCKED","title":"Maya - Algebra II","start":f"{day1}T15:00","end":f"{day1}T16:30"},
            {"type":"BLOCKED","title":"Maya (online)",    "start":f"{day2}T16:00","end":f"{day2}T17:00"},
            {"type":"BLOCKED","title":"Devon - Calc",     "start":f"{day1}T17:00","end":f"{day1}T19:00"},
            {"type":"AVAILABLE","title":"open",           "start":f"{day2}T09:00","end":f"{day2}T12:00"},
        ]
        for ev in seed:
            await page.evaluate("""async (ev) => {
                await fetch('/api/events', {method:'POST',
                    headers:{'Content-Type':'application/json','x-admin-password':'t'},
                    body: JSON.stringify(ev)});
            }""", ev)
        await page.reload(wait_until="networkidle")
        # the device was remembered at login, so the reload comes back in admin mode
        await page.wait_for_timeout(800)

        check("summary panel visible in admin mode",
              await page.evaluate("!document.getElementById('weekSummary').classList.contains('hidden')"))

        hours = await page.evaluate("document.getElementById('summaryHours').textContent.trim()")
        check("total blocked hours = 4.5 (availability excluded)", hours == "4.5", f"got {hours!r}")

        students = await page.evaluate("document.getElementById('summaryStudents').textContent.trim()")
        check("student count = 2 (two titles for Maya merge)", students == "2", f"got {students!r}")

        await page.click("#summaryToggle"); await page.wait_for_timeout(300)
        rows = await page.evaluate("""() => [...document.querySelectorAll('.week-summary-student')].map(r => ({
            name: r.querySelector('strong').textContent.trim(),
            hours: r.querySelector('.week-summary-student-hours').textContent.trim(),
            when: r.querySelector('.week-summary-sessions').textContent.trim()
        }))""")
        check("one row per student", len(rows) == 2, str(rows))
        if len(rows) == 2:
            check("busiest student first", rows[0]["name"] == "Maya", str([r['name'] for r in rows]))
            check("Maya shows 2.5 hrs across 2 sessions",
                  rows[0]["hours"].startswith("2.5") and "2 sessions" in rows[0]["hours"], rows[0]["hours"])
            check("Maya's sessions list both of her days",
                  label1 in rows[0]["when"].lower() and label2 in rows[0]["when"].lower(),
                  f"{rows[0]['when']!r} vs {label1}/{label2}")
            check("Devon shows 2 hrs, 1 session",
                  rows[1]["hours"].startswith("2 hr") and "1 session" in rows[1]["hours"], rows[1]["hours"])
            lines = await page.evaluate("""() => [...document.querySelectorAll('.week-summary-student')[0].querySelectorAll('.week-summary-session')]
                .map(l => l.getBoundingClientRect().top)""")
            check("each of Maya's sessions sits on its own line", len(lines) == 2 and lines[1] > lines[0] + 10, str(lines))
        check("the toggle reads Hide all students while the list is open, Show all students when closed",
              await page.text_content("#summaryToggleLabel") == "Hide all students"
              and (await page.click("#summaryToggle") or True) and await page.text_content("#summaryToggleLabel") == "Show all students")
        await page.click("#summaryToggle"); await page.wait_for_timeout(200)

        # An empty week
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        empty = await page.evaluate("""() => ({
            hours: document.getElementById('summaryHours').textContent.trim(),
            students: document.getElementById('summaryStudents').textContent.trim(),
            msg: (document.querySelector('.week-summary-empty')||{}).textContent
        })""")
        check("empty week reads 0 / 0 with a message",
              empty["hours"]=="0" and empty["students"]=="0" and empty["msg"], str(empty))

        # Public view must not show it
        await page.click("#prevWeekBtn"); await page.wait_for_timeout(500)
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(700)
        check("summary hidden in public view",
              await page.evaluate("document.getElementById('weekSummary').classList.contains('hidden')"))

        real = [e for e in errs if "favicon" not in e and "manifest" not in e.lower()]
        check("no console errors", not real, str(real[:3]))

        print(f"\n{len(ok)} passed, {len(fail)} failed")
        if fail: print("FAILED: " + "; ".join(fail))
        await b.close()
        return 1 if fail else 0

def run():
    s = subprocess.Popen(["node","tests/server.mjs",str(PORT)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try: urllib.request.urlopen(f"{BASE}/api/config", timeout=1).read(); break
        except Exception: time.sleep(0.2)
    else:
        print("server failed:", s.stderr.read().decode()[:300]); return 1
    try: return asyncio.run(main())
    finally: s.terminate()

sys.exit(run())
