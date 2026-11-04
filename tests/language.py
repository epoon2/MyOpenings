#!/usr/bin/env python3
"""Languages: a visitor's browser language picks the page's language
when it is one of ours, the header menu changes it and the choice
sticks, the calendar's own default applies to everyone else, and the
owner's tools stay in English.

    python3 tests/language.py
"""
import asyncio, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

PORT = 8997
BASE = f"http://127.0.0.1:{PORT}"
CAL = f"{BASE}/ethan"
oks, fails = [], []
def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   {extra}" if extra and not cond else ""))

async def text(page, sel):
    return (await page.text_content(sel) or "").strip()

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        errs = []

        # ---- an English browser
        page = await (await b.new_context(viewport={"width": 1300, "height": 900}, locale="en-US")).new_page()
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(CAL, wait_until="networkidle"); await page.wait_for_timeout(400)
        check("an English browser reads English", await text(page, "#requestBtn") == "Request a session" and await text(page, "#todayBtn") == "Today")
        check("the header offers six languages, English chosen", await page.evaluate("document.getElementById('langSelect').options.length") == 6
              and await page.evaluate("document.getElementById('langSelect').value") == "en")
        check("the document is marked as English", await page.evaluate("document.documentElement.lang") == "en")

        # ---- switching in the header
        await page.select_option("#langSelect", "es"); await page.wait_for_timeout(600)
        check("Spanish: the header and toolbar change", await text(page, "#requestBtn") == "Solicitar una sesión" and await text(page, "#todayBtn") == "Hoy"
              and await text(page, "#adminBtn") == "Iniciar sesión", await text(page, "#requestBtn"))
        check("the status line too", "Ethan" in await text(page, "#updatedLabel") and "horario" in await text(page, "#updatedLabel"), await text(page, "#updatedLabel"))
        check("the time zone reads in Spanish", await text(page, "#timezoneLabel") == "hora del Pacífico", await text(page, "#timezoneLabel"))
        labels = await page.evaluate("[...document.querySelectorAll('.time-label')].map(l => l.textContent.trim()).filter(Boolean)")
        labels = [l.replace("\u00a0", " ") for l in labels]
        check("so do the hour labels", "8 a. m." in labels and "2 p. m." in labels, str(labels[:4]))
        check("and the default words for open and booked time", await text(page, "#legendAvailable") == "Disponible" and await text(page, "#legendBlocked") == "Sesión ocupada")
        check("and the word the summary counts", await text(page, "#summaryPeopleLabel") == "estudiantes")
        week_label = (await text(page, "#weekLabel")).lower()
        check("and the week label speaks Spanish", any(m in week_label for m in ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]), week_label)
        await page.click("#requestBtn"); await page.wait_for_timeout(300)
        check("the request form is in Spanish, owner named", await text(page, "#requestModalTitle") == "Solicitar una sesión"
              and "Ethan lo confirme" in await text(page, "#requestIntro") and await text(page, "#sendRequestBtn") == "Enviar solicitud"
              and await page.get_attribute("#requestName", "placeholder") == "p. ej. Juan")
        letters = await page.evaluate("[...document.querySelectorAll('#requestModal .weekday-btn')].map(b => b.textContent.trim())")
        check("weekday letters follow", letters == ["D", "L", "M", "X", "J", "V", "S"], str(letters))
        await page.evaluate("document.getElementById('sendRequestBtn').click()"); await page.wait_for_timeout(300)
        check("a validation message is in Spanish", await text(page, "#requestError") == "Escribe tu nombre.", await text(page, "#requestError"))
        await page.evaluate("document.querySelector('#requestModal [data-close]').click()")
        check("Cancel closes it, and the choice is stored on the device", await page.evaluate("localStorage.getItem('lang')") == "es")
        await page.reload(wait_until="networkidle"); await page.wait_for_timeout(400)
        check("a reload keeps Spanish", await text(page, "#todayBtn") == "Hoy" and await page.evaluate("document.getElementById('langSelect').value") == "es")

        await page.select_option("#langSelect", "zh"); await page.wait_for_timeout(600)
        check("Chinese", await text(page, "#requestBtn") == "预约时段" and await page.evaluate("document.documentElement.lang") == "zh-CN")
        await page.select_option("#langSelect", "en"); await page.wait_for_timeout(600)
        check("and back to English", await text(page, "#requestBtn") == "Request a session")

        # ---- a word the owner typed stays as typed
        await page.evaluate("fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify({ labels: { blocked: 'Piano lesson' } }) })")
        await page.wait_for_timeout(300)
        await page.select_option("#langSelect", "es"); await page.wait_for_timeout(700)
        check("a name the owner typed is not translated, the default beside it is", await text(page, "#legendBlocked") == "Piano lesson" and await text(page, "#legendAvailable") == "Disponible")
        await page.evaluate("fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json', 'x-admin-password': 't'}, body: JSON.stringify({ labels: { blocked: 'Blocked Session' } }) })")
        await page.wait_for_timeout(300)
        await page.select_option("#langSelect", "en"); await page.wait_for_timeout(400)

        # ---- the owner's tools follow the language too
        await page.select_option("#langSelect", "fr"); await page.wait_for_timeout(400)
        await page.click("#adminBtn"); await page.wait_for_timeout(200)
        check("the log-in dialog (admin password, first calendar) is in French", await text(page, "#loginTitle") == "Accès admin" and await text(page, "#loginSubmitBtn") == "Entrer en mode admin")
        await page.fill("#adminPasswordInput", "t"); await page.click("#loginSubmitBtn"); await page.wait_for_timeout(700)
        check("so are the admin banner, toolbar and switch", "Comment modifier" in await text(page, "#adminBanner") and await text(page, "#addBtn") == "+ Ajouter un événement"
              and await text(page, "#backToAdminBtn") == "Vue édition" and await text(page, "#historyBtn") == "Historique des versions", (await text(page, "#adminBanner"))[:40] + " | " + await text(page, "#backToAdminBtn"))
        check("and the weekly summary", await text(page, "#summaryHoursLabel") == "heures occupées cette semaine")
        await page.click("#profileBtn"); await page.wait_for_timeout(100)
        check("and the profile menu, with the role", await text(page, "#signOutBtn") == "Se déconnecter" and await text(page, "#profileMenuMode") == "Admin", await text(page, "#profileMenuMode"))
        await page.click("#portalTitle"); await page.wait_for_timeout(100)
        await page.click("#gearBtn"); await page.wait_for_timeout(100)
        check("and the gear menu", await text(page, "#settingsBtn") == "Réglages" and await page.get_attribute("#gearBtn", "title") == "Outils du calendrier", await page.get_attribute("#gearBtn", "title"))
        await page.click("#settingsBtn"); await page.wait_for_timeout(500)
        check("Settings is in French and offers a default language for visitors, English", await page.evaluate("document.getElementById('settingLanguage').value") == "en"
              and await text(page, "#settingsModal h2") == "Réglages" and await text(page, "#saveSettingsBtn") == "Enregistrer les réglages")
        await page.select_option("#settingLanguage", "vi")
        await page.click("#saveSettingsBtn"); await page.wait_for_timeout(900)
        check("saving keeps this device's own choice (French), and says so in French", await text(page, "#todayBtn") == "Aujourd’hui" and (await text(page, "#status")).startswith("Réglages enregistrés"), await text(page, "#status"))
        await page.evaluate("document.getElementById('addBtn').click()"); await page.wait_for_timeout(300)
        check("the editor is in French", await text(page, "#eventModalTitle") == "Ajouter un événement" if await page.evaluate("!!document.getElementById('eventModalTitle')") else await page.evaluate("[...document.querySelectorAll('#eventModal h2')].some(h => h.textContent.trim() === 'Ajouter un événement')"))
        await page.evaluate("document.querySelector('#eventModal [data-close]').click()")

        # ---- the home page follows too
        await page.goto(BASE + "/?login", wait_until="networkidle"); await page.wait_for_timeout(400)
        check("the home page reads in the device's language (French)", "adresse" in (await text(page, "h1")).lower() and await text(page, "#topSignupBtn") == "S’inscrire", await text(page, "h1"))
        check("with the dialog open on Log in", await page.evaluate("!document.getElementById('authModal').classList.contains('hidden')") and await text(page, "#loginSubmit") == "Se connecter")
        await page.select_option("#langSelect", "ko"); await page.wait_for_timeout(300)
        check("and its menu switches it", await text(page, "#topSignupBtn") == "가입" and "링크" in await text(page, "h1"))
        await page.select_option("#langSelect", "fr"); await page.wait_for_timeout(200)

        # ---- a Vietnamese default: a German browser gets it, a Korean browser gets Korean
        german = await (await b.new_context(viewport={"width": 1300, "height": 900}, locale="de-DE")).new_page()
        await german.goto(CAL, wait_until="networkidle"); await german.wait_for_timeout(500)
        check("a browser in a language we lack reads the calendar's default (Vietnamese)", await text(german, "#requestBtn") == "Đặt buổi học", await text(german, "#requestBtn"))
        korean = await (await b.new_context(viewport={"width": 1300, "height": 900}, locale="ko-KR")).new_page()
        await korean.goto(CAL, wait_until="networkidle"); await korean.wait_for_timeout(500)
        check("a Korean browser reads Korean", await text(korean, "#requestBtn") == "세션 요청", await text(korean, "#requestBtn"))
        check("the theme button's tooltip follows too", await korean.get_attribute("#themeBtn", "title") == "라이트/다크 전환")

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
