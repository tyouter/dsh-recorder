/**
 * The recorder's host-side session: one recording at a time, one page operation at a time.
 *
 * The browser half polls `/recorder/api/poll`; this engine hands it a job (steps to perform, or a DOM
 * scan) and waits for the matching report. That is the whole bridge: no debug port, no injected
 * script, no change to the plugin being filmed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Capture, captureAvailability, prepareSessionDir } from './capture.js'
import { recorderEvents, resolvePython, runPython } from './python.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const STAMP = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export class RecorderEngine {
  constructor({ ctx, config, logger } = {}) {
    this.ctx = ctx
    this.config = config ?? {}
    this.logger = logger
    this.python = resolvePython(this.config.pythonPath)
    this.active = null
    this.stopping = null
    this.last = null
    this.lastRoot = null
    this.progress = null
    this.job = null
    this.jobSeq = 0
    this.waiters = new Map()
    this.client = { attachedAt: null, lastPollAt: null, userAgent: null }
    this.disposed = false
  }

  /** Where recordings go: the session's workspace when one is known, else the deployment default. */
  defaultRoot(agent) {
    const configured = typeof this.config.outDir === 'string' ? this.config.outDir.trim() : ''
    if (configured !== '') return resolve(configured)
    try {
      const sessions = this.ctx?.get?.('sessions')
      const workingDirectory = this.ctx?.get?.('workingDirectory')
      const session = agent?.id === undefined ? undefined : sessions?.get?.(agent.id)
      const cwd = session === undefined ? undefined : workingDirectory?.get?.(session)
      if (typeof cwd === 'string' && cwd !== '') return join(cwd, 'recordings')
      const fallback = workingDirectory?.defaultDirectory
      if (typeof fallback === 'string' && fallback !== '') return join(fallback, 'recordings')
    } catch {
      /* fall through to the process directory */
    }
    return join(process.cwd(), 'recordings')
  }

  /** The directory the panel reads from: the last recording's root, else the default. */
  rootFor() {
    return this.lastRoot ?? this.defaultRoot()
  }

  /** A live Session's workspace, through the working-directory service. */
  async workspaceOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const sessions = this.ctx?.get?.('sessions')
    const session = sessions?.get?.(sessionId)
    // The Session header carries the committed cwd; it is the one value that does not need I/O.
    const fromHeader = session?.header?.cwd
    if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
    const workingDirectory = this.ctx?.get?.('workingDirectory')
    const agents = this.ctx?.get?.('agents')
    const agent = agents?.get?.(sessionId)
    if (agent !== undefined && typeof workingDirectory?.ensure === 'function') {
      try {
        const cwd = await workingDirectory.ensure(agent)
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        /* fall through to the committed directory */
      }
    }
    if (session !== undefined && typeof workingDirectory?.get === 'function') {
      try {
        const cwd = workingDirectory.get(session)
        if (typeof cwd === 'string' && cwd !== '') return cwd
      } catch {
        /* no committed directory */
      }
    }
    return undefined
  }

  /** Registered workspaces for the panel's output picker; the default is where recordings already are. */
  listWorkspaces() {
    try {
      const registry = this.ctx?.get?.('workspaceRegistry')
      const list = typeof registry?.list === 'function' ? registry.list() : []
      const workspaces = list
        .filter((item) => typeof item?.path === 'string' && item.path !== '')
        .map((item) => ({
          title: typeof item.title === 'string' && item.title !== '' ? item.title : item.path,
          path: item.path,
          sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
        }))
      // A live session's committed cwd is the best hint for "the workspace the user is in".
      const live = new Set()
      try {
        const sessions = this.ctx?.get?.('sessions')
        const agents = this.ctx?.get?.('agents')
        for (const agent of typeof agents?.list === 'function' ? agents.list() : []) {
          const cwd = sessions?.get?.(agent?.id)?.header?.cwd
          if (typeof cwd === 'string' && cwd !== '') live.add(cwd)
        }
      } catch {
        /* no live sessions */
      }
      const preferred =
        (this.lastRoot === null ? undefined : workspaces.find((item) => this.lastRoot.startsWith(item.path))) ??
        workspaces.find((item) => live.has(item.path))
      const fallback = preferred ?? [...workspaces].sort((a, b) => b.sessions - a.sessions)[0]
      return { workspaces, default: fallback?.path ?? '' }
    } catch {
      return { workspaces: [], default: '' }
    }
  }

  /** A workspace the panel asked for, restricted to registered ones; undefined when unknown. */
  workspaceRoot(workspace) {
    if (typeof workspace !== 'string' || workspace === '') return undefined
    const { workspaces } = this.listWorkspaces()
    const match = workspaces.find((item) => item.path === workspace)
    return match === undefined ? undefined : join(match.path, 'recordings')
  }

  /** Every root an asset may come from: the last recording plus each registered workspace. */
  allowedRoots() {
    const roots = []
    if (this.lastRoot !== null) roots.push(this.lastRoot)
    for (const item of this.listWorkspaces().workspaces) roots.push(join(item.path, 'recordings'))
    return roots
  }

  /** The panel has no session id of its own: borrow a live session's workspace. */
  async rootForRequest(sessionId) {
    if ((typeof sessionId !== 'string' || sessionId === '') && this.lastRoot !== null) return this.lastRoot
    const explicit = await this.workspaceOf(sessionId)
    if (explicit !== undefined) return join(explicit, 'recordings')
    // Prefer a live session whose cwd is an actual registered workspace; a session opened outside
    // one (cwd = profile dir) would otherwise win and write outside the user's projects.
    try {
      const agents = this.ctx?.get?.('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      const registered = new Set(this.listWorkspaces().workspaces.map((item) => item.path))
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const cwd = await this.workspaceOf(list[index]?.id)
        if (cwd !== undefined && registered.has(cwd)) return join(cwd, 'recordings')
      }
    } catch {
      /* fall through */
    }
    return this.rootFor()
  }

  /** Recent recordings, newest first — what the panel lists under the script. */
  listRecordings(limit = 8, root = this.rootFor()) {
    const recordings = []
    try {
      const names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('rec-'))
        .map((entry) => entry.name)
        .sort()
        .reverse()
      for (const name of names.slice(0, Math.max(1, Math.min(Number(limit) || 8, 30)))) {
        const dir = join(root, name)
        const meta = readJsonFile(join(dir, 'meta.json'), null)
        const gif = join(dir, 'recording.gif')
        if (!existsSync(gif)) continue
        let stat
        try {
          stat = statSync(gif)
        } catch {
          continue
        }
        const probe = join(dir, 'probe.png')
        recordings.push({
          name,
          gif,
          probe: existsSync(probe) ? probe : null,
          seconds: meta?.seconds ?? null,
          frames: meta?.frames ?? null,
          bytes: stat.size,
          mtime: stat.mtimeMs,
        })
      }
    } catch {
      /* an empty or missing root is simply an empty list */
    }
    return { root, recordings }
  }

  setProgress(progress) {
    const index = Number(progress?.index) || 0
    const total = Number(progress?.total) || 0
    this.progress = {
      index: Math.max(0, Math.min(index, 999)),
      total: Math.max(0, Math.min(total, 999)),
      op: typeof progress?.op === 'string' ? progress.op.slice(0, 40) : '',
      ok: progress?.ok === true,
      at: Date.now(),
    }
    return this.progress
  }

  origin() {
    try {
      return this.ctx?.get?.('webServer')?.getOrigin?.() ?? ''
    } catch {
      return ''
    }
  }

  /** Move the app window to the cursor's monitor and maximize it (fills the screen at 1:1). */
  async fillScreen(title = 'DeepSeek Harness') {
    const result = await runPython(this.python, ['--title', title, '--fill-screen'], { timeoutMs: 20_000 })
    const events = recorderEvents(result.stdout)
    return {
      ok: result.code === 0,
      event: events.length > 0 ? events[events.length - 1] : null,
    }
  }

  async start(options = {}, agent) {
    if (this.disposed) throw new Error('recorder plugin is shutting down')
    if (this.active !== null) throw new Error('a recording is already running — call recorder_stop first')
    const fps = Math.max(0.5, Math.min(Number(options.fps) || 6, 30))
    const width = Math.max(240, Math.min(Number(options.width) || 900, 2400))
    const maxSeconds = Math.max(5, Math.min(Number(options.maxSeconds) || 300, 1800))
    const root = typeof options.outDir === 'string' && options.outDir.trim() !== '' ? resolve(options.outDir) : this.defaultRoot(agent)
    this.lastRoot = root
    this.progress = null
    const dir = prepareSessionDir(join(root, `rec-${STAMP()}`))
    mkdirSync(dir, { recursive: true })
    const rect = Array.isArray(options.rect) && options.rect.length === 4 ? options.rect.map((value) => Number(value) || 0) : null
    if (options.target === 'rect' && rect === null) throw new Error('target=rect needs rect: [left, top, width, height] from recorder_windows')
    const capture = new Capture({
      dir,
      title: typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : 'DeepSeek Harness',
      rect,
      fps,
      width,
      maxSeconds,
      python: this.python,
      origin: this.origin(),
      inset: Array.isArray(options.inset) ? options.inset : null,
      logger: this.logger,
    })
    this.active = { capture, startedAt: Date.now(), dir, fps, width, target: options.target === 'rect' ? 'rect' : 'window', title: capture.title }
    let started
    try {
      started = await capture.start()
    } catch (error) {
      this.active = null
      throw error
    }
    this.active.startedAt = Date.now()
    const state = this.publicState()
    const result = {
      ...state,
      probe: started.probe,
      target: started.target,
      backend: started.backend,
      focused: started.focused,
    }
    // Omitting the key entirely matters: a tool result must be lossless JSON.
    if (started.backend === 'screen' && started.focused === false) {
      result.note =
        'The window is not in the foreground; a screen grab records whatever covers its rectangle. Look at `probe` before trusting this recording.'
    }
    return result
  }

  publicState() {
    if (this.active === null) return { recording: false, last: this.last === null ? null : { gif: this.last.gif, seconds: this.last.seconds, frames: this.last.frames } }
    const active = this.active
    return {
      recording: true,
      id: `rec-${active.startedAt}`,
      startedAt: active.startedAt,
      elapsedMs: Date.now() - active.startedAt,
      fps: active.fps,
      width: active.width,
      target: active.target,
      title: active.capture.window?.title ?? active.title,
      outDir: active.dir,
      gif: join(active.dir, 'recording.gif'),
      backend: active.capture.backend,
      progress: this.progress,
      clientConnected: Date.now() - (this.client.lastPollAt ?? 0) < 4000,
    }
  }

  async stop(options = {}) {
    if (this.stopping !== null) return await this.stopping
    if (this.active === null) {
      if (this.last !== null) return { ...this.last, note: 'no recording was running; returning the last one' }
      throw new Error('no recording is running')
    }
    const active = this.active
    this.stopping = (async () => {
      const stills = Array.isArray(options.stills) ? options.stills.slice(0, 12) : []
      const result = await active.capture.stop({ stills })
      this.last = result
      return result
    })()
    try {
      return await this.stopping
    } finally {
      this.stopping = null
      this.active = null
      this.progress = null
    }
  }

  /** Hand the next operation to the page and wait for its report. */
  async drive(steps, options = {}) {
    const list = Array.isArray(steps) ? steps.filter((step) => step !== null && typeof step === 'object').slice(0, 80) : []
    if (list.length === 0) throw new Error('no steps to run')
    await this.waitForClient(options.waitClientMs ?? 8000)
    // A UI-triggered run can race the click that started it: let the previous job report first.
    const free = Date.now() + 5000
    while (this.job !== null && Date.now() < free) await sleep(100)
    const id = this.queueJob({ kind: 'steps', steps: list, strict: options.strict === true, settleMs: Math.max(0, Number(options.settleMs) || 0) })
    try {
      return await this.waitReport(id, Math.max(1000, Math.min(Number(options.timeoutMs) || 120_000, 900_000)))
    } catch (error) {
      this.job = null
      throw error
    }
  }

  async scan(options = {}) {
    await this.waitForClient(options.waitClientMs ?? 8000)
    const id = this.queueJob({ kind: 'scan', selector: typeof options.selector === 'string' ? options.selector : '', max: Math.max(1, Math.min(Number(options.max) || 60, 120)) })
    try {
      return await this.waitReport(id, 15_000)
    } catch (error) {
      this.job = null
      throw error
    }
  }

  /** Start, drive, settle, stop — one call for "make me a demo of this plugin". */
  async demo(options = {}, agent) {
    const started = await this.start(options, agent)
    this.progress = { index: 0, total: Array.isArray(options.steps) ? options.steps.length : 0, op: '', ok: true, at: Date.now() }
    let driven = null
    let stopError = null
    try {
      if (Array.isArray(options.steps) && options.steps.length > 0) {
        driven = await this.drive(options.steps, options)
      }
      const settleMs = Math.max(0, Math.min(Number(options.settleMs ?? 1200), 30_000))
      if (settleMs > 0) await sleep(settleMs)
    } catch (error) {
      driven = { ok: false, error: String(error?.message ?? error) }
    }
    let result = null
    try {
      result = await this.stop({ stills: options.stills })
    } catch (error) {
      stopError = String(error?.message ?? error)
    }
    if (result === null) throw new Error(`the walk failed (${driven?.error ?? 'unknown'}) and the recording could not be finished: ${stopError}`)
    return { ...result, started: { backend: started.backend, target: started.target, probe: started.probe, focused: started.focused }, walk: driven }
  }

  // ---------------------------------------------------------------- jobs ---

  queueJob(job) {
    if (this.job !== null && this.job.deliveredAt == null) throw new Error('the page is still running the previous operation')
    this.jobSeq += 1
    this.job = { ...job, id: `job-${this.jobSeq}`, queuedAt: Date.now(), deliveredAt: null }
    return this.job.id
  }

  /** The poll route's half: register the page and hand out one job exactly once. */
  takeJob(userAgent) {
    this.client.lastPollAt = Date.now()
    if (this.client.attachedAt === null) this.client.attachedAt = this.client.lastPollAt
    if (typeof userAgent === 'string' && userAgent !== '') this.client.userAgent = userAgent.slice(0, 200)
    if (this.job === null || this.job.deliveredAt != null) return null
    this.job.deliveredAt = Date.now()
    return { id: this.job.id, kind: this.job.kind, steps: this.job.steps, strict: this.job.strict, settleMs: this.job.settleMs, selector: this.job.selector, max: this.job.max }
  }

  submitReport(report) {
    if (report === null || typeof report !== 'object') throw new Error('report must be an object')
    const id = typeof report.id === 'string' ? report.id : ''
    if (id === '' || this.job === null || this.job.id !== id) return { accepted: false }
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    if (waiter !== undefined) waiter(report)
    this.job = null
    return { accepted: true }
  }

  waitReport(id, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.waiters.delete(id)
        reject(new Error(`the page did not report back within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.waiters.set(id, (report) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(report)
      })
    })
  }

  async waitForClient(timeoutMs) {
    const by = Date.now() + timeoutMs
    while (Date.now() < by) {
      if (Date.now() - (this.client.lastPollAt ?? 0) < 4000) return
      if (this.disposed) throw new Error('recorder plugin is shutting down')
      await sleep(150)
    }
    throw new Error(
      'the recorder client is not connected: open the Harness window (and reload it once if the recorder was just installed), then retry',
    )
  }

  async dispose() {
    this.disposed = true
    try {
      await this.active?.capture?.dispose()
    } catch {
      /* shutting down anyway */
    }
    this.active = null
    for (const [id, waiter] of this.waiters) {
      waiter({ id, ok: false, error: 'recorder plugin unloaded' })
    }
    this.waiters.clear()
  }

  health() {
    return {
      python: this.python,
      capture: captureAvailability(),
      recording: this.active !== null,
      clientConnected: Date.now() - (this.client.lastPollAt ?? 0) < 4000,
      defaultRoot: this.defaultRoot(),
      lastRoot: this.lastRoot,
      root: this.rootFor(),
    }
  }
}
