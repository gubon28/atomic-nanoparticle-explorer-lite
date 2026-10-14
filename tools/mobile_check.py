"""Phase 2.3 — mobile viewer UI validation (headless Chrome over CDP).

Measures real geometry (never "the element exists"): the toolbar, canvas, the
projected *particle* bounding box (from the WebGL pixels), the legend, the HUD,
their overlaps, page overflow, touch-target sizes, fullscreen entry/exit, camera
framing inside the unobstructed region, and mobile page scrolling.

    python tools/mobile_check.py [url] [--json out.json] [--shots DIR] [--full]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

try:
    import websockets
except ImportError:  # pragma: no cover
    print("this tool needs the 'websockets' package")
    raise SystemExit(2)

PORT = 9337
VIEWPORTS = [
    (320, 568),
    (360, 800),
    (375, 667),
    (390, 844),
    (430, 932),
    (844, 390),
    (768, 1024),
    (1366, 768),
    (1920, 1080),
]
MOBILE_MAX = 1024


def find_chrome() -> str:
    for candidate in (
        os.environ.get("CHROME_PATH"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    raise SystemExit("Chrome not found; set CHROME_PATH")


def wait_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as sock:
            sock.settimeout(0.4)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.25)
    return False


# ---------------------------------------------------------------- page probes

PROBE = r"""
(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
  };
  const q = (sel) => document.querySelector(sel);
  const viewer = q('.viewer');
  const canvas = q('.viewer canvas');
  const out = {
    vw: window.innerWidth,
    vh: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    viewer: rectOf(viewer),
    canvas: rectOf(canvas),
    toolbar: rectOf(q('.viewer-toolbar')),
    hud: rectOf(q('.viewer-hud')),
    legend: rectOf(q('.legend')),
    legendInStage: !!(viewer && q('.legend') && viewer.contains(q('.legend'))),
    panels: rectOf(q('[data-testid="mobile-panels"]')),
    settingsOpen: !!q('#mobile-viewer-settings'),
    legendOpen: !!q('#mobile-cn-legend'),
    buffer: canvas ? { w: canvas.width, h: canvas.height } : null,
    fullscreenElement: document.fullscreenElement
      ? String(document.fullscreenElement.className || document.fullscreenElement.tagName)
      : null,
    buttons: Array.from(document.querySelectorAll('.viewer-toolbar button, .side-panel-section button')).map((b) => ({
      label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 26),
      r: rectOf(b),
      visible: b.offsetParent !== null,
    })),
    camera: window.__liteDebug ? window.__liteDebug.snapshot() : null,
  };

  const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null;
  if (gl && canvas.width * canvas.height <= 4200000) {
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let minX = W, maxX = -1, minY = H, maxY = -1, count = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = px[i + 3];
        const sum = px[i] + px[i + 1] + px[i + 2];
        if (a > 12 && sum > 30) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (count > 0) {
      // readPixels origin is bottom-left -> flip to top-left
      out.pixels = { x: minX, y: H - 1 - maxY, w: maxX - minX + 1, h: maxY - minY + 1, count };
    } else {
      out.pixels = null;
    }
  } else {
    out.pixels = 'skipped';
  }
  return JSON.stringify(out);
})()
"""

# open the "Viewer settings" panel (mobile) so the hidden controls are reachable
OPEN_SETTINGS = r"""
(() => {
  const buttons = Array.from(document.querySelectorAll('.viewer-toolbar button'));
  const target = buttons.find((b) => (b.getAttribute('aria-label') || '') === 'Viewer settings');
  if (!target) return 'no-settings-button';
  if (!document.querySelector('#mobile-viewer-settings')) target.click();
  return document.querySelector('#mobile-viewer-settings') ? 'open' : 'failed';
})()
"""

TOGGLE_DIRECTIONS_OFF = r"""
(() => {
  const section = document.querySelector('#mobile-viewer-settings');
  const scope = section || document.querySelector('.viewer-toolbar');
  const buttons = Array.from((scope || document).querySelectorAll('button'));
  const target = buttons.find((b) => (b.textContent || '').trim() === 'Directions');
  if (!target) return 'no-directions-button';
  if (target.classList.contains('active') || document.querySelector('#mobile-viewer-settings')) target.click();
  return 'toggled:' + target.classList.contains('active');
})()
"""

CLICK_TEXT = r"""
(() => {
  const wanted = %s;
  const nodes = Array.from(document.querySelectorAll('.viewer-toolbar button, .side-panel-section button'));
  const target = nodes.find((b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase().includes(wanted.toLowerCase()));
  if (!target) return 'not-found';
  target.click();
  return 'clicked';
})()
"""

SCROLL_TEST = r"""
(() => {
  window.scrollTo(0, 260);
  const y = window.scrollY;
  window.scrollTo(0, 0);
  return JSON.stringify({ scrolledTo: y });
})()
"""


class Session:
    def __init__(self, ws) -> None:
        self.ws = ws
        self.next_id = 0
        self.requests: list[str] = []

    async def cmd(self, method: str, params: dict | None = None):
        self.next_id += 1
        message = {"id": self.next_id, "method": method, "params": params or {}}
        await self.ws.send(json.dumps(message))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=60)
            data = json.loads(raw)
            if data.get("method") == "Network.requestWillBeSent":
                url = str(data.get("params", {}).get("request", {}).get("url", ""))
                self.requests.append(url)
                continue
            if data.get("id") == self.next_id:
                if "error" in data:
                    raise RuntimeError(f"{method}: {data['error']}")
                return data.get("result")

    async def js(self, expression: str):
        result = await self.cmd(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        value = result.get("result", {})
        if result.get("exceptionDetails"):
            return {"error": result["exceptionDetails"].get("text", "exception")}
        return value.get("value")

    async def shot(self, path: str) -> bool:
        result = await self.cmd("Page.captureScreenshot", {"format": "png"})
        data = result.get("data")
        if not data:
            return False
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
        return True


async def connect(port: int) -> tuple[Session, dict]:
    import urllib.request

    deadline = time.time() + 40
    target = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=4) as response:
                targets = json.load(response)
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                target = pages[0]
                break
        except Exception:
            await asyncio.sleep(0.4)
    if target is None:
        raise SystemExit("no page target found")
    ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
    return Session(ws), target


def rect_inside(inner: dict | None, outer: dict | None, tol: float = 2.0) -> bool:
    if not inner or not outer:
        return False
    return (
        inner["x"] >= outer["x"] - tol
        and inner["y"] >= outer["y"] - tol
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + tol
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + tol
    )


def overlap_area(a: dict | None, b: dict | None) -> float:
    if not a or not b:
        return 0.0
    ox = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    oy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0.0, ox) * max(0.0, oy)


def pixels_to_page(px: dict | None, canvas: dict | None, buffer: dict | None) -> dict | None:
    """Convert the WebGL pixel bounding box into CSS page coordinates."""
    if not px or not canvas or not buffer or not buffer.get("w") or not buffer.get("h"):
        return None
    sx = canvas["w"] / buffer["w"]
    sy = canvas["h"] / buffer["h"]
    return {
        "x": canvas["x"] + px["x"] * sx,
        "y": canvas["y"] + px["y"] * sy,
        "w": px["w"] * sx,
        "h": px["h"] * sy,
    }


def unobstructed(canvas: dict, toolbar: dict | None, hud: dict | None) -> dict:
    """The band of the stage that no permanent overlay covers.

    The camera fit reserves the overlay inset symmetrically, so the checker measures
    the same band: the particle should be centred in it and its occupancy is relative
    to the shorter side of that band.
    """
    top = 0.0
    if toolbar and toolbar["y"] < canvas["y"] + canvas["h"]:
        top = max(0.0, min(canvas["h"], toolbar["y"] + toolbar["h"] - canvas["y"]))
    bottom = 0.0
    if hud and hud["y"] + hud["h"] > canvas["y"]:
        bottom = max(0.0, min(canvas["h"], canvas["y"] + canvas["h"] - hud["y"]))
    inset = max(top, bottom)
    return {
        "x": canvas["x"],
        "y": canvas["y"] + inset,
        "w": canvas["w"],
        "h": max(1.0, canvas["h"] - 2 * inset),
        "top": inset,
        "bottom": inset,
    }


def evaluate(data: dict, width: int, height: int) -> list[tuple[str, bool, str]]:
    stage = f"{width}x{height}"
    mobile = width <= MOBILE_MAX
    viewer = data.get("viewer")
    canvas = data.get("canvas")
    toolbar = data.get("toolbar")
    hud = data.get("hud")
    legend = data.get("legend")
    particle = pixels_to_page(
        data.get("pixels") if isinstance(data.get("pixels"), dict) else None, canvas, data.get("buffer")
    )
    checks: list[tuple[str, bool, str]] = []

    checks.append(
        (
            f"{stage} canvas fills the stage",
            bool(canvas and viewer) and abs(canvas["h"] - viewer["h"]) <= 4 and abs(canvas["w"] - viewer["w"]) <= 4,
            f"canvas {canvas['w']:.0f}x{canvas['h']:.0f} vs stage {viewer['w']:.0f}x{viewer['h']:.0f}"
            if canvas and viewer
            else "missing",
        )
    )
    if toolbar:
        limit = 56.0 if mobile else 150.0
        checks.append(
            (
                f"{stage} toolbar compact, single row" if mobile else f"{stage} toolbar present",
                toolbar["h"] <= limit,
                f"toolbar {toolbar['w']:.0f}x{toolbar['h']:.0f}px (limit {limit:.0f})",
            )
        )
    checks.append(
        (
            f"{stage} nanoparticle rendered",
            bool(particle),
            f"particle box {particle['w']:.0f}x{particle['h']:.0f}px" if particle else "no lit pixels",
        )
    )

    if mobile:
        checks.append(
            (
                f"{stage} no legend drawn over the model",
                not data.get("legendInStage") and not data.get("legendOpen"),
                f"legendInStage={data.get('legendInStage')} legendOpen={data.get('legendOpen')}",
            )
        )
    if legend and hud:
        checks.append(
            (
                f"{stage} legend and HUD do not overlap",
                overlap_area(legend, hud) <= 1.0,
                f"overlap {overlap_area(legend, hud):.0f}px2",
            )
        )

    if particle and toolbar:
        area = overlap_area(particle, toolbar)
        checks.append((f"{stage} particle clear of the toolbar", area <= 40.0, f"overlap {area:.0f}px2"))
    if particle and hud:
        area = overlap_area(particle, hud)
        checks.append((f"{stage} particle clear of the HUD", area <= 40.0, f"overlap {area:.0f}px2"))

    if particle and canvas and toolbar:
        free = unobstructed(canvas, toolbar, hud)
        p_cx = particle["x"] + particle["w"] / 2
        p_cy = particle["y"] + particle["h"] / 2
        f_cx = free["x"] + free["w"] / 2
        f_cy = free["y"] + free["h"] / 2
        short = min(free["w"], free["h"])
        dx = abs(p_cx - f_cx)
        dy = abs(p_cy - f_cy)
        checks.append(
            (
                f"{stage} particle centred in the unobstructed area",
                dx <= 0.10 * short and dy <= 0.10 * short,
                f"offset dx={dx:.0f} dy={dy:.0f}px (limit {0.10 * short:.0f})",
            )
        )
        # mobile: the requirement defines occupancy against the unobstructed band.
        # desktop: Phase 2.1 defined it against the shorter canvas side (the toolbar
        # and legend there are part of the desktop shell, not mobile overlays).
        reference = short if mobile else min(canvas["w"], canvas["h"])
        occupancy = max(particle["w"], particle["h"]) / reference
        checks.append(
            (
                f"{stage} particle occupancy 42-72% ({'band' if mobile else 'canvas'})",
                0.42 <= occupancy <= 0.72,
                f"{100 * occupancy:.1f}% of {reference:.0f}px (band {free['w']:.0f}x{free['h']:.0f})",
            )
        )

    overflow = data.get("docScrollW", 0) - data.get("vw", 0)
    checks.append((f"{stage} no horizontal page overflow", overflow <= 2, f"scrollWidth-innerWidth={overflow:.0f}px"))

    reachable = [b for b in (data.get("buttons") or []) if b.get("visible")]
    min_target = 40.0 if mobile else 20.0
    small = [b for b in reachable if b["r"] and (b["r"]["h"] < min_target or b["r"]["w"] < min_target)]
    checks.append(
        (
            f"{stage} controls >= {min_target:.0f}px",
            len(reachable) > 0 and not small,
            f"{len(reachable)} controls, smallest {min((min(b['r']['h'], b['r']['w']) for b in reachable if b['r']), default=0):.0f}px",
        )
    )
    clipped = [
        b
        for b in reachable
        if b["r"] and (b["r"]["x"] < -1 or b["r"]["x"] + b["r"]["w"] > data.get("vw", 0) + 1)
    ]
    checks.append((f"{stage} no clipped controls", not clipped, f"{len(clipped)} out of viewport"))

    camera = data.get("camera") or {}
    if camera.get("aspect") and canvas and canvas["h"]:
        expected = canvas["w"] / canvas["h"]
        checks.append(
            (
                f"{stage} camera aspect matches the canvas",
                abs(float(camera["aspect"]) - expected) <= 0.02,
                f"aspect {float(camera['aspect']):.3f} vs canvas {expected:.3f} ({camera.get('type')})",
            )
        )
    return checks


async def real_click(session: Session, x: float, y: float) -> None:
    for kind in ("mousePressed", "mouseReleased"):
        await session.cmd(
            "Input.dispatchMouseEvent",
            {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1},
        )
        await asyncio.sleep(0.06)


async def click_button(session: Session, label: str) -> str:
    result = await session.js(CLICK_TEXT % json.dumps(label))
    return str(result)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", default="http://localhost:4174/atomic-nanoparticle-explorer-lite/")
    parser.add_argument("--json", dest="json_out", default=None)
    parser.add_argument("--shots", dest="shots", default=None)
    parser.add_argument("--full", action="store_true", help="also run the fullscreen and reset checks")
    args = parser.parse_args()

    profile = os.path.join(tempfile.gettempdir(), "lite-mobile-profile")
    chrome = subprocess.Popen(
        [
            find_chrome(),
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--hide-scrollbars",
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={profile}",
            "--window-size=1920,1080",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    failures = 0
    results: dict[str, dict] = {}
    try:
        if not wait_port(PORT):
            print("chrome devtools port did not open")
            return 2
        session, _ = await connect(PORT)
        await session.cmd("Runtime.enable")
        await session.cmd("Page.enable")
        await session.cmd("Network.enable")

        for width, height in VIEWPORTS:
            stage = f"{width}x{height}"
            await session.cmd(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= MOBILE_MAX},
            )
            await session.cmd("Page.navigate", {"url": args.url})
            await asyncio.sleep(3.4)

            # default state (direction axes on) — recorded for the report
            default = json.loads(await session.js(PROBE))
            # normal mode, particle measured without the direction axes
            await session.js(OPEN_SETTINGS)
            await asyncio.sleep(0.6)
            await session.js(TOGGLE_DIRECTIONS_OFF)
            await asyncio.sleep(1.4)
            await click_button(session, "Viewer settings")
            await asyncio.sleep(0.8)
            data = json.loads(await session.js(PROBE))
            data["defaultParticle"] = default.get("pixels")
            data["defaultLegendInStage"] = default.get("legendInStage")
            results[stage] = data

            if args.shots:
                os.makedirs(args.shots, exist_ok=True)
                await session.shot(os.path.join(args.shots, f"mobile_{stage}.png"))

            scroll = json.loads(await session.js(SCROLL_TEST) or "{}")
            if width <= MOBILE_MAX:
                ok = scroll.get("scrolledTo", 0) > 100
                print(("  PASS  " if ok else "  FAIL  ") + f"{stage} page scrolls normally   (scrollY after scrollTo(260) = {scroll.get('scrolledTo')})")
                if not ok:
                    failures += 1

            print(f"\n=== {stage} ===")
            for name, ok, detail in evaluate(data, width, height):
                print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
                if not ok:
                    failures += 1
            if args.full and width <= MOBILE_MAX:
                await run_fullscreen(session, data, width, height, failures, results)
            print(f"  particle (with axes): {default.get('pixels')}")
            print(f"  particle (axes off): {data.get('pixels')}")

        print(f"\nmobile/desktop layout failures: {failures}")
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except Exception:
            chrome.kill()
        if args.json_out:
            with open(args.json_out, "w", encoding="utf-8") as handle:
                json.dump(results, handle, indent=1)
            print(f"measurements written to {args.json_out}")
    return failures


async def run_fullscreen(session: Session, data: dict, width: int, height: int, failures: int, results: dict) -> None:
    stage = f"{width}x{height}"
    button = next((b for b in (data.get("buttons") or []) if "fullscreen" in str(b.get("label", "")).lower()), None)
    print("  --- fullscreen ---")
    if not button or not button.get("r"):
        print(f"  FAIL  {stage} fullscreen button reachable   (not found)")
        return
    r = button["r"]
    await real_click(session, r["x"] + r["w"] / 2, r["y"] + r["h"] / 2)
    await asyncio.sleep(1.8)
    fs = json.loads(await session.js(PROBE))
    results[f"{stage}-fullscreen"] = fs
    canvas = fs.get("canvas") or {}
    viewer = fs.get("viewer") or {}
    print(("  PASS  " if fs.get("fullscreenElement") else "  FAIL  ") + f"{stage} enters fullscreen   (element={fs.get('fullscreenElement')})")
    if not fs.get("fullscreenElement"):
        failures += 1
    ok_size = abs(viewer.get("w", 0) - fs.get("vw", 0)) <= 2 and abs(viewer.get("h", 0) - fs.get("vh", 0)) <= 2
    print(("  PASS  " if ok_size else "  FAIL  ") + f"{stage} stage fills the viewport   (stage {viewer.get('w'):.0f}x{viewer.get('h'):.0f} vs {fs.get('vw')}x{fs.get('vh')})")
    if not ok_size:
        failures += 1
    ok_canvas = abs(canvas.get("w", 0) - fs.get("vw", 0)) <= 4 and abs(canvas.get("h", 0) - fs.get("vh", 0)) <= 4
    print(("  PASS  " if ok_canvas else "  FAIL  ") + f"{stage} canvas resized   (canvas {canvas.get('w'):.0f}x{canvas.get('h'):.0f})")
    if not ok_canvas:
        failures += 1
    overflow = fs.get("docScrollW", 0) - fs.get("vw", 0)
    print(("  PASS  " if overflow <= 2 else "  FAIL  ") + f"{stage} fullscreen has no overflow   (overflow {overflow:.0f}px)")
    if overflow > 2:
        failures += 1
    await session.cmd(
        "Input.dispatchKeyEvent",
        {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27},
    )
    await session.cmd(
        "Input.dispatchKeyEvent",
        {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27},
    )
    await asyncio.sleep(1.4)
    after = json.loads(await session.js(PROBE))
    ok_exit = not after.get("fullscreenElement")
    print(("  PASS  " if ok_exit else "  FAIL  ") + f"{stage} Esc exits fullscreen   (element={after.get('fullscreenElement')})")
    if not ok_exit:
        failures += 1
    reset = await click_button(session, "Reset view")
    await asyncio.sleep(1.4)
    after_reset = json.loads(await session.js(PROBE))
    particle = pixels_to_page(
        after_reset.get("pixels") if isinstance(after_reset.get("pixels"), dict) else None,
        after_reset.get("canvas"),
        after_reset.get("buffer"),
    )
    canvas_after = after_reset.get("canvas") or {}
    if particle and canvas_after:
        free = unobstructed(canvas_after, after_reset.get("toolbar"), after_reset.get("hud"))
        dx = abs(particle["x"] + particle["w"] / 2 - (free["x"] + free["w"] / 2))
        dy = abs(particle["y"] + particle["h"] / 2 - (free["y"] + free["h"] / 2))
        limit = 0.10 * min(free["w"], free["h"])
        ok_reset = dx <= limit and dy <= limit
        print(("  PASS  " if ok_reset else "  FAIL  ") + f"{stage} Reset view re-centres   (dx={dx:.0f} dy={dy:.0f}px, click={reset})")
        if not ok_reset:
            failures += 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
