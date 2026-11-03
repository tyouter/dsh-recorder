/**
 * The capture half: pixels in, frames out.
 *
 * Two backends, tried in order:
 *
 *   electron  the app's own `webContents.capturePage()` — exact page pixels, no occlusion and no
 *             focus fight. This is the one that makes a demo look like the product: same DOM, same
 *             animations, no window chrome.
 *   screen    a screen grab of the window rectangle through the Python helper. Used when the plugin
 *             Host is not inside the Electron main process.
 *
 * Both write `frames/fNNN.png` and finish through the same GIF assembly step, so a recording has one
 * shape regardless of which backend produced it.
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { runPython, SCRIPT } from './python.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value) => Math.round(value * 100) / 100

/** Electron's main-process module, or null outside it. */
export function electronApi() {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('electron')
    if (mod !== null && typeof mod === 'object' && typeof mod.BrowserWindow === 'function') return mod
  } catch {
    /* not running inside Electron: the screen backend takes over */
  }
  return null
}

export function captureAvailability() {
  const electron = electronApi()
  if (electron === null) return { backend: 'screen', electron: null }
  const windows = electron.BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  return { backend: windows.length > 0 ? 'electron' : 'screen', electron: process.versions.electron ?? 'unknown', windows: windows.length }
}

function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

function pickWindow(BrowserWindow, origin) {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.webContents !== undefined)
  const matching = origin === undefined || origin === '' ? windows : windows.filter((win) => String(win.webContents.getURL() ?? '').startsWith(origin))
  const pool = matching.length > 0 ? matching : windows
  if (pool.length === 0) return null
  // The application window, not a devtools or helper window: the biggest visible one.
  return [...pool].sort((a, b) => {
    const area = (win) => {
      const bounds = win.getBounds()
      return bounds.width * bounds.height
    }
    return area(b) - area(a)
  })[0]
}

export class Capture {
  constructor({ dir, title, rect, fps, width, maxSeconds, python, origin, inset, logger } = {}) {
    this.dir = dir
    this.title = title ?? 'DeepSeek Harness'
    this.rect = rect ?? null
    this.fps = Math.max(0.5, Math.min(Number(fps) || 6, 30))
    this.width = Math.max(240, Math.min(Number(width) || 900, 2400))
    this.maxSeconds = Math.max(5, Math.min(Number(maxSeconds) || 300, 1800))
    this.python = python
    this.origin = origin
    this.inset = Array.isArray(inset) && inset.length === 5 && inset.every((value) => Number.isFinite(Number(value))) ? inset.map(Number) : null
    this.logger = logger
    this.backend = null
    this.window = null
    this.times = []
    this.errors = []
    this.proc = null
    this.exit = null
    this.loop = null
    this.running = false
    this.stopFile = join(dir, 'STOP')
    this.probe = join(dir, 'probe.png')
  }

  framesDir() {
    return join(this.dir, 'frames')
  }

  async start() {
    mkdirSync(this.framesDir(), { recursive: true })
    // A rect is in screen coordinates, which only the screen backend understands.
    const electron = this.rect === null ? electronApi() : null
    if (electron !== null) {
      try {
        const result = await this.startElectron(electron)
        this.backend = 'electron'
        return result
      } catch (error) {
        this.logger?.warn?.(`[recorder] electron capture unavailable (${error?.message ?? error}); falling back to a screen grab`)
        this.running = false
        this.window = null
      }
    }
    const result = await this.startScreen()
    this.backend = 'screen'
    return result
  }

  async startElectron(electron) {
    const win = pickWindow(electron.BrowserWindow, this.origin)
    if (win === null) throw new Error('no Electron window is open')
    try {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (typeof win.moveTop === 'function') win.moveTop()
    } catch (error) {
      this.logger?.warn?.(`[recorder] could not focus the window: ${error?.message ?? error}`)
    }
    await sleep(250)
    const bounds = win.getBounds()
    const size = win.getContentSize()
    const [contentWidth, contentHeight] = size
    this.electronRect =
      this.inset === null
        ? undefined
        : {
            x: Math.max(0, Math.round(this.inset[0])),
            y: Math.max(0, Math.round(this.inset[1])),
            width: Math.max(40, Math.round(contentWidth - this.inset[0] - this.inset[2])),
            height: Math.max(40, Math.round(contentHeight - this.inset[1] - this.inset[3])),
          }
    const image = await win.webContents.capturePage(this.electronRect)
    if (image === null || image === undefined || image.isEmpty()) throw new Error('capturePage returned an empty image')
    writeFileSync(this.probe, image.toPNG())
    this.window = { title: win.getTitle(), bounds, content: size }
    writeJson(join(this.dir, 'session.json'), {
      startedAt: new Date().toISOString(),
      backend: 'electron',
      target: { title: win.getTitle(), rect: [bounds.x, bounds.y, bounds.width, bounds.height], content: size },
      fps: this.fps,
      width: this.width,
      probe: this.probe,
    })
    this.running = true
    this.startedAt = Date.now()
    this.times = []
    this.loop = this.electronLoop(win)
    return {
      backend: 'electron',
      target: { title: win.getTitle(), rect: [bounds.x, bounds.y, bounds.width, bounds.height], content: size },
      probe: this.probe,
      focused: typeof win.isFocused === 'function' ? win.isFocused() : null,
    }
  }

  async electronLoop(win) {
    const interval = 1000 / this.fps
    let index = 0
    while (this.running) {
      const started = Date.now()
      try {
        const image = await win.webContents.capturePage(this.electronRect)
        if (image !== null && image !== undefined && !image.isEmpty()) {
          writeFileSync(join(this.framesDir(), `f${String(index).padStart(3, '0')}.png`), image.toPNG())
          this.times.push(round((Date.now() - this.startedAt) / 1000))
          index += 1
        }
      } catch (error) {
        this.errors.push(String(error?.message ?? error))
      }
      const elapsed = Date.now() - this.startedAt
      if (elapsed > this.maxSeconds * 1000) break
      const wait = interval - (Date.now() - started)
      if (wait > 0) await sleep(wait)
    }
    this.running = false
  }

  async startScreen() {
    const args = [
      '--title', this.title,
      '--fps', String(this.fps),
      '--width', String(this.width),
      '--max-seconds', String(this.maxSeconds),
      '--stop-file', this.stopFile,
      '--out-dir', this.dir,
      '--probe', this.probe,
      '--start-delay', '0.25',
    ]
    if (this.rect !== null) args.push('--rect', this.rect.join(','))
    else args.push('--activate')
    if (this.inset !== null) args.push('--inset', this.inset.join(','))
    let child
    try {
      child = spawn(this.python, [SCRIPT, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw new Error(`could not start the screen recorder: ${error?.message ?? error}`)
    }
    this.proc = child
    let stderr = ''
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 32_000) stdout = stdout.slice(-16_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 32_000) stderr = stderr.slice(-16_000)
    })
    this.exit = new Promise((resolve) => child.once('exit', (code) => resolve(code ?? -1)))
    child.once('error', (error) => {
      this.exit = Promise.resolve(-1)
      stderr += `\n${error?.message ?? error}`
    })

    const sessionPath = join(this.dir, 'session.json')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (existsSync(sessionPath)) {
        const session = readJson(sessionPath, {})
        this.window = session?.target ?? null
        return {
          backend: 'screen',
          target: session?.target ?? { title: this.title },
          probe: session?.probe ?? this.probe,
          focused: session?.focused ?? null,
        }
      }
      const exited = await Promise.race([this.exit.then(() => true), sleep(120).then(() => false)])
      if (exited) break
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    throw new Error(`the screen recorder did not start\n${(stderr || stdout).slice(-1200)}`)
  }

  async stop({ stills = [] } = {}) {
    if (this.backend === 'electron') return await this.stopElectron(stills)
    return await this.stopScreen(stills)
  }

  async stopElectron(stills) {
    this.running = false
    try {
      await Promise.race([this.loop, sleep(4000)])
    } catch {
      /* the loop reports its own errors */
    }
    if (this.times.length === 0) throw new Error('no frames were captured')
    writeJson(join(this.dir, 'times.json'), this.times)
    const assembly = await runPython(
      this.python,
      ['--assemble-only', '--out-dir', this.dir, '--fps', String(this.fps), '--width', String(this.width)],
      { timeoutMs: 180_000 },
    )
    if (assembly.code !== 0) {
      throw new Error(`GIF assembly failed\n${(assembly.stderr || assembly.stdout).slice(-1500)}`)
    }
    return this.finish(stills)
  }

  async stopScreen(stills) {
    if (this.proc === null || this.exit === null) throw new Error('no screen recording is running')
    try {
      writeFileSync(this.stopFile, 'stop', 'utf8')
    } catch (error) {
      throw new Error(`could not signal the recorder to stop: ${error?.message ?? error}`)
    }
    const code = await Promise.race([
      this.exit,
      sleep(120_000).then(() => {
        try {
          this.proc?.kill()
        } catch {
          /* already gone */
        }
        throw new Error('the screen recorder did not stop within 120 s')
      }),
    ])
    const meta = readJson(join(this.dir, 'meta.json'), null)
    if (meta === null) {
      throw new Error(`the screen recorder exited with code ${code} without producing a recording`)
    }
    return this.finish(stills)
  }

  /** Read the assembled recording, export the requested stills, and return one flat result. */
  finish(stills) {
    const meta = readJson(join(this.dir, 'meta.json'), {})
    const framesDir = this.framesDir()
    const frames = readdirSync(framesDir)
      .filter((name) => /^f\d+\.png$/.test(name))
      .sort()
    if (frames.length === 0) throw new Error('no frames were captured')
    const times = Array.isArray(meta?.times) && meta.times.length === frames.length ? meta.times : frames.map((_, index) => round(index / this.fps))
    const exported = []
    if (Array.isArray(stills) && stills.length > 0) {
      const stillsDir = join(this.dir, 'stills')
      mkdirSync(stillsDir, { recursive: true })
      for (const raw of stills.slice(0, 12)) {
        const at = Math.max(0, Number(raw) || 0)
        let best = 0
        let distance = Infinity
        for (let index = 0; index < times.length; index += 1) {
          const current = Math.abs(Number(times[index]) - at)
          if (current < distance) {
            distance = current
            best = index
          }
        }
        const path = join(stillsDir, `still-${at.toFixed(1)}s.png`)
        copyFileSync(join(framesDir, frames[best]), path)
        exported.push({ at, path, frameAt: times[best] })
      }
    }
    let bytes = 0
    try {
      bytes = statSync(meta.gif).size
    } catch {
      bytes = 0
    }
    const warning =
      meta?.focusedLost === true
        ? 'the window lost the foreground during the recording; some frames may show another app'
        : undefined
    return {
      backend: this.backend,
      gif: meta.gif ?? join(this.dir, 'recording.gif'),
      frames: meta.frames ?? frames.length,
      seconds: meta.seconds ?? (times.length > 0 ? times[times.length - 1] : 0),
      fps: this.fps,
      width: meta.gifWidth ?? this.width,
      bytes,
      target: meta.target ?? this.window,
      probe: meta.probe ?? this.probe,
      framesDir,
      outDir: this.dir,
      stills: exported,
      ...(warning === undefined ? {} : { warning }),
    }
  }

  /** Best-effort teardown when the plugin unloads mid-recording. */
  async dispose() {
    this.running = false
    if (this.backend === 'screen') {
      try {
        writeFileSync(this.stopFile, 'stop', 'utf8')
      } catch {
        /* the directory may be gone */
      }
    }
    try {
      await Promise.race([this.exit ?? Promise.resolve(), sleep(2500)])
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
  }
}

/** Create the frames directory cleanly: a stale frame would otherwise leak into a new GIF. */
export function prepareSessionDir(outDir) {
  mkdirSync(outDir, { recursive: true })
  const framesDir = join(outDir, 'frames')
  mkdirSync(framesDir, { recursive: true })
  for (const name of readdirSync(framesDir)) {
    if (/^f\d+\.png$/.test(name)) {
      try {
        unlinkSync(join(framesDir, name))
      } catch {
        /* a locked frame is not worth failing the recording */
      }
    }
  }
  return outDir
}
