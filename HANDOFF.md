# Handoff — build a DSH recording plugin

You are taking over a prototype whose goal is: **record a DSH plugin's real interface and produce a GIF
(or stills) from it**, without hand-building a lookalike page.

Read [docs/findings.md](docs/findings.md) first; it contains the measurements. This document is the
brief: what to build, the seams that already exist, and the traps that already cost time.

---

## The honest starting point

Two instruments were tried against `@tyouter/dsh-notes`:

| Approach | What it produced | Verdict |
| --- | --- | --- |
| **Re-render**: a generated HTML page reusing the plugin's renderer + stylesheet, driven by `seek(t)`, captured over CDP | A perfect-looking GIF that was *almost* the app — wrong proportions, invented labels | Rejected by the user: "你的 GIF 不对啊" |
| **Real capture**: scripted driver inside the real page + window grab from outside | Real pixels, real interactions; the note count went 13 → 14 (proof it ran) | Worked, but the tooling was bolted onto the notes repo and the timing/visibility problems below were never solved |

The second approach is the right one. What is missing is the product around it.

---

## What to build

A plugin, `@tyouter/dsh-recorder` (name is yours), with two surfaces.

### 1. A host tool the agent can call

```
record_start({ target: "window" | "rect", title?, rect?: [l,t,w,h], fps?, width? })
record_stop()  →  { gif, frames, seconds, framesCount }
list_windows() →  [{ hwnd, title, rect }]
```

Reuse `tools/record-window.py` as the engine: it is a complete, working recorder (Win32 enumerate +
`ImageGrab` + Pillow GIF). Wrap it as a subprocess, or port the ~120 lines into the plugin's host half.
Return the GIF path so the agent can present it.

Requirements the prototype implies:

- **start/stop, not fixed duration.** The agent does not know how long a walkthrough will take.
- **a status line in the UI while recording.** The prototype was silent; the user assumed nothing was
  happening ("我切过去了，那边没有开始自动录制啊").
- **explicit rect support.** Titles are not unique; the biggest match is often the wrong pane.

### 2. A client-side driver contract

The half that must live inside the plugin under test. `src/demo-driver.js` is a working reference
implementation for one plugin; generalise the idea:

- a small **driver API** the plugin under test exposes: `startDemo(steps)`, or a generic "act like a
  user" helper layered on selectors;
- a **dev flag** to arm it (the prototype used a `.demo` file in the data folder plus an env var —
  the file form means arming needs no restart; the *client bundle* still needs a reload);
- `resetDemo()` so a walk can be replayed without reloading the page;
- **no network of its own**: the demo should exercise the product's real code paths, never mock them.

### 3. Assembling outputs

- GIF: already in `record-window.py` (128-colour palette, one shared palette per recording).
- Stills: pick frames by timestamp; `tools/record-window.py` keeps every frame under `frames/`.
- Optional later: chapter cards, cursor highlight, zoom — none of this exists yet. Do not promise it in
  a README before it is built; that was the mistake of the re-render approach.

---

## Traps, in the order they cost time

1. **One-shot driver.** A module-level `started` flag means "run once per page load". After the first
   run the UI is inert, which reads as a bug. Either reload or expose a reset.
2. **Recording the wrong window.** The panel can be mounted while the chat pane is in front. Sample a
   frame mid-recording and *look at it*; do not trust the timer.
3. **Dynamic import does not work in a plugin client half.** The bundle is one factory function; the
   driver must be concatenated into it (that is why `build.mjs` in dsh-notes has a `parts` list).
4. **React ignores `value = …`.** Use the native setter + `dispatchEvent(new Event('input'))`.
5. **Console encoding.** The bundled Python defaults to cp1252; `--list` crashes on a Chinese window
   title without `sys.stdout.reconfigure(encoding="utf-8")`.
6. **The GUI is 401-gated and its port changes on restart.** Do not hard-code a port; read it from the
   app or pass it in.
7. **The renderer has no debug port** unless the app is started with `--remote-debugging-port`. If you
   want CDP-based capture (cleaner than screen grabbing: no focus, no occlusion, exact frames), that
   restart is part of the design, not an accident.

---

## Suggested order of work

1. Wrap `tools/record-window.py` behind a host tool + a `record_start/stop` pair, with a visible status.
   This alone is useful to any plugin author.
2. Move the driver into a small, documented module (`driveUI({ steps })`) and use the notes walk as the
   first fixture; keep selector strings in the fixture, not in the engine.
3. Add a "record this panel" flow: open the panel, arm the demo, start the recorder, stop on completion.
4. Only then: overlays (cursor, zoom, chapter cards) — and only as an opt-in post-process on the frames.

## Acceptance for v0.1

- Start a recording of a named window or rect, get a GIF back, and the GIF shows the plugin's real UI.
- Stop reliably; no orphan process; the frames folder is cleaned on the next start.
- The recording is visible in the UI while it runs.
- A replay needs no page reload (reset path exists).
- Nothing in the plugin under test changes except an opt-in dev flag.

---

## Files

```
src/demo-driver.js     reference driver (works against dsh-notes 1.1 selectors)
tools/record-window.py reference recorder (window/rect, fps, GIF, --list)
docs/findings.md       measurements: ports, 401, window rects, what worked, what did not
```

The notebook repo (`../dsh-notes`) no longer contains any of this; it was reverted to its product code
only. Do not add recording concerns back into it.
