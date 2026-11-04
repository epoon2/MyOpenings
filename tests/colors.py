#!/usr/bin/env python3
"""Block colors in a real browser: the editor's swatch row with a custom
hex picker, the Customize menu with its four reaches on a two-day series
(nothing split), "All Mondays" on the delete dialog, colors travelling
with copy and paste, the summary's dots, and a public page that stays
red and green.

    python3 tests/colors.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8981
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def menu_items(page):
    return await page.evaluate("[...document.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim())")

async def click_menu(page, label):
    await page.evaluate("""(label) => [...document.querySelectorAll('.context-menu-item')]
        .find(i => i.textContent.trim() === label).click()""", label)
    await page.wait_for_timeout(300)

async def scope_labels(page):
    await page.wait_for_selector(".choice-modal")
    return await page.evaluate("[...document.querySelectorAll('.choice-modal .choice-radio-row')].map(r => r.textContent.trim())")

async def choose_scope(page, label, ok="OK"):
    await page.wait_for_selector(".choice-modal")
    if label:
        await page.evaluate("""(label) => [...document.querySelectorAll('.choice-modal .choice-radio-row')]
            .find(r => r.textContent.trim() === label).querySelector('input').click()""", label)
    await page.evaluate("""(ok) => [...document.querySelectorAll('.choice-modal button')]
        .find(b => b.textContent.trim() === ok).click()""", ok)
    await page.wait_for_timeout(800)

async def pick_swatch(page, root, title):
    await page.evaluate("""([root, title]) => document.querySelector(root + ' .color-swatch[title="' + title + '"]').click()""", [root, title])
    await page.wait_for_timeout(150)

async def set_custom(page, root, hex_):
    # the native picker cannot be driven; feed the input the value it would produce
    await page.evaluate("""([root, hex]) => { const i = document.querySelector(root + ' .color-custom-input');
        i.value = hex; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }""", [root, hex_])
    await page.wait_for_timeout(150)

async def card_colors(page):
    """{weekday: ink color or '' } for every card on the grid"""
    return await page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('.event-card')].map(c => [
        new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay(),
        c.classList.contains('tinted') ? c.style.getPropertyValue('--card-ink') : '' ]))""")

async def rclick_weekday(page, wd):
    await page.evaluate("""(wd) => {
        const card = [...document.querySelectorAll('.event-card')].find(c =>
            new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === wd);
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    }""", wd)
    await page.wait_for_timeout(250)

async def click_weekday(page, wd):
    await page.evaluate("""(wd) => [...document.querySelectorAll('.event-card')].find(c =>
        new Date(c.closest('.day-column').dataset.date + 'T12:00').getDay() === wd).click()""", wd)
    await page.wait_for_timeout(400)

async def masters(page):
    return await page.evaluate("fetch('/api/events', {headers: {'x-admin-password': 't'}}).then(r => r.json()).then(d => d.events)")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto(CAL, wait_until="networkidle")
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

        # ---- the editor's swatch row
        col = page.locator(".day-column").nth(1)  # Monday
        box = await col.bounding_box()
        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + 200); await page.wait_for_timeout(400)
        swatches = await page.evaluate("[...document.querySelectorAll('#eventColorRow .color-swatch')].map(s => s.title)")
        check("the editor offers the named default, the nine other basic colors and Custom",
              swatches[0] == "Default (Red)" and len(swatches) == 11 and "Red" not in swatches[1:] and swatches[-1] == "Custom color…", str(swatches))
        check("Default is selected on a new block", await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "Default (Red)")
        await page.select_option("#eventType", "AVAILABLE"); await page.wait_for_timeout(100)
        swatches = await page.evaluate("[...document.querySelectorAll('#eventColorRow .color-swatch')].map(s => s.title)")
        check("availability names its default Green and offers Red instead",
              swatches[0] == "Default (Green)" and "Green" not in swatches[1:] and "Red" in swatches, str(swatches))
        check("and the caption says so", await page.text_content("#eventColorRow .color-caption") == "Default (Green)")
        check("the custom swatch is a real color input",
              await page.evaluate("document.querySelector('#eventColorRow input[type=color]') !== null"))
        await page.select_option("#eventType", "BLOCKED"); await page.wait_for_timeout(100)
        check("the Default swatch shows the type's color",
              await page.evaluate("document.querySelector('#eventColorRow .is-default').style.getPropertyValue('--swatch')") == "#b42318")
        await page.fill("#eventTitle", "Maya - Algebra II")
        await pick_swatch(page, "#eventColorRow", "Blue")
        check("picking a swatch names it", await page.text_content("#eventColorRow .color-caption") == "Blue")
        # repeat on Mon + Wed
        await page.select_option("#repeatType", "WEEKLY"); await page.wait_for_timeout(200)
        await page.evaluate("""() => [...document.querySelectorAll('#eventModal .weekday-btn')].forEach(el => {
            const wd = Number(el.dataset.day); const on = el.classList.contains('selected');
            if ((wd === 1 || wd === 3) !== on) el.click(); })""")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(900)
        colors = await card_colors(page)
        check("a two-day series saves blue and draws tinted", colors.get("1") == "#1d4ed8" and colors.get("3") == "#1d4ed8", str(colors))
        series = await masters(page)
        check("one series, no split", len({e.get("masterId") or e["id"] for e in series}) == 1 and series[0]["recurrence"]["weekdays"] == [1, 3], str(series))
        series_id = series[0].get("masterId") or series[0]["id"]

        # ---- Customize from the menu, all Wednesdays
        await rclick_weekday(page, 3)
        items = await menu_items(page)
        check("the block menu offers Customize after Edit", items[:2] == ["Edit", "Customize"], str(items))
        await click_menu(page, "Customize")
        labels = await scope_labels(page)
        check("a two-day series offers four reaches, including All Wednesdays",
              labels == ["This event only", "This and following events", "All Wednesdays", "All events in the series"], str(labels))
        check("the dialog carries the swatches with the block's color selected",
              await page.evaluate("document.querySelector('.choice-modal .color-swatch.selected').title") == "Blue")
        await pick_swatch(page, ".choice-modal", "Purple")
        await choose_scope(page, "All Wednesdays", ok="Apply")
        colors = await card_colors(page)
        check("Wednesday is purple, Monday still blue", colors.get("3") == "#6d28d9" and colors.get("1") == "#1d4ed8", str(colors))
        series = await masters(page)
        check("still one series - a color rule, not a split", len({e.get("masterId") or e["id"] for e in series}) == 1
              and series[0]["recurrence"]["colorRules"] == [{"weekday": 3, "color": "#6d28d9"}], str(series[0]["recurrence"]))
        status = await page.text_content("#status")
        check("the status names the color", "Purple" in status, status)

        # ---- a custom hex from the editor, this event only, stays one series
        await click_weekday(page, 1)
        check("the editor opens with the block's color", await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "Blue")
        await set_custom(page, "#eventColorRow", "#ff8800")
        check("a custom color shows its hex", await page.text_content("#eventColorRow .color-caption") == "#FF8800")
        check("and it appears as a selected preset swatch beside the +",
              await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "#FF8800"
              and await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').classList.contains('is-preset')"))
        await page.click("#saveEventBtn")
        heading = await page.text_content(".choice-modal h2")
        check("a color-only save asks about color, not editing", heading == "Customize recurring event", heading)
        labels = await scope_labels(page)
        check("with All Mondays on offer", "All Mondays" in labels, str(labels))
        await choose_scope(page, "This event only")
        await page.wait_for_timeout(400)
        colors = await card_colors(page)
        check("this Monday is orange (darkened for the text)", colors.get("1") not in ("", "#1d4ed8") and colors.get("3") == "#6d28d9", str(colors))
        series = await masters(page)
        check("the series is still one record", len({e.get("masterId") or e["id"] for e in series}) == 1
              and any(r.get("date") and r["color"] == "#ff8800" for r in series[0]["recurrence"]["colorRules"]), str(series[0]["recurrence"]))
        # next week's Monday is still blue
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(600)
        colors = await card_colors(page)
        check("next Monday keeps the series blue", colors.get("1") == "#1d4ed8", str(colors))
        await page.click("#prevWeekBtn"); await page.wait_for_timeout(600)

        # ---- the custom color is now a preset, here and on another block
        await click_weekday(page, 3)
        swatches = await page.evaluate("[...document.querySelectorAll('#eventColorRow .color-swatch')].map(s => s.title)")
        check("the custom color used on Monday is a preset when editing Wednesday, before the +",
              "#FF8800" in swatches and swatches.index("#FF8800") == len(swatches) - 2, str(swatches))
        check("and Wednesday's editor shows Wednesday's own color", await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "Purple")
        check("every swatch sits on one row",
              await page.evaluate("""() => { const tops = new Set([...document.querySelectorAll('#eventColorRow .color-swatch')].map(s => Math.round(s.getBoundingClientRect().top))); return tops.size === 1; }"""))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)
        await rclick_weekday(page, 3)
        await click_menu(page, "Customize")
        swatches = await page.evaluate("[...document.querySelectorAll('.choice-modal .color-swatch')].map(s => s.title)")
        check("and it survives a reload, in the Customize dialog too (served by the server)", "#FF8800" in swatches, str(swatches))
        check("the dialog's row is one line as well",
              await page.evaluate("""() => { const tops = new Set([...document.querySelectorAll('.choice-modal .color-swatch')].map(s => Math.round(s.getBoundingClientRect().top))); return tops.size === 1; }"""))
        check("the dialog is no wider than its content",
              await page.evaluate("""() => { const card = document.querySelector('.choice-modal').getBoundingClientRect();
                  const widest = Math.max(...[...document.querySelectorAll('.choice-modal > *')].map(el => el.getBoundingClientRect().width));
                  return card.width - widest < 60; }"""))
        check("each preset carries a remove x", await page.evaluate("document.querySelector('.choice-modal .color-swatch.is-preset .color-preset-remove') !== null"))
        await pick_swatch(page, ".choice-modal", "#FF8800")
        await choose_scope(page, "This event only", ok="Apply")
        colors = await card_colors(page)
        check("a preset applies like any swatch", colors.get("3") == colors.get("1"), str(colors))
        await rclick_weekday(page, 3)
        await click_menu(page, "Customize")
        await pick_swatch(page, ".choice-modal", "Purple")
        await choose_scope(page, "All Wednesdays", ok="Apply")

        # ---- removing a preset forgets it everywhere, and keeps the blocks that wear it
        await rclick_weekday(page, 1)
        await click_menu(page, "Customize")
        await page.evaluate("document.querySelector('.choice-modal .color-swatch[title=\"#FF8800\"] .color-preset-remove').click()")
        await page.wait_for_timeout(300)
        swatches = await page.evaluate("[...document.querySelectorAll('.choice-modal .color-swatch')].map(s => s.title)")
        check("the x removes the preset from the row at once", "#FF8800" not in swatches, str(swatches))
        check("and, as it was the selection, Default is selected", await page.evaluate("document.querySelector('.choice-modal .color-swatch.selected').title") == "Default (Red)")
        await page.keyboard.press("Escape"); await page.wait_for_timeout(300)
        colors = await card_colors(page)
        check("cancelling leaves Monday's orange in place", colors.get("1") not in ("", "#1d4ed8"), str(colors))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)
        await click_weekday(page, 3)
        swatches = await page.evaluate("[...document.querySelectorAll('#eventColorRow .color-swatch')].map(s => s.title)")
        check("the server forgot it too", "#FF8800" not in swatches, str(swatches))
        check("and the editor shows the clicked Wednesday's own purple, not Monday's",
              await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "Purple")
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)

        # ---- many presets wrap onto more rows rather than widening the dialog forever
        await page.evaluate("""async () => { for (const hx of ['#14b8a6','#f472b6','#a3e635','#818cf8','#7c2d12','#0ea5e9','#e11d48','#65a30d','#9333ea','#facc15']) {
            await fetch('/api/events/' + %s + '/color', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify({ color: hx, scope: 'all' }) }); } }""" % repr(series_id))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)
        await rclick_weekday(page, 3)
        await click_menu(page, "Customize")
        rows = await page.evaluate("new Set([...document.querySelectorAll('.choice-modal .color-swatch')].map(s => Math.round(s.getBoundingClientRect().top))).size")
        width = await page.evaluate("document.querySelector('.choice-modal').getBoundingClientRect().width")
        check("with many presets the swatches wrap onto more rows and the dialog stays a sane width", rows >= 2 and width <= 520, f"rows={rows} width={width}")
        order = await page.evaluate("[...document.querySelectorAll('.choice-modal .color-swatch.is-preset')].map(s => s.title)")
        check("presets keep the order they were first used, newest on the right", order[-1] == "#FACC15" and order[0] == "#14B8A6", str(order))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)
        # put the series back the way it was: blue, Wednesdays purple, this Monday orange, no extra presets
        await page.evaluate("""async (id) => {
            const hdr = { 'Content-Type': 'application/json', 'x-admin-password': 't' };
            for (const hx of ['#14b8a6','#f472b6','#a3e635','#818cf8','#7c2d12','#0ea5e9','#e11d48','#65a30d','#9333ea','#facc15']) {
                await fetch('/api/customcolors/' + encodeURIComponent(hx), { method: 'DELETE', headers: hdr }); }
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const mon = cols.find(d => new Date(d + 'T12:00').getDay() === 1);
            const wed = cols.find(d => new Date(d + 'T12:00').getDay() === 3);
            const paint = (body) => fetch('/api/events/' + id + '/color', { method: 'POST', headers: hdr, body: JSON.stringify(body) });
            await paint({ color: '#1d4ed8', scope: 'all' });
            await paint({ color: '#6d28d9', scope: 'weekday', date: wed });
            await paint({ color: '#ff8800', scope: 'one', date: mon });
            await fetch('/api/customcolors/%23ff8800', { method: 'DELETE', headers: hdr });
        }""", series_id)
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)

        # ---- an edit that changes more than color still goes through Edit recurring event
        await click_weekday(page, 3)
        await page.fill("#eventTitle", "Maya - Calculus")
        await page.click("#saveEventBtn")
        heading = await page.text_content(".choice-modal h2")
        check("a real edit still asks how far the edit reaches", heading == "Edit recurring event", heading)
        await choose_scope(page, "All events, past and future")
        colors = await card_colors(page)
        check("an untouched swatch leaves every color alone", colors.get("3") == "#6d28d9" and colors.get("1") not in ("", "#1d4ed8"), str(colors))

        # ---- the summary marks the student with the dominant color
        dot = await page.evaluate("document.querySelector('#summaryList .week-summary-dot') && document.querySelector('#summaryList .week-summary-dot').style.getPropertyValue('--dot')")
        check("the summary's dot is colored", bool(dot) and dot != "", str(dot))

        # ---- copy and paste carry the color
        await rclick_weekday(page, 3)
        await click_menu(page, "Copy")
        fri = page.locator(".day-column").nth(5)
        fbox = await fri.bounding_box()
        await page.mouse.click(fbox["x"] + fbox["width"] / 2, fbox["y"] + 300, button="right"); await page.wait_for_timeout(300)
        items = await menu_items(page)
        await click_menu(page, next(i for i in items if i.startswith("Paste")))
        check("the pasted block opens with the copied color", await page.evaluate("document.querySelector('#eventColorRow .color-swatch.selected').title") == "Purple")
        await page.click("#saveEventBtn"); await page.wait_for_timeout(800)
        colors = await card_colors(page)
        check("and saves purple", colors.get("5") == "#6d28d9", str(colors))

        # ---- the public page keeps red and green
        await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(700)
        tinted = await page.evaluate("document.querySelectorAll('.event-card.tinted').length")
        check("the public view has no tinted cards", tinted == 0, str(tinted))
        body = await page.evaluate("fetch('/api/events?start=2020-01-01&end=2030-01-01').then(r => r.text())")
        import json as _json
        pub = _json.loads(body)
        check("and the public API carries no block colors or presets - only the two defaults", "color" not in _json.dumps(pub["events"]) and "customColors" not in pub and "colors" in pub["config"])
        await page.evaluate("document.getElementById('backToAdminBtn').click()"); await page.wait_for_timeout(700)

        # ---- delete All Mondays
        await rclick_weekday(page, 1)
        await click_menu(page, "Delete…")
        labels = await scope_labels(page)
        check("the delete dialog offers All Mondays on a two-day series",
              labels == ["This event only", "This and following events", "All Mondays", "All events, past and future"], str(labels))
        await choose_scope(page, "All Mondays")
        colors = await card_colors(page)
        check("Mondays are gone, Wednesday and the Friday copy remain", "1" not in colors and colors.get("3") == "#6d28d9" and colors.get("5") == "#6d28d9", str(colors))
        series = await masters(page)
        main_series = next(e for e in series if (e.get("masterId") or e["id"]) == series_id)
        check("the series now meets on Wednesdays only", main_series["recurrence"]["weekdays"] == [3], str(main_series["recurrence"]))
        status = await page.text_content("#status")
        check("and says so", "Every Monday removed" in status, status)
        await rclick_weekday(page, 3)
        await click_menu(page, "Delete…")
        labels = await scope_labels(page)
        check("a one-day series is back to three reaches", len(labels) == 3, str(labels))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)

        # ---- undo puts the Mondays (and their colors) back
        await page.evaluate("document.getElementById('undoBtn').click()"); await page.wait_for_timeout(900)
        colors = await card_colors(page)
        check("undo restores the Mondays with their colors", colors.get("1") not in (None, "", "#1d4ed8"), str(colors))

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
