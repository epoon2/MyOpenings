#!/usr/bin/env python3
"""The bug from the phone: opening a repeating session from the Blocked
Sessions list, for a week that is not on screen, and pressing Delete
wiped the whole series without asking. Both the editor's Delete and its
Save must offer the three scopes wherever the editor was opened from.

    python3 tests/drawerdelete.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8963
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def fetch_range(page, start, end):
    return await page.evaluate("""async ([s, e]) => {
        const r = await fetch(`/api/events?start=${s}&end=${e}`, { headers: { 'x-admin-password': 't' } });
        return (await r.json()).events; }""", [start, end])

async def choose_scope(page, label):
    await page.wait_for_selector(".choice-modal", timeout=5000)
    await page.evaluate("""(label) => [...document.querySelectorAll('.choice-modal .choice-radio-row')]
        .find(r => r.textContent.trim() === label).querySelector('input').click()""", label)
    await page.evaluate("""() => [...document.querySelectorAll('.choice-modal button')]
        .find(b => b.textContent.trim() === 'OK').click()""")
    await page.wait_for_timeout(900)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        # a phone-sized viewport, since that is where it bit
        page = await (await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # A weekly series that starts NEXT week, so nothing of it is in
        # the week on screen and the page has never loaded its master.
        dates = await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const shift = (s, n) => { const [y,m,d] = s.split('-').map(Number);
                return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); };
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const nextTue = shift(tue, 7), nextThu = shift(tue, 9), afterTue = shift(tue, 14), afterThu = shift(tue, 16);
            await fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Maya - Algebra II',
                    start: nextTue + 'T16:00', end: nextTue + 'T17:00',
                    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } }) });
            return { nextTue, nextThu, afterTue, afterThu, nextStart: shift(tue, 5), nextEnd: shift(tue, 11),
                     afterStart: shift(tue, 12), afterEnd: shift(tue, 18) };
        }""")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        check("nothing of the series is on the visible week", await page.locator(".event-card").count() == 0)

        # ---- open next Thursday's block from the Blocked Sessions list
        await page.click("#blockedSessionsBtn"); await page.wait_for_timeout(900)
        items = await page.evaluate("""() => [...document.querySelectorAll('.blocked-session-item')]
            .map(i => i.textContent.replace(/\\s+/g, ' ').trim())""")
        check("the list shows the series' upcoming blocks", len(items) >= 2, str(items))
        opened = await page.evaluate("""(thu) => {
            const items = [...document.querySelectorAll('.blocked-session-item')];
            const wanted = items.find(i => i.textContent.includes(new Date(thu + 'T12:00')
                .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })));
            if (!wanted) return items.map(i => i.textContent.replace(/\\s+/g, ' ').trim());
            wanted.click(); return true; }""", dates["nextThu"])
        await page.wait_for_timeout(500)
        check("tapping it opens the editor", opened is True and await page.evaluate(
            "!document.getElementById('eventModal').classList.contains('hidden')"), str(opened))
        title = await page.text_content("#eventModalTitle")
        form_date = await page.evaluate("document.getElementById('eventStartDate').value")
        check("the editor knows it is a series and shows the tapped week",
              title.strip() == "Edit recurring event" and form_date == dates["nextThu"], f"{title} {form_date}")

        # ---- Delete must ask, and "this event only" must remove one block
        await page.click("#deleteEventBtn")
        dialog = await page.evaluate("() => { const h = document.querySelector('.choice-modal h2'); return h ? h.textContent.trim() : null; }")
        check("Delete asks how far to reach instead of deleting everything", dialog == "Delete recurring event", str(dialog))
        await choose_scope(page, "This event only")
        nxt = await fetch_range(page, dates["nextStart"], dates["nextEnd"])
        after = await fetch_range(page, dates["afterStart"], dates["afterEnd"])
        check("only that Thursday is gone; the series survives",
              sorted(e["start"][:10] for e in nxt) == [dates["nextTue"]]
              and sorted(e["start"][:10] for e in after) == [dates["afterTue"], dates["afterThu"]],
              f"next={[e['start'] for e in nxt]} after={[e['start'] for e in after]}")
        check("the editor closed after the choice",
              await page.evaluate("document.getElementById('eventModal').classList.contains('hidden')"))

        # ---- Save from the same opener must ask too
        await page.click("#blockedSessionsBtn"); await page.wait_for_timeout(900)
        await page.evaluate("""(tue) => {
            const items = [...document.querySelectorAll('.blocked-session-item')];
            const label = new Date(tue + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            items.find(i => i.textContent.includes(label)).click(); }""", dates["nextTue"])
        await page.wait_for_timeout(500)
        await page.evaluate("document.getElementById('eventNotes').value = 'bring the workbook'")
        await page.click("#saveEventBtn")
        dialog = await page.evaluate("() => { const h = document.querySelector('.choice-modal h2'); return h ? h.textContent.trim() : null; }")
        check("Save from the list asks for a scope as well", dialog == "Edit recurring event", str(dialog))
        await choose_scope(page, "This event only")
        nxt = await fetch_range(page, dates["nextStart"], dates["nextEnd"])
        after = await fetch_range(page, dates["afterStart"], dates["afterEnd"])
        loose = [e for e in nxt if not e.get("recurrence")]
        check("the note landed on that one week only", len(loose) == 1 and loose[0]["notes"] == "bring the workbook"
              and loose[0]["start"][:10] == dates["nextTue"]
              and all(not e.get("notes") for e in after), str([(e["start"], e.get("notes")) for e in nxt + after]))

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
