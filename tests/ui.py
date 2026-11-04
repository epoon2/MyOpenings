#!/usr/bin/env python3
"""Drives the admin schedule: typed times, the quarter-hour wheel, single-click
create, and the right-click menu with copy and paste."""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8891
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
ok, fail = [], []
def check(name, cond, extra=""):
    (ok if cond else fail).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width":1400,"height":950})).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        await page.goto(CAL, wait_until="networkidle")

        # --- admin mode ---
        await page.click("#adminBtn")
        await page.fill("#adminPasswordInput", "test")
        await page.click("#loginSubmitBtn")
        await page.wait_for_timeout(600)
        check("admin mode entered", await page.evaluate("!document.getElementById('adminBanner').classList.contains('hidden')"))

        # ---------- 1. single left-click creates ----------
        col = page.locator(".day-column").first
        box = await col.bounding_box()
        await page.mouse.click(box["x"] + box["width"]/2, box["y"] + 200)
        await page.wait_for_timeout(400)
        modal_open = await page.evaluate("!document.getElementById('eventModal').classList.contains('hidden')")
        check("single left-click opens the new-session form", modal_open)

        # ---------- 2. time segments ----------
        seg = await page.evaluate("""() => ({
            hour: !!document.getElementById('eventStartHour'),
            minute: !!document.getElementById('eventStartMinute'),
            meridiem: !!document.getElementById('eventStartMeridiem'),
            wheel: !!document.getElementById('eventStartWheel')
        })""")
        check("three time segments + wheel button exist", all(seg.values()), str(seg))

        # clicked at a slot -> should be snapped to :00/:15/:30/:45
        await page.evaluate("window.__testDate = document.getElementById('eventStartDate').value")
        snapped = await page.evaluate("document.getElementById('eventStartMinute').value")
        check("click-created time snaps to a quarter hour", snapped in ("00","15","30","45"), f"got {snapped!r}")

        # ---------- 3. typing with auto-advance ----------
        await page.click("#eventStartHour")
        await page.keyboard.type("11")
        after_hour = await page.evaluate("document.activeElement.id")
        check("2 digits in hour auto-advances to minute", after_hour == "eventStartMinute", f"focus={after_hour}")

        await page.keyboard.type("07")
        after_min = await page.evaluate("document.activeElement.id")
        check("2 digits in minute auto-advances to AM/PM", after_min == "eventStartMeridiem", f"focus={after_min}")

        await page.keyboard.type("a")
        await page.wait_for_timeout(200)
        vals = await page.evaluate("""() => ({
            h: document.getElementById('eventStartHour').value,
            m: document.getElementById('eventStartMinute').value,
            p: document.getElementById('eventStartMeridiem').value,
            hidden: document.getElementById('eventStartTime').value,
            combined: document.getElementById('eventStart').value
        })""")
        check("typing 11 / 07 / a yields 11:07 AM", vals["h"]=="11" and vals["m"]=="07" and vals["p"]=="AM", str(vals))
        check("any minute is accepted (11:07 not snapped)", vals["hidden"]=="11:07", str(vals))
        check("hidden combined field updated", vals["combined"].endswith("T11:07"), str(vals))

        # PM path
        await page.click("#eventStartHour")
        await page.keyboard.type("3")
        await page.wait_for_timeout(100)
        after_single = await page.evaluate("document.activeElement.id")
        check("a lone 3 in hour advances (no hour 3x)", after_single == "eventStartMinute", f"focus={after_single}")
        await page.keyboard.type("45p")
        await page.wait_for_timeout(200)
        pm = await page.evaluate("document.getElementById('eventStartTime').value")
        check("3:45 PM converts to 15:45", pm == "15:45", f"got {pm!r}")

        # ---------- 4. the wheel is quarter-hours only ----------
        await page.click("#eventStartWheel")
        await page.wait_for_timeout(300)
        wheel = await page.evaluate("""() => {
            const w = document.querySelector('.time-wheel');
            if (!w) return null;
            const opts = [...w.querySelectorAll('.time-wheel-option')].map(o => o.dataset.value);
            return { count: opts.length, allQuarter: opts.every(v => ['00','15','30','45'].includes(v.slice(3))) };
        }""")
        check("wheel opens", wheel is not None)
        if wheel:
            check("wheel lists 96 quarter-hour options", wheel["count"]==96 and wheel["allQuarter"], str(wheel))
        await page.click(".time-wheel-option[data-value='13:30']")
        await page.wait_for_timeout(250)
        picked = await page.evaluate("""() => ({
            t: document.getElementById('eventStartTime').value,
            h: document.getElementById('eventStartHour').value,
            p: document.getElementById('eventStartMeridiem').value,
            gone: !document.querySelector('.time-wheel')
        })""")
        check("picking from the wheel sets 1:30 PM and closes", picked["t"]=="13:30" and picked["h"]=="1" and picked["p"]=="PM" and picked["gone"], str(picked))

        # ---------- 5. year capped at 4 digits ----------
        # Focus the month segment explicitly, then type the whole date.
        await page.click("#eventStartDate")
        for _ in range(3):
            await page.keyboard.press("Delete")
        await page.keyboard.press("ArrowLeft")
        await page.keyboard.press("ArrowLeft")
        await page.keyboard.type("12252026")
        await page.wait_for_timeout(200)
        d = await page.evaluate("document.getElementById('eventStartDate').value")
        check("date typed normally", d == "2026-12-25", f"got {d!r}")

        # Keep typing digits at the year: it must not grow past 4.
        await page.keyboard.type("9999999")
        await page.locator("#eventTitle").click()
        await page.wait_for_timeout(250)
        d2 = await page.evaluate("document.getElementById('eventStartDate').value")
        year_ok = d2 == "" or len(d2.split("-")[0]) == 4
        check("year cannot exceed 4 digits", year_ok, f"got {d2!r}")
        in_range = d2 == "" or 2000 <= int(d2.split("-")[0]) <= 2099
        check("year stays inside the allowed range", in_range, f"got {d2!r}")

        # ---------- save an event so there is a card ----------
        # Reopen a clean form on the visible week, so the saved card lands where
        # the later right-click steps can reach it. The date-typing checks above
        # deliberately left this form on a far-off month.
        await page.click("[data-close='eventModal']")
        await page.wait_for_timeout(250)
        col2 = page.locator(".day-column").first
        box3 = await col2.bounding_box()
        await page.mouse.click(box3["x"] + box3["width"]/2, box3["y"] + 200)
        await page.wait_for_timeout(400)
        await page.evaluate("""() => {
            document.getElementById('eventType').value = 'BLOCKED';
            document.getElementById('eventTitle').value = 'Maya - Algebra II';
            document.getElementById('eventNotes').value = 'chapter 4';
        }""")
        await page.click("#saveEventBtn")
        await page.wait_for_timeout(700)
        cards = await page.locator(".event-card").count()
        check("event saved and rendered as a card", cards >= 1, f"cards={cards}")

        # ---------- 6. right-click a card ----------
        if cards:
            await page.locator(".event-card").first.click(button="right")
            await page.wait_for_timeout(300)
            items = await page.evaluate("[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")
            check("card menu has Edit/Customize/Duplicate/Copy/Delete",
                  items[:5] == ["Edit","Customize","Duplicate","Copy","Delete"], str(items))

            # Copy
            await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')]
                .find(i => i.textContent.trim() === 'Copy').click()""")
            await page.wait_for_timeout(250)
            copied = await page.evaluate("!!window.__state?.clipboardEvent")
            check("menu closes after choosing", await page.evaluate("!document.querySelector('.context-menu')"))

            # ---------- 7. right-click empty space offers paste ----------
            box2 = await page.locator(".day-column").nth(2).bounding_box()
            await page.mouse.click(box2["x"]+box2["width"]/2, box2["y"]+300, button="right")
            await page.wait_for_timeout(300)
            items2 = await page.evaluate("[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")
            check("empty-slot menu offers New + Paste",
                  len(items2)==2 and items2[0]=="New session here" and items2[1].startswith("Paste"), str(items2))

            await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')]
                .find(i => i.textContent.trim().startsWith('Paste')).click()""")
            await page.wait_for_timeout(400)
            pasted = await page.evaluate("""() => ({
                open: !document.getElementById('eventModal').classList.contains('hidden'),
                title: document.getElementById('eventTitle').value,
                type: document.getElementById('eventType').value,
                notes: document.getElementById('eventNotes').value,
                date: document.getElementById('eventStartDate').value
            })""")
            check("paste prefills title/type/notes", pasted["open"] and pasted["title"]=="Maya - Algebra II"
                  and pasted["type"]=="BLOCKED" and pasted["notes"]=="chapter 4", str(pasted))
            # Column index 2 was right-clicked, so paste must land on that day.
            want = await page.evaluate(
                "document.querySelectorAll('.day-column')[2].dataset.date")
            check("paste lands on the right-clicked day, not the copied one",
                  pasted["date"] == want, f"{pasted['date']} vs {want}")
            await page.click("[data-close='eventModal']")
            await page.wait_for_timeout(300)

        # ---------- 8. left-click: a session edits, everything else adds ----------
        async def modal_state():
            return await page.evaluate("""() => ({
                open: !document.getElementById('eventModal').classList.contains('hidden'),
                id: document.getElementById('eventId').value,
                title: document.getElementById('eventModalTitle').textContent.trim(),
                name: document.getElementById('eventTitle').value,
                type: document.getElementById('eventType').value
            })""")
        if cards:
            # The blocked session saved above: a left-click opens it for editing.
            await page.locator(".event-card.blocked").first.click()
            await page.wait_for_timeout(400)
            on_card = await modal_state()
            check("left-click on a blocked session opens it for editing",
                  on_card["open"] and on_card["id"] != "" and on_card["title"] == "Edit event"
                  and on_card["name"] == "Maya - Algebra II", str(on_card))
            check("the editor is the full form, not a fresh one",
                  on_card["type"] == "BLOCKED", str(on_card))
            await page.click("[data-close='eventModal']")
            await page.wait_for_timeout(300)

            # An availability block on the same first day: a left-click on it
            # still adds a new session, exactly like empty space.
            await page.evaluate("""async () => {
                const day = document.querySelector('.day-column').dataset.date;
                await fetch('/api/events', { method: 'POST',
                    headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
                    body: JSON.stringify({ type: 'AVAILABLE', title: 'Open',
                        start: day + 'T17:00', end: day + 'T19:00' }) });
            }""")
            await page.click("#todayBtn")
            await page.wait_for_timeout(700)
            avail = page.locator(".event-card.available").first
            check("availability block rendered", await avail.count() == 1)
            await avail.click()
            await page.wait_for_timeout(400)
            on_avail = await modal_state()
            check("left-click on availability adds a NEW session (not edit)",
                  on_avail["open"] and on_avail["id"] == "" and on_avail["title"] == "Add event", str(on_avail))
            await page.click("[data-close='eventModal']")
            await page.wait_for_timeout(300)

            # Empty space, unchanged.
            box4 = await page.locator(".day-column").nth(3).bounding_box()
            await page.mouse.click(box4["x"] + box4["width"]/2, box4["y"] + 260)
            await page.wait_for_timeout(400)
            on_empty = await modal_state()
            check("left-click on empty space adds a NEW session",
                  on_empty["open"] and on_empty["id"] == "" and on_empty["title"] == "Add event", str(on_empty))
            await page.click("[data-close='eventModal']")
            await page.wait_for_timeout(300)

            # ---------- 9. paste lands on availability too ----------
            # Copy the session, then right-click the availability block:
            # its menu offers the slot under the pointer, like empty space.
            await page.locator(".event-card.blocked").first.click(button="right")
            await page.wait_for_timeout(250)
            await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')]
                .find(i => i.textContent.trim() === 'Copy').click()""")
            await page.wait_for_timeout(250)
            await page.locator(".event-card.available").first.click(button="right")
            await page.wait_for_timeout(300)
            items3 = await page.evaluate("[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")
            check("an availability block's menu offers New session here and Paste",
                  "New session here" in items3 and any(i.startswith("Paste") for i in items3)
                  and items3[:4] == ["Edit", "Customize", "Duplicate", "Copy"], str(items3))
            await page.evaluate("""() => [...document.querySelectorAll('.context-menu-item')]
                .find(i => i.textContent.trim().startsWith('Paste')).click()""")
            await page.wait_for_timeout(400)
            pasted2 = await modal_state()
            day0 = await page.evaluate("document.querySelector('.day-column').dataset.date")
            pasted2_date = await page.evaluate("document.getElementById('eventStartDate').value")
            check("pasting onto availability opens a new session with the copied details on that day",
                  pasted2["open"] and pasted2["id"] == "" and pasted2["name"] == "Maya - Algebra II"
                  and pasted2["type"] == "BLOCKED" and pasted2_date == day0, str(pasted2) + " " + pasted2_date)
            await page.click("[data-close='eventModal']")

        real = [e for e in errors if "favicon" not in e and "manifest" not in e.lower()]
        check("no console errors", not real, str(real[:3]))

        print(f"\n{len(ok)} passed, {len(fail)} failed")
        if fail:
            print("FAILED: " + "; ".join(fail))
        await b.close()
        return 1 if fail else 0

def run():
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/api/config", timeout=1).read()
            break
        except Exception:
            time.sleep(0.2)
    else:
        print("server never came up:", server.stderr.read().decode()[:400])
        return 1
    try:
        return asyncio.run(main())
    finally:
        server.terminate()

sys.exit(run())
