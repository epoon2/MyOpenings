#!/usr/bin/env python3
"""Email notifications as the admin sees them: the status line and test
button in Settings, and the banner notice when a notification failed.
The stub server pretends Brevo is set up (FAKE_MAIL=ok), then failing.

    python3 tests/mail.py
"""
import asyncio, os, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8984
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"          # the first calendar, at its address
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def login(page):
    await page.goto(CAL, wait_until="networkidle")
    await page.click("#adminBtn"); await page.fill("#adminPasswordInput", "t")
    await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)

async def scenario(pw, mode):
    env = dict(os.environ, FAKE_MAIL=mode)
    server = subprocess.Popen(["node", "tests/server.mjs", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{BASE}/index.html", timeout=1).read(); break
        except Exception:
            time.sleep(0.2)
    try:
        b = await pw.chromium.launch()
        page = await (await b.new_context(viewport={"width": 1300, "height": 900})).new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await login(page)
        if mode == "off":
            await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
            check("with no Brevo the dialog says so and the test button is off",
                  "not set up" in await page.text_content("#mailStatusText") and await page.evaluate("document.getElementById('testMailBtn').disabled"))
            check("no email notice on the page", await page.evaluate("document.getElementById('mailNotice').classList.contains('hidden')"))
        elif mode == "ok":
            await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
            check("with Brevo set up but no address, the dialog asks for one",
                  "Enter an address" in await page.text_content("#mailStatusText") and not await page.evaluate("document.getElementById('testMailBtn').disabled"))
            await page.fill("#settingNotificationEmail", "ethan@example.com")
            await page.click("#testMailBtn"); await page.wait_for_timeout(600)
            status = await page.text_content("#mailStatusText")
            check("Send a test email saves the typed address and reports success", "Test email sent to ethan@example.com" in status, status)
            await page.click("#settingsModal [data-close]"); await page.wait_for_timeout(200)
            await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
            check("reopening shows where requests go", "emailed to ethan@example.com" in await page.text_content("#mailStatusText"), await page.text_content("#mailStatusText"))
        else:
            await page.evaluate("document.getElementById('settingsBtn').click()"); await page.wait_for_timeout(500)
            await page.fill("#settingNotificationEmail", "ethan@example.com")
            await page.click("#testMailBtn"); await page.wait_for_timeout(600)
            check("a failing test shows the reason in the dialog", "Brevo 401" in await page.text_content("#mailStatusText"), await page.text_content("#mailStatusText"))
            await page.click("#settingsModal [data-close]"); await page.wait_for_timeout(200)
            await page.reload(wait_until="networkidle"); await page.wait_for_timeout(700)
            check("the banner reports the failed email on the next load", not await page.evaluate("document.getElementById('mailNotice').classList.contains('hidden')")
                  and "could not be sent" in await page.text_content("#mailNoticeText"), await page.text_content("#mailNoticeText"))
            await page.click("#mailNoticeCloseBtn"); await page.wait_for_timeout(200)
            check("Dismiss hides it", await page.evaluate("document.getElementById('mailNotice').classList.contains('hidden')"))
            await page.evaluate("document.getElementById('exitAdminBtn').click()"); await page.wait_for_timeout(600)
            check("the public page never shows it", await page.evaluate("document.getElementById('mailNotice').classList.contains('hidden')"))
        real = [e for e in errs if "fonts" not in e and "favicon" not in e]
        check(f"no page errors ({mode})", not real, str(real[:3]))
        await b.close()
    finally:
        server.terminate()

async def main():
    async with async_playwright() as pw:
        for mode in ["off", "ok", "failed"]:
            await scenario(pw, mode)
    print(f"\n{len(oks)} passed, {len(fails)} failed")
    return 1 if fails else 0

subprocess.run(["node", "tests/install-shim.mjs"], check=True, stdout=subprocess.DEVNULL)
sys.exit(asyncio.run(main()))
