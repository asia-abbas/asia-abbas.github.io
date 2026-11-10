"""UI smoke test for the Jêga app with Firebase replaced by test/mock-fb.js.
Run:  python3 test/ui_test.py   (needs playwright + chrome). Screenshots land in test/out/."""
import os, shutil, subprocess, sys, time, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "out"); os.makedirs(OUT, exist_ok=True)
site = tempfile.mkdtemp()
shutil.copytree(os.path.join(ROOT, "app"), site, dirs_exist_ok=True)
shutil.copy(os.path.join(ROOT, "test", "mock-fb.js"), os.path.join(site, "js", "fb.js"))
os.remove(os.path.join(site, "sw.js"))
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 400, "height": 860}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and errors.append(m.text))
        pg.goto("http://localhost:8765/")
        pg.wait_for_selector("#lf")
        pg.screenshot(path=f"{OUT}/1-login-en.png")
        # Sorani, right to left
        pg.click('[data-lang="ckb"]'); assert pg.evaluate("document.documentElement.dir") == "rtl"
        pg.screenshot(path=f"{OUT}/2-login-ckb.png")
        pg.fill("#ph", "0750 123 4567"); pg.fill("#nm", "Aram Hassan"); pg.click("#lgo")
        pg.wait_for_selector(".slot")
        assert pg.locator(".slot").count() == 2, "two slots listed"
        assert pg.locator("#bell .dot").inner_text() == "1", "bell shows unread"
        pg.screenshot(path=f"{OUT}/3-park-ckb.png")
        # back to English, flat-price slot shows the flat tag
        pg.click("#lb"); pg.click('[data-lang="en"]')
        assert "Flat price" in pg.locator('[data-slot="s2"]').inner_text()
        # open hourly slot, 3 hours, cash
        pg.click('[data-slot="s1"]'); pg.wait_for_selector("#book")
        pg.click("#hp")
        assert "4,500 IQD" in pg.locator("#tt").inner_text(), pg.locator("#tt").inner_text()
        pg.screenshot(path=f"{OUT}/4-slot-sheet.png")
        pg.click("#book"); pg.wait_for_selector(".status.s-confirmed")
        pg.screenshot(path=f"{OUT}/5-booking-cash.png")
        pg.click("#sx")
        # flat slot: hours do not change the price; pay online
        pg.click('[data-slot="s2"]'); pg.wait_for_selector("#book")
        pg.click("#hp"); pg.click("#hp")
        assert "5,000 IQD" in pg.locator("#tt").inner_text()
        pg.click('input[value="online"]', force=True); pg.click("#book")
        pg.wait_for_selector("[data-svc]")
        pg.screenshot(path=f"{OUT}/6-pay-services.png")
        pg.click('[data-svc="test-fib"]'); pg.wait_for_selector(".paywait"); pg.wait_for_timeout(400)
        pg.screenshot(path=f"{OUT}/7-pay-wait.png")
        pg.evaluate("window.__pay(window.__payBooking)")
        pg.wait_for_selector(".toast.ok"); assert "Payment received" in pg.locator(".toast.ok").last.inner_text()
        pg.click("#sx")
        # chat
        pg.click('[data-tab="chats"]'); pg.wait_for_selector(".thread"); pg.click(".thread >> nth=0")
        pg.fill("#ci", "سڵاو، کاتژمێر 4 دێم"); pg.press("#ci", "Enter")
        pg.wait_for_selector(".msg.me")
        pg.screenshot(path=f"{OUT}/8-chat.png")
        pg.click("#cb")
        # host flow: open form, validate, publish (Arabic)
        pg.click("#lb"); pg.click('[data-lang="ar"]')
        pg.click('[data-tab="host"]'); pg.click("#add"); pg.wait_for_selector("#af")
        pg.click('#af button[type="submit"]'); assert pg.locator("#ae").inner_text() != ""
        pg.fill("#at", "كراج مسقوف قرب منزلي"); pg.fill("#al", "بجانب الصيدلية"); pg.click('label:has(#pm-flat)')
        pg.fill("#ap", "4000")
        pg.screenshot(path=f"{OUT}/9-host-form-ar.png")
        pg.click('#af button[type="submit"]'); pg.wait_for_selector(".slotcard")
        pg.screenshot(path=f"{OUT}/10-host-ar.png")
        # notifications + account
        pg.click("#bell"); pg.wait_for_selector(".notif"); pg.click("#sx")
        pg.click('[data-tab="me"]'); pg.wait_for_selector("#out")
        pg.screenshot(path=f"{OUT}/11-account-ar.png", full_page=True)
        b.close()
finally:
    srv.terminate()
real = [e for e in errors if "leaflet" not in e.lower() and "L is not defined" not in e]
print("JS errors:", real or "none")
sys.exit(1 if real else 0)
