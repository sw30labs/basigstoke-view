import asyncio, json, sys
from playwright.async_api import async_playwright

async def main():
    errors, pageerrors = [], []
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        page = await b.new_page(viewport={"width": 1600, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: pageerrors.append(str(e)))
        await page.goto("http://127.0.0.1:8123/", wait_until="load")
        await page.wait_for_timeout(16000)  # boot
        boot = await page.inner_text("#boot-log")
        await page.screenshot(path="docs/shot_tactical.png")
        state = await page.evaluate("""() => ({
            appVisible: !document.querySelector('#app').classList.contains('hidden'),
            sats: document.querySelector('#sats-chip').textContent,
            wx: document.querySelector('#wx-chip').textContent,
            flights: document.querySelector('#n-flights').textContent,
            quakes: document.querySelector('#n-quakes').textContent,
            iss: document.querySelector('#iss-body').innerText.slice(0, 200),
            hub: document.querySelector('#hub-body').innerText.slice(0, 160),
        })""")
        # zoom in deep + switch modes
        await page.mouse.move(800, 450)
        for _ in range(6): await page.mouse.wheel(0, -240); await page.wait_for_timeout(120)
        await page.wait_for_timeout(800)
        await page.screenshot(path="docs/shot_zoomed.png")
        for mode in ["relief", "radar", "night"]:
            await page.click(f'[data-mode="{mode}"]')
            await page.wait_for_timeout(2500 if mode == "radar" else 1200)
            await page.screenshot(path=f"docs/shot_{mode}.png")
        # flight popup: click canvas centre after zoom-out
        await page.click('[data-mode="tactical"]')
        await page.wait_for_timeout(500)
        print(json.dumps({"boot": boot, "state": state,
                          "console_errors": errors[:10], "page_errors": pageerrors[:10]}, indent=1))
        await b.close()

asyncio.run(main())
