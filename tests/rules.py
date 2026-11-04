#!/usr/bin/env python3
"""The request form's own settings: its introduction, the rules a
request must meet (notice, how far ahead, session length), turning
requests off altogether, and whether visitors see booked time.

    python3 tests/rules.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8996
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def hidden(page, sel):
    return await page.evaluate(f"document.querySelector('{sel}').classList.contains('hidden')")

async def put_settings(page, body):
    return await page.evaluate("(body) => fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) }).then(r => r.json())", body)

async def post_request(page, hours_ahead, minutes=60):
    return await page.evaluate("""([h, m]) => {
        const start = new Date(Date.now() + h * 3600000); start.setSeconds(0, 0); start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
        const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const end = new Date(start.getTime() + m * 60000);
        return fetch('/api/requests', { method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name: 'Maya', email: 'maya@example.com', subject: 'Math', format: 'Online', start: local(start), end: local(end), recurrence: null }) })
            .then(r => r.json().then(d => ({ status: r.status, ...d })));
    }""", [hours_ahead, minutes])

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1300, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle")

        # the calendar has an open block and a booked one on the same day, a week out
        await page.evaluate("""async () => {
            const d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
            const post = (body) => fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'open', start: d + 'T09:00', end: d + 'T13:00' });
            await post({ type: 'BLOCKED', title: 'Noah', start: d + 'T10:00', end: d + 'T11:00' });
        }""")

        # ---- defaults: the form has the standard introduction and no rules line
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(500)
        check("visitors get a Request button by default", not await hidden(page, "#requestBtn"))
        await page.click("#requestBtn"); await page.wait_for_timeout(300)
        check("the standard introduction names the owner", "Ethan confirms it" in (await page.text_content("#requestIntro")))
        check("and no rules line, since the defaults are in force", await hidden(page, "#requestRules"))
        await page.evaluate("document.querySelector('#requestModal [data-close]').click()")
        r = await post_request(page, 2)
        check("a request two hours out is fine by default", r["status"] == 201, str(r))

        # ---- the admin sets rules and wording in Settings
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
        check("Settings shows requests on, the standard rules and booked time shown",
              await page.is_checked("#settingRequestsEnabled") and await page.input_value("#settingMinNotice") == "0" and await page.input_value("#settingMaxWeeks") == "12"
              and await page.evaluate("document.getElementById('settingMinMinutes').value") == "15" and await page.evaluate("document.getElementById('settingMaxMinutes').value") == "480"
              and await page.is_checked("#settingShowBooked"))
        await page.fill("#settingRequestIntro", "Tell me what you'd like to work on and I'll get back to you within a day.")
        await page.fill("#settingMinNotice", "24"); await page.fill("#settingMaxWeeks", "2")
        await page.select_option("#settingMinMinutes", "30"); await page.select_option("#settingMaxMinutes", "120")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("the rules save", (await page.text_content("#status")).startswith("Settings saved"), await page.text_content("#status"))

        # ---- a visitor sees the wording and the rules, and the server holds them
        await page.click("#exitAdminBtn"); await page.wait_for_timeout(600)
        await page.click("#requestBtn"); await page.wait_for_timeout(300)
        check("the form carries the owner's introduction", (await page.text_content("#requestIntro")).startswith("Tell me what you'd like"))
        rules = await page.text_content("#requestRules")
        check("and states the rules", not await hidden(page, "#requestRules") and "24 hours' notice" in rules and "2 weeks ahead" in rules and "30 minutes to 2 hours" in rules, rules)
        await page.evaluate("document.querySelector('#requestModal [data-close]').click()")
        r = await post_request(page, 2)
        check("two hours out is refused for want of notice", r["status"] == 400 and "notice" in r["error"], str(r))
        r = await post_request(page, 24 * 30)
        check("a month out is refused as too far ahead", r["status"] == 400 and "2 weeks" in r["error"], str(r))
        r = await post_request(page, 48, 15)
        check("a quarter-hour is refused as too short", r["status"] == 400 and "30 minutes" in r["error"], str(r))
        r = await post_request(page, 48, 180)
        check("three hours is refused as too long", r["status"] == 400 and "2 hours" in r["error"], str(r))
        r = await post_request(page, 48, 60)
        check("an hour, two days out, goes through", r["status"] == 201, str(r))

        # ---- requests off
        await page.evaluate("(b) => fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(b) })", {"requests": {"enabled": False}})
        await page.wait_for_timeout(200)
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(500)
        check("with requests off the button is gone", await hidden(page, "#requestBtn"))
        r = await post_request(page, 48, 60)
        check("and the server refuses one anyway", r["status"] == 403, str(r))

        # ---- privacy: booked time hidden from visitors (the blocks are a week out; a fresh visitor, not the remembered admin)
        visitor = await (await b.new_context(viewport={"width": 1300, "height": 950})).new_page()
        await visitor.goto(CAL, wait_until="networkidle"); await visitor.wait_for_timeout(400)
        await visitor.click("#nextWeekBtn"); await visitor.wait_for_timeout(600)
        cards = await visitor.evaluate("[...document.querySelectorAll('.event-card')].map(c => c.className)")
        check("visitors see the booked block by default", any("blocked" in c for c in cards), str(cards))
        await page.evaluate("(b) => fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify(b) })", {"privacy": {"showBooked": False}})
        await page.wait_for_timeout(200)
        await visitor.reload(wait_until="networkidle"); await visitor.wait_for_timeout(500)
        await visitor.click("#nextWeekBtn"); await visitor.wait_for_timeout(600)
        cards = await visitor.evaluate("[...document.querySelectorAll('.event-card')].map(c => c.className)")
        check("with booked time hidden they see open time only", cards and not any("blocked" in c for c in cards), str(cards))
        open_times = await visitor.evaluate("[...document.querySelectorAll('.event-card')].map(c => c.textContent)")
        check("and the open time still leaves the booked hour out", len(open_times) == 2, str(open_times))

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
