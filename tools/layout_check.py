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

# Phase 2.1 suite: desktop sizes only — 1024x768 and below are owned by the
# Phase 2.2 phone/tablet suite below (which asserts the stacked, page-scrolling
# layout instead of the desktop shell).
VIEWPORTS = [(1772, 864), (1920, 1080), (1366, 768)]
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


# --- Phase 2.2: phone / tablet layout + real fullscreen --------------------------

PHASE22_VIEWPORTS = [
    (1024, 768),
    (1024, 600),
    (430, 932),
    (412, 915),
    (390, 844),
    (375, 667),
    (360, 800),
    (768, 1024),
    (1920, 1080),
]

PHASE22_PROBE = r"""
(() => {
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const q = (sel) => document.querySelector(sel);
  const scrollInfo = (el) => { if (!el) return null; return {
    scrollH: el.scrollHeight, clientH: el.clientHeight,
    scrollW: el.scrollWidth, clientW: el.clientWidth } };
  const sidebar = q('.sidebar'), right = q('.right'), viewer = q('.viewer');
  const toolbar = q('.viewer-toolbar'), legend = q('.viewer-legend, .legend, .color-legend');
  const canvas = q('.viewer canvas');
  const fsBtn = q('[data-testid="fullscreen-toggle"]');
  return JSON.stringify({
    viewer: rect(viewer), canvas: rect(canvas), toolbar: rect(toolbar), legend: rect(legend),
    sidebar: rect(sidebar), right: rect(right),
    sidebarScroll: scrollInfo(sidebar), rightScroll: scrollInfo(right),
    toolbarScroll: scrollInfo(toolbar),
    fullscreenButton: fsBtn ? { label: fsBtn.textContent.trim(), ...rect(fsBtn) } : null,
    fullscreenElement: document.fullscreenElement ? (document.fullscreenElement.className || 'element') : null,
    message: q('.viewer-message') ? q('.viewer-message').textContent.trim() : null,
    bodyOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    doc: { scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight },
  });
})()
"""


def _inside(inner, outer, tol=2.0) -> bool:
    if not inner or not outer:
        return False
    return (
        inner["x"] >= outer["x"] - tol
        and inner["y"] >= outer["y"] - tol
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + tol
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + tol
    )


def _overlap(a, b, tol=2.0) -> float:
    if not a or not b:
        return 0.0
    ox = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    oy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0.0, ox - tol) * max(0.0, oy - tol)


PHASE22_FAILURES: list = []


def phase22_checks(data: dict, width: int, height: int) -> list:
    """Twelve layout rules across the phone / tablet / desktop viewport list."""
    stage = f"{width}x{height}"
    checks = []
    viewer = data.get("viewer") or {}
    canvas = data.get("canvas") or {}
    toolbar = data.get("toolbar") or {}
    legend = data.get("legend") or {}
    sidebar = data.get("sidebar") or {}
    right = data.get("right") or {}
    if not viewer or not canvas:
        return [(f"{stage} viewer measured", False, "no viewer/canvas in the DOM")]

    # 1/2. the control panel and the toolbar are on screen and not clipped
    # (above 1024px the panels scroll internally by design, so only the phone /
    #  tablet layout has to fit without its own scrollbar)
    sb = data.get("sidebarScroll") or {}
    tb = data.get("toolbarScroll") or {}
    panel_fits = (not sb or sb["scrollH"] <= sb["clientH"] + 6) if width <= 1024 else True
    checks.append((
        f"{stage} control panel visible and not clipped",
        bool(sidebar) and sidebar["h"] > 40 and sidebar["y"] >= -1 and panel_fits,
        f"panel y={sidebar.get('y', 0):.0f} h={sidebar.get('h', 0):.0f} "
        f"scroll={sb.get('scrollH', 0)}/client={sb.get('clientH', 0)}"
        + ("" if width <= 1024 else " (desktop: panel scrolls internally by design)"),
    ))
    checks.append((
        f"{stage} toolbar visible and not clipped",
        bool(toolbar) and toolbar["h"] > 20 and _inside(toolbar, viewer, 3)
        and (not tb or tb["scrollW"] <= tb["clientW"] + 6),
        f"toolbar h={toolbar.get('h', 0):.0f} "
        f"scrollW={tb.get('scrollW', 0)}/clientW={tb.get('clientW', 0)}",
    ))

    # 3. viewer height: 45-60% of the viewport on small screens, larger on desktop
    frac = viewer["h"] / max(height, 1)
    if width <= 1024:
        ok = 0.44 <= frac <= 0.61
        note = f"{frac*100:.1f}% of {height}px (target 45-60%)"
    else:
        ok = frac > 0.55
        note = f"{frac*100:.1f}% of {height}px (desktop: unchanged, fills the column)"
    checks.append((f"{stage} viewer keeps a usable height", ok, note))

    # 4. toolbar and legend stay inside the stage
    checks.append((
        f"{stage} toolbar and legend inside the stage",
        _inside(toolbar, viewer, 3) and _inside(legend, viewer, 3),
        f"toolbar in={_inside(toolbar, viewer, 3)} legend in={_inside(legend, viewer, 3)}",
    ))

    # 5. no horizontal page overflow
    checks.append((
        f"{stage} no horizontal overflow",
        data.get("bodyOverflowX", 1) <= 1,
        f"scrollWidth-innerWidth={data.get('bodyOverflowX', 0):.0f}px",
    ))

    # 6. the panels never overlap the stage
    worst = max(_overlap(viewer, sidebar), _overlap(viewer, right))
    checks.append((f"{stage} no overlapping panels", worst <= 0.001, f"overlap area {worst:.1f}px2"))

    # 7. the stage is usable: the canvas fills it and the particle is framed
    fills = abs(canvas["w"] - viewer["w"]) <= 4 and abs(canvas["h"] - viewer["h"]) <= 4
    px = data.get("pixels")
    if isinstance(px, dict):
        short = min(canvas["w"], canvas["h"]) or 1
        occ = max(px["w"], px["h"]) / short
        dx = abs(px["cx"] - canvas["w"] / 2)
        dy = abs(px["cy"] - canvas["h"] / 2)
        ok = fills and 0.35 <= occ <= 0.8 and dx <= 0.09 * canvas["w"] and dy <= 0.09 * canvas["h"]
        note = f"canvas {canvas['w']:.0f}x{canvas['h']:.0f} vs viewer {viewer['w']:.0f}x{viewer['h']:.0f}, occupancy {occ*100:.1f}%, offsets {dx:.0f}/{dy:.0f}px"
    else:
        ok = fills
        note = f"canvas {canvas['w']:.0f}x{canvas['h']:.0f} vs viewer {viewer['w']:.0f}x{viewer['h']:.0f} (pixel probe unavailable)"
    checks.append((f"{stage} viewer usable (canvas fills, particle framed)", ok, note))

    return checks


def fullscreen_checks(data: dict, width: int, height: int) -> list:
    """The fullscreen contract: real fullscreen, correct sizes, synced state, Esc."""
    checks = []
    vp = data.get("viewport") or {"w": width, "h": height}
    viewer = data.get("viewer") or {}
    canvas = data.get("canvas") or {}
    button = data.get("fullscreenButton") or {}
    active = data.get("fullscreenElement")

    full = bool(active and "viewer" in str(active))
    checks.append(("fullscreen: the stage is the fullscreen element", full, f"fullscreenElement={active}"))

    fills = (
        abs(viewer.get("x", 9) - 0) <= 2
        and abs(viewer.get("y", 9) - 0) <= 2
        and abs(viewer.get("w", 0) - vp["w"]) <= 4
        and abs(viewer.get("h", 0) - vp["h"]) <= 4
    )
    checks.append((
        "fullscreen: stage fills 100vw x 100vh",
        fills,
        f"stage {viewer.get('w', 0):.0f}x{viewer.get('h', 0):.0f} at ({viewer.get('x', 0):.0f},{viewer.get('y', 0):.0f}), viewport {vp['w']}x{vp['h']}",
    ))

    resized = abs(canvas.get("w", 0) - vp["w"]) <= 4 and abs(canvas.get("h", 0) - vp["h"]) <= 4
    checks.append((
        "fullscreen: the drawing surface was resized",
        resized,
        f"canvas {canvas.get('w', 0):.0f}x{canvas.get('h', 0):.0f}",
    ))

    checks.append((
        "fullscreen: no clipping or overflow",
        data.get("bodyOverflowX", 0) <= 1 and (data.get("toolbar") or {}).get("h", 0) > 20,
        f"overflow {data.get('bodyOverflowX', 0):.0f}px, toolbar h={(data.get('toolbar') or {}).get('h', 0):.0f}",
    ))

    inside = _inside(data.get("toolbar"), viewer, 3) and _inside(data.get("legend"), viewer, 3)
    checks.append(("fullscreen: toolbar and legend visible inside", inside, f"in-bounds={inside}"))

    label = str(button.get("label", ""))
    checks.append((
        "fullscreen: the button reports the state",
        "exit" in label.lower(),
        f"button label={label!r}",
    ))

    return checks


def fullscreen_failure_checks(data: dict) -> list:
    """A refused fullscreen request must stay in the normal view and say so."""
    checks = []
    active = data.get("fullscreenElement")
    message = data.get("message") or ""
    checks.append((
        "fullscreen: a refusal keeps the normal view",
        not active,
        f"fullscreenElement={active}",
    ))
    checks.append((
        "fullscreen: a refusal shows a visible message",
        "refused" in message.lower() or "not available" in message.lower(),
        f"message={message[:80]!r}",
    ))
    return checks


async def real_click(session: "Session", x: float, y: float) -> None:
    """A trusted click (needed for the Fullscreen API's user-gesture requirement)."""
    for kind in ("mousePressed", "mouseReleased"):
        await session.cmd(
            "Input.dispatchMouseEvent",
            {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1},
        )
        await asyncio.sleep(0.06)


async def phase22_run(session: "Session", url: str, failures: list) -> None:
    for width, height in PHASE22_VIEWPORTS:
        print(f"\n=== Phase 2.2 {width}x{height} ===")
        await session.cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 1024},
        )
        await session.cmd("Page.navigate", {"url": url})
        await asyncio.sleep(3.2)
        # the direction axes are WebGL geometry that would inflate the measured
        # particle bounding box, so the pixel probe runs with them switched off
        await session.js(PROBE_NO_AXES)
        await asyncio.sleep(1.5)
        data = json.loads(await session.js(PHASE22_PROBE))
        base = json.loads(await session.js(PROBE))
        if isinstance(base, dict):
            data["pixels"] = base.get("pixels")
            data["pixels_with_axes"] = base.get("pixels_with_axes")

        for name, ok, detail in phase22_checks(data, width, height):
            print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
            if not ok:
                PHASE22_FAILURES.append(name)

        if (width, height) == (1920, 1080):
            await phase22_fullscreen(session, data, failures)
    print(f"\nPhase 2.2 checks failed: {len(PHASE22_FAILURES)}")
    for name in PHASE22_FAILURES:
        print(f"  - {name}")


async def phase22_fullscreen(session: "Session", data: dict, failures: list) -> None:
    print("  --- fullscreen ---")
    button = data.get("fullscreenButton") or {}
    if not button:
        failures.append("fullscreen: the toolbar exposes a fullscreen button")
        print("  FAIL  fullscreen: the toolbar exposes a fullscreen button   (not found)")
        return
    cx = button["x"] + button["w"] / 2
    cy = button["y"] + button["h"] / 2

    await real_click(session, cx, cy)
    await asyncio.sleep(1.8)
    after = json.loads(await session.js(PHASE22_PROBE))
    for name, ok, detail in fullscreen_checks(after, 1920, 1080):
        print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
        if not ok:
            PHASE22_FAILURES.append(name)

    # Esc leaves fullscreen (the browser handles it; the button must follow)
    for kind in ("keyDown", "keyUp"):
        await session.cmd(
            "Input.dispatchKeyEvent",
            {"type": kind, "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27},
        )
        await asyncio.sleep(0.08)
    await asyncio.sleep(1.4)
    exited = json.loads(await session.js(PHASE22_PROBE))
    label = str((exited.get("fullscreenButton") or {}).get("label", ""))
    for name, ok, detail in (
        ("fullscreen: Esc returns to the normal view", not exited.get("fullscreenElement"), f"fullscreenElement={exited.get('fullscreenElement')}"),
        ("fullscreen: the button label follows the state", "exit" not in label.lower(), f"label={label!r}"),
    ):
        print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
        if not ok:
            PHASE22_FAILURES.append(name)

    # refusal path: the request rejects -> normal view plus a visible message
    await session.js(
        "(() => { window.__fsOriginal = Element.prototype.requestFullscreen;"
        " Element.prototype.requestFullscreen = () => Promise.reject(new Error('stub refusal'));"
        " return true })()"
    )
    button = (json.loads(await session.js(PHASE22_PROBE)).get("fullscreenButton")) or button
    await real_click(session, button["x"] + button["w"] / 2, button["y"] + button["h"] / 2)
    await asyncio.sleep(1.4)
    refused = json.loads(await session.js(PHASE22_PROBE))
    for name, ok, detail in fullscreen_failure_checks(refused):
        print(("  PASS  " if ok else "  FAIL  ") + name + f"   ({detail})")
        if not ok:
            PHASE22_FAILURES.append(name)
    await session.js(
        "(() => { if (window.__fsOriginal) Element.prototype.requestFullscreen = window.__fsOriginal; return true })()"
    )


async def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else "https://gubon28.github.io/atomic-nanoparticle-explorer-lite/"
    json_out = None
    if "--json" in sys.argv:
        json_out = sys.argv[sys.argv.index("--json") + 1]
    phase22 = "--phase22" in sys.argv

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
            if phase22:
                await phase22_run(session, url, failures)
            for width, height in ([] if phase22 else VIEWPORTS):
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
