#!/usr/bin/env python3
"""Accounts, end to end: the home page, sign-up, the unconfirmed
calendar, the confirmation link, log in from a calendar page, visiting
someone else's calendar while signed in, taking over the first calendar
with the admin password, and the page for an address with no calendar.

    python3 tests/accounts.py
"""
import asyncio, json, os, re, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8993
BASE = f"http://127.0.0.1:{PORT}"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def hidden(page, sel):
    return await page.evaluate(f"document.querySelector('{sel}').classList.contains('hidden')")

def sent_mail():
    return json.load(urllib.request.urlopen(f"{BASE}/api/sentmail"))["sentMail"]

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1300, "height": 900})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        # ---- the home page
        await page.goto(BASE + "/", wait_until="networkidle"); await page.wait_for_timeout(300)
        check("the home page opens with the dialog closed and a sticky header", await hidden(page, "#authModal")
              and await page.evaluate("getComputedStyle(document.querySelector('.home-top')).position") == "sticky")
        check("it is a long page with sections", await page.evaluate("document.body.scrollHeight") > 2000
              and await page.evaluate("['how','features','visitors','faq'].every(id => document.getElementById(id))"))
        check("the footer points to the first calendar's address; no live-calendar link on the page", "/ethan" in (await page.text_content("#footNote"))
              and await page.evaluate("!document.getElementById('exampleLink')")
              and await page.evaluate("[...document.querySelectorAll('a')].every(a => a.getAttribute('href') !== '/ethan' || a.closest('#footNote'))"))
        check("the sections are full-width bands", await page.evaluate("document.querySelectorAll('section.band').length") >= 5
              and await page.evaluate("Math.abs(document.querySelector('section.band').getBoundingClientRect().width - window.innerWidth) < 2"))
        await page.click("#topLoginBtn"); await page.wait_for_timeout(200)
        check("Log in opens the dialog on Log in", not await hidden(page, "#authModal") and not await hidden(page, "#loginPanel") and await hidden(page, "#signupPanel"))
        await page.keyboard.press("Escape"); await page.wait_for_timeout(100)
        check("Escape closes it", await hidden(page, "#authModal"))
        await page.click("#heroSignupBtn"); await page.wait_for_timeout(200)
        check("Create your calendar opens it on Sign up, offering to take over the first calendar, which nobody owns yet",
              not await hidden(page, "#signupPanel") and not await hidden(page, "#claimRow"))
        check("sign-up asks for a calendar name, not an address", await page.evaluate("!!document.getElementById('signupTitle') && !document.getElementById('signupSlug')"))

        # ---- sign up
        await page.fill("#signupName", "Maya Chen")
        await page.fill("#signupTitle", "Maya's Piano Lessons")
        await page.fill("#signupEmail", "maya@example.com")
        await page.fill("#signupPassword", "maya-pass-1")
        await page.click("#signupSubmit"); await page.wait_for_timeout(800)
        check("sign-up says a confirmation email went out and where the calendar is",
              not await hidden(page, "#welcomePanel") and "maya@example.com" in (await page.text_content("#welcomeText")) and "/maya-chen" in (await page.text_content("#welcomeText")))
        mail = sent_mail()
        check("the email carries a confirmation link to the home page", len(mail) == 1 and mail[0]["to"] == "maya@example.com" and "/?verify=" in mail[0]["text"])
        link = re.search(r"http://\S+\?verify=\S+", mail[0]["text"]).group(0)

        await page.click("#welcomeOpen"); await page.wait_for_load_state("networkidle"); await page.wait_for_timeout(800)
        check("Open my calendar lands on /maya-chen in admin mode", page.url.endswith("/maya-chen") and not await hidden(page, "#adminBanner"))
        check("with the calendar name as its title, the address from her name, and the chip", await page.text_content("#portalTitle") == "Maya's Piano Lessons" and await page.text_content("#profileName") == "Maya Chen")
        check("and a notice that the email is not confirmed", not await hidden(page, "#verifyNotice") and "maya@example.com" in (await page.text_content("#verifyNoticeText")))

        # ---- the calendar is not public until confirmed
        visitor = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        await visitor.goto(BASE + "/maya-chen", wait_until="networkidle"); await visitor.wait_for_timeout(500)
        check("a visitor is told the calendar is not published yet", await visitor.evaluate("document.body.classList.contains('calendar-missing')") and "not published" in (await visitor.text_content("#missingTitle")))

        # ---- the confirmation link, on another device
        confirm = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        await confirm.goto(link, wait_until="networkidle"); await confirm.wait_for_timeout(1500)
        check("the link confirms the email and goes to the calendar, signed in", confirm.url.endswith("/maya-chen") and not await hidden(confirm, "#adminBanner"))
        await visitor.reload(wait_until="networkidle"); await visitor.wait_for_timeout(500)
        check("now the visitor sees it", not await visitor.evaluate("document.body.classList.contains('calendar-missing')") and await visitor.text_content("#portalTitle") == "Maya's Piano Lessons")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        check("and the notice is gone on the first device", await hidden(page, "#verifyNotice"))

        # ---- the address in Settings
        await page.click("#gearBtn"); await page.wait_for_timeout(100)
        await page.click("#settingsBtn"); await page.wait_for_timeout(500)
        check("Settings shows the address and the link to share", await page.input_value("#settingSlug") == "maya-chen" and (await page.text_content("#shareLink")).endswith("/maya-chen"))
        await page.fill("#settingSlug", "maya")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("a new address moves the page there", page.url.endswith("/maya") and not await hidden(page, "#adminBanner"))
        await visitor.goto(BASE + "/maya-chen", wait_until="networkidle"); await visitor.wait_for_timeout(400)
        check("and the old one is free", await visitor.evaluate("document.body.classList.contains('calendar-missing')"))

        # ---- sign out, log in from the calendar page
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        await page.click("#signOutBtn"); await page.wait_for_timeout(600)
        check("Sign out shows the visitor page with Log in", not await hidden(page, "#adminBtn") and await hidden(page, "#profileMenu"))
        await page.click("#adminBtn"); await page.wait_for_timeout(200)
        check("Log in asks for email and password, no admin-password option", not await hidden(page, "#accountLoginFields") and await hidden(page, "#legacyLoginLink"))
        await page.fill("#loginEmailInput", "maya@example.com"); await page.fill("#loginPasswordInput", "wrong-pass")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(500)
        check("a wrong password is refused", "do not match" in (await page.text_content("#loginError")))
        await page.fill("#loginPasswordInput", "maya-pass-1")
        await page.click("#loginSubmitBtn"); await page.wait_for_timeout(800)
        check("the right one opens admin mode", await hidden(page, "#loginModal") and not await hidden(page, "#adminBanner"))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        check("and a reload stays signed in", not await hidden(page, "#adminBanner"))

        # ---- Public view while signed in as the owner shows what a visitor gets, not the owner's answer
        await page.click("#nextWeekBtn"); await page.wait_for_timeout(600)
        await page.evaluate("""async () => { const wed = [...document.querySelectorAll('.day-column')].map(c => c.dataset.date)[3];
            const token = JSON.parse(localStorage.getItem('calendarSession')).token;
            const post = (body) => fetch('/api/events?calendar=maya', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-session': token}, body: JSON.stringify(body) });
            await post({ type: 'AVAILABLE', title: 'Available', start: wed + 'T09:00', end: wed + 'T12:00' });
            await post({ type: 'BLOCKED', title: 'Leo - algebra', start: wed + 'T10:00', end: wed + 'T11:00' }); }""")
        await page.evaluate("document.getElementById('refreshBtn').click()"); await page.wait_for_timeout(800)
        check("the owner sees the student's name", "Leo - algebra" in (await page.text_content("#calendar")))
        await page.click("#exitAdminBtn"); await page.wait_for_timeout(900)
        check("Public view, still signed in, shows the visitor's calendar: no name, the block just booked", await hidden(page, "#adminBanner")
              and "Leo - algebra" not in (await page.text_content("#calendar")) and await page.evaluate("document.querySelectorAll('.event-card').length") >= 2
              and not await hidden(page, "#profileMenu"), await page.text_content("#calendar"))
        await page.click("#backToAdminBtn"); await page.wait_for_timeout(900)
        check("Edit view brings the name back without a password", "Leo - algebra" in (await page.text_content("#calendar")) and await hidden(page, "#loginModal"))
        await page.click("#todayBtn"); await page.wait_for_timeout(500)

        # ---- change password
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        check("the menu offers Change password to an account", not await hidden(page, "#changePasswordBtn"))
        await page.click("#changePasswordBtn"); await page.wait_for_timeout(300)
        await page.fill("#currentPasswordInput", "wrong-pass"); await page.fill("#newPasswordInput", "maya-pass-2"); await page.fill("#newPasswordAgainInput", "maya-pass-2")
        await page.click("#savePasswordBtn"); await page.wait_for_timeout(500)
        check("the current password must be right", "not right" in (await page.text_content("#passwordError")))
        await page.fill("#currentPasswordInput", "maya-pass-1"); await page.fill("#newPasswordAgainInput", "maya-pass-3")
        await page.click("#savePasswordBtn"); await page.wait_for_timeout(300)
        check("and the new one typed twice the same", "do not match" in (await page.text_content("#passwordError")))
        await page.fill("#newPasswordAgainInput", "maya-pass-2")
        await page.click("#savePasswordBtn"); await page.wait_for_timeout(800)
        check("then it changes, and this device stays signed in", await hidden(page, "#passwordModal") and "Password changed" in (await page.text_content("#status")))
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(600)
        check("even across a reload", not await hidden(page, "#adminBanner"))
        await confirm.reload(wait_until="networkidle"); await confirm.wait_for_timeout(600)
        check("while the other device is signed out", await hidden(confirm, "#adminBanner") and not await hidden(confirm, "#adminBtn"))

        # ---- forgot password: a typo can be fixed
        await page.goto(BASE + "/?forgot", wait_until="networkidle"); await page.wait_for_timeout(300)
        check("?forgot opens the reset form", not await hidden(page, "#forgotPanel"))
        await page.fill("#forgotEmail", "mya@example.com")
        await page.click("#forgotSubmit"); await page.wait_for_timeout(600)
        check("an unknown email is refused plainly", "no account" in (await page.text_content("#forgotError")) and await page.is_editable("#forgotEmail"))
        await page.fill("#forgotEmail", "maya@example.com")
        await page.click("#forgotSubmit"); await page.wait_for_timeout(800)
        check("the corrected one gets the link, and the field stays for another go", "maya@example.com" in (await page.text_content("#forgotDone"))
              and await page.is_editable("#forgotEmail") and (await page.text_content("#forgotSubmit")).strip() == "Send it again")
        check("the reset email went out", any("Reset" in m["subject"] for m in sent_mail()))

        # ---- the home page sends a signed-in person to their calendar
        await page.goto(BASE + "/", wait_until="networkidle"); await page.wait_for_timeout(800)
        check("the home page goes straight to the calendar when signed in", page.url.endswith("/maya"))

        # ---- someone else's calendar
        await page.goto(BASE + "/ethan", wait_until="networkidle"); await page.wait_for_timeout(600)
        check("on another calendar a signed-in person is a visitor", await hidden(page, "#adminBanner") and await hidden(page, "#modeSwitch") and await hidden(page, "#adminBtn"))
        check("with the chip showing their own name", await page.text_content("#profileName") == "Maya Chen")
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        check("and a way home in the menu, no gear here", not await hidden(page, "#myCalendarLink") and (await page.get_attribute("#myCalendarLink", "href")) == "/maya" and await hidden(page, "#toolsMenuWrap"))
        await page.click("#portalTitle")

        # ---- the first calendar: the admin password still works until it is claimed
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        await page.click("#signOutBtn"); await page.wait_for_timeout(600)
        await page.click("#adminBtn"); await page.wait_for_timeout(200)
        check("on the unclaimed first calendar the dialog opens on the admin password, with the account way offered", not await hidden(page, "#legacyLoginFields") and not await hidden(page, "#legacyLoginLink"))
        await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("and the password opens it", not await hidden(page, "#adminBanner"))
        await page.evaluate("""fetch('/api/events', { method: 'POST', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'},
            body: JSON.stringify({ type: 'BLOCKED', title: 'Noah', start: '2031-01-08T15:00', end: '2031-01-08T16:00' }) })""")
        await page.wait_for_timeout(300)
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        await page.click("#signOutBtn"); await page.wait_for_timeout(600)

        # ---- taking it over
        await page.goto(BASE + "/?signup", wait_until="networkidle"); await page.wait_for_timeout(300)
        check("?signup opens the sign-up form", not await hidden(page, "#signupPanel"))
        await page.fill("#signupName", "Ethan"); await page.fill("#signupEmail", "ethan@example.com"); await page.fill("#signupPassword", "ethan-pass-1")
        await page.check("#claimMain"); await page.wait_for_timeout(100)
        check("ticking the box asks for the admin password", not await hidden(page, "#claimField") and await page.text_content("#signupSubmit") == "Take over my calendar")
        await page.fill("#claimPassword", "wrong")
        await page.click("#signupSubmit"); await page.wait_for_timeout(600)
        check("a wrong admin password is refused", "Incorrect admin password" in (await page.text_content("#signupError")))
        await page.fill("#claimPassword", "t")
        await page.click("#signupSubmit"); await page.wait_for_timeout(800)
        check("the right one takes the first calendar over", not await hidden(page, "#welcomePanel") and "/ethan" in (await page.text_content("#welcomeText")))
        await page.click("#welcomeOpen"); await page.wait_for_load_state("networkidle"); await page.wait_for_timeout(800)
        check("which opens at /ethan with everything it had", page.url.endswith("/ethan") and not await hidden(page, "#adminBanner")
              and await page.evaluate("[...document.querySelectorAll('.event-card')].length") >= 0 and await page.text_content("#portalTitle") == "Ethan's Tutoring Availability")
        events = await page.evaluate("fetch('/api/events?start=2031-01-04&end=2031-01-10&calendar=ethan', { headers: { 'x-session': JSON.parse(localStorage.getItem('calendarSession')).token } }).then(r => r.json()).then(d => d.events.map(e => e.title))")
        check("including the block saved with the admin password", events == ["Noah"], str(events))
        await page.goto(BASE + "/", wait_until="networkidle"); await page.wait_for_timeout(500)
        await page.goto(BASE + "/?signup", wait_until="networkidle"); await page.wait_for_timeout(400)
        check("once claimed, the take-over box is gone from sign-up", await hidden(page, "#claimRow"))

        # ---- no calendar here
        await visitor.goto(BASE + "/nobody-here", wait_until="networkidle"); await visitor.wait_for_timeout(400)
        check("an unknown address says there is no calendar, with a way to the home page",
              "no calendar" in (await visitor.text_content("#missingTitle")) and await visitor.get_attribute("#missingCalendar a", "href") == "/")

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
