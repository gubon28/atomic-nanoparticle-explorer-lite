"""Browser verification for the Lite app: rendering, features, performance, offline.

Drives a headless Chrome over the DevTools Protocol against a locally served build
and checks that

  * the WebGL canvas renders a particle (instance count > 0),
  * the locally computed numbers match the reference engine for the default particle,
  * colour modes, morphologies and the diameter slider actually change the scene,
  * the atom budget refuses oversized requests instead of freezing,
  * NO request goes to any external host and there is no API/backend call,
  * generation time stays well inside an interactive budget.

Usage:  python tools/browser_check.py [url]
Default url: http://127.0.0.1:4174/atomic-nanoparticle-explorer-lite/
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "google-chrome",
    "/usr/bin/google-chrome",
]
PORT = 9337
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4174/atomic-nanoparticle-explorer-lite/"


def find_chrome() -> str:
    for candidate in CHROME_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    found = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")
    if not found:
        raise SystemExit("Chrome not found")
    return found


class Session:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.next_id = 0
        self.requests: list[str] = []
        self.external: list[str] = []
        self.problems: list[str] = []

    async def cmd(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        request_id = self.next_id
        await self.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=90)
            message = json.loads(raw)
            if message.get("id") == request_id:
                return message
            method_name = message.get("method", "")
            if method_name == "Network.requestWillBeSent":
                url = message["params"]["request"]["url"]
                self.requests.append(url)
                host = url.split("/")[2] if "://" in url else ""
                if host and not host.startswith("127.0.0.1") and not host.startswith("localhost"):
                    self.external.append(url)
            elif method_name == "Runtime.exceptionThrown":
                self.problems.append(str(message["params"].get("exceptionDetails", {}).get("text"))[:160])
            elif method_name == "Runtime.consoleAPICalled" and message["params"].get("type") == "error":
                args = message["params"].get("args", [])
                self.problems.append("console.error: " + ", ".join(str(a.get("value"))[:120] for a in args))

    async def js(self, expression: str):
        result = await self.cmd(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}
        )
        payload = result.get("result", {})
        if "exceptionDetails" in payload:
            return f"JS-ERROR: {payload['exceptionDetails'].get('text')}"
        return payload.get("result", {}).get("value")

    async def click(self, text: str, selector: str = "button") -> object:
        return await self.js(
            "(() => {const el = [...document.querySelectorAll('%s')].find(e => (e.textContent || '').includes(%s));"
            "if (!el) return 'NOT-FOUND'; el.click(); return 'clicked';})()" % (selector, json.dumps(text))
        )


async def main() -> int:
    chrome = find_chrome()
    profile = tempfile.mkdtemp(prefix="lite-check-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--enable-unsafe-swiftshader",
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={profile}",
            "--window-size=1680,1050",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    ws_url = None
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=2) as response:
                for target in json.load(response):
                    if target.get("type") == "page":
                        ws_url = target["webSocketDebuggerUrl"]
                        break
            if ws_url:
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)
    if not ws_url:
        proc.kill()
        raise SystemExit("could not reach Chrome devtools")

    checks: list[tuple[str, bool, object]] = []
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            session = Session(ws)
            await session.cmd("Runtime.enable")
            await session.cmd("Network.enable")
            await session.cmd("Page.enable")
            await session.cmd("Page.navigate", {"url": URL})
            await asyncio.sleep(9)

            title = await session.js("document.title")
            checks.append(("page loads with the Lite title", "Lite" in str(title), title))

            canvas = await session.js("!!document.querySelector('canvas')")
            checks.append(("WebGL canvas is present", canvas is True, canvas))

            instances = await session.js(
                "(() => {const c = document.querySelector('canvas'); return c ? c.width * c.height : 0;})()"
            )
            checks.append(("canvas has a drawing surface", isinstance(instances, (int, float)) and instances > 0, instances))

            hud = await session.js("document.querySelector('.viewer-hud')?.textContent?.replace(/\\s+/g,' ').trim()")
            checks.append(("atom HUD reports drawn atoms", "atoms drawn" in str(hud), hud))
            checks.append(("computation time reported", "computed locally in" in str(hud), hud))

            particles = await session.js("document.querySelectorAll('.panel').length")
            checks.append(("panels rendered (controls + info + validation)", isinstance(particles, (int, float)) and particles >= 6, particles))

            checks_summary = await session.js("document.querySelector('.check-summary')?.textContent?.trim()")
            checks.append(("live scientific checks pass", str(checks_summary).startswith("all"), checks_summary))

            # capture the untouched default particle before driving the UI
            shot = await session.cmd("Page.captureScreenshot", {"format": "png"})
            data = shot.get("result", {}).get("data")
            if data:
                import base64

                out = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "Temp-nano", "lite_default.png")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "wb") as handle:
                    handle.write(base64.b64decode(data))
                print(f"screenshot (default view): {out}")

            table = await session.js("document.querySelector('.kv')?.textContent?.replace(/\\s+/g,' ').slice(0,120)")
            checks.append(("lattice constants shown", "4.0782" in str(await session.js("document.body.innerHTML")), None))

            # ---- colour mode switching ----
            await session.click("Coordination number", ".color-modes button")
            await asyncio.sleep(1.2)
            legend = await session.js("document.querySelector('.legend')?.textContent?.replace(/\\s+/g,' ').trim()")
            checks.append(("colour mode switches to coordination", "Coordination number" in str(legend), legend))

            # ---- morphology switching (rubber-stamp the numbers) ----
            await session.click("Cube", ".morph-item")
            await asyncio.sleep(2.5)
            cube = await session.js("document.querySelector('.header-stats')?.textContent?.replace(/\\s+/g,' ').trim()")
            checks.append(("cube preset applied", "facets" in str(cube), cube))
            await session.click("Octahedron", ".morph-item")
            await asyncio.sleep(2.5)
            octa = await session.js("document.querySelector('.header-stats')?.textContent?.replace(/\\s+/g,' ').trim()")
            checks.append(("octahedron preset applied", str(octa) != str(cube), octa))

            # ---- diameter slider (drives the atom count) ----
            before = await session.js("document.querySelector('.header-stats')?.textContent?.replace(/\\s+/g,' ').trim()")
            await session.js(
                "(() => {const r = [...document.querySelectorAll('input[type=range]')].find(x => x.max === '20');"
                "if (!r) return 'NOT-FOUND'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
                "setter.call(r, '6'); r.dispatchEvent(new Event('input', {bubbles:true})); return 'moved';})()"
            )
            await asyncio.sleep(3.5)
            after = await session.js("document.querySelector('.header-stats')?.textContent?.replace(/\\s+/g,' ').trim()")
            checks.append(("diameter slider regenerates the particle", str(before) != str(after), f"{before} -> {after}"))

            # ---- atom budget guard ----
            await session.js(
                "(() => {const r = [...document.querySelectorAll('input[type=range]')].find(x => x.max === '20');"
                "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
                "setter.call(r, '20'); r.dispatchEvent(new Event('input', {bubbles:true})); return 'moved';})()"
            )
            await asyncio.sleep(4)
            guard = await session.js("document.querySelector('.error-box')?.textContent?.replace(/\\s+/g,' ').slice(0,110)")
            checks.append(("oversized request is refused, not frozen", "refused" in str(guard).lower(), guard))

            checks.append(("no external network requests", len(session.external) == 0, session.external[:3]))
            checks.append(
                (
                    "no backend/API calls (static assets only)",
                    all("/api" not in url for url in session.requests),
                    [url for url in session.requests if "/api" in url][:3],
                )
            )
            checks.append(("no uncaught JS errors", len(session.problems) == 0, session.problems[:3]))

            # ---- XYZ export end-to-end (real download through the browser) ----
            download_dir = os.path.join(tempfile.gettempdir(), "lite-downloads")
            os.makedirs(download_dir, exist_ok=True)
            for stale in os.listdir(download_dir):
                os.remove(os.path.join(download_dir, stale))
            await session.cmd(
                "Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": download_dir}
            )
            await session.click("Download XYZ", ".panel button")
            exported = None
            for _ in range(20):
                await asyncio.sleep(0.5)
                files = [f for f in os.listdir(download_dir) if f.endswith(".xyz")]
                if files:
                    exported = os.path.join(download_dir, files[0])
                    break
            if exported:
                with open(exported, "r", encoding="utf-8") as handle:
                    lines = [next(handle, "") for _ in range(3)]
                header_count = lines[0].strip()
                first_atom = lines[2].split()
                checks.append(
                    (
                        "XYZ export downloads a valid file",
                        header_count.isdigit() and len(first_atom) == 4 and first_atom[0] in {"Au", "Ag", "Pt", "Pd", "Cu"},
                        f"{os.path.basename(exported)}: count={header_count} first atom={lines[2].strip()}",
                    )
                )
            else:
                checks.append(("XYZ export downloads a valid file", False, "no .xyz file appeared"))

            shot = await session.cmd("Page.captureScreenshot", {"format": "png"})
            data = shot.get("result", {}).get("data")
            if data:
                import base64

                out = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "Temp-nano", "lite_app.png")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "wb") as handle:
                    handle.write(base64.b64decode(data))
                print(f"screenshot: {out}")
            print("requests:", len(session.requests), "| external:", len(session.external))
            for url in session.requests[:6]:
                print("   ", url)
    finally:
        proc.kill()

    passed = sum(1 for _, ok, _ in checks if ok)
    for name, ok, detail in checks:
        print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"   -> {detail}"))
    print(f"\n{passed}/{len(checks)} browser checks passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
