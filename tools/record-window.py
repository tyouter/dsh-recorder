#!/usr/bin/env python3
"""Capture a real window (or rectangle) of the running app and assemble a GIF.

This is not a re-render: it grabs the window pixel for pixel, so the footage is the product.

  # list the windows it can see (titles included)
  <python> tools/record-window.py --list

  # record a window until a stop file appears, then build the GIF
  <python> tools/record-window.py --title "DeepSeek Harness" --stop-file STOP --fps 6 --width 900

  # record 20 seconds of a fixed rectangle
  <python> tools/record-window.py --rect -433,-1449,2578,1410 --seconds 20

  # grab one frame (used to verify the recorder is looking at the right window)
  <python> tools/record-window.py --title "DeepSeek Harness" --grab probe.png

Started/stopped by the plugin's host half: it creates the output directory, writes the stop file to end a
recording, and reads `session.json` / `meta.json` / `times.json` back. Every machine-readable line is
prefixed with `RECORDER ` so a caller can ignore the human progress lines.

Windows only (ctypes + GDI through Pillow).

Notes learned the hard way:
  * a window title is not unique, and the biggest match is usually the main frame — pass --rect if a
    recording keeps picking the wrong one;
  * the console here defaults to cp1252 and window titles are often Chinese; the UTF-8 reconfiguration
    below is what keeps --list from crashing;
  * there is no recording indicator in the process itself anymore: the plugin paints one in the page and
    writes the stop file, so a person always sees when a recording is live.
"""

import argparse
import ctypes
import ctypes.wintypes as wintypes
import glob
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from PIL import Image, ImageGrab

user32 = ctypes.windll.user32

SW_RESTORE = 9
SW_MINIMIZE = 6
GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008


def make_dpi_aware():
    """Without this, GetWindowRect returns virtualized (scaled) coordinates while ImageGrab's
    bbox is physical — the crop then lands on a different monitor and records the wrong app."""
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
            return True
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return True
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


make_dpi_aware()

dwmapi = ctypes.windll.dwmapi
DWMWA_EXTENDED_FRAME_BOUNDS = 9


def window_bounds(hwnd):
    """The visible frame. GetWindowRect includes the invisible resize border and drop shadow, which a
    screen grab would show as a sliver of whatever window is underneath."""
    rect = wintypes.RECT()
    try:
        if dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)) == 0:
            if rect.right > rect.left and rect.bottom > rect.top:
                return rect
    except Exception:
        pass
    fallback = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(fallback))
    return fallback


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


MONITOR_DEFAULTTONEAREST = 2
SWP_NOZORDER = 0x0004
SWP_SHOWWINDOW = 0x0040


def cursor_work_area():
    """The work area of the monitor the cursor is on — "the screen the user is looking at"."""
    point = wintypes.POINT()
    if not user32.GetCursorPos(ctypes.byref(point)):
        return None
    monitor = user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return None
    return info.rcWork


def fill_screen(hwnd):
    """Move the window to the cursor's monitor and maximize it: a 1:1, screen-filling window."""
    work = cursor_work_area()
    try:
        user32.ShowWindow(hwnd, SW_RESTORE)
    except Exception:
        pass
    if work is None:
        user32.ShowWindow(hwnd, SW_MAXIMIZE)
        time.sleep(0.4)
        return False
    user32.SetWindowPos(
        hwnd,
        0,
        work.left,
        work.top,
        work.right - work.left,
        work.bottom - work.top,
        SWP_NOZORDER | SWP_SHOWWINDOW,
    )
    user32.ShowWindow(hwnd, SW_MAXIMIZE)
    time.sleep(0.45)
    return True


def emit(event, **fields):
    """One machine-readable progress line; the host half parses these."""
    payload = {"event": event, **fields}
    print("RECORDER " + json.dumps(payload, ensure_ascii=False), flush=True)


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.UINT),
        ("flags", wintypes.UINT),
        ("showCmd", wintypes.UINT),
        ("ptMinPosition", wintypes.POINT),
        ("ptMaxPosition", wintypes.POINT),
        ("rcNormalPosition", wintypes.RECT),
    ]


SW_MAXIMIZE = 3


def save_placement(hwnd):
    placement = WINDOWPLACEMENT()
    placement.length = ctypes.sizeof(WINDOWPLACEMENT)
    try:
        if user32.GetWindowPlacement(hwnd, ctypes.byref(placement)):
            return placement
    except Exception:
        pass
    return None


def fill_work_area(hwnd, placement):
    """A window taller than its screen records the taskbar as well as black off-screen rows. Filling
    the work area for the length of the shoot avoids both, and the previous placement is restored."""
    if placement is None or user32.IsZoomed(hwnd):
        return False
    try:
        user32.ShowWindow(hwnd, SW_MAXIMIZE)
    except Exception:
        return False
    time.sleep(0.55)
    return True


def restore_placement(hwnd, placement):
    if placement is None:
        return
    try:
        user32.SetWindowPlacement(hwnd, ctypes.byref(placement))
    except Exception:
        pass


def screen_clip(left, top, width, height):
    """Clamp to the virtual desktop: a grab outside it is black in the GIF."""
    vx = user32.GetSystemMetrics(76)
    vy = user32.GetSystemMetrics(77)
    vw = user32.GetSystemMetrics(78)
    vh = user32.GetSystemMetrics(79)
    right = min(left + width, vx + vw)
    bottom = min(top + height, vy + vh)
    left = max(left, vx)
    top = max(top, vy)
    return left, top, max(1, right - left), max(1, bottom - top)



def list_windows():
    results = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        rect = window_bounds(hwnd)
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width > 200 and height > 200:
            results.append((hwnd, buffer.value, rect.left, rect.top, width, height))
        return True

    user32.EnumWindows(callback, 0)
    return results


def find_window(title_part):
    best = None
    for hwnd, title, left, top, width, height in list_windows():
        if title_part.lower() in title.lower():
            # Prefer the biggest match: the main frame, not a tooltip.
            if best is None or width * height > best[4] * best[5]:
                best = (hwnd, title, left, top, width, height)
    return best


def parse_rect(text):
    parts = [int(piece) for piece in str(text).split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--rect wants left,top,width,height")
    return parts


def parse_inset(text):
    """left,top,right,bottom,scale in CSS pixels relative to the page viewport."""
    if not text:
        return None
    try:
        parts = [float(piece) for piece in str(text).split(",")]
    except ValueError:
        return None
    return parts if len(parts) == 5 else None


def crop_box(hwnd, frame_left, frame_top, frame_width, frame_height, inset):
    """Map viewport insets to a crop inside the grabbed frame.

    The page reports insets in CSS pixels; the client area's physical origin and size come from Win32.
    Working from those two facts keeps the crop right on mixed-DPI monitors without guessing a scale.
    """
    if inset is None or not hwnd:
        return None
    left_css, top_css, right_css, bottom_css, scale = inset
    if scale <= 0:
        return None
    client = wintypes.RECT()
    if not user32.GetClientRect(int(hwnd), ctypes.byref(client)):
        return None
    point = wintypes.POINT(0, 0)
    if not user32.ClientToScreen(int(hwnd), ctypes.byref(point)):
        return None
    offset_x = point.x - frame_left
    offset_y = point.y - frame_top
    width_px = client.right - client.left
    height_px = client.bottom - client.top
    x0 = offset_x + left_css * scale
    y0 = offset_y + top_css * scale
    x1 = offset_x + width_px - right_css * scale
    y1 = offset_y + height_px - bottom_css * scale
    x0 = max(0.0, min(x0, frame_width - 40.0))
    y0 = max(0.0, min(y0, frame_height - 40.0))
    x1 = max(x0 + 40.0, min(x1, float(frame_width)))
    y1 = max(y0 + 40.0, min(y1, float(frame_height)))
    return (int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1)))



def grab(left, top, width, height):
    return ImageGrab.grab(bbox=(left, top, left + width, top + height), all_screens=True)


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)


def resolve_target(args):
    if args.rect is not None:
        left, top, width, height = args.rect
        return {"title": "rect", "left": left, "top": top, "width": width, "height": height}
    found = find_window(args.title)
    if found is None:
        return None
    hwnd, title, left, top, width, height = found
    return {"title": title, "hwnd": int(hwnd), "left": left, "top": top, "width": width, "height": height}


def activate(hwnd):
    """Bring a window forward so a screen grab sees it rather than whatever covers it.

    Windows refuses SetForegroundWindow from a background process, so when that fails this does the
    one thing that always works: minimize and restore, which makes the restored window the foreground.
    The caller gets `focused` back and can sample a frame to check what it is actually looking at.

    A maximized window must stay maximized: SW_RESTORE on a zoomed window returns it to its *normal*
    size, which used to shrink the app as soon as a rehearsal focused it.
    """
    if not hwnd:
        return False
    try:
        was_maximized = bool(user32.IsZoomed(hwnd))
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.2)
        if user32.GetForegroundWindow() == hwnd:
            return True
        # The foreground lock refuses the direct call; a minimize settles it, then restore the exact
        # state the window was in (maximized stays maximized).
        user32.ShowWindow(hwnd, SW_MINIMIZE)
        time.sleep(0.25)
        user32.ShowWindow(hwnd, SW_MAXIMIZE if was_maximized else SW_RESTORE)
        time.sleep(0.45)
    except Exception:
        return False
    return user32.GetForegroundWindow() == hwnd


def assemble_gif(frames_dir, out_dir, width, fps):
    """One shared palette from a middle frame, 128 colours: the GIF stays small and stable."""
    paths = sorted(glob.glob(os.path.join(frames_dir, "f*.png")))
    if not paths:
        return None, 0
    first = Image.open(paths[0])
    ratio = width / first.width
    size = (width, max(1, round(first.height * ratio)))
    images = [Image.open(path).convert("RGB").resize(size, Image.LANCZOS) for path in paths]
    palette = images[len(images) // 2].quantize(colors=128, method=Image.MEDIANCUT)
    quantized = [image.quantize(palette=palette, dither=Image.NONE) for image in images]
    gif = os.path.join(out_dir, "recording.gif")
    quantized[0].save(
        gif,
        save_all=True,
        append_images=quantized[1:],
        duration=max(20, round(1000 / fps)),
        loop=0,
        optimize=True,
        disposal=2,
    )
    return gif, len(quantized)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--json", action="store_true", help="machine-readable stdout for --list/--grab")
    parser.add_argument("--title", default="DeepSeek Harness")
    parser.add_argument("--rect", type=parse_rect, default=None)
    parser.add_argument("--seconds", type=float, default=0.0, help="fixed duration; 0 means until --stop-file")
    parser.add_argument("--max-seconds", type=float, default=600.0, help="safety cap when waiting for --stop-file")
    parser.add_argument("--fps", type=float, default=6.0)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--width", type=int, default=900, help="GIF width in pixels")
    parser.add_argument("--start-delay", type=float, default=0.0, help="seconds to wait before the first frame")
    parser.add_argument("--stop-file", default=None, help="end the recording when this file appears")
    parser.add_argument("--grab", default=None, help="save one frame to this path and exit")
    parser.add_argument("--probe", default=None, help="also save the first recorded frame to this path")
    parser.add_argument("--activate", action="store_true", default=True, help="bring the window forward first")
    parser.add_argument("--no-activate", dest="activate", action="store_false")
    parser.add_argument("--maximize", action="store_true", default=True, help="fill the work area while recording")
    parser.add_argument("--no-maximize", dest="maximize", action="store_false")
    parser.add_argument("--focus", action="store_true", help="bring the window forward and exit (no capture)")
    parser.add_argument("--fill-screen", action="store_true", help="move the window to the cursor's monitor and maximize it")
    parser.add_argument(
        "--inset",
        default=None,
        help="left,top,right,bottom,scale in CSS pixels: crop the page area away from the window",
    )
    parser.add_argument(
        "--assemble-only",
        action="store_true",
        help="build the GIF from frames another capture backend already wrote into --out-dir",
    )
    args = parser.parse_args()

    if args.list:
        rows = [
            {"hwnd": int(hwnd), "title": title, "rect": [left, top, width, height], "width": width, "height": height}
            for hwnd, title, left, top, width, height in list_windows()
        ]
        if args.json:
            print(json.dumps(rows, ensure_ascii=False))
        else:
            for row in rows:
                l, t, w, h = row["rect"]
                print(f"{row['hwnd']:>8}  {w}x{h} at ({l},{t})  {row['title']}")
        return 0

    if args.assemble_only:
        out_dir = args.out_dir
        if out_dir is None:
            emit("error", message="--assemble-only needs --out-dir")
            return 1
        frames_dir = os.path.join(out_dir, "frames")
        times_path = os.path.join(out_dir, "times.json")
        times = []
        try:
            with open(times_path, "r", encoding="utf-8") as handle:
                times = json.load(handle)
        except Exception:
            times = []
        seconds = round(times[-1] - times[0], 2) if len(times) > 1 else round(len(times) / max(0.5, args.fps), 2)
        session = {}
        try:
            with open(os.path.join(out_dir, "session.json"), "r", encoding="utf-8") as handle:
                session = json.load(handle)
        except Exception:
            session = {}
        gif, frames = assemble_gif(frames_dir, out_dir, args.width, max(0.5, float(args.fps)))
        if gif is None:
            emit("error", message="no frames were captured")
            return 1
        meta = {
            "frames": frames,
            "seconds": seconds,
            "fps": max(0.5, float(args.fps)),
            "gifWidth": args.width,
            "bytes": os.path.getsize(gif),
            "target": session.get("target", {}),
            "gif": gif,
            "framesDir": frames_dir,
            "probe": session.get("probe"),
            "times": times,
        }
        write_json(os.path.join(out_dir, "meta.json"), meta)
        emit("done", gif=gif, frames=frames, seconds=seconds, bytes=os.path.getsize(gif))
        return 0

    target = resolve_target(args)
    if target is None:
        emit("error", message=f"no visible window matching {args.title!r}; run --list")
        return 1

    if args.fill_screen:
        hwnd = int(target.get("hwnd") or 0)
        if not hwnd:
            emit("error", message="--fill-screen needs a window target")
            return 1
        moved = fill_screen(hwnd)
        rect = window_bounds(hwnd)
        emit("filled", title=target["title"], rect=[rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top], moved=moved)
        return 0

    left, top, width, height = target["left"], target["top"], target["width"], target["height"]
    focused = None
    placement = None
    maximized = False
    if target.get("hwnd"):
        hwnd = int(target["hwnd"])
        placement = save_placement(hwnd)
        if args.activate:
            focused = activate(hwnd)
        if args.maximize:
            maximized = fill_work_area(hwnd, placement)
        # Re-read: a restored or maximized window has new bounds.
        rect = window_bounds(hwnd)
        left, top = rect.left, rect.top
        width, height = rect.right - rect.left, rect.bottom - rect.top
    left, top, width, height = screen_clip(left, top, width, height)
    crop = crop_box(target.get("hwnd"), left, top, width, height, parse_inset(args.inset))
    emit("target", title=target["title"], rect=[left, top, width, height], focused=focused, maximized=maximized, crop=crop)

    if args.focus:
        if maximized:
            restore_placement(int(target["hwnd"]), placement)
        emit("focus", title=target["title"], focused=focused)
        return 0

    if args.grab is not None:
        os.makedirs(os.path.dirname(os.path.abspath(args.grab)) or ".", exist_ok=True)
        shot = grab(left, top, width, height)
        if crop is not None:
            shot = shot.crop(crop)
        shot.save(args.grab)
        if maximized:
            restore_placement(int(target["hwnd"]), placement)
        emit("grab", path=args.grab, title=target["title"], rect=[left, top, width, height], crop=crop)
        return 0

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir or os.path.join(root, "exports", "recording")
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    # A session directory is created fresh by the caller, but clear leftovers anyway.
    for old in glob.glob(os.path.join(frames_dir, "f*.png")):
        os.remove(old)

    fps = max(0.5, min(float(args.fps), 30.0))
    write_json(
        os.path.join(out_dir, "session.json"),
        {
            "pid": os.getpid(),
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "target": {
                "title": target["title"],
                "hwnd": target.get("hwnd"),
                "rect": [left, top, width, height],
                "left": left,
                "top": top,
                "width": width,
                "height": height,
            },
            "focused": focused,
            "maximized": maximized,
            "crop": crop,
            "fps": fps,
            "width": args.width,
            "stopFile": args.stop_file,
            "backend": "screen",
        },
    )
    emit("started", pid=os.getpid(), target=target, fps=fps, outDir=out_dir)

    if args.start_delay > 0:
        time.sleep(args.start_delay)

    interval = 1.0 / fps
    started = time.time()
    deadline = started + (args.seconds if args.seconds > 0 else args.max_seconds)
    times = []
    index = 0
    stop_path = args.stop_file
    focused_lost = False
    target_hwnd = int(target["hwnd"]) if target.get("hwnd") else 0
    while True:
        if stop_path and os.path.exists(stop_path):
            break
        now = time.time()
        if now >= deadline:
            break
        target_at = started + index * interval
        delay = target_at - time.time()
        if delay > 0:
            time.sleep(delay)
        if target_hwnd and index % max(1, int(fps)) == 0 and user32.GetForegroundWindow() != target_hwnd:
            focused_lost = True
        shot = grab(left, top, width, height)
        if crop is not None:
            shot = shot.crop(crop)
        path = os.path.join(frames_dir, f"f{index:03d}.png")
        shot.save(path)
        if index == 0 and args.probe:
            os.makedirs(os.path.dirname(os.path.abspath(args.probe)) or ".", exist_ok=True)
            shot.save(args.probe)
        times.append(round(time.time() - started, 3))
        index += 1
        if index % max(1, int(fps * 5)) == 0:
            emit("progress", frames=index, seconds=round(time.time() - started, 1))

    seconds = round(time.time() - started, 2)
    write_json(os.path.join(out_dir, "times.json"), times)
    emit("stopped", frames=len(times), seconds=seconds)
    if maximized:
        restore_placement(int(target["hwnd"]), placement)

    if not times:
        emit("error", message="no frames were captured")
        return 1

    gif, frames = assemble_gif(frames_dir, out_dir, args.width, fps)
    if gif is None:
        emit("error", message="no frames were captured")
        return 1
    meta = {
        "frames": frames,
        "seconds": seconds,
        "fps": fps,
        "gifWidth": args.width,
        "bytes": os.path.getsize(gif),
        "target": {"title": target["title"], "rect": [left, top, width, height]},
        "focused": focused,
        "focusedLost": focused_lost,
        "maximized": maximized,
        "crop": crop,
        "backend": "screen",
        "gif": gif,
        "framesDir": frames_dir,
        "probe": args.probe,
        "times": times,
    }
    write_json(os.path.join(out_dir, "meta.json"), meta)
    emit("done", gif=gif, frames=frames, seconds=seconds, bytes=os.path.getsize(gif))
    return 0


if __name__ == "__main__":
    sys.exit(main())
