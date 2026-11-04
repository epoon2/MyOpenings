#!/usr/bin/env python3
"""Several calendars per account, and the master account: the
dashboard lists and makes calendars; on any of them the others can be
drawn over it and their blocks edited in place; the site's owner sees
every account and opens any calendar as its admin.

    python3 tests/multical.py
"""
import asyncio, os, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8998
BASE = f"http://127.0.0.1:{PORT}"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def hidden(page, sel):
    return await page.evaluate(f"document.querySelector('{sel}').classList.contains('hidden')")

async def signup(page, name, title, email):
    await page.goto(BASE + "/?signup", wait_until="networkidle"); await page.wait_for_timeout(300)
    await page.fill("#signupName", name); await page.fill("#signupTitle", title)
    await page.fill("#signupEmail", email); await page.fill("#signupPassword", "pass-word-1")
    await page.click("#signupSubmit"); await page.wait_for_load_state("networkidle"); await page.wait_for_timeout(800)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        # ---- one calendar: straight in, no switch, but a way to the dashboard
        await signup(page, "Maya Chen", "Maya's Tutoring", "maya@example.com")
        check("sign-up with no email set up lands straight on the calendar, confirmed", page.url.endswith("/maya-chen") and not await hidden(page, "#adminBanner"))
        check("with one calendar there is no side panel and no Calendars toggle", await hidden(page, "#calendarsPanel") and await hidden(page, "#calendarsBtn")
              and not await page.evaluate("document.querySelector('.calendar-body').classList.contains('with-panel')"))
        await page.click("#profileBtn"); await page.wait_for_timeout(200)
        check("the profile menu offers My calendars, not Admin view, and names her Owner", not await hidden(page, "#dashboardLink") and await hidden(page, "#accountsLink")
              and await page.text_content("#profileMenuMode") == "Owner")
        await page.click("#dashboardLink"); await page.wait_for_load_state("networkidle"); await page.wait_for_timeout(500)

        # ---- the dashboard
        check("the dashboard lists the one calendar as the main one, public", page.url.endswith("/dashboard")
              and await page.evaluate("document.querySelectorAll('.cal-card').length") == 1
              and "Main calendar" in await page.text_content(".cal-card") and "Public" in await page.text_content(".cal-card"))
        check("and shows no account list to an ordinary account", await hidden(page, "#accounts"))
        await page.fill("#newCalName", "Piano lessons")
        await page.click("#newCalBtn"); await page.wait_for_timeout(800)
        cards = await page.evaluate("[...document.querySelectorAll('.cal-card')].map(c => c.dataset.slug)")
        check("a new calendar is made from its name", cards == ["maya-chen", "piano-lessons"], str(cards))
        check("the main calendar cannot be deleted from here, the new one can", await page.evaluate("!document.querySelector('.cal-card[data-slug=\"maya-chen\"] .danger-link') && !!document.querySelector('.cal-card[data-slug=\"piano-lessons\"] .danger-link')"))
        await page.goto(BASE + "/", wait_until="networkidle"); await page.wait_for_timeout(800)
        check("the home page now sends her to the dashboard, since she has two", page.url.endswith("/dashboard"))

        # ---- the second calendar is hers, and gets a block
        await page.goto(BASE + "/piano-lessons", wait_until="networkidle"); await page.wait_for_timeout(600)
        check("the new calendar opens in admin mode with its own title and her name", not await hidden(page, "#adminBanner") and await page.text_content("#portalTitle") == "Piano lessons"
              and await page.text_content("#profileName") == "Maya Chen")
        await page.evaluate("""async () => {
            const cols = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date);
            const wed = cols.find(d => new Date(d + 'T12:00').getDay() === 3);
            const token = JSON.parse(localStorage.getItem('calendarSession')).token;
            await fetch('/api/events?calendar=piano-lessons', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-session': token},
                body: JSON.stringify({ type: 'BLOCKED', title: 'Kai - piano', start: wed + 'T16:00', end: wed + 'T17:00' }) });
        }""")

        # ---- overlaying it on the first calendar
        await page.goto(BASE + "/maya-chen", wait_until="networkidle"); await page.wait_for_timeout(800)
        check("with two calendars a side panel appears beside the grid, like Google Calendar", not await hidden(page, "#calendarsPanel")
              and await page.evaluate("document.querySelector('.calendar-body').classList.contains('with-panel')")
              and await page.evaluate("(() => { const p = document.getElementById('calendarsPanel').getBoundingClientRect(), c = document.getElementById('calendar').getBoundingClientRect(); return p.right <= c.left + 1 && p.width > 150; })()"))
        check("and no borrowed blocks yet", await page.evaluate("document.querySelectorAll('.event-card.overlay').length") == 0)
        rows = await page.evaluate("[...document.querySelectorAll('#calendarsList .calendar-row')].map(r => [r.querySelector('.calendar-name').textContent, r.querySelector('input').checked, r.querySelector('input').disabled, r.querySelector('input').getAttribute('role')])")
        check("the panel lists both as switches, this one on and fixed", rows == [["Maya's Tutoring", True, True, "switch"], ["Piano lessons", False, False, "switch"]], str(rows))
        await page.check("#calendarsList .calendar-row:nth-child(2) input"); await page.wait_for_timeout(800)
        card = await page.query_selector(".event-card.overlay")
        check("switching Piano lessons on draws its block here, dashed and tagged", card is not None and "Kai - piano" in await card.text_content() and "Piano lessons" in await card.text_content()
              and await page.evaluate("document.querySelector('.event-card.overlay').dataset.calendar") == "piano-lessons")
        check("the choice is kept for this calendar on this device", await page.evaluate("JSON.parse(localStorage.getItem('overlays:maya-chen'))") == ["piano-lessons"])
        await page.evaluate("document.body.click()")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(800)
        check("and survives a reload", await page.evaluate("document.querySelectorAll('.event-card.overlay').length") == 1)

        # ---- editing the borrowed block in place
        await page.click(".event-card.overlay"); await page.wait_for_timeout(400)
        check("the borrowed block opens in the editor", await page.input_value("#eventTitle") == "Kai - piano")
        await page.fill("#eventTitle", "Kai - piano (moved)")
        await page.evaluate("document.getElementById('saveEventBtn').click()"); await page.wait_for_timeout(900)
        titles = await page.evaluate("""() => { const token = JSON.parse(localStorage.getItem('calendarSession')).token;
            return fetch('/api/events?start=2020-01-01&end=2030-01-01&calendar=piano-lessons', { headers: { 'x-session': token } }).then(r => r.json()).then(d => d.events.map(e => e.title)); }""")
        check("the change went to the Piano lessons calendar", titles == ["Kai - piano (moved)"], str(titles))
        own = await page.evaluate("""() => { const token = JSON.parse(localStorage.getItem('calendarSession')).token;
            return fetch('/api/events?start=2020-01-01&end=2030-01-01&calendar=maya-chen', { headers: { 'x-session': token } }).then(r => r.json()).then(d => d.events.length); }""")
        check("and not to the calendar on screen", own == 0, str(own))
        check("the block on screen shows the new title", "Kai - piano (moved)" in await page.text_content(".event-card.overlay"))

        # ---- the master
        master = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        master.on("pageerror", lambda e: errs.append(str(e)))
        await master.goto(BASE + "/?signup", wait_until="networkidle"); await master.wait_for_timeout(300)
        await master.fill("#signupName", "Ethan"); await master.fill("#signupEmail", "ethan@example.com"); await master.fill("#signupPassword", "ethan-pass-1")
        await master.check("#claimMain"); await master.fill("#claimPassword", "t")
        await master.click("#signupSubmit"); await master.wait_for_load_state("networkidle"); await master.wait_for_timeout(1000)
        check("the site's owner is sent to the dashboard", master.url.endswith("/dashboard"), master.url)
        await master.wait_for_timeout(600)
        check("which lists every account with its calendars", not await hidden(master, "#accounts")
              and "maya@example.com" in await master.text_content("#accountsBody") and "Piano lessons" in await master.text_content("#accountsBody")
              and "Site owner" in await master.text_content("#accountsBody"))
        await master.click("#accountsBody a[href='/maya-chen']"); await master.wait_for_load_state("networkidle"); await master.wait_for_timeout(800)
        check("opening someone's calendar from there is admin mode for the master", master.url.endswith("/maya-chen") and not await hidden(master, "#adminBanner")
              and not await hidden(master, "#modeSwitch"))
        await master.click("#profileBtn"); await master.wait_for_timeout(200)
        check("with Admin view in the menu, and the role Admin", not await hidden(master, "#accountsLink") and (await master.text_content("#accountsLink")).strip() == "Admin view"
              and await master.text_content("#profileMenuMode") == "Admin")

        # ---- deleting a calendar
        await page.goto(BASE + "/dashboard", wait_until="networkidle"); await page.wait_for_timeout(600)
        page.once("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await page.click(".cal-card[data-slug='piano-lessons'] .danger-link"); await page.wait_for_timeout(800)
        cards = await page.evaluate("[...document.querySelectorAll('.cal-card')].map(c => c.dataset.slug)")
        check("deleting the second calendar leaves the first", cards == ["maya-chen"], str(cards))
        await page.goto(BASE + "/piano-lessons", wait_until="networkidle"); await page.wait_for_timeout(500)
        check("and its address is gone", await page.evaluate("document.body.classList.contains('calendar-missing')"))

        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check("no page errors", not real, str(real[:3]))
        print(f"\n{len(oks)} passed, {len(fails)} failed")
        await b.close()
        return 1 if fails else 0

def run():
    subprocess.run(["node", "tests/install-shim.mjs"], check=True, stdout=subprocess.DEVNULL)
    env = dict(os.environ, MASTER_EMAIL="ethan@example.com")
    env.pop("FAKE_MAIL", None)
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
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
