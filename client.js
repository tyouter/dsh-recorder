/**
 * Browser half of @tyouter/dsh-recorder.
 *
 * This half lives in the same page as the plugin being filmed, so it can operate that plugin's real
 * DOM — type with real input events, click with real mouse events, set a text selection, switch
 * panels. Nothing is re-rendered and the plugin under test is not modified.
 *
 * Two jobs:
 *   1. poll the Host at /recorder/api and run the steps it hands out;
 *   2. paint the parts a person needs while being recorded: a REC pill with a stop control, and a
 *      visible cursor that shows where the "hand" is.
 */

window.__ModuleLoader__.load({
  id: '@tyouter/dsh-recorder',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/recorder/api'
    const POLL_MS = 450

    // ---------------------------------------------------------------- store ---

    /** The page-side snapshot the overlay renders from. */
    const store = {
      recording: null,
      rehearsal: null,
      toast: null,
      cursor: { visible: false, x: 0, y: 0, press: 0, trail: [] },
      highlight: null,
    }
    const listeners = new Set()

    function publish(patch) {
      Object.assign(store, patch)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* one broken subscriber must not stop the others */
        }
      }
    }

    let hideCursorTimer = null
    let trailSeq = 0
    const trailPoints = []
    function moveCursor(x, y) {
      if (hideCursorTimer !== null) {
        clearTimeout(hideCursorTimer)
        hideCursorTimer = null
      }
      const to = { x: Math.round(x), y: Math.round(y) }
      const from = store.cursor.visible ? { x: store.cursor.x, y: store.cursor.y } : null
      if (from !== null && Math.hypot(to.x - from.x, to.y - from.y) > 40) {
        // Breadcrumbs along the jump, so a single move still reads as movement on camera.
        for (const t of [0.35, 0.7]) {
          trailPoints.push({ id: (trailSeq += 1), x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) })
        }
      }
      trailPoints.push({ id: (trailSeq += 1), ...to })
      while (trailPoints.length > 8) trailPoints.shift()
      publish({ cursor: { ...store.cursor, visible: true, x: to.x, y: to.y, trail: trailPoints.slice() } })
    }
    function pressCursor() {
      publish({ cursor: { ...store.cursor, press: store.cursor.press + 1 } })
    }

    let highlightTimer = null
    function highlightElement(node) {
      try {
        const rect = node.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return
        publish({ highlight: { key: Date.now(), rect: [rect.left, rect.top, rect.width, rect.height] } })
        if (highlightTimer !== null) clearTimeout(highlightTimer)
        highlightTimer = setTimeout(() => {
          highlightTimer = null
          publish({ highlight: null })
        }, 760)
      } catch {
        /* a decorative outline is not worth failing a click over */
      }
    }
    function scheduleCursorHide(delay = 1400) {
      if (hideCursorTimer !== null) clearTimeout(hideCursorTimer)
      hideCursorTimer = setTimeout(() => {
        hideCursorTimer = null
        publish({ cursor: { ...store.cursor, visible: false } })
      }, delay)
    }

    let toastTimer = null
    function toast(message) {
      publish({ toast: message })
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastTimer = null
        publish({ toast: null })
      }, 7000)
    }

    // ------------------------------------------------------------- helpers ---

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return await response.json()
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
      return await response.json()
    }

    /** Clipboard with a fallback for pages where the async API is unavailable. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        /* fall through to the selection copy */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    function isVisible(node) {
      if (node === null || node === undefined || node.isConnected !== true) return false
      if (typeof node.closest === 'function' && node.closest('[data-dsh-recorder]') !== null) return false
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      const style = window.getComputedStyle(node)
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
    }

    function findElement(selector, text) {
      if (typeof selector !== 'string' || selector.trim() === '') throw new Error('this step needs a selector')
      let nodes
      try {
        nodes = [...document.querySelectorAll(selector)]
      } catch (error) {
        throw new Error(`bad selector "${selector}": ${error?.message ?? error}`)
      }
      nodes = nodes.filter(isVisible)
      if (nodes.length === 0) throw new Error(`no visible element matches ${selector}`)
      if (text === undefined || text === null || String(text).trim() === '') return nodes[0]
      const needle = norm(text)
      const label = (node) => norm(node.getAttribute?.('aria-label') ?? node.getAttribute?.('title') ?? '')
      const exact = nodes.find((node) => norm(node.textContent) === needle)
      const partial = nodes.find((node) => norm(node.textContent).includes(needle))
      const byLabel = nodes.find((node) => label(node).includes(needle))
      const found = exact ?? partial ?? byLabel ?? null
      if (found === null) {
        const seen = nodes.slice(0, 6).map((node) => norm(node.textContent).slice(0, 40) || node.tagName.toLowerCase())
        throw new Error(`no element matching ${selector} contains "${text}" (saw: ${seen.join(' | ')})`)
      }
      return found
    }

    function centerOf(node) {
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }

    function nativeSetValue(node, value) {
      const prototype = node instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : node instanceof window.HTMLInputElement
          ? window.HTMLInputElement.prototype
          : null
      if (prototype !== null) {
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter !== undefined) {
          setter.call(node, value)
          return
        }
      }
      if (node.isContentEditable === true) {
        node.textContent = value
        return
      }
      node.value = value
    }

    function inputEvent(kind) {
      return new Event(kind ?? 'input', { bubbles: true, cancelable: true })
    }

    function setValueNow(node, value) {
      nativeSetValue(node, value)
      node.dispatchEvent(inputEvent('input'))
      node.dispatchEvent(inputEvent('change'))
    }

    function focusLikeHuman(node) {
      try {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      } catch {
        /* not every node scrolls */
      }
      try {
        node.focus?.({ preventScroll: true })
      } catch {
        /* focus is optional */
      }
      const point = centerOf(node)
      moveCursor(point.x, point.y)
    }

    async function clickLikeHuman(node) {
      try {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      } catch {
        /* ignore */
      }
      const point = centerOf(node)
      moveCursor(point.x, point.y)
      await sleep(240)
      pressCursor()
      highlightElement(node)
      try {
        node.focus?.({ preventScroll: true })
      } catch {
        /* ignore */
      }
      const options = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons: 1,
        view: window,
      }
      const pointer = (type, extra) => {
        if (typeof window.PointerEvent !== 'function') return
        try {
          node.dispatchEvent(new window.PointerEvent(type, { ...options, ...extra }))
        } catch {
          /* older engines */
        }
      }
      const mouse = (type, extra) => node.dispatchEvent(new window.MouseEvent(type, { ...options, ...extra }))
      pointer('pointerdown', { pointerType: 'mouse', isPrimary: true })
      mouse('mousedown', {})
      pointer('pointerup', { pointerType: 'mouse', isPrimary: true })
      mouse('mouseup', { buttons: 0 })
      mouse('click', { buttons: 0 })
      await sleep(90)
    }

    async function typeLikeHuman(node, value, delayMs) {
      focusLikeHuman(node)
      await sleep(180)
      const text = String(value ?? '')
      const delay = Math.max(8, Math.min(Number(delayMs) || 60, 400))
      let current = typeof node.value === 'string' ? node.value : ''
      for (const character of [...text]) {
        if (isStopRequested()) throw new Error('stopped by the user')
        current += character
        nativeSetValue(node, current)
        node.dispatchEvent(inputEvent('input'))
        await sleep(delay)
      }
      scheduleCursorHide()
      return { chars: [...text].length, ms: delay }
    }

    function keyName(step) {
      const name = typeof step.key === 'string' && step.key.trim() !== '' ? step.key.trim() : 'Enter'
      return name
    }

    async function pressKey(node, step) {
      const key = keyName(step)
      const target = node ?? document.activeElement ?? document.body
      if (target === null || target === undefined) throw new Error('nothing is focused to receive the key')
      if (node !== null && node !== undefined) focusLikeHuman(node)
      const before = typeof target.value === 'string' ? target.value : null
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
      const common = { key, code, bubbles: true, cancelable: true, composed: true }
      target.dispatchEvent(new window.KeyboardEvent('keydown', common))
      target.dispatchEvent(new window.KeyboardEvent('keypress', common))
      target.dispatchEvent(new window.KeyboardEvent('keyup', common))
      // Synthetic Enter does not insert a newline, and a controlled textarea needs the change.
      if (key === 'Enter' && before !== null && target.value === before) {
        nativeSetValue(target, `${before}\n`)
        target.dispatchEvent(inputEvent('input'))
      }
      await sleep(160)
      return { key }
    }

    async function selectRange(node, step) {
      focusLikeHuman(node)
      const value = typeof node.value === 'string' ? node.value : String(node.textContent ?? '')
      let start = 0
      let end = 0
      if (typeof step.text === 'string' && step.text !== '') {
        const index = value.indexOf(step.text)
        if (index < 0) throw new Error(`text "${step.text.slice(0, 30)}" is not in the element`)
        start = index
        end = index + step.text.length
      } else {
        start = Math.max(0, Number(step.from) || 0)
        end = Math.min(value.length, Math.max(start, Number(step.to) || 0))
      }
      node.setSelectionRange(start, end)
      node.dispatchEvent(new Event('select', { bubbles: true }))
      node.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      await sleep(420)
      return { from: start, to: end, selected: value.slice(start, end).slice(0, 60) }
    }

    async function waitForElement(selector, step) {
      const timeout = Math.max(200, Math.min(Number(step.timeoutMs) || 8000, 60_000))
      const started = Date.now()
      for (;;) {
        if (isStopRequested()) throw new Error('stopped by the user')
        try {
          const node = findElement(selector, step.text)
          return { text: norm(node.textContent).slice(0, 50) }
        } catch (error) {
          if (Date.now() - started > timeout) throw error
          await sleep(90)
        }
      }
    }

    // ------------------------------------------------------------ scanning ---

    const INTERACTIVE = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="tab"]',
      '[role="button"]',
      '[role="switch"]',
      '[role="menuitem"]',
      '[role="listitem"]',
      '[contenteditable="true"]',
    ].join(',')

    const cssEscape = (value) => {
      if (typeof window.CSS?.escape === 'function') return window.CSS.escape(value)
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
    }

    function uniqueSelector(selector) {
      try {
        return document.querySelectorAll(selector).length === 1
      } catch {
        return false
      }
    }

    function selectorOf(node, depth = 0) {
      if (node === null || node === undefined || node.nodeType !== 1) return ''
      if (node.id) {
        const candidate = `#${cssEscape(node.id)}`
        if (uniqueSelector(candidate)) return candidate
      }
      const classes = [...node.classList].slice(0, 2).map((name) => `.${cssEscape(name)}`).join('')
      const base = `${node.tagName.toLowerCase()}${classes}`
      if (classes !== '' && uniqueSelector(base)) return base
      const parent = node.parentElement
      const sameTag = parent === null ? [node] : [...parent.children].filter((child) => child.tagName === node.tagName)
      const index = Math.max(1, sameTag.indexOf(node) + 1)
      const withIndex = `${base}:nth-of-type(${index})`
      if (uniqueSelector(withIndex)) return withIndex
      if (depth >= 2 || parent === null || parent === document.body) return withIndex
      const prefix = selectorOf(parent, depth + 1)
      return prefix === '' ? withIndex : `${prefix} > ${withIndex}`
    }

    function describe(node) {
      const rect = node.getBoundingClientRect()
      const info = {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute?.('role') ?? undefined,
        text: norm(node.textContent).slice(0, 80),
        selector: selectorOf(node),
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      }
      const aria = node.getAttribute?.('aria-label')
      if (aria) info.label = aria.slice(0, 60)
      if (typeof node.value === 'string' && node.value !== '') info.value = node.value.slice(0, 60)
      const placeholder = node.getAttribute?.('placeholder')
      if (placeholder) info.placeholder = String(placeholder).slice(0, 60)
      if (node.disabled === true) info.disabled = true
      if (node.getAttribute?.('data-active')) info.active = node.getAttribute('data-active') === 'true'
      return info
    }

    function scanPage(step) {
      const container = typeof step.selector === 'string' && step.selector !== '' ? document.querySelector(step.selector) : document
      if (container === null) throw new Error(`scan container not found: ${step.selector}`)
      const all = [...container.querySelectorAll(INTERACTIVE)].filter(isVisible)
      const max = Math.max(1, Math.min(Number(step.max) || 60, 120))
      const elements = all.slice(0, max).map(describe)
      return {
        url: window.location.pathname,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        count: all.length,
        truncated: all.length > max,
        elements,
      }
    }

    // ------------------------------------------------------------ the walk ---

    const runtime = { layout: null, ctx: null }
    /** Shared through globalThis on purpose: a reloaded client must be able to stop a run started by
     * the previous module instance. The stop button sets this; every step loop checks it. */
    const control = (globalThis.__dshRecorderControl ??= { stopRequested: false })

    /**
     * Stop signalling also travels through the DOM: a rehearsal may be executing in a module instance
     * whose closure the current panel cannot reach, while `document` is shared by both.
     */
    function clearStop() {
      control.stopRequested = false
      try {
        delete document.documentElement.dataset.dshRecorderStop
      } catch {
        /* ignore */
      }
    }

    function requestStop() {
      control.stopRequested = true
      try {
        document.documentElement.dataset.dshRecorderStop = String(Date.now())
      } catch {
        /* ignore */
      }
    }

    function isStopRequested() {
      if (control.stopRequested === true) return true
      try {
        return (document.documentElement.dataset.dshRecorderStop ?? '') !== ''
      } catch {
        return false
      }
    }
    /** Survives a panel unmount: a rehearsal usually opens another panel and hides this page. */
    let lastRehearsal = null
    /** The last panel-run result, same reason — the panel is hidden while the script runs. */
    let lastPanelResult = null

    async function doStep(step) {
      const op = String(step?.op ?? '')
      if (op === 'openPanel') {
        const panel = String(step.panel ?? '').trim()
        if (panel === '') throw new Error('openPanel needs panel')
        const layout = runtime.layout ?? runtime.ctx?.get?.('layout') ?? null
        if (layout === null || typeof layout.selectPanel !== 'function') throw new Error('the page does not expose ctx.layout.selectPanel')
        layout.selectPanel(panel)
        await sleep(520)
        return { detail: `panel ${panel}` }
      }
      if (op === 'sleep') {
        const ms = Math.max(0, Math.min(Number(step.ms) || 500, 60_000))
        const until = Date.now() + ms
        while (Date.now() < until) {
          if (isStopRequested()) throw new Error('stopped by the user')
          await sleep(Math.min(100, until - Date.now()))
        }
        return { detail: `${ms} ms` }
      }
      if (op === 'wait') {
        const found = await waitForElement(step.selector, step)
        return { detail: `appeared: ${found.text || step.selector}` }
      }
      const node = op === 'key' && (step.selector === undefined || step.selector === '') ? null : findElement(step.selector, op === 'click' ? step.text : undefined)
      if (op === 'click') {
        await clickLikeHuman(node)
        scheduleCursorHide()
        return { detail: `clicked: ${norm(node.textContent).slice(0, 40) || selectorOf(node)}` }
      }
      if (op === 'type') {
        const result = await typeLikeHuman(node, step.text, step.ms)
        return { detail: `typed ${result.chars} chars` }
      }
      if (op === 'setValue') {
        focusLikeHuman(node)
        await sleep(120)
        setValueNow(node, String(step.text ?? ''))
        scheduleCursorHide()
        return { detail: `set ${String(step.text ?? '').length} chars` }
      }
      if (op === 'key') {
        const result = await pressKey(node, step)
        scheduleCursorHide()
        return { detail: `key ${result.key}` }
      }
      if (op === 'select') {
        const result = await selectRange(node, step)
        scheduleCursorHide()
        return { detail: `selected ${result.to - result.from} chars: ${result.selected}` }
      }
      if (op === 'scroll') {
        node.scrollIntoView({ block: 'center', inline: 'nearest' })
        const point = centerOf(node)
        moveCursor(point.x, point.y)
        scheduleCursorHide()
        await sleep(260)
        return { detail: `scrolled to ${selectorOf(node)}` }
      }
      if (op === 'focus') {
        focusLikeHuman(node)
        scheduleCursorHide()
        await sleep(180)
        return { detail: `focused ${selectorOf(node)}` }
      }
      throw new Error(`unknown op "${op}"`)
    }

    async function runSteps(job, onStep) {
      // A fresh run starts fresh: a stop meant for an earlier run must not kill this one.
      clearStop()
      const steps = Array.isArray(job.steps) ? job.steps : []
      const log = []
      let ok = true
      let error = ''
      const started = Date.now()
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (isStopRequested()) {
          ok = false
          error = 'stopped by the user'
          log.push({ op: 'stop', ok: false, error })
          break
        }
        const stepStarted = Date.now()
        let stepOk = true
        try {
          const outcome = await doStep(step)
          log.push({ op: step.op, ok: true, ms: Date.now() - stepStarted, detail: String(outcome?.detail ?? '') })
        } catch (problem) {
          stepOk = false
          ok = false
          error = String(problem?.message ?? problem)
          log.push({ op: step.op, ok: false, ms: Date.now() - stepStarted, error })
          if (job.strict === true) break
        }
        if (typeof onStep === 'function') {
          try {
            onStep(index + 1, steps.length, String(step.op ?? ''), stepOk)
          } catch {
            /* a broken progress callback must not stop the walk */
          }
        }
        // The pill's step counter. Fire and forget: a missed tick is cosmetic.
        void postJson(`${API}/progress`, { index: index + 1, total: steps.length, op: String(step.op ?? ''), ok: stepOk }).catch(() => undefined)
      }
      const settleMs = Math.max(0, Math.min(Number(job.settleMs) || 0, 30_000))
      if (settleMs > 0) {
        const until = Date.now() + settleMs
        while (Date.now() < until && !isStopRequested()) {
          await sleep(Math.min(100, until - Date.now()))
        }
      }
      scheduleCursorHide(900)
      return { ok, error, log, data: { ms: Date.now() - started, steps: steps.length } }
    }

    let runningJob = false

    async function runJob(job) {
      if (runningJob || job === null || job === undefined) return
      runningJob = true
      let report = { id: job.id, ok: true, error: '', log: [] }
      try {
        if (job.kind === 'steps') {
          // A fresh job starts fresh: a stop meant for an earlier run must not kill this one.
          clearStop()
          const result = await runSteps(job)
          report = { id: job.id, ...result }
        } else if (job.kind === 'scan') {
          const data = scanPage(job)
          report = { id: job.id, ok: true, error: '', log: [{ op: 'scan', ok: true, detail: `${data.count} elements` }], data }
        } else {
          report = { id: job.id, ok: false, error: `unknown job kind ${job.kind}`, log: [] }
        }
      } catch (problem) {
        report = { id: job.id, ok: false, error: String(problem?.message ?? problem), log: [] }
      } finally {
        runningJob = false
        try {
          await postJson(`${API}/report`, report)
        } catch {
          /* the Host may have timed out; nothing else to do */
        }
      }
    }

    async function pollOnce() {
      try {
        const payload = await getJson(`${API}/poll`)
        const data = payload?.data ?? {}
        const recording = data.state?.recording === true ? data.state : null
        if ((store.recording === null) !== (recording === null)) publish({ recording })
        else if (recording !== null && store.recording !== null) {
          store.recording = recording
          for (const listener of [...listeners]) listener()
        }
        if (data.job) await runJob(data.job)
      } catch {
        if (store.recording !== null) publish({ recording: null })
      }
    }

    // ------------------------------------------------------------- overlay ---

    function useStore() {
      const snapshotOf = () => ({ recording: store.recording, rehearsal: store.rehearsal, toast: store.toast, cursor: store.cursor, highlight: store.highlight })
      const [snapshot, setSnapshot] = useState(snapshotOf)
      useEffect(() => {
        const listener = () => setSnapshot(snapshotOf())
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return snapshot
    }

    function Cursor({ cursor }) {
      const style = { transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }
      return h(
        'div',
        { className: 'dshr-cursor', style, 'data-dsh-recorder': '1', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 26, height: 26, viewBox: '0 0 24 24' },
          h('path', {
            d: 'M4 2.5 20 11l-7.2 1.6L9 20.5z',
            fill: '#ffffff',
            stroke: '#111111',
            strokeWidth: 1.8,
            strokeLinejoin: 'round',
          }),
        ),
        h('span', { key: `a${cursor.press}`, className: 'dshr-ping' }),
        h('span', { key: `b${cursor.press}`, className: 'dshr-ping dshr-ping-late' }),
        h('span', { key: `c${cursor.press}`, className: 'dshr-flash' }),
      )
    }

    function Styles() {
      return h('style', { 'data-dsh-recorder-style': '1' }, CSS)
    }

    function RecorderOverlay() {
      const snapshot = useStore()
      const [stopping, setStopping] = useState(false)
      const [, setTick] = useState(0)
      const active = snapshot.recording !== null
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 500)
        return () => clearInterval(timer)
      }, [active])

      const stop = async () => {
        setStopping(true)
        requestStop()
        // Respond to the click immediately; GIF assembly can take many seconds and the pill would
        // otherwise look like it ignored the click.
        publish({ recording: null })
        toast('正在结束录制并生成 GIF…')
        try {
          const payload = await postJson(`${API}/stop`, {})
          const result = payload?.data ?? {}
          toast(result?.gif ? `已保存 ${result.gif}` : '录制已结束')
          publish({ recording: null })
        } catch (problem) {
          toast(`结束失败：${String(problem?.message ?? problem)}`)
        } finally {
          setStopping(false)
        }
      }

      const recording = snapshot.recording
      const elapsed = recording === null ? 0 : Math.max(0, Math.floor(((Date.now() - Number(recording.startedAt ?? Date.now())) || 0) / 1000))
      const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

      return h(
        React.Fragment,
        null,
        h(Styles, null),
        recording !== null
          ? h(
              'div',
              { className: 'dshr-overlay', 'data-dsh-recorder': '1' },
              h(
                'div',
                { className: 'dshr-pill', role: 'status', 'aria-live': 'polite' },
                h('span', { className: 'dshr-dot' }),
                h('span', { className: 'dshr-rec' }, 'REC'),
                h('span', { className: 'dshr-clock' }, clock),
                h('span', { className: 'dshr-title' }, String(recording.title ?? 'this window')),
                h(
                  'button',
                  { className: 'dshr-stop', type: 'button', onClick: () => void stop(), disabled: stopping, 'data-dsh-recorder': '1' },
                  stopping ? '生成中…' : '停止',
                ),
              ),
            )
          : snapshot.rehearsal !== null
            ? h(
                'div',
                { className: 'dshr-overlay', 'data-dsh-recorder': '1' },
                h(
                  'div',
                  { className: 'dshr-pill', role: 'status', 'aria-live': 'polite' },
                  h('span', { className: 'dshr-dot dshr-dot-rehearsal' }),
                  h('span', { className: 'dshr-rec dshr-rec-rehearsal' }, '排练'),
                  h('span', { className: 'dshr-clock' }, `${snapshot.rehearsal.index}/${snapshot.rehearsal.total}`),
                  snapshot.rehearsal.op ? h('span', { className: 'dshr-title' }, String(snapshot.rehearsal.op)) : null,
                  h(
                    'button',
                    {
                      className: 'dshr-stop',
                      type: 'button',
                      'data-dsh-recorder': '1',
                      onClick: () => {
                        requestStop()
                        toast('已请求停止排练')
                      },
                    },
                    '停止',
                  ),
                ),
              )
            : null,
        snapshot.cursor.visible && Array.isArray(snapshot.cursor.trail)
          ? snapshot.cursor.trail.slice(0, -1).map((point) =>
              h('span', {
                key: point.id,
                className: 'dshr-trail',
                style: { transform: `translate3d(${point.x}px, ${point.y}px, 0)` },
                'data-dsh-recorder': '1',
                'aria-hidden': 'true',
              }),
            )
          : null,
        snapshot.highlight !== null
          ? h('div', {
              key: snapshot.highlight.key,
              className: 'dshr-highlight',
              style: {
                left: `${snapshot.highlight.rect[0]}px`,
                top: `${snapshot.highlight.rect[1]}px`,
                width: `${snapshot.highlight.rect[2]}px`,
                height: `${snapshot.highlight.rect[3]}px`,
              },
              'data-dsh-recorder': '1',
              'aria-hidden': 'true',
            })
          : null,
        snapshot.cursor.visible ? h(Cursor, { cursor: snapshot.cursor }) : null,
        snapshot.toast !== null
          ? h('div', { className: 'dshr-toast', 'data-dsh-recorder': '1', role: 'status' }, snapshot.toast)
          : null,
      )
    }

    // ------------------------------------------------------------- the page ---

    const OP_ALIASES = {
      open: 'openPanel',
      openPanel: 'openPanel',
      click: 'click',
      type: 'type',
      set: 'setValue',
      setValue: 'setValue',
      key: 'key',
      select: 'select',
      wait: 'wait',
      sleep: 'sleep',
      scroll: 'scroll',
      focus: 'focus',
    }

    const unescapeText = (value) => String(value ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t')

    function parseScriptLine(line, lineNo) {
      const pipeAt = line.indexOf('|')
      const head = (pipeAt === -1 ? line : line.slice(0, pipeAt)).trim()
      const tail = pipeAt === -1 ? '' : unescapeText(line.slice(pipeAt + 1).trim())
      const parts = head.split(/\s+/).filter(Boolean)
      const rawOp = parts.shift() ?? ''
      const op = OP_ALIASES[rawOp]
      if (op === undefined) {
        throw new Error(`第 ${lineNo} 行：不认识的指令「${rawOp}」。可用：open / click / type / set / select / wait / sleep / key / scroll / focus`)
      }
      const step = { op }
      if (op === 'openPanel') {
        if (!parts[0]) throw new Error(`第 ${lineNo} 行：open 后面要写面板 key，例如 open notes`)
        step.panel = parts[0]
        return step
      }
      if (op === 'sleep') {
        step.ms = Number(parts[0]) || 800
        return step
      }
      if (op === 'key') {
        if (parts.length >= 2) {
          step.selector = parts[0]
          step.key = parts[1]
        } else {
          step.key = parts[0] ?? 'Enter'
        }
        return step
      }
      if (!parts[0]) throw new Error(`第 ${lineNo} 行：${rawOp} 需要一个选择器`)
      step.selector = parts[0]
      if (op === 'click' || op === 'type' || op === 'setValue' || op === 'select') step.text = tail
      if (op === 'wait' && parts[1]) step.timeoutMs = Number(parts[1]) || 8000
      return step
    }

    /** JSON steps when the text starts with `[`, otherwise one step per line. */
    function parseScript(text) {
      const source = String(text ?? '').trim()
      if (source === '') return []
      if (source.startsWith('[')) {
        let value
        try {
          value = JSON.parse(source)
        } catch (problem) {
          throw new Error(`JSON 解析失败：${problem?.message ?? problem}`)
        }
        if (!Array.isArray(value)) throw new Error('JSON 脚本必须是一个步骤数组')
        return value.filter((step) => step !== null && typeof step === 'object')
      }
      const steps = []
      source.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) return
        steps.push(parseScriptLine(line, index + 1))
      })
      return steps
    }

    const SAMPLE_SCRIPT = `# 每一行是一步；竖线后面是该步要写的文字
# 也可以直接粘贴 JSON 步骤数组
open notes
wait .dshn-root
click .dshn-switch[aria-checked="true"]
click .dshn-tabs button.dshn-tab:nth-of-type(1)
set .dshn-textarea |
click .dshn-textarea
type .dshn-textarea | 极简笔记\\n\\n这不是一个新的工具，而是一个关于文字的哲学思考。\\n智能不能成为文字的主角。\\n功能应当服务于思想。\\n书写带来快乐。
sleep 900
select .dshn-textarea | 智能不能成为文字的主角。
sleep 1200`

    const DRAFT_KEY = 'dshr.script'

    /** One-click prompt for the agent that owns the plugin being filmed. */
    const AGENT_PROMPT = `你是这个 DSH 插件的开发 agent。我要用「插件录制器」给它录一段演示 GIF：录制器会按一份脚本操作真实界面并录屏。请根据下面的规范，生成一份我能直接粘贴的脚本。

# 录制器脚本规范 v1

格式：一行一步；竖线 | 后面是该步的文字；# 开头是注释。也可以输出 JSON 步骤数组（以 [ 开头，字段同名）。

指令：
- open <panel>              切到插件的主面板；panel 是 main 面板的 key（例如 notes）。
- click <选择器> [| 文字]    点击；文字用于在多个匹配里挑，优先用按钮上可见的文字。
- type <选择器> | 文字       逐字输入（约 60ms/字），\\n 表示换行。
- set <选择器> | 文字        一次性赋值；清空输入框写成 set <选择器> |（竖线后留空）。
- select <选择器> | 文字     选中这段文字（用于展示划选/翻译）。
- wait <选择器> [毫秒]       等元素出现，默认 8000。
- sleep <毫秒>               停顿。
- key <选择器> <键>          发送 Tab / Enter / Escape 等按键。
- scroll / focus <选择器>

选择器规则（最重要）：
1. 必须来自真实 DOM。优先插件自己的类名前缀（如 .dshn-xxx）、[role=...]、[aria-label=...]。
2. 不要用哈希类名（如 wtg9ga_abc、_button_1rv3m_2），不要依赖 nth-child 的偶然顺序；没有稳定类名时才用结构选择器。
3. 点按钮优先写 click <容器选择器> | 按钮文字，这样文案中英文切换也能命中。
4. 每个选择器要唯一命中；有歧义就用更具体的类名/属性收窄。

节奏与安全：
- 切换面板/长操作后加 wait 或 sleep（300–900ms），让画面跟得上。
- 打字前先 click 输入框；先 set 清空再 type，保证可重放。
- 8–15 步、10–20 秒为宜。
- 不要保存/删除/提交/发消息/调用模型或消耗 token；演示应可重复、无副作用（除非我明确要求展示保存）。

输出要求：
- 只输出一个 \`\`\`text 代码块，里面是脚本；不要解释，不要输出其它代码块。
- 如果我给了「页面元件清单」，优先使用清单里的 selector 和文字；没有清单就根据插件源码里的类名、aria-label 推断，并在代码块外一句话说明哪些选择器是推断的。
- 先告诉我你的插件在 main 面板的 key（例如 notes），我把它填进 open。

# 我要演示的内容
<在这里写：先做什么、点什么、输入什么、最后停在哪>
`

    function buildAgentPrompt() {
      return AGENT_PROMPT
    }

    function readDraft() {
      try {
        const stored = localStorage.getItem(DRAFT_KEY)
        if (typeof stored === 'string' && stored.trim() !== '') return stored
      } catch {
        /* storage may be unavailable */
      }
      return SAMPLE_SCRIPT
    }

    function parseStills(text) {
      return String(text ?? '')
        .split(/[,，\s]+/)
        .map((piece) => Number(piece))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .slice(0, 12)
    }

    /** Crop insets in CSS pixels from the page viewport, plus the CSS→device scale. */
    function measureInsets(mode, selector) {
      if (mode === 'window') return null
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      let node = null
      if (mode === 'custom') {
        const input = String(selector ?? '').trim()
        if (input === '') throw new Error('自定义区域需要填写 CSS 选择器')
        try {
          node = document.querySelector(input)
        } catch (problem) {
          throw new Error(`选择器无效：${problem?.message ?? problem}`)
        }
        if (node === null) throw new Error(`找不到选择器 ${input}`)
      } else {
        node = document.querySelector('.dshr-page')
        if (node === null) throw new Error('录制器页面没有挂载，无法计算功能区')
      }
      const rect = node.getBoundingClientRect()
      const left = Math.max(0, Math.min(rect.left, viewportWidth - 40))
      const top = Math.max(0, Math.min(rect.top, viewportHeight - 40))
      const right = Math.max(0, viewportWidth - Math.max(left + 40, Math.min(rect.right, viewportWidth)))
      const bottom = Math.max(0, viewportHeight - Math.max(top + 40, Math.min(rect.bottom, viewportHeight)))
      const scale = Number(window.devicePixelRatio) || 1
      return [left, top, right, bottom, scale]
    }

    function assetUrl(path) {
      return `${API}/asset?path=${encodeURIComponent(String(path ?? ''))}`
    }

    function optionField(label, input) {
      return h('label', { className: 'dshr-field' }, h('span', { className: 'dshr-label' }, label), input)
    }

    function RecorderIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3.5 }),
        h('circle', { cx: 12, cy: 12, r: 3.2, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function resultCard(result, onCopy, title = '录制结果', onPreview = null) {
      const log = Array.isArray(result?.walk?.log) ? result.walk.log : []
      const shot = h('img', { className: 'dshr-shot', src: assetUrl(result?.gif), alt: 'recording' })
      return h(
        'section',
        { className: 'dshr-card' },
        h(
          'div',
          { className: 'dshr-card-head' },
          h('span', { className: 'dshr-card-title' }, title),
          h('button', { className: 'dshr-link', type: 'button', onClick: onCopy }, '复制路径'),
        ),
        onPreview !== null
          ? h(
              'button',
              { className: 'dshr-shot-button', type: 'button', onClick: () => onPreview(result), title: '全尺寸查看', 'aria-label': '全尺寸查看' },
              shot,
              h('span', { className: 'dshr-shot-zoom' }, '⤢ 全尺寸'),
            )
          : shot,
        h('div', { className: 'dshr-meta' }, `${result?.seconds ?? '?'}s · ${result?.frames ?? '?'} 帧 · ${Math.round((Number(result?.bytes) || 0) / 1024)} KB`),
        result?.warning ? h('div', { className: 'dshr-warn' }, String(result.warning)) : null,
        h('code', { className: 'dshr-path' }, String(result?.gif ?? '')),
        log.length > 0
          ? h(
              'details',
              { className: 'dshr-walk' },
              h('summary', null, `步骤结果（${log.length}）`),
              h(
                'ul',
                null,
                ...log.map((entry, index) =>
                  h(
                    'li',
                    { key: index, className: entry.ok === false ? 'bad' : 'good' },
                    `${entry.ok === false ? '✗' : '✓'} ${entry.op}${entry.detail ? ` — ${entry.detail}` : ''}${entry.error ? ` — ${entry.error}` : ''}`,
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function rehearsalCard(report) {
      const log = Array.isArray(report?.log) ? report.log : []
      const failed = log.filter((entry) => entry?.ok === false).length
      return h(
        'section',
        { className: 'dshr-card' },
        h(
          'div',
          { className: 'dshr-card-head' },
          h('span', { className: 'dshr-card-title' }, '排练结果（未录制）'),
          h('span', { className: 'dshr-recent-meta' }, failed === 0 ? `${log.length} 步全部通过` : `${failed} / ${log.length} 步失败`),
        ),
        h(
          'ul',
          { className: 'dshr-log' },
          ...log.map((entry, index) =>
            h(
              'li',
              { key: index, className: entry?.ok === false ? 'bad' : 'good' },
              `${entry?.ok === false ? '✗' : '✓'} ${entry?.op ?? '?'}${entry?.detail ? ` — ${entry.detail}` : ''}${entry?.error ? ` — ${entry.error}` : ''}`,
            ),
          ),
        ),
      )
    }

    function GearIcon() {
      return h(
        'svg',
        { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', {
          d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.56 1.03z',
        }),
      )
    }

    function emptyCard(title, note) {
      return h('section', { className: 'dshr-card dshr-empty' }, h('div', { className: 'dshr-empty-title' }, title), h('div', { className: 'dshr-empty-note' }, note))
    }

    function historyCard(item, onOpen) {
      return h(
        'button',
        { key: item.name, className: 'dshr-history-card', type: 'button', onClick: onOpen, title: item.gif },
        item.probe !== null && item.probe !== undefined
          ? h('img', { className: 'dshr-history-thumb', src: assetUrl(item.probe), alt: item.name })
          : h('span', { className: 'dshr-history-thumb' }),
        h('span', { className: 'dshr-history-name' }, item.name),
        h('span', { className: 'dshr-history-meta' }, `${item.seconds ?? '?'}s · ${item.frames ?? '?'} 帧 · ${Math.round((Number(item.bytes) || 0) / 1024)} KB`),
      )
    }

    function RecorderPanel() {
      const [tab, setTab] = useState('record')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [historyPick, setHistoryPick] = useState(null)
      const [preview, setPreview] = useState(null)
      const [script, setScript] = useState(readDraft)
      const [fps, setFps] = useState(6)
      // The GIF is encoded at the crop's physical width so the preview is not upscaled: a 1000 px GIF
      // on a 125% display is stretched past 1200 device pixels and reads as blurry. Capped to keep the
      // file reasonable; the setting overrides it per run.
      const [width, setWidth] = useState(() => {
        try {
          const dpr = window.devicePixelRatio || 1
          const content = Math.max(640, window.innerWidth - 360)
          return Math.max(900, Math.min(1600, Math.round(content * dpr)))
        } catch {
          return 1400
        }
      })
      const [stills, setStills] = useState('3, 6')
      const [workspaces, setWorkspaces] = useState([])
      const [workspace, setWorkspace] = useState('')
      const [cropMode, setCropMode] = useState(() => {
        try {
          const stored = localStorage.getItem('dshr.cropMode')
          if (stored === 'window' || stored === 'content' || stored === 'custom') return stored
        } catch {
          /* storage may be unavailable */
        }
        return 'content'
      })
      const [cropSelector, setCropSelector] = useState(() => {
        try {
          return localStorage.getItem('dshr.cropSelector') ?? ''
        } catch {
          return ''
        }
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const [recent, setRecent] = useState([])
      const [rehearsal, setRehearsal] = useState(() => lastRehearsal)
      const [rehearsing, setRehearsing] = useState(false)
      const [localProgress, setLocalProgress] = useState(null)
      const [stopTick, setStopTick] = useState(0)
      const snapshot = useStore()
      const recording = snapshot.recording

      const loadWorkspaces = async () => {
        try {
          const payload = await getJson(`${API}/workspaces`)
          const list = Array.isArray(payload?.data?.workspaces) ? payload.data.workspaces : []
          setWorkspaces(list)
          let saved = ''
          try {
            saved = localStorage.getItem('dshr.workspace') ?? ''
          } catch {
            /* storage may be unavailable */
          }
          const next = list.some((item) => item.path === saved) ? saved : (payload?.data?.default ?? list[0]?.path ?? '')
          setWorkspace(next)
          try {
            if (next !== '') localStorage.setItem('dshr.workspace', next)
          } catch {
            /* storage may be unavailable */
          }
          return next
        } catch {
          return ''
        }
      }

      const refreshRecent = async (root = workspace) => {
        try {
          const query = root === '' ? '' : `&workspace=${encodeURIComponent(root)}`
          const payload = await getJson(`${API}/recordings?limit=24${query}`)
          const list = Array.isArray(payload?.data?.recordings) ? payload.data.recordings : []
          setRecent(list)
          return list
        } catch {
          return []
        }
      }

      useEffect(() => {
        void (async () => {
          const root = await loadWorkspaces()
          const list = await refreshRecent(root)
          const latest = lastPanelResult ?? list[0]
          if (latest) setResult((current) => current ?? latest)
        })()
      }, [])

      useEffect(() => {
        if (tab === 'history') void refreshRecent(workspace)
      }, [tab])

      const updateScript = (value) => {
        setScript(value)
        try {
          localStorage.setItem(DRAFT_KEY, value)
        } catch {
          /* storage may be unavailable */
        }
      }

      const chooseWorkspace = (value) => {
        setWorkspace(value)
        try {
          localStorage.setItem('dshr.workspace', value)
        } catch {
          /* storage may be unavailable */
        }
        void refreshRecent(value)
      }

      const chooseCrop = (mode, selector) => {
        setCropMode(mode)
        setCropSelector(selector)
        try {
          localStorage.setItem('dshr.cropMode', mode)
          localStorage.setItem('dshr.cropSelector', selector)
        } catch {
          /* storage may be unavailable */
        }
      }

      const start = async () => {
        setError('')
        setResult(null)
        setBusy(true)
        setLocalProgress(null)
        setTab('record')
        let started = false
        let finished = false
        try {
          const steps = parseScript(script)
          if (steps.length === 0) throw new Error('脚本里没有步骤')
          const inset = measureInsets(cropMode, cropSelector)
          clearStop()
          // The steps run here, in this page, not through the poll bridge: a background timer must
          // never decide whether a demo starts.
          const begin = await postJson(`${API}/start`, {
            workspace: workspace === '' ? undefined : workspace,
            inset: inset === null ? undefined : inset,
            fps: Number(fps) || 6,
            width: Number(width) || 1000,
            title: 'DeepSeek Harness',
          })
          if (begin?.ok !== true) throw new Error(begin?.error?.message ?? '录制启动失败')
          started = true
          const walk = await runSteps({ steps, settleMs: 600 }, (index, total, op) => setLocalProgress({ index, total, op }))
          await sleep(700)
          const stop = await postJson(`${API}/stop`, { stills: parseStills(stills) })
          if (stop?.ok === true) {
            finished = true
            lastPanelResult = { ...stop.data, walk }
            setResult(lastPanelResult)
            await refreshRecent(workspace)
          }
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          if (started && !finished) {
            try {
              const stop = await postJson(`${API}/stop`, {})
              if (stop?.ok === true) {
                lastPanelResult = stop.data
                setResult(stop.data)
              }
            } catch {
              /* the recording may already be over */
            }
          }
          setBusy(false)
          setLocalProgress(null)
          clearStop()
        }
      }

      const stop = async () => {
        requestStop()
        setStopTick((value) => value + 1)
        if (!running) {
          toast('已请求停止')
          return
        }
        try {
          await postJson(`${API}/stop`, {})
        } catch {
          /* the recording may already be over */
        }
      }

      const copyPrompt = async () => {
        const ok = await copyText(buildAgentPrompt())
        toast(ok ? '已复制给插件 agent 的 prompt' : '复制失败，请手动选择文本框内容')
      }

      const copyPath = async (path) => {
        const ok = await copyText(String(path ?? ''))
        toast(ok ? '路径已复制' : '复制失败')
      }

      const fillScreen = async () => {
        setSettingsOpen(false)
        try {
          const payload = await postJson(`${API}/fill`, { title: 'DeepSeek Harness' })
          toast(payload?.ok ? '已铺满当前屏幕' : '铺满失败：找不到窗口')
        } catch (problem) {
          toast(`铺满失败：${String(problem?.message ?? problem)}`)
        }
      }

      const rehearse = async () => {
        setError('')
        setRehearsal(null)
        setRehearsing(true)
        setLocalProgress(null)
        try {
          const steps = parseScript(script)
          if (steps.length === 0) throw new Error('脚本里没有步骤')
          clearStop()
          publish({ rehearsal: { index: 0, total: steps.length, op: '准备' } })
          // A background window throttles timers, which freezes every sleep/wait in the walk. Bring
          // the window forward first; a rehearsal never captures, so nothing else would do it.
          try {
            await postJson(`${API}/focus`, { title: 'DeepSeek Harness' })
          } catch {
            /* best effort: the walk still works when the window is already in front */
          }
          // Rehearsal is local too: it starts on the click, not on the next poll.
          const report = await runSteps({ steps, settleMs: 300 }, (index, total, op) => {
            setLocalProgress({ index, total, op })
            publish({ rehearsal: { index, total, op } })
          })
          lastRehearsal = report
          setRehearsal(report)
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          publish({ rehearsal: null })
          setRehearsing(false)
          setLocalProgress(null)
          clearStop()
        }
      }

      const elapsed = recording === null ? 0 : Math.max(0, Math.floor((Date.now() - Number(recording.startedAt ?? Date.now())) / 1000))
      const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
      const progress = recording?.progress ?? null
      const running = recording !== null
      const statusText = running
        ? `录制中 ${clock}${progress && progress.total > 0 ? ` · ${progress.index}/${progress.total} ${progress.op}` : ''}`
        : busy || rehearsing
          ? localProgress
            ? `${rehearsing ? '排练' : '录制'} ${localProgress.index}/${localProgress.total} ${localProgress.op}`
            : '准备中…'
          : '就绪'

      const tabButton = (id, label, count) =>
        h(
          'button',
          { className: 'dshr-tab', type: 'button', 'data-active': String(tab === id), onClick: () => setTab(id) },
          label,
          count ? h('span', { className: 'dshr-tab-count' }, String(count)) : null,
        )

      const header = h(
        'header',
        { className: 'dshr-head' },
        h(
          'div',
          { className: 'dshr-title-block' },
          h('h1', { className: 'dshr-h1' }, '录制器'),
          h('p', { className: 'dshr-sub' }, '写一段脚本，它会在页面里像真人一样执行，同时把真实窗口录成 GIF。'),
        ),
        h(
          'div',
          { className: 'dshr-head-right' },
          h(
            'div',
            { className: 'dshr-head-status' + (running || busy || rehearsing ? ' is-running' : '') },
            h('span', { className: 'dshr-status-dot' }),
            h('span', null, statusText),
          ),
          h(
            'button',
            { className: 'dshr-icon-btn', type: 'button', title: '设置', 'aria-label': '设置', 'aria-expanded': String(settingsOpen), onClick: () => setSettingsOpen((value) => !value) },
            h(GearIcon),
          ),
        ),
      )

      const tabs = h('div', { className: 'dshr-tabs-bar' }, tabButton('record', '录制'), tabButton('history', '历史', recent.length))

      const scriptCard = h(
        'section',
        { className: 'dshr-card dshr-script-card' },
        h(
          'div',
          { className: 'dshr-card-head' },
          h('span', { className: 'dshr-card-title' }, '录制脚本'),
          h(
            'div',
            { className: 'dshr-card-head-actions' },
            h('button', { className: 'dshr-link', type: 'button', onClick: () => void copyPrompt() }, '复制给插件 agent 的 prompt'),
            h('button', { className: 'dshr-link', type: 'button', onClick: () => updateScript(SAMPLE_SCRIPT) }, '载入示例'),
          ),
        ),
        h('textarea', {
          className: 'dshr-script',
          value: script,
          spellCheck: false,
          onChange: (event) => updateScript(event.target.value),
          placeholder: 'open notes\nwait .dshn-root\ntype .dshn-textarea | 写点什么',
          'aria-label': '录制脚本',
        }),
        h('p', { className: 'dshr-hint' }, '每行一步：open / click / type / set / select / wait / sleep / key / scroll / focus。文字里用 \\n 换行；也可以直接粘贴 JSON 步骤数组。'),
      )

      const home = h(
        'div',
        { className: 'dshr-home' },
        scriptCard,
        h(
          'div',
          { className: 'dshr-record-row' },
          h(
            'button',
            { className: 'dshr-record', type: 'button', disabled: busy || running || rehearsing, onClick: () => void start() },
            h('span', { className: 'dshr-record-dot' }),
            busy ? '录制中…' : '开始录制',
          ),
          h('button', { className: 'dshr-secondary', type: 'button', disabled: busy || running || rehearsing, onClick: () => void rehearse() }, rehearsing ? '排练中…' : '排练（不录制）'),
          running || rehearsing || busy
            ? h('button', { className: 'dshr-secondary', type: 'button', onClick: () => void stop() }, isStopRequested() ? '停止中…' : '停止')
            : null,
        ),
        h('p', { className: 'dshr-note-line' }, '窗口会抬到前台并最大化，结束后恢复；光标、点击圆环和目标描边都会录进 GIF。'),
        error !== '' ? h('div', { className: 'dshr-error' }, error) : null,
        rehearsal !== null ? rehearsalCard(rehearsal) : null,
        result !== null
          ? resultCard(result, () => void copyPath(result.gif), '本次录制', (item) => setPreview(item))
          : emptyCard('还没有录制结果', '写好脚本，按「开始录制」，结果会显示在这里。'),
      )

      const history = h(
        'div',
        { className: 'dshr-home' },
        historyPick !== null
          ? h(
              React.Fragment,
              null,
              h('button', { className: 'dshr-link dshr-back', type: 'button', onClick: () => setHistoryPick(null) }, '← 返回历史列表'),
              resultCard(historyPick, () => void copyPath(historyPick.gif), '历史录制', (item) => setPreview(item)),
            )
          : recent.length === 0
            ? emptyCard('还没有录制', '录制一次之后，历史记录会出现在这里。')
            : h('div', { className: 'dshr-history-grid' }, ...recent.map((item) => historyCard(item, () => setHistoryPick(item)))),
      )

      const settings = settingsOpen
        ? h(
            React.Fragment,
            null,
            h('div', { className: 'dshr-backdrop', onClick: () => setSettingsOpen(false) }),
            h(
              'aside',
              { className: 'dshr-settings', role: 'dialog', 'aria-label': '设置' },
              h(
                'div',
                { className: 'dshr-settings-head' },
                h('span', { className: 'dshr-card-title' }, '设置'),
                h('button', { className: 'dshr-icon-btn', type: 'button', onClick: () => setSettingsOpen(false), 'aria-label': '关闭设置' }, '✕'),
              ),
              h(
                'div',
                { className: 'dshr-settings-body' },
                workspaces.length > 0
                  ? optionField(
                      '输出工作区',
                      h(
                        'select',
                        { className: 'dshr-input', value: workspace, onChange: (event) => chooseWorkspace(event.target.value), 'aria-label': '输出工作区' },
                        ...workspaces.map((item) => h('option', { key: item.path, value: item.path, title: item.path }, `${item.title} — ${item.path}`)),
                      ),
                    )
                  : null,
                optionField(
                  '录制区域',
                  h(
                    'select',
                    { className: 'dshr-input', value: cropMode, onChange: (event) => chooseCrop(event.target.value, cropSelector), 'aria-label': '录制区域' },
                    h('option', { value: 'content' }, '功能区（自动去掉侧边栏）'),
                    h('option', { value: 'window' }, '整个窗口'),
                    h('option', { value: 'custom' }, '自定义区域（CSS 选择器）'),
                  ),
                ),
                cropMode === 'custom'
                  ? optionField(
                      '区域选择器',
                      h('input', {
                        className: 'dshr-input',
                        value: cropSelector,
                        placeholder: '.dshr-page',
                        onChange: (event) => chooseCrop('custom', event.target.value),
                        'aria-label': '区域选择器',
                      }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dshr-settings-grid' },
                  optionField('帧率', h('input', { className: 'dshr-input', value: fps, inputMode: 'decimal', onChange: (event) => setFps(event.target.value), 'aria-label': '帧率' })),
                  optionField('GIF 宽度', h('input', { className: 'dshr-input', value: width, inputMode: 'numeric', onChange: (event) => setWidth(event.target.value), 'aria-label': 'GIF 宽度' })),
                  optionField('截图时间点（秒）', h('input', { className: 'dshr-input', value: stills, onChange: (event) => setStills(event.target.value), 'aria-label': '截图时间点' })),
                ),
                h('button', { className: 'dshr-secondary dshr-wide', type: 'button', onClick: () => void fillScreen() }, '铺满当前屏幕'),
                h('p', { className: 'dshr-hint dshr-settings-note' }, '设置自动保存在本地，作用于下一次录制。GIF 宽度越大越清晰，文件也越大。'),
              ),
            ),
          )
        : null

      return h(
        'div',
        { className: 'dshr-page' },
        h(Styles, null),
        header,
        tabs,
        tab === 'record' ? home : history,
        settings,
        preview !== null
          ? h(
              'div',
              { className: 'dshr-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '全尺寸预览', onClick: () => setPreview(null) },
              h('img', {
                className: 'dshr-lightbox-img',
                src: assetUrl(preview.gif),
                alt: 'full-size preview',
                onClick: (event) => event.stopPropagation(),
              }),
              h(
                'button',
                {
                  className: 'dshr-lightbox-close',
                  type: 'button',
                  'aria-label': '关闭全尺寸预览',
                  onClick: (event) => {
                    event.stopPropagation()
                    setPreview(null)
                  },
                },
                '✕',
              ),
              h('span', { className: 'dshr-lightbox-meta' }, `${preview.name ?? (tab === 'record' ? '本次录制' : '历史录制')} · ${preview.seconds ?? '?'}s · 点击空白处或 ✕ 关闭`),
            )
          : null,
      )
    }

    // --------------------------------------------------------------- styles ---

    const CSS = `
/* Below the title bar on purpose: the top strip is the window-drag region, and a click there is
   consumed by the window manager instead of reaching the button. */
.dshr-overlay { position: fixed; top: 46px; left: 50%; transform: translateX(-50%); z-index: 2147483000; pointer-events: auto; -webkit-app-region: no-drag; }
.dshr-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 8px 6px 11px; border-radius: 999px;
  background: var(--dsw-alias-bg-overlay, #1f1f1f);
  color: var(--dsw-alias-label-primary, #f5f5f5);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35));
  font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums; user-select: none; white-space: nowrap;
  -webkit-app-region: no-drag;
}
.dshr-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-error-primary, #e5484d); animation: dshr-pulse 1.3s ease-in-out infinite; }
.dshr-dot-rehearsal { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dshr-rec-rehearsal { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dshr-rec { flex: 0 0 auto; letter-spacing: .08em; font-weight: 700; color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 11px; }
.dshr-clock { flex: 0 0 auto; color: var(--dsw-alias-label-primary, #f5f5f5); font-variant-numeric: tabular-nums; }
.dshr-title { flex: 0 1 auto; min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #b3b3b3); font-weight: 400; }
.dshr-stop {
  flex: 0 0 auto;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5)); background: var(--dsw-alias-bg-layer-2, #2b2b2b);
  color: var(--dsw-alias-label-primary, #f5f5f5); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11.5px;
  cursor: pointer; transition: background .15s ease, border-color .15s ease;
  -webkit-app-region: no-drag;
}
.dshr-stop:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, #363636); border-color: var(--dsw-alias-border-l1, rgba(160,160,160,.5)); }
.dshr-stop:disabled { opacity: .55; cursor: default; }
.dshr-cursor {
  position: fixed; left: 0; top: 0; z-index: 2147483001; pointer-events: none;
  transition: transform 260ms cubic-bezier(.2,.8,.2,1); will-change: transform;
  filter: drop-shadow(0 2px 5px rgba(0,0,0,.5)); margin: -3px 0 0 -3px;
}
.dshr-trail {
  position: fixed; left: 0; top: 0; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px;
  border-radius: 50%; background: #4d6bfe; pointer-events: none;
  z-index: 2147482999; animation: dshr-trail 560ms ease-out forwards;
}
.dshr-ping {
  position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%;
  border: 3px solid #4d6bfe; opacity: 0;
  animation: dshr-ping 620ms ease-out forwards;
}
.dshr-ping-late { animation-delay: 95ms; }
.dshr-flash {
  position: absolute; left: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%;
  background: #4d6bfe; opacity: 0;
  animation: dshr-flash 460ms ease-out forwards;
}
.dshr-highlight {
  position: fixed; z-index: 2147482998; pointer-events: none;
  border: 2px solid #4d6bfe; border-radius: 8px;
  background: rgba(77,107,254,.14); background: color-mix(in srgb, #4d6bfe 14%, transparent);
  animation: dshr-highlight 760ms ease-out forwards;
}
.dshr-toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 2147483002; max-width: 70vw;
  padding: 8px 14px; border-radius: 10px; background: var(--dsw-alias-bg-overlay, #1f1f1f);
  color: var(--dsw-alias-label-primary, #f5f5f5); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35));
  box-shadow: 0 10px 30px rgba(0,0,0,.3); font: 500 12.5px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: none;
}
.dshr-page { position: relative; height: 100%; overflow: auto; padding: 22px 30px 44px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dshr-head { max-width: 980px; margin: 0 auto; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dshr-title-block { min-width: 0; }
.dshr-head-right { display: flex; align-items: center; gap: 10px; flex: none; }
.dshr-tabs-bar { max-width: 980px; margin: 14px auto 0; display: flex; gap: 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-tab { position: relative; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; padding: 8px 2px 9px; cursor: pointer; }
.dshr-tab:hover { color: var(--dsw-alias-label-primary); }
.dshr-tab[data-active="true"] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshr-tab[data-active="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--dsw-alias-label-primary); }
.dshr-tab-count { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dshr-home { max-width: 980px; margin: 16px auto 0; display: flex; flex-direction: column; gap: 14px; }
.dshr-icon-btn { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshr-icon-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dshr-record-row { display: flex; align-items: center; justify-content: center; gap: 10px; }
.dshr-record-row .dshr-secondary { height: 40px; padding: 0 18px; }
.dshr-record { display: inline-flex; align-items: center; gap: 9px; height: 46px; padding: 0 30px; border: 0; border-radius: 12px; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.12); }
.dshr-record:hover:not(:disabled) { filter: brightness(1.08); }
.dshr-record:disabled { opacity: .55; cursor: default; box-shadow: none; }
.dshr-record-dot { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; flex: none; }
.dshr-note-line { margin: 0; text-align: center; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dshr-backdrop { position: fixed; inset: 0; z-index: 50; background: transparent; }
.dshr-settings { position: fixed; top: 56px; right: 30px; z-index: 51; width: 380px; max-height: calc(100% - 90px); overflow: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.2); }
.dshr-settings-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-settings-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.dshr-settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.dshr-settings-note { padding: 0; margin: 0; }
.dshr-wide { width: 100%; box-sizing: border-box; }
.dshr-empty { padding: 40px 20px; text-align: center; }
.dshr-empty-title { font-size: 14px; font-weight: 600; }
.dshr-empty-note { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshr-history-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.dshr-history-card { display: flex; flex-direction: column; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; cursor: pointer; text-align: left; color: inherit; font: inherit; }
.dshr-history-card:hover { border-color: var(--dsw-alias-border-l2); box-shadow: 0 8px 22px rgba(0,0,0,.08); }
.dshr-history-thumb { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--dsw-alias-bg-base); }
.dshr-history-name { padding: 10px 12px 0; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-history-meta { padding: 4px 12px 12px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshr-back { align-self: flex-start; }
.dshr-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dshr-h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
.dshr-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dshr-head-status { display: inline-flex; align-items: center; gap: 7px; flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dshr-head-status.is-running { color: var(--dsw-alias-label-primary); }
.dshr-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.is-running .dshr-status-dot { background: var(--dsw-alias-state-error-primary); animation: dshr-pulse 1.3s ease-in-out infinite; }
.dshr-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; overflow: hidden; }
.dshr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshr-head-actions { display: flex; align-items: center; gap: 12px; }
.dshr-card-head-actions { display: flex; align-items: center; gap: 12px; }
.dshr-log { margin: 0; padding: 12px 14px 12px 30px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshr-log li.good { color: var(--dsw-alias-state-success-primary); }
.dshr-log li.bad { color: var(--dsw-alias-state-error-primary); }
.dshr-card-title { font-size: 12.5px; font-weight: 600; }
.dshr-link { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.dshr-link:hover { text-decoration: underline; }
.dshr-script { display: block; width: 100%; box-sizing: border-box; min-height: 320px; max-height: 46vh; resize: vertical; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); padding: 14px 16px; font: 12.5px/1.65 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; tab-size: 2; }
.dshr-hint { margin: 0; padding: 0 16px 12px; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dshr-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.dshr-field { display: flex; flex-direction: column; gap: 5px; }
.dshr-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshr-input { height: 32px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 0 10px; font: inherit; font-size: 12.5px; box-sizing: border-box; width: 100%; }
.dshr-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dshr-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshr-primary { height: 34px; padding: 0 18px; border: 0; border-radius: 9px; background: var(--dsw-alias-brand-primary); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.dshr-primary:disabled { opacity: .5; cursor: default; }
.dshr-secondary { height: 34px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.dshr-secondary:disabled { opacity: .45; cursor: default; }
.dshr-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dshr-error { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); padding: 9px 12px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.dshr-shot { display: block; width: 100%; max-height: 520px; object-fit: contain; background: var(--dsw-alias-bg-base); }
.dshr-shot-button { position: relative; display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.dshr-shot-button:hover .dshr-shot { filter: brightness(.97); }
.dshr-shot-zoom { position: absolute; right: 10px; bottom: 10px; padding: 4px 9px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; font-size: 11px; line-height: 1.2; pointer-events: none; }
.dshr-lightbox { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,.84); cursor: zoom-out; }
.dshr-lightbox-img { display: block; max-width: 96vw; max-height: 88vh; width: auto; height: auto; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.5); background: #fff; cursor: default; }
.dshr-lightbox-close { position: fixed; top: 56px; right: 22px; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.16); color: #fff; font-size: 15px; line-height: 1; cursor: pointer; }
.dshr-lightbox-close:hover { background: rgba(255,255,255,.28); }
.dshr-lightbox-meta { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,.78); font-size: 12px; font-variant-numeric: tabular-nums; }
.dshr-meta { padding: 10px 14px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dshr-warn { padding: 6px 14px 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary); }
.dshr-path { display: block; margin: 6px 14px 12px; font: 11.5px/1.5 ui-monospace, Consolas, monospace; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dshr-walk { padding: 0 14px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshr-walk summary { cursor: pointer; }
.dshr-walk ul { margin: 8px 0 0; padding-left: 18px; }
.dshr-walk li.good { color: var(--dsw-alias-state-success-primary); }
.dshr-walk li.bad { color: var(--dsw-alias-state-error-primary); }
.dshr-recent { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 6px; padding: 12px; }
.dshr-recent-item { display: flex; gap: 10px; align-items: center; text-align: left; padding: 6px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dshr-recent-item:hover { border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dshr-thumb { width: 84px; height: 52px; border-radius: 6px; object-fit: cover; background: var(--dsw-alias-bg-base); flex: none; }
.dshr-recent-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dshr-recent-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-recent-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
@keyframes dshr-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }
@keyframes dshr-ping { from { opacity: .95; transform: scale(.25); } to { opacity: 0; transform: scale(1.6); } }
@keyframes dshr-flash { 0% { opacity: .95; transform: scale(.6); } 100% { opacity: 0; transform: scale(2.4); } }
@keyframes dshr-trail { from { opacity: .55; } to { opacity: 0; } }
@keyframes dshr-highlight { 0% { opacity: .95; } 55% { opacity: .75; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .dshr-dot, .dshr-ping, .dshr-flash, .dshr-trail, .dshr-highlight { animation: none; }
  .dshr-cursor { transition: none; }
}
`

    // ----------------------------------------------------------------- apply ---

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        runtime.ctx = ctx
        runtime.layout = ctx.get?.('layout') ?? null

        ctx.effect(
          () => {
            let stopped = false
            let timer = null
            const tick = async () => {
              if (stopped) return
              await pollOnce()
              if (!stopped) timer = setTimeout(tick, POLL_MS)
            }
            void tick()
            return () => {
              stopped = true
              if (timer !== null) clearTimeout(timer)
            }
          },
          'dsh-recorder.poll',
        )

        // Escape is the stop that always works: it does not depend on hitting a small button, and it
        // survives the window chrome swallowing clicks.
        ctx.effect(
          () => {
            const onKey = (event) => {
              if (event.key !== 'Escape') return
              const active = store.recording !== null || store.rehearsal !== null
              if (!active) return
              event.preventDefault()
              requestStop()
              if (store.recording !== null) void postJson(`${API}/stop`, {}).catch(() => undefined)
              toast('已请求停止（Esc）')
            }
            document.addEventListener('keydown', onKey, true)
            return () => document.removeEventListener('keydown', onKey, true)
          },
          'dsh-recorder.escape',
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-recorder', order: 5 }, RecorderOverlay),
        )

        // The recorder's own page: a script editor that drives and records in one action.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'recorder', order: 32, label: () => '录制器' }, RecorderIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'recorder' }, RecorderPanel))
      },
    }
  },
})
