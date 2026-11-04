#!/usr/bin/env python3
"""A session request with contact details: the public form asks for an
email (required), phone and parent/guardian (optional); the admin's
Requests list shows them as links; Accept carries them into the
session's notes; the notification would reply to the requester.

    python3 tests/requests.py
"""
import asyncio, os, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8985
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1300, "height": 950})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        # the tutor sets a notification address (so the stub records a "sent" email)
        await page.goto(CAL, wait_until="networkidle")
        await page.evaluate("fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify({ notificationEmail: 'ethan@example.com' }) })")
        await page.wait_for_timeout(200)

        # ---- a visitor requests a session
        await page.click("#requestBtn"); await page.wait_for_timeout(400)
        check("the form asks for email, phone and parent/guardian", await page.evaluate("!!document.getElementById('requestEmail') && !!document.getElementById('requestPhone') && !!document.getElementById('requestGuardian')"))
        next_week = await page.evaluate("new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)")
        await page.fill("#requestName", "Maya Chen")
        await page.fill("#requestSubject", "Algebra II")
        await page.select_option("#requestFormat", index=1)
        await page.evaluate("""(d) => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); };
            set('requestStart', d + 'T16:00'); set('requestEnd', d + 'T17:00'); }""", next_week)
        await page.evaluate("document.getElementById('sendRequestBtn').click()"); await page.wait_for_timeout(400)
        check("without an email the form refuses and says why", "email" in (await page.text_content("#requestError")).lower(), await page.text_content("#requestError"))
        await page.fill("#requestEmail", "maya.chen@example.com")
        await page.fill("#requestPhone", "(555) 555-1234")
        await page.fill("#requestGuardian", "Lin Chen")
        await page.evaluate("document.getElementById('sendRequestBtn').click()"); await page.wait_for_timeout(900)
        if not await page.evaluate("document.getElementById('requestModal').classList.contains('hidden')"):
            # a time warning may be up; send anyway
            await page.evaluate("document.getElementById('sendRequestAnywayBtn').click()"); await page.wait_for_timeout(900)
        check("the request is sent", await page.evaluate("document.getElementById('requestModal').classList.contains('hidden')")
              and "Request sent" in await page.text_content("#status"), await page.text_content("#status"))
        sent = await page.evaluate("fetch('/api/sentmail').then(r => r.json())")
        check("the notification went to the tutor with replies routed to the requester",
              sent["sentMail"] and sent["sentMail"][-1]["to"] == "ethan@example.com" and sent["sentMail"][-1]["replyTo"] == "maya.chen@example.com", str(sent))

        # ---- the admin sees the contact details
        await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        await page.click("#requestsBtn"); await page.wait_for_timeout(600)
        contact = await page.evaluate("document.querySelector('.request-contact') && document.querySelector('.request-contact').textContent")
        check("the request lists the guardian, email and phone", contact and "Lin Chen" in contact and "maya.chen@example.com" in contact and "(555) 555-1234" in contact, str(contact))
        links = await page.evaluate("[...document.querySelectorAll('.request-contact a')].map(a => a.getAttribute('href'))")
        check("email and phone are tap-to-use links", links == ["mailto:maya.chen@example.com", "tel:5555551234"], str(links))

        # ---- accepting carries them into the notes
        await page.evaluate("[...document.querySelectorAll('.request-item-actions button')].find(b => b.textContent.trim() === 'Accept').click()")
        await page.wait_for_timeout(500)
        notes = await page.input_value("#eventNotes")
        check("Accept opens the editor with the contact in the notes", "Algebra II" in notes and "Lin Chen" in notes and "maya.chen@example.com" in notes and "(555) 555-1234" in notes, notes)
        check("and the title as before", "Maya Chen" in await page.input_value("#eventTitle"))

        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check("no page errors", not real, str(real[:3]))
        print(f"\n{len(oks)} passed, {len(fails)} failed")
        await b.close()
        return 1 if fails else 0

def run():
    subprocess.run(["node", "tests/install-shim.mjs"], check=True, stdout=subprocess.DEVNULL)
    env = dict(os.environ, FAKE_MAIL="ok")
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
