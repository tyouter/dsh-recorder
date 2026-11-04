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

---

# v0.1 build — what the plugin work measured

Everything below was observed while turning the prototype into `@tyouter/dsh-recorder`.

## Capture

| Fact | Value / behaviour | How it was checked |
| --- | --- | --- |
| The Host half is not inside Electron | `require('electron')` from the plugin does not yield `BrowserWindow`; `process.versions.electron` is not available to it | `recorder_windows` → `capture: { backend: "screen", electron: null }` |
| A screen grab needs DPI awareness | Python starts **DPI-unaware** (`GetProcessDpiAwareness → 0`); `GetWindowRect` then returns logical coordinates while `ImageGrab`'s bbox is physical, so the crop lands on the wrong monitor | first probe recorded an Acrobat window instead of the app; fixed with `SetProcessDpiAwarenessContext(-4)` before any window call |
| `GetWindowRect` includes invisible borders | a grab showed a sliver of the window underneath along the bottom edge | switched to `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` |
| `SetForegroundWindow` is refused from the Host-spawned process | returns 0; `GetForegroundWindow` stays on the previous app | probe after start, `focused: false` |
| `AttachThreadInput` + `SetForegroundWindow` also failed | `AttachThreadInput` returned 0 | diagnostic |
| **minimize + restore does bring it forward** | `ShowWindow(SW_MINIMIZE)` → 250 ms → `ShowWindow(SW_RESTORE)` → `GetForegroundWindow == hwnd` | diagnostic; also worked through the plugin |
| A window can be taller than the screen | the app window was 1603×1021 at y=192 on a 1080-tall work area; the grab showed the taskbar and black off-screen rows | probe image |
| Maximize + restore keeps footage clean | `ShowWindow(SW_MAXIMIZE)` → capture 1920×1020 → `SetWindowPlacement(saved)` afterwards | test run, frames inspected |
| Screen grab has no occlusion handling | whatever is on top at that rectangle is what gets recorded | first two recordings |

## Driving

| Fact | Value / behaviour |
| --- | --- |
| The driver can live in the recorder | the client half is in the same page as the target plugin, so it reads and clicks the target's real DOM; **the target plugin needs no change and no dev flag** |
| The page ↔ Host bridge is a plain route | `GET /recorder/api/poll` hands out one job, `POST /recorder/api/report` completes it; no CDP and no debug port involved |
| Client half appears without a page reload | after `plugin_manager(set_plugin)` re-enabled the bundle with the page already open, `health.clientConnected` became `true` and driving worked; a later CSS change in `client.js` was live after the next re-enable |
| Host half does not reload from file edits | a re-enable (`set_plugin` off → on) picked up the new `lib/*.js`; plain file edits were not observed to take effect |
| Tool results must be lossless JSON | returning an object with an `undefined` field fails the call with `value is not lossless JSON`; strip undefined at the boundary |
| Synthetic events are enough | native setter + `input`, `setSelectionRange` + `select`, PointerEvent/MouseEvent sequence + `click` all reached the notes panel |

## The verified run

`recorder_demo` with `examples/notes-demo.json`, 6 fps, 1000 px wide:

- 10.79 s, 65 frames, 2 021 KB GIF, three stills (3 s / 6 s / 9 s);
- every step reported `✓`, including turning Auto-write off, switching to the Capture tab, clearing
  the draft, typing 62 characters, and selecting 12 characters;
- the stills show the typed note on the left, its live typeset mirror on the right with the same
  selection highlighted, the recorder's cursor, and the REC pill with its clock and stop button.

## The panel (v0.2)

| Fact | Value / behaviour |
| --- | --- |
| The panel is a `main` page plus a `sidebar.panellist` entry | sidebar id `recorder` matches the `main` key; both registered from the client half |
| The `main` slot does not pass a session id | the panel cannot name its session, so output root is resolved host-side and exposed as a picker |
| Output-root resolution | `workspaceRegistry` gives the registered workspaces; a live session's committed cwd (`session.header.cwd`) decides the default. `workingDirectory.defaultDirectory` is the **profile** dir here, not a workspace — do not use it |
| A live session's cwd can be the profile dir | one of the two live agents had `cwd = ~/.dsh/profiles/desktop`; preferring any live cwd would have written outside the user's projects, so only registered workspace paths are accepted |
| Panel-triggered runs race the click | the button's `POST /run` reaches the Host while the click step's own job is still pending; `drive()` now waits up to 5 s for the previous job to report |
| Step progress | the page posts `/recorder/api/progress` after each step; `publicState.progress` feeds both the panel's status line and nothing else (purely cosmetic if missed) |
| The result survives a panel unmount | a run usually opens another plugin's panel, unmounting the recorder page; on return it shows the newest recording from `GET /recordings` |
| Assets are served by the Host | `GET /recorder/api/asset?path=…` only serves files under a recordings root, so the panel can show GIFs and probe frames without exposing the filesystem |
| Cropping by page insets | the panel sends `left,top,right,bottom,scale` in CSS pixels plus `devicePixelRatio`; the Python helper maps them through `GetClientRect`/`ClientToScreen` and crops every frame. No DPI guesswork, and the insets are stable across maximizing |
| The REC pill moved into the content | it used to sit above the content box (outside a `功能区` crop) but that strip is the window-drag region, so its stop was unclickable. It now sits just below the title bar and is recorded with the panel — a deliberate trade of a clean frame for a working stop |
| Foreground can be stolen mid-recording | WorkBuddy came to the front during a test run and the probe showed that app; the loop now samples `GetForegroundWindow` each second and the result carries a warning when focus was lost |
| A rehearsal is worth more than a static check | `POST /recorder/api/rehearse` runs the same steps through `drive()` without recording; it catches a selector that only exists after the panel switch, which `querySelector` at time zero cannot see |
| The prompt is the portable form of the spec | `docs/script-spec.md` is the versioned grammar; the panel's copy button emits the same content embedded in a self-contained prompt, so an agent in another repository needs no access to this one |
| **Panel actions must not depend on poll timers** | the first panel build queued 排练/录制 as a `/poll` job. With the Harness window in the background Chromium throttles the page's timers, so the job sat in the queue (or `waitForClient` timed out) and the button showed 排练中… with nothing happening. `health.clientConnected` was `false` while the window was backgrounded, then `true` again after an external `/poll` — a throttled/transient client, not a crashed one. The panel now runs the steps directly (`POST /start` → local `runSteps` → `POST /stop`); only the agent tools still use the job bridge |
| The pill's stop must reach the local driver | a panel run executes `runSteps` in the module, outside React; the overlay's stop button sets `control.stopRequested` so a manual stop ends the walk between steps instead of letting it run to the end |
| **A background window freezes the walk, including stop** | the steps await `setTimeout`; when the window is not foreground/visible Chromium throttles those timers, so a rehearsal appears to do nothing and a stop flag is not observed until a timer fires. Evidence: a stalled rehearsal ended immediately once the window was brought forward. The rehearsal now calls `POST /focus` (py `--focus`: minimize+restore) before running, and the stop signal is written both to a shared control object and to `document.documentElement.dataset`, so a run started by an earlier module instance can also be stopped. Keep the Harness window visible for the whole walk |
| `ctx.get('layout')` can be null at apply time | after an app restart the client applied before the layout service was up, so `openPanel` threw "the page does not expose ctx.layout.selectPanel". Declaring `layout` in the client `inject` list and resolving it lazily (`runtime.ctx.get('layout')`) fixes ordering and timing |
| Rehearsal needs a stop surface of its own | the panel's stop used to be disabled unless a recording was running, and the panel is often unmounted by the script itself. There is now a floating rehearsal pill (step counter + stop) independent of the panel, plus the panel's stop enabled while rehearsing |
| **The top strip is a window-drag region** | the floating pill sat inside the app's custom title bar, where mouse input is treated as a window drag: a real click on 停止 never reached the button (verified with a real `mouse_event` click at the button's pixel position). The pill was moved **below the title bar** (`top: 46px`); a real click at the button now stops the recording. `-webkit-app-region: no-drag` alone was not enough in that strip |
| Escape is not a dependable stop | the app consumes Escape somewhere before a document-level listener (a real key press with the window foreground did not stop the recording). The listener is left as a best-effort fallback, but the pill button and the panel's 停止 are the controls to rely on |
| A stop that takes 15 s looks like a dead button | splicing a 26 s / 211-frame recording into a GIF takes a while; the pill used to stay on screen with the clock during assembly. It now disappears the moment 停止 is pressed and a toast says the GIF is being built |
| Click feedback is an in-page overlay | the pointer, motion breadcrumbs, double ring and element outline are DOM elements, so they are captured with the page and need no post-processing. The theme's brand colour is near-black here, so the effects use a fixed blue (`#4d6bfe`) instead of `--dsw-alias-brand-primary` or they would vanish into text and borders; the overlay's element outline is what makes a small click still readable at 900 px |
| **A 1000 px GIF is blurry on a 125% display** | the panel preview is ~978 CSS px = ~1222 device px, so a 1000 px GIF is upscaled 1.22x before it reaches the screen; the GIF was also encoded below the crop's physical width (1470). The width now defaults to `(innerWidth - sidebar) * devicePixelRatio` (1470 here, capped at 1600), and the encoder palette went from 128 to 256 colours. Old 1000 px recordings stay soft; re-record to get the sharper ones |
| Settings used the wrong surface token | the popover had `--dsw-alias-bg-overlay`, a blue-grey floating surface, while the page is `--dsw-alias-bg-base`; it now uses `bg-base` and matches the page |
| The GIF's aspect is the panel's, not the window's | `功能区` crops to `.dshr-page` (1544×970 for a 1920×1020 window), so the image is proportional but not the same aspect as the window; `整个窗口` keeps the window aspect. A fit-to-screen view of a whole page always shows text smaller than the live UI — the lightbox opens at **100% = one GIF pixel per device pixel** (width = naturalWidth / devicePixelRatio) so the text matches the recorded physical size; `适应屏幕` upscales to the viewport |
| **OneDrive makes `rmSync` fail EPERM** | recordings under OneDrive inherit `FILE_ATTRIBUTE_READONLY` + a reparse point on directories; Node's `rmSync` cannot clear the attribute and fails `EPERM` on the directory itself (PowerShell's `Remove-Item` clears it and succeeds). The delete route now walks the tree and `chmod`s it (0o777 dirs, 0o666 files) before `rmSync`, with retries for transient handles. Verified by deleting a test clip from 历史 while the user's other recordings stayed |

## Window geometry

| Fact | Value / behaviour |
| --- | --- |
| The app window must fill the current screen | `--fill-screen` moves the window to the **cursor's** monitor (its work area) and maximizes it (Win32 `MonitorFromPoint` + `SetWindowPos` + `SW_MAXIMIZE`); the Host calls it shortly after activation when `maximizeOnStart` is true, and the panel exposes 铺满屏幕 |
| **Focus must not change the window's size** | `activate()` called `ShowWindow(SW_RESTORE)` unconditionally. On Windows that returns a **maximized** window to its normal size and remembered position — so starting a rehearsal (which calls `POST /focus`) un-maximized and moved a perfectly fullscreen app. It now restores only when minimized, and the minimize-then-foreground fallback re-maximizes if the window was maximized. Verified: after `/focus` and after a whole rehearsal, `IsZoomed` stays true and the rect is unchanged |
| "Fill the screen" is not the same as "no scaling" | window geometry is ours; the UI scale follows the monitor's DPI (the primary here is 120 DPI = 125%, the secondary 96 DPI = 100%). A page plugin cannot change the process's DPI mode — that needs the monitor set to 100%, or the app launched with Chromium's `--force-device-scale-factor=1` |



