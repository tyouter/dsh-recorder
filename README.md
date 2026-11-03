# dsh-recorder

Aiming to record a DSH plugin's **real** interface — pixels of the running app, not a re-render — and turn
that into a GIF / stills suitable for a README or a market page.

**Status: prototype.** Nothing here is a plugin yet. Two working pieces were extracted from the
`dsh-notes` repo after a long attempt to film that plugin; they are kept because both were proven, and
the handoff explains what is still missing.

```
src/demo-driver.js     scripted walk through a plugin's real UI (works: it typed, completed,
                       structured, applied, translated, saved, edited, copied, and ended on the Board)
tools/record-window.py window recorder (works: finds a window by title or a rect, grabs frames with
                       Pillow, assembles a GIF)
docs/findings.md       what was measured about this machine and this app while trying
HANDOFF.md             what to build, what to avoid, and where the seams are
```

## Quick start

```powershell
$py = "C:\Users\dwwekfd\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

# what can be recorded
& $py tools/record-window.py --list

# record 60 s of the app window
& $py tools/record-window.py --title "DeepSeek Harness" --seconds 60 --fps 8
```

Frames go to `exports/recording/frames`, the GIF to `exports/recording/recording.gif`.

## The two halves, and why they are separate

- **Driving** the UI (so the footage shows interactions, not a static page) has to happen *inside* the
  page that owns the UI — that means code inside the plugin under test (a dev flag) or a debugger
  attached to its renderer.
- **Capturing** the pixels can happen from outside, by anyone with a screen and Pillow. It knows
  nothing about DSH.

Keeping them apart is the point of this folder: the capture half is reusable for any plugin; the driver
half is a per-plugin script.

See [HANDOFF.md](HANDOFF.md) before writing the plugin.
