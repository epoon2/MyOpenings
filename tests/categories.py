#!/usr/bin/env python3
"""Categories for booked time: the owner names them in Settings, picks
one on each booked session, and the weekly summary counts each apart
(plus what is filed under none). A rename keeps the sessions; a
removal files them under none. "Omitted" keeps a session out of the
count altogether. The per-person rows in the summary
wear their block's color plainly.

    python3 tests/categories.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8993
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def hidden(page, sel):
    return await page.evaluate(f"document.querySelector('{sel}').classList.contains('hidden')")

async def open_settings(page):
    await page.click("#gearBtn"); await page.wait_for_timeout(100)
    await page.click("#settingsBtn"); await page.wait_for_timeout(500)

async def chips(page):
    return await page.evaluate("[...document.querySelectorAll('#summaryCategories .week-summary-category')].map(c => [...c.children].map(n => n.textContent.trim()).join(' '))")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # ---- three booked sessions this week, one open block
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const post = (body) => fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) });
            await post({ type: 'BLOCKED', title: 'Maya - Algebra II', start: cols[1] + 'T16:00', end: cols[1] + 'T17:00', color: '#1d4ed8' });
            await post({ type: 'BLOCKED', title: 'Office - team meeting', start: cols[2] + 'T09:00', end: cols[2] + 'T11:00' });
            await post({ type: 'BLOCKED', title: 'Kai - piano', start: cols[3] + 'T15:00', end: cols[3] + 'T15:30' });
            await post({ type: 'AVAILABLE', title: 'Open', start: cols[4] + 'T13:00', end: cols[4] + 'T15:00' }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)
        check("with no categories the summary shows only the total", await page.text_content("#summaryHours") == "3.5" and await hidden(page, "#summaryCategories"))
        await page.click(".event-card"); await page.wait_for_timeout(400)
        check("and the editor asks for none", await hidden(page, "#categoryField"))
        await page.evaluate("document.querySelector('#eventModal [data-close]').click()"); await page.wait_for_timeout(200)

        # ---- naming two in Settings
        await open_settings(page)
        check("Settings has a Categories section with none yet", await page.evaluate("document.querySelectorAll('#categoryList .category-row').length") == 0
              and "Categories" in (await page.text_content("#settingsModal")))
        await page.click("#addCategoryBtn"); await page.keyboard.type("Work")
        await page.click("#addCategoryBtn"); await page.keyboard.type("Private tutoring")
        await page.click("#addCategoryBtn")   # left blank: dropped on save
        check("Add makes a row each time, focused", await page.evaluate("document.querySelectorAll('#categoryList .category-row').length") == 3)
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("saved", (await page.text_content("#status")).startswith("Settings saved"), await page.text_content("#status"))
        await open_settings(page)
        names = await page.evaluate("[...document.querySelectorAll('#categoryList input')].map(i => i.value)")
        check("Settings shows the two named, the blank one dropped", names == ["Work", "Private tutoring"], str(names))
        await page.evaluate("document.querySelector('#settingsModal [data-close]').click()"); await page.wait_for_timeout(200)
        check("with categories named, the summary counts them, all under none so far",
              await chips(page) == ["3.5 h · All", "0 h · Work", "0 h · Private tutoring", "3.5 h · Uncategorized"], str(await chips(page)))
        check("All is pressed by default", await page.evaluate("[...document.querySelectorAll('#summaryCategories button')].map(b => b.getAttribute('aria-pressed'))") == ["true", "false", "false", "false"])

        # ---- filing sessions
        async def file_under(title, option):
            await page.evaluate("(title) => [...document.querySelectorAll('.event-card')].find(c => c.textContent.includes(title)).click()", title)
            await page.wait_for_timeout(400)
            await page.select_option("#eventCategory", label=option)
            await page.click("#saveEventBtn"); await page.wait_for_timeout(900)
        await page.evaluate("[...document.querySelectorAll('.event-card')].find(c => c.textContent.includes('Maya')).click()"); await page.wait_for_timeout(400)
        options = await page.evaluate("[...document.querySelectorAll('#eventCategory option')].map(o => o.textContent)")
        check("a booked session's editor offers the categories, none chosen", not await hidden(page, "#categoryField") and options == ["No category", "Work", "Private tutoring", "Omitted (not counted in the summary)"]
              and await page.input_value("#eventCategory") == "", str(options))
        await page.select_option("#eventType", "AVAILABLE"); await page.wait_for_timeout(100)
        check("open time has no category", await hidden(page, "#categoryField"))
        await page.select_option("#eventType", "BLOCKED"); await page.wait_for_timeout(100)
        await page.select_option("#eventCategory", label="Private tutoring")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(900)
        await file_under("Office", "Work")
        await file_under("Kai", "Private tutoring")
        check("each category counts its own hours, All the total", await chips(page) == ["3.5 h · All", "2 h · Work", "1.5 h · Private tutoring"], str(await chips(page)))

        # ---- choosing a category narrows the rows to it
        await page.click("#summaryToggle"); await page.wait_for_timeout(300)
        async def rows():
            return await page.evaluate("[...document.querySelectorAll('#summaryList .week-summary-student strong')].map(s => s.textContent.trim())")
        check("under All every student is listed", await rows() == ["Office", "Maya", "Kai"] or sorted(await rows()) == ["Kai", "Maya", "Office"], str(await rows()))
        await page.click("#summaryCategories button[data-category]:nth-child(2)"); await page.wait_for_timeout(300)
        check("choosing Work highlights it and lists only what is filed under Work", await page.evaluate("document.querySelector('#summaryCategories button:nth-child(2)').getAttribute('aria-pressed')") == "true"
              and await page.evaluate("document.querySelector('#summaryCategories button:nth-child(1)').getAttribute('aria-pressed')") == "false"
              and await rows() == ["Office"], str(await rows()))
        await page.click("#summaryCategories button:nth-child(3)"); await page.wait_for_timeout(300)
        check("Private tutoring lists Maya and Kai", sorted(await rows()) == ["Kai", "Maya"], str(await rows()))
        check("while the totals above still count the whole week", await page.text_content("#summaryHours") == "3.5" and await page.text_content("#summaryStudents") == "3")
        await page.click("#summaryCategories button:nth-child(1)"); await page.wait_for_timeout(300)
        check("All brings every row back", len(await rows()) == 3)
        await page.click("#summaryToggle"); await page.wait_for_timeout(200)
        await page.evaluate("[...document.querySelectorAll('.event-card')].find(c => c.textContent.includes('Kai')).click()"); await page.wait_for_timeout(400)
        check("the editor remembers the choice", await page.evaluate("document.getElementById('eventCategory').selectedOptions[0].textContent") == "Private tutoring")
        await page.evaluate("document.querySelector('#eventModal [data-close]').click()"); await page.wait_for_timeout(200)

        # ---- a save that says nothing about the category keeps it (a drag, say)
        await page.evaluate("""async () => {
            const ev = (await fetch('/api/events?start=2020-01-01&end=2030-01-01', { headers: { 'x-admin-password': 't' } }).then(r => r.json())).events.find(e => e.title.includes('Kai'));
            await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': 't' },
                body: JSON.stringify({ id: ev.id, type: ev.type, title: ev.title, start: ev.start, end: ev.end.replace('15:30', '16:00'), notes: ev.notes }) }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)
        check("a save without the field keeps the category", await chips(page) == ["4 h · All", "2 h · Work", "2 h · Private tutoring"], str(await chips(page)))

        # ---- renaming keeps the sessions; removing files them under none
        await open_settings(page)
        await page.fill("#categoryList .category-row:nth-child(2) input", "Tutoring")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("a rename keeps the sessions filed under it", await chips(page) == ["4 h · All", "2 h · Work", "2 h · Tutoring"], str(await chips(page)))
        await open_settings(page)
        await page.click("#categoryList .category-row:nth-child(1) button")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("removing one files its sessions under none", await chips(page) == ["4 h · All", "2 h · Tutoring", "2 h · Uncategorized"], str(await chips(page)))
        await page.click("#summaryToggle"); await page.wait_for_timeout(200)
        await page.click("#summaryCategories button:nth-child(3)"); await page.wait_for_timeout(300)
        check("Uncategorized can be chosen too", await page.evaluate("[...document.querySelectorAll('#summaryList .week-summary-student strong')].map(s => s.textContent.trim())") == ["Office"])
        pressed = await page.evaluate("(() => { const c = document.querySelector('#summaryCategories button:nth-child(3)'); return [getComputedStyle(c).backgroundColor, getComputedStyle(c.querySelector('strong')).color]; })()")
        check("and its number reads white on the gray, not gray on gray", pressed[1] == "rgb(255, 255, 255)" and pressed[0] != pressed[1], str(pressed))
        await page.click("#summaryCategories button:nth-child(1)"); await page.wait_for_timeout(300)
        await page.click("#summaryToggle"); await page.wait_for_timeout(200)

        # ---- an omitted session stays on the calendar but out of the count
        await file_under("Maya", "Omitted (not counted in the summary)")
        check("an omitted session is left out of the total, All and the students",
              await page.text_content("#summaryHours") == "3" and await page.text_content("#summaryStudents") == "2"
              and await chips(page) == ["3 h · All", "1 h · Tutoring", "2 h · Uncategorized", "1 h · Omitted"], str(await chips(page)))
        check("it is still drawn on the calendar", await page.evaluate("[...document.querySelectorAll('.event-card')].some(c => c.textContent.includes('Maya'))"))
        await page.click("#summaryToggle"); await page.wait_for_timeout(300)
        check("under All its student is not listed", sorted(await page.evaluate("[...document.querySelectorAll('#summaryList .week-summary-student strong')].map(s => s.textContent.trim())")) == ["Kai", "Office"])
        await page.click("#summaryCategories button[data-category='omitted']"); await page.wait_for_timeout(300)
        check("choosing Omitted lists what was left out", await page.evaluate("[...document.querySelectorAll('#summaryList .week-summary-student strong')].map(s => s.textContent.trim())") == ["Maya"]
              and await page.text_content("#summaryHours") == "3")
        await page.click("#summaryCategories button:nth-child(1)"); await page.wait_for_timeout(300)
        await page.click("#summaryToggle"); await page.wait_for_timeout(200)

        # ---- with every category removed, an omitted session can still be counted again
        await open_settings(page)
        await page.click("#categoryList .category-row:nth-child(1) button")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("with no categories left, the Omitted count still shows", await chips(page) == ["3 h · All", "1 h · Omitted"], str(await chips(page)))
        await page.evaluate("[...document.querySelectorAll('.event-card')].find(c => c.textContent.includes('Maya')).click()"); await page.wait_for_timeout(400)
        check("and its editor still offers the choice", not await hidden(page, "#categoryField") and await page.input_value("#eventCategory") == "omitted")
        await page.select_option("#eventCategory", label="No category")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(900)
        check("filed under none, it counts again", await page.text_content("#summaryHours") == "4" and await hidden(page, "#summaryCategories"))

        # ---- the per-person rows wear their color plainly
        await page.click("#summaryToggle"); await page.wait_for_timeout(300)
        rows = await page.evaluate("""[...document.querySelectorAll('#summaryList .week-summary-student')].map(r => {
            const cs = getComputedStyle(r), dot = r.querySelector('.week-summary-dot'), ds = getComputedStyle(dot);
            return { edge: cs.borderLeftWidth, bg: cs.backgroundColor, dot: ds.width, name: r.querySelector('strong').textContent.trim() }; })""")
        check("each person's row has a colored bar, a tint and a clear swatch", len(rows) == 3
              and all(r["edge"] == "4px" and r["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and r["dot"] == "14px" for r in rows), str(rows))
        maya = [r for r in rows if r["name"] == "Maya"][0]
        office = [r for r in rows if r["name"] == "Office"][0]
        check("and the color is the block's own", maya["bg"] != office["bg"], str((maya, office)))

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
