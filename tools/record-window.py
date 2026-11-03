#!/usr/bin/env python3
"""Record a window of the running app and assemble a GIF.

This is not a re-render: it captures the real window, pixel for pixel, so the footage is the product.

  # list the windows it can see (titles included)
  <python> tools/record-window.py --list

  # record 60 seconds of the DeepSeek Harness window at 8 fps
  <python> tools/record-window.py --title "DeepSeek Harness" --seconds 60 --fps 8

  # record a fixed rectangle instead (e.g. one panel of a wide window)
  <python> tools/record-window.py --rect -433,-1449,2578,1410 --seconds 60

Frames land in exports/recording/frames and the GIF in exports/recording/recording.gif.
Windows only (ctypes + GDI through Pillow).

Notes learned the hard way:
  * a window title is not unique, and the biggest match is usually the main frame — pass --rect if a
    recording keeps picking the wrong one;
  * the console here defaults to cp1252 and window titles are often Chinese; the UTF-8 reconfiguration
    below is what keeps --list from crashing;
  * there is no recording indicator. The process is silent, so whoever is being recorded needs to be
    told when it starts and when it ends, or they will assume nothing happened.
"""

import argparse
import ctypes
import ctypes.wintypes as wintypes
import glob
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
GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008


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
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--title", default="DeepSeek Harness")
    parser.add_argument("--rect", type=parse_rect, default=None)
    parser.add_argument("--seconds", type=float, default=40.0)
    parser.add_argument("--fps", type=float, default=8.0)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--width", type=int, default=900, help="GIF width")
    parser.add_argument("--start-delay", type=float, default=0.0, help="seconds to wait before the first frame")
    args = parser.parse_args()

    if args.list:
        for hwnd, title, left, top, width, height in list_windows():
            print(f"{hwnd:>8}  {width}x{height} at ({left},{top})  {title}")
        return 0

    if args.rect is not None:
        left, top, width, height = args.rect
        title = "rect"
    else:
        found = find_window(args.title)
        if found is None:
            print(f"no visible window matching {args.title!r}; run --list")
            return 1
        _hwnd, title, left, top, width, height = found
    print(f"recording: {title}  {width}x{height} at ({left},{top})", flush=True)

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir or os.path.join(root, "exports", "recording")
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    for old in glob.glob(os.path.join(frames_dir, "f*.png")):
        os.remove(old)

    if args.start_delay > 0:
        time.sleep(args.start_delay)

    count = int(args.seconds * args.fps)
    interval = 1.0 / args.fps
    started = time.time()
    written = 0
    for index in range(count):
        target = started + index * interval
        delay = target - time.time()
        if delay > 0:
            time.sleep(delay)
        shot = ImageGrab.grab(bbox=(left, top, left + width, top + height), all_screens=True)
        shot.save(os.path.join(frames_dir, f"f{index:03d}.png"))
        written += 1
        if index % int(args.fps * 5) == 0:
            print(f"  {index} frames…", flush=True)
    print(f"frames: {written}", flush=True)

    paths = sorted(glob.glob(os.path.join(frames_dir, "f*.png")))
    first = Image.open(paths[0])
    ratio = args.width / first.width
    size = (args.width, max(1, round(first.height * ratio)))
    images = [Image.open(path).convert("RGB").resize(size, Image.LANCZOS) for path in paths]
    palette = images[len(images) // 2].quantize(colors=128, method=Image.MEDIANCUT)
    quantized = [image.quantize(palette=palette, dither=Image.NONE) for image in images]
    gif = os.path.join(out_dir, "recording.gif")
    quantized[0].save(
        gif,
        save_all=True,
        append_images=quantized[1:],
        duration=max(20, round(1000 / args.fps)),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"gif: {gif}  ({os.path.getsize(gif) / 1024:.0f} KB, {len(quantized)} frames)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
