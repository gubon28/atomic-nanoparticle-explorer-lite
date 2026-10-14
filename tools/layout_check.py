"""Layout / camera validation for the deployed Lite app (headless Chrome CDP).

Measures, at several viewport sizes:
  1. viewer container bounding rectangle
  2. canvas bounding rectangle (CSS pixels)
  3. WebGL drawing buffer dimensions
  4. camera projection parameters (aspect, fov/zoom) via the app's read-only debug hook
  5. projected nanoparticle centre relative to the canvas centre (from the camera
     projection AND, empirically, from the rendered pixels)
  6. projected nanoparticle bounding box relative to the viewport
plus layout health: page overflow, panel/viewer overlap, side-panel scrolling.

Usage:
  python tools/layout_check.py <url> [--json out.json]
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import websockets

VIEWPORTS = [(1772, 864), (1920, 1080), (1366, 768), (1024, 768)]
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "google-chrome",
    "/usr/bin/google-chrome",
]
PORT = 9341

# Everything runs in the page: geometry from getBoundingClientRect, the WebGL
# drawing buffer from the canvas element, camera parameters from window.__liteDebug
# and an empirical content bounding box from gl.readPixels.
PROBE = r"""
(() => {
  const rect = (el) => { const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; };
  const viewer = document.querySelector('.viewer');
  const canvas = document.querySelector('.viewer canvas') || document.querySelector('canvas');
  const out = {
    viewport: {w: window.innerWidth, h: window.innerHeight},
    scroll: {w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight},
  };
  if (!viewer || !canvas) { out.error = 'missing viewer or canvas'; return JSON.stringify(out); }
  out.viewer = rect(viewer);
  out.canvas = rect(canvas);
  out.buffer = {w: canvas.width, h: canvas.height};
  const centre = document.querySelector('.center');
  out.center = centre ? rect(centre) : null;
  const left = document.querySelector('.sidebar');
  const right = document.querySelector('.right');
  out.panels = {
    left: left ? rect(left) : null,
    right: right ? rect(right) : null,
    leftScroll: left ? {scroll: left.scrollHeight, client: left.clientHeight} : null,
    rightScroll: right ? {scroll: right.scrollHeight, client: right.clientHeight} : null,
  };
  const dbg = window.__liteDebug && window.__liteDebug.snapshot ? window.__liteDebug.snapshot() : null;
  out.camera = dbg;
  // ---- empirical content bounding box from the rendered pixels ----
  let gl = null;
  try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); } catch (e) { gl = null; }
  if (gl && canvas.width * canvas.height <= 5000000) {
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let minX = W, maxX = -1, minY = H, maxY = -1, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const bright = px[i] + px[i + 1] + px[i + 2];
        if (px[i + 3] > 12 && bright > 30) {
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (n > 0) {
      // readPixels has its origin at the bottom-left; convert to top-left
      out.pixels = {
        minX, maxX, topMinY: H - 1 - maxY, topMaxY: H - 1 - minY,
        cx: (minX + maxX) / 2, cy: H - 1 - (minY + maxY) / 2,
        w: maxX - minX + 1, h: maxY - minY + 1, count: n,
      };
    } else {
      out.pixels = null;
    }
  } else {
    out.pixels = 'skipped';
  }
  return JSON.stringify(out);
})()
"""

# The rendered pixel bounding box also contains the WebGL direction axes, which
# extend past the atoms, so the probe runs a second time with the "Directions"
# toggle switched off (which also exercises that toolbar button).
PROBE_NO_AXES = r"""
(() => {
  const btn = [...document.querySelectorAll('.viewer-toolbar button')]
    .find((b) => (b.textContent || '').trim() === 'Directions');
  if (btn && btn.classList.contains('active')) { btn.click(); return 'turned off'; }
  return btn ? 'already off' : 'missing';
})()
"""


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

    async def cmd(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        request_id = self.next_id
        await self.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=120))
            if message.get("id") == request_id:
                return message

    async def js(self, expression: str, await_promise: bool = True):
        result = await self.cmd(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": await_promise}
        )
        payload = result.get("result", {})
        if "exceptionDetails" in payload:
            return {"error": str(payload["exceptionDetails"].get("text"))}
        return payload.get("result", {}).get("value")

    async def click(self, text: str, selector: str = "button"):
        return await self.js(
            "(() => {const el = [...document.querySelectorAll('%s')].find(e => (e.textContent || '').includes(%s));"
            "if (!el) return 'NOT-FOUND'; el.click(); return 'clicked';})()" % (selector, json.dumps(text))
        )


def pct(value: float, total: float) -> float:
    return 100.0 * value / total if total else 0.0


def evaluate(data: dict, width: int, height: int) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    viewer, canvas, buffer = data["viewer"], data["canvas"], data["buffer"]
    checks.append(
        (
            "canvas fills the viewer horizontally",
            abs(canvas["w"] - viewer["w"]) <= 4,
            f"canvas {canvas['w']:.0f}px vs viewer {viewer['w']:.0f}px",
        )
    )
    checks.append(
        (
            "canvas fills the viewer vertically",
            abs(canvas["h"] - viewer["h"]) <= 4,
            f"canvas {canvas['h']:.0f}px vs viewer {viewer['h']:.0f}px",
        )
    )
    checks.append(
        (
            "viewer is usable (>= 300 px tall, >= 600 px wide)",
            canvas["h"] >= 300 and canvas["w"] >= 600,
            f"canvas {canvas['w']:.0f}x{canvas['h']:.0f}",
        )
    )
    checks.append(
        (
            "drawing buffer matches the CSS size",
            abs(buffer["w"] - canvas["w"]) <= 2 and abs(buffer["h"] - canvas["h"]) <= 2,
            f"buffer {buffer['w']}x{buffer['h']} vs css {canvas['w']:.0f}x{canvas['h']:.0f}",
        )
    )
    camera = data.get("camera")
    if camera:
        checks.append(
            (
                "camera aspect ratio matches the canvas",
                abs(float(camera["aspect"]) - buffer["w"] / max(buffer["h"], 1)) < 0.02,
                f"aspect {float(camera['aspect']):.3f} vs buffer {buffer['w'] / max(buffer['h'], 1):.3f}",
            )
        )
    pixels = data.get("pixels")
    if isinstance(pixels, dict):
        short = min(canvas["w"], canvas["h"])
        dx = pixels["cx"] - buffer["w"] / 2
        dy = pixels["cy"] - buffer["h"] / 2
        checks.append(
            (
                "particle is centred (rendered pixels)",
                abs(dx) <= 0.10 * buffer["w"] and abs(dy) <= 0.10 * buffer["h"],
                f"offset dx={dx:+.0f}px dy={dy:+.0f}px ({pct(abs(dx), buffer['w']):.1f}% / {pct(abs(dy), buffer['h']):.1f}%)",
            )
        )
        occupancy = max(pixels["w"], pixels["h"]) / short
        # the projected particle is a rotated convex solid: its bbox is bounded by
        # sqrt(3)*r for a cube, so 50-65% of the short side with margin is the target
        checks.append(
            (
                "particle occupies 40-75% of the shorter side",
                0.40 <= occupancy <= 0.75,
                f"occupancy {pct(max(pixels['w'], pixels['h']), short):.1f}% of {short}px "
                f"(w {pixels['w']}px h {pixels['h']}px, {pixels['count']} px)",
            )
        )
    if camera and isinstance(pixels, dict):
        checks.append(
            (
                "camera centre matches the rendered centre",
                abs(float(camera["center_ndc"][0])) < 0.06 and abs(float(camera["center_ndc"][1])) < 0.06,
                f"particle centre at NDC "
                f"({float(camera['center_ndc'][0]):+.3f}, {float(camera['center_ndc'][1]):+.3f})",
            )
        )
    scroll = data["scroll"]
    checks.append(
        (
            "no page-level overflow",
            scroll["w"] <= width + 2 and scroll["h"] <= height + 2,
            f"scroll {scroll['w']}x{scroll['h']} vs viewport {width}x{height}",
        )
    )
    panels = data["panels"]
    if panels.get("left"):
        checks.append(
            (
                "left panel does not overlap the viewer",
                panels["left"]["x"] + panels["left"]["w"] <= viewer["x"] + 2,
                f"panel right edge {panels['left']['x'] + panels['left']['w']:.0f} vs viewer left {viewer['x']:.0f}",
            )
        )
    if panels.get("right") and panels["right"]["x"] > viewer["x"]:
        checks.append(
            (
                "right panel does not overlap the viewer",
                panels["right"]["x"] >= viewer["x"] + viewer["w"] - 2,
                f"panel left {panels['right']['x']:.0f} vs viewer right {viewer['x'] + viewer['w']:.0f}",
            )
        )
    for side in ("left", "right"):
        info = panels.get(f"{side}Scroll")
        if info:
            # a panel may legitimately scroll internally; what matters is that it is
            # usable (enough viewport left) and that its content is reachable
            checks.append(
                (
                    f"{side} panel is usable and scrollable",
                    info["client"] >= 180,
                    f"content {info['scroll']}px in {info['client']}px viewport"
                    + (" (scrolls internally)" if info["scroll"] > info["client"] + 2 else ""),
                )
            )
    return checks


async def drag(session: "Session", x0: float, y0: float, x1: float, y1: float, button: str = "left", steps: int = 10) -> None:
    await session.cmd(
        "Input.dispatchMouseEvent",
        {"type": "mousePressed", "x": x0, "y": y0, "button": button, "clickCount": 1, "buttons": 1 if button == "left" else 2},
    )
    for step in range(1, steps + 1):
        await session.cmd(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseMoved",
                "x": x0 + (x1 - x0) * step / steps,
                "y": y0 + (y1 - y0) * step / steps,
                "button": button,
                "buttons": 1 if button == "left" else 2,
            },
        )
        await asyncio.sleep(0.03)
    await session.cmd(
        "Input.dispatchMouseEvent",
        {"type": "mouseReleased", "x": x1, "y": y1, "button": button, "clickCount": 1, "buttons": 0},
    )


async def interaction_checks(session: "Session", data: dict, download_dir: str) -> list[tuple[str, bool, str]]:
    """Rotate / zoom / pan / reset / screenshot, verified through the rendered pixels."""
    checks: list[tuple[str, bool, str]] = []
    viewer = data["viewer"]
    cx, cy = viewer["x"] + viewer["w"] / 2, viewer["y"] + viewer["h"] / 2
    buffer_h = max(data["buffer"]["h"], 1)

    async def pixels() -> dict | None:
        raw = await session.js(PROBE)
        parsed = json.loads(raw) if isinstance(raw, str) else {}
        value = parsed.get("pixels")
        return value if isinstance(value, dict) else None

    base = await pixels()
    if not base:
        checks.append(("interaction checks need a rendered particle", False, "no pixels detected"))
        return checks

    # --- rotation (left drag) ---
    await drag(session, cx, cy, cx + 150, cy + 60)
    await asyncio.sleep(1.2)
    turned = await pixels()
    if turned:
        moved = abs(turned["count"] - base["count"]) / max(base["count"], 1)
        checks.append(
            (
                "rotation changes the view",
                moved > 0.01 or abs(turned["w"] - base["w"]) > 2,
                f"pixel count {base['count']} -> {turned['count']} ({100 * moved:.1f}% change)",
            )
        )

    # --- zoom (wheel) ---
    await session.cmd(
        "Input.dispatchMouseEvent",
        {"type": "mouseWheel", "x": cx, "y": cy, "deltaX": 0, "deltaY": -720},
    )
    await asyncio.sleep(1.4)
    zoomed = await pixels()
    if zoomed and turned:
        ratio = max(zoomed["w"], zoomed["h"]) / max(max(turned["w"], turned["h"]), 1)
        checks.append(
            (
                "zoom in enlarges the particle",
                ratio > 1.02,
                f"bbox {turned['w']}x{turned['h']} -> {zoomed['w']}x{zoomed['h']} (x{ratio:.2f})",
            )
        )

    # --- pan (right drag) ---
    await drag(session, cx, cy, cx - 170, cy + 40, button="right")
    await asyncio.sleep(1.2)
    panned = await pixels()
    if panned:
        # NOTE: the offset is measured against the CANVAS centre, not the bounding
        # box width (an earlier version of this check compared against the bbox and
        # produced nonsense numbers)
        buffer_w = data["buffer"]["w"]
        offset = abs(panned["cx"] - buffer_w / 2)
        checks.append(
            (
                "pan moves the particle off centre",
                offset > 15,
                f"centre offset {panned['cx'] - buffer_w / 2:+.0f}px after a right-drag",
            )
        )

    # --- reset view ---
    await session.click("Reset view", ".viewer-toolbar button")
    await asyncio.sleep(1.6)
    reset = await pixels()
    if reset:
        buffer_w = data["buffer"]["w"]
        buffer_h = max(data["buffer"]["h"], 1)
        dx = abs(reset["cx"] - buffer_w / 2)
        dy = abs(reset["cy"] - buffer_h / 2)
        size_ratio = max(reset["w"], reset["h"]) / max(max(base["w"], base["h"]), 1)
        checks.append(
            (
                "Reset view restores the centred framing",
                dx <= 0.06 * buffer_w and dy <= 0.06 * buffer_h and 0.9 <= size_ratio <= 1.1,
                f"offset dx={dx:.0f} dy={dy:.0f}px from the canvas centre, size x{size_ratio:.2f} vs the initial view",
            )
        )

    # --- morphology changes and the orthographic camera keep the framing ---
    buffer_w = data["buffer"]["w"]
    short = min(data["buffer"]["w"], data["buffer"]["h"])
    for label in ("Cube", "Octahedron"):
        await session.click(label, ".morph-item")
        await asyncio.sleep(2.8)
        shot = await pixels()
        if shot:
            occupancy = max(shot["w"], shot["h"]) / short
            offset = abs(shot["cx"] - buffer_w / 2)
            checks.append(
                (
                    f"framing is refitted after switching to {label}",
                    0.40 <= occupancy <= 0.75 and offset <= 0.06 * buffer_w,
                    f"occupancy {pct(max(shot['w'], shot['h']), short):.1f}%, centre offset {offset:.0f}px",
                )
            )
    await session.click("Orthographic", ".viewer-toolbar button")
    await asyncio.sleep(2.4)
    ortho = await pixels()
    raw_cam = await session.js("window.__liteDebug ? JSON.stringify(window.__liteDebug.snapshot()) : '{}'")
    cam = json.loads(raw_cam) if isinstance(raw_cam, str) and raw_cam.startswith("{") else {}
    if ortho:
        occupancy = max(ortho["w"], ortho["h"]) / short
        offset = abs(ortho["cx"] - buffer_w / 2)
        checks.append(
            (
                "orthographic camera fits the particle too",
                0.40 <= occupancy <= 0.75
                and offset <= 0.06 * buffer_w
                and cam.get("type") == "orthographic",
                f"occupancy {pct(max(ortho['w'], ortho['h']), short):.1f}%, centre offset {offset:.0f}px, "
                f"type={cam.get('type')} zoom={float(cam.get('zoom') or 0):.2f}",
            )
        )
    await session.click("Perspective", ".viewer-toolbar button")
    await asyncio.sleep(1.6)

    # --- screenshot PNG (real download) ---
    os.makedirs(download_dir, exist_ok=True)
    for stale in os.listdir(download_dir):
        os.remove(os.path.join(download_dir, stale))
    await session.cmd("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": download_dir})
    await session.click("Screenshot PNG", ".viewer-toolbar button")
    shot = None
    for _ in range(20):
        await asyncio.sleep(0.5)
        files = [f for f in os.listdir(download_dir) if f.endswith(".png")]
        if files:
            shot = os.path.join(download_dir, files[0])
            break
    checks.append(
        (
            "Screenshot PNG downloads a real image",
            bool(shot) and os.path.getsize(shot) > 20000,
            f"{os.path.basename(shot)} ({os.path.getsize(shot) // 1024} kB)" if shot else "no .png file appeared",
        )
    )
    return checks


async def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://gubon28.github.io/atomic-nanoparticle-explorer-lite/"
    json_out = None
    if "--json" in sys.argv:
        json_out = sys.argv[sys.argv.index("--json") + 1]

    chrome = find_chrome()
    profile = tempfile.mkdtemp(prefix="lite-layout-")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--enable-unsafe-swiftshader",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

    results = {}
    failures = 0
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            session = Session(ws)
            await session.cmd("Runtime.enable")
            await session.cmd("Page.enable")
            for width, height in VIEWPORTS:
                await session.cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False},
                )
                await session.cmd("Page.navigate", {"url": url})
                await asyncio.sleep(9)
                raw = await session.js(PROBE)
                data = json.loads(raw) if isinstance(raw, str) else {"error": raw}
                if "error" not in data:
                    # second pass without the direction axes so the measured bounding
                    # box is the particle itself, not the axes
                    await session.js(PROBE_NO_AXES)
                    await asyncio.sleep(1.6)
                    raw2 = await session.js(PROBE)
                    data2 = json.loads(raw2) if isinstance(raw2, str) else {}
                    if isinstance(data2, dict) and "error" not in data2:
                        data["pixels_with_axes"] = data.get("pixels")
                        data["pixels"] = data2.get("pixels")
                        data["camera"] = data2.get("camera") or data.get("camera")
                results[f"{width}x{height}"] = data
                print(f"\n=== viewport {width}x{height} ===")
                if "error" in data:
                    print("  probe error:", data["error"])
                    failures += 1
                    continue
                v, c, b = data["viewer"], data["canvas"], data["buffer"]
                print(
                    f"  viewer {v['w']:.0f}x{v['h']:.0f} @({v['x']:.0f},{v['y']:.0f})   "
                    f"canvas {c['w']:.0f}x{c['h']:.0f}   buffer {b['w']}x{b['h']}   "
                    f"aspect {b['w'] / max(b['h'], 1):.3f}"
                )
                cam = data.get("camera")
                if cam:
                    print(
                        f"  camera {cam.get('type')} fov={cam.get('fov')} zoom={cam.get('zoom')} "
                        f"aspect={float(cam.get('aspect', 0)):.3f} dist={float(cam.get('distance', 0)):.1f} "
                        f"radius={float(cam.get('radius', 0)):.1f}"
                    )
                px = data.get("pixels")
                was = data.get("pixels_with_axes")
                if isinstance(px, dict):
                    print(
                        f"  rendered particle: centre ({px['cx']:.0f},{px['cy']:.0f}) in buffer "
                        f"{b['w']}x{b['h']} -> offset dx={px['cx'] - b['w'] / 2:+.0f} dy={px['cy'] - b['h'] / 2:+.0f}   "
                        f"bbox {px['w']}x{px['h']}px = {pct(max(px['w'], px['h']), min(b['w'], b['h'])):.1f}% of the short side"
                    )
                elif px == "skipped":
                    print("  particle pixels: probe skipped (buffer too large)")
                else:
                    print("  particle pixels: nothing detected")
                if isinstance(was, dict):
                    print(
                        f"    (with direction axes: bbox {was['w']}x{was['h']}px = "
                        f"{pct(max(was['w'], was['h']), min(b['w'], b['h'])):.1f}% — excluded from the checks)"
                    )
                for name, ok, detail in evaluate(data, width, height):
                    print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
                    if not ok:
                        failures += 1
                if (width, height) == VIEWPORTS[0] and isinstance(data.get("pixels"), dict):
                    print("  --- interaction ---")
                    download_dir = os.path.join(tempfile.gettempdir(), "lite-layout-downloads")
                    for name, ok, detail in await interaction_checks(session, data, download_dir):
                        print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
                        if not ok:
                            failures += 1
    finally:
        proc.kill()

    if json_out:
        with open(json_out, "w", encoding="utf-8") as handle:
            json.dump(results, handle, indent=2)
        print(f"\nraw measurements -> {json_out}")
    print(f"\nlayout failures: {failures}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
