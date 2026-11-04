#!/usr/bin/env python3
"""Undo and redo as the admin uses them: the toolbar buttons, Ctrl+Z and
Ctrl+Shift+Z, one gesture = one step even when it took several
requests, and the keys leaving text fields alone.

    python3 tests/undo.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8957
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def cards(page):
    return await page.locator(".event-card").count()

async def buttons(page):
    return await page.evaluate("""() => ({
        undo: !document.getElementById('undoBtn').disabled,
        redo: !document.getElementById('redoBtn').disabled,
        undoTitle: document.getElementById('undoBtn').title,
        redoTitle: document.getElementById('redoBtn').title,
        shown: !document.getElementById('toolsMenuWrap').classList.contains('hidden') })""")

async def rclick(page, selector):
    await page.evaluate("""(sel) => document.querySelector(sel).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))""", selector)
    await page.wait_for_timeout(250)

async def click_menu(page, label):
    await page.evaluate("""(label) => [...document.querySelectorAll('.context-menu-item')]
        .find(i => i.textContent.trim() === label).click()""", label)

async def choose_scope(page, label):
    await page.wait_for_selector(".choice-modal")
    await page.evaluate("""(label) => [...document.querySelectorAll('.choice-modal .choice-radio-row')]
        .find(r => r.textContent.trim() === label).querySelector('input').click()""", label)
    await page.evaluate("""() => [...document.querySelectorAll('.choice-modal button')]
        .find(b => b.textContent.trim() === 'OK').click()""")
    await page.wait_for_timeout(900)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        await page.goto(CAL, wait_until="networkidle")
        check("visitors never see Undo", not (await buttons(page))["shown"])
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        st = await buttons(page)
        check("the admin sees Undo and Redo, both idle on a fresh schedule",
              st["shown"] and not st["undo"] and not st["redo"] and st["undoTitle"] == "Nothing to undo", str(st))

        # ---- add a session from the form
        box = await page.locator(".day-column").nth(2).bounding_box()
        await page.mouse.click(box["x"] + box["width"]/2, box["y"] + 240)
        await page.wait_for_timeout(400)
        await page.evaluate("""() => {
            document.getElementById('eventType').value = 'BLOCKED';
            document.getElementById('eventTitle').value = 'Maya - Algebra II'; }""")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(800)
        check("the session is on the grid", await cards(page) == 1)
        st = await buttons(page)
        check("Undo wakes up and says what it will undo",
              st["undo"] and "add session" in st["undoTitle"] and "Ctrl+Z" in st["undoTitle"], str(st))

        # ---- Ctrl+Z on the grid
        await page.keyboard.press("Control+z"); await page.wait_for_timeout(900)
        check("Ctrl+Z removes it", await cards(page) == 0, f"cards={await cards(page)}")
        status = await page.text_content("#status")
        check("the status names what was undone", "Undid: add session" in status, status)
        st = await buttons(page)
        check("now Redo is live and Undo is not", st["redo"] and not st["undo"] and "add session" in st["redoTitle"], str(st))

        # ---- Ctrl+Shift+Z brings it back, Ctrl+Y works too
        await page.keyboard.press("Control+Shift+z"); await page.wait_for_timeout(900)
        check("Ctrl+Shift+Z redoes", await cards(page) == 1)
        await page.click("#gearBtn"); await page.wait_for_timeout(150)
        check("the gear menu holds Undo, enabled", not await page.evaluate("document.getElementById('toolsMenu').classList.contains('hidden')")
              and not await page.evaluate("document.getElementById('undoBtn').disabled"))
        await page.click("#undoBtn"); await page.wait_for_timeout(900)
        check("the Undo item undoes and closes the menu", await cards(page) == 0 and await page.evaluate("document.getElementById('toolsMenu').classList.contains('hidden')"))
        await page.keyboard.press("Control+y"); await page.wait_for_timeout(900)
        check("Ctrl+Y redoes as well", await cards(page) == 1)

        # ---- a gesture that takes several requests: delete "this and
        # following" from a series that started last week
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const tue = cols.find(d => new Date(d + 'T12:00').getDay() === 2);
            const [y,m,d] = tue.split('-').map(Number);
            const anchor = new Date(Date.UTC(y, m-1, d-7)).toISOString().slice(0,10);
            await fetch('/api/events', { method: 'POST',
                headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Noah - Geometry',
                    start: anchor + 'T16:00', end: anchor + 'T17:00',
                    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } }) });
        }""")
        await page.click("#todayBtn"); await page.wait_for_timeout(800)
        check("this week shows the one-off plus Tue and Thu", await cards(page) == 3, f"cards={await cards(page)}")
        before = (await buttons(page))["undoTitle"]

        # right-click this week's Thursday and cut the series from there
        await page.evaluate("""() => {
            const card = [...document.querySelectorAll('.event-card')].find(c =>
                new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === 4);
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        }""")
        await page.wait_for_timeout(250)
        await click_menu(page, "Delete…")
        await choose_scope(page, "This and following events")
        check("the cut removed Thursday and everything after", await cards(page) == 2, f"cards={await cards(page)}")
        st = await buttons(page)
        check("one gesture, one step, named for its scope",
              "delete this and following" in st["undoTitle"], st["undoTitle"])
        await page.keyboard.press("Control+z"); await page.wait_for_timeout(1000)
        check("one Ctrl+Z restores the whole series", await cards(page) == 3, f"cards={await cards(page)}")
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(700)
        check("next week is back as well", await cards(page) == 2, f"cards={await cards(page)}")
        await page.click("#todayBtn"); await page.wait_for_timeout(700)
        st = await buttons(page)
        check("the earlier step is next in line", st["undoTitle"] == before, f"{st['undoTitle']} vs {before}")

        # ---- dragging is undoable
        moved = await page.evaluate("""() => {
            const card = document.querySelector('.event-card.blocked');
            const col = card.closest('.day-column');
            const rect = col.getBoundingClientRect();
            const start = card.querySelector('.event-time').textContent;
            const dt = new DataTransfer();
            card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientY: card.getBoundingClientRect().top + 5 }));
            col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 40, clientY: rect.top + 200 }));
            col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 40, clientY: rect.top + 200 }));
            card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return start;
        }""")
        await page.wait_for_timeout(500)
        # a recurring card asks for a scope; a one-time one just moves
        if await page.locator(".choice-modal").count():
            await choose_scope(page, "This event only")
        await page.wait_for_timeout(700)
        st = await buttons(page)
        check("a drag lands on the stack as a move", "move" in st["undoTitle"], st["undoTitle"])
        await page.keyboard.press("Control+z"); await page.wait_for_timeout(1000)
        times = await page.evaluate("[...document.querySelectorAll('.event-card .event-time')].map(t => t.textContent)")
        check("undoing the drag puts the block back at its old time", moved in times, f"{moved} not in {times}")

        # ---- the keys stay out of text fields and dialogs
        # (the synthetic drag above left the "swallow the click after a
        # drop" flag armed, exactly as a real drop would - one click clears it)
        await page.locator(".event-card.blocked").first.click(); await page.wait_for_timeout(300)
        if await page.evaluate("document.getElementById('eventModal').classList.contains('hidden')"):
            await page.locator(".event-card.blocked").first.click(); await page.wait_for_timeout(400)
        opened = await page.evaluate("!document.getElementById('eventModal').classList.contains('hidden')")
        check("the editor is open", opened)
        n = await cards(page)
        await page.click("#eventTitle")
        await page.keyboard.type("x")
        await page.keyboard.press("Control+z"); await page.wait_for_timeout(600)
        check("Ctrl+Z inside a text field is the browser's own undo, not the schedule's",
              await cards(page) == n and await page.evaluate("!document.getElementById('eventModal').classList.contains('hidden')"))
        await page.click("[data-close='eventModal']"); await page.wait_for_timeout(300)

        # ---- exit admin: buttons go
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(400)
        check("leaving admin hides Undo and Redo", not (await buttons(page))["shown"])

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
