# Findings — what was measured while trying to film the notebook

Everything below is a measurement or an observed frame, not an assumption. The machine is Windows, the
app is the Electron desktop build.

## The app and its surfaces

| Fact | Value | How it was checked |
| --- | --- | --- |
| App process | `DeepSeek Harness.exe` | `Get-Process -Id <owner of the web port>` |
| Web GUI is served by the app | `http://127.0.0.1:<port>` — port changed on restart (`52139` → `56849`) | `Get-NetTCPConnection -State Listen` |
| The GUI is auth-gated | `GET /` → **401**, `Content-Type: text/plain`, no `WWW-Authenticate` | `Invoke-WebRequest` |
| The plugin data route is *not* gated | `GET /notes/api/list` → 200 JSON | same |
| Plugin client halves are not at guessable URLs | `/plugins/<pkg>/client.js`, `/dsh/modules/<pkg>/client.js`, `/dsh/client.js` → 404 | probe |
| Renderer debug port | **not open**. The only CDP port (9222) belongs to a separate Chrome with `file://` pages | `GET :9222/json/list` |

Consequence: a debugging attach to the real renderer needs either a restart with
`--remote-debugging-port=<n>` or a served GUI in a debuggable browser (blocked by the 401).

## Capturing pixels works, from outside

```python
from PIL import ImageGrab
ImageGrab.grab()          # 1920x1080, works
ImageGrab.grab(bbox=(left, top, left + w, top + h), all_screens=True)   # a window rect
```

`ffmpeg` is **not** on PATH; Pillow is enough to encode a GIF. `tools/record-window.py` uses Win32
`EnumWindows` + `GetWindowRect` to find the window, then Pillow to grab it at a chosen fps.

The window that mattered: title `记事本 — DeepSeek Harness`, rect `(-433, -1449) 2578x1410` (second
monitor, negative coordinates — `all_screens=True` is required).

## Driving the UI works, from inside the page

A scripted driver (now `src/demo-driver.js`) typed into the real textarea, pressed TAB, selected a range
and clicked the real buttons. Proof it ran end to end: the notebook went from 13 to 14 notes, and the new
note's body is exactly the scripted text.

Implementation notes that had to be discovered:

- The client half of a DSH plugin is **one factory function**. A dynamic `import('./demo.js')` does not
  resolve; the driver has to be concatenated into the same bundle (that is what `build.mjs`'s `parts`
  list is for).
- Setting `textarea.value` is not enough for React: use the native setter, then dispatch `input`.
- TAB and Enter must be real `KeyboardEvent`s dispatched on the textarea; the panel's handlers listen
  there.
- Selection: `setSelectionRange` + dispatch `select` is what makes "structure only this range" possible.

## The failure mode that wasted the most time

`demo-driver.js` keeps a module-level `started` flag, so the walk runs **once per page load**. After the
first run, opening (or re-opening) the panel does nothing at all — which looks exactly like "the demo is
broken". The page had to be reloaded (`Ctrl+R` / `F5` / menu → Reload) to replay it.

A recorder UI must therefore either reload the page or call `resetDemo()`.

## The second failure mode: recording the wrong window

The first recordings captured the chat pane while the demo was actually running in the notebook panel —
the panel had mounted without being visible. The frames looked "empty" rather than "wrong", which made
it easy to misdiagnose. Two habits fix this:

1. **sample a frame mid-recording** and look at it, instead of trusting the timer;
2. prefer an explicit `--rect` for the panel under test once its coordinates are known.

## What has not been solved

- **No in-app recording indicator or control surface.** The recorder is a separate process; whoever is
  recorded has to be told when it starts.
- **No stable mapping from a plugin to its window/rect.** Titles are dynamic (`记事本 — DeepSeek
  Harness` is the session title, not the plugin name), and several plugins share one window.
- **No captioning / cursor overlay.** The frames are raw pixels: no zoom, no pointer highlight, no
  chapter cards. That work was done in the *re-render* approach (a generated HTML page), which is a
  different instrument and produces a lookalike, not the product.
