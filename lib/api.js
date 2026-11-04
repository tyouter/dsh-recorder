/**
 * The page's half of the bridge: `/recorder/api`.
 *
 * The browser half polls `poll`, runs the handed-out steps in the live page, and posts the result to
 * `report`. Everything else is read-only state for the recording indicator, plus `stop` so a person
 * can end a recording from the page itself.
 *
 * The recorder panel uses four more routes: `run` starts a script end to end, `progress` keeps the
 * panel's step counter current, `recordings` lists recent output, and `asset` serves a recording's
 * GIF or probe frame so the panel can show it.
 *
 * This is a plain route, not a package RPC: a bundled plugin's client half has no private RPC bridge,
 * and a route is the version-stable way to talk to it.
 */

const PREFIX = '/recorder/api'

import { chmodSync, createReadStream, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

import { recorderEvents, runPython } from './python.js'

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function registerRecorderApi(ctx, engine, { logger } = {}) {
  const mount = (webServer) => {
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      logger?.warn?.('[recorder] webServer is unavailable: the page cannot be driven')
      return () => {}
    }
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = decodeURIComponent(url.pathname.slice(PREFIX.length).replace(/^\/+/, ''))
        const method = (req.method ?? 'GET').toUpperCase()
        const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : {}

        if (route === 'health' && method === 'GET') {
          respondJson(res, 200, { ok: true, data: engine.health() })
          return
        }
        if (route === 'state' && method === 'GET') {
          respondJson(res, 200, { ok: true, data: engine.publicState() })
          return
        }
        if (route === 'poll' && method === 'GET') {
          const job = engine.takeJob(String(req.headers?.['user-agent'] ?? ''))
          respondJson(res, 200, { ok: true, data: { state: engine.publicState(), job } })
          return
        }
        if (route === 'report' && method === 'POST') {
          const accepted = engine.submitReport(body)
          respondJson(res, 200, { ok: true, data: accepted })
          return
        }
        if (route === 'stop' && method === 'POST') {
          const result = await engine.stop({ stills: body?.stills })
          respondJson(res, 200, { ok: true, data: result })
          return
        }
        if (route === 'focus' && method === 'POST') {
          const title = typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim() : 'DeepSeek Harness'
          const result = await runPython(engine.python, ['--title', title, '--focus', '--no-maximize'], { timeoutMs: 20_000 })
          const events = recorderEvents(result.stdout)
          const last = events.length > 0 ? events[events.length - 1] : null
          respondJson(res, 200, { ok: result.code === 0, data: { focused: last?.focused ?? null } })
          return
        }
        if (route === 'fill' && method === 'POST') {
          const title = typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim() : 'DeepSeek Harness'
          const result = await engine.fillScreen(title)
          respondJson(res, 200, { ok: result.ok, data: result.event })
          return
        }
        if (route === 'start' && method === 'POST') {
          const root = engine.workspaceRoot(body.workspace) ?? (await engine.rootForRequest(body.sessionId))
          const state = await engine.start(
            {
              fps: body.fps,
              width: body.width,
              title: body.title,
              maxSeconds: body.maxSeconds,
              inset: Array.isArray(body.inset) ? body.inset : undefined,
              outDir: root,
            },
            typeof body.sessionId === 'string' && body.sessionId !== '' ? { id: body.sessionId } : undefined,
          )
          respondJson(res, 200, { ok: true, data: state })
          return
        }
        if (route === 'progress' && method === 'POST') {
          respondJson(res, 200, { ok: true, data: engine.setProgress(body) })
          return
        }
        if (route === 'workspaces' && method === 'GET') {
          respondJson(res, 200, { ok: true, data: engine.listWorkspaces() })
          return
        }
        if (route === 'run' && method === 'POST') {
          const steps = Array.isArray(body?.steps) ? body.steps : []
          if (steps.length === 0) throw badRequest('the script has no steps')
          const root = engine.workspaceRoot(body.workspace) ?? (await engine.rootForRequest(body.sessionId))
          const result = await engine.demo(
            {
              steps,
              fps: body.fps,
              width: body.width,
              stills: Array.isArray(body.stills) ? body.stills : [],
              title: body.title,
              settleMs: body.settleMs,
              strict: body.strict === true,
              inset: Array.isArray(body.inset) ? body.inset : undefined,
              outDir: root,
            },
            typeof body.sessionId === 'string' && body.sessionId !== '' ? { id: body.sessionId } : undefined,
          )
          respondJson(res, 200, { ok: true, data: result })
          return
        }
        if (route === 'rehearse' && method === 'POST') {
          const steps = Array.isArray(body?.steps) ? body.steps : []
          if (steps.length === 0) throw badRequest('the script has no steps')
          const report = await engine.drive(steps, {
            settleMs: body.settleMs,
            strict: body.strict === true,
            timeoutMs: 600_000,
          })
          respondJson(res, 200, { ok: true, data: report })
          return
        }
        if (route === 'recordings' && method === 'GET') {
          const limit = Number(url.searchParams.get('limit')) || 8
          const root = engine.workspaceRoot(url.searchParams.get('workspace') ?? '') ?? (await engine.rootForRequest(url.searchParams.get('sessionId') ?? ''))
          respondJson(res, 200, { ok: true, data: engine.listRecordings(limit, root) })
          return
        }
        if (route === 'delete' && method === 'POST') {
          const target = typeof body?.path === 'string' ? body.path : ''
          if (target === '') throw badRequest('path is required')
          const resolved = resolvePath(target)
          const samePath = (a, b) => a.toLowerCase() === b.toLowerCase()
          const root = engine.allowedRoots().find((item) => samePath(dirname(resolved), item))
          if (root === undefined) throw forbidden('not a recording directory under a recordings root')
          if (!/^rec-\d{8}-\d{6}$/.test(basename(resolved))) throw badRequest('not a recording directory')
          // OneDrive marks synced directories (and sometimes files) read-only with reparse points, and
          // Node's rmSync cannot clear FILE_ATTRIBUTE_READONLY: it fails EPERM on the directory itself.
          // Clear the attribute tree first, then remove with retries for transient handles.
          clearReadOnly(resolved)
          rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
          respondJson(res, 200, { ok: true, data: { deleted: resolved } })
          return
        }
        if (route === 'asset' && method === 'GET') {
          const target = String(url.searchParams.get('path') ?? '')
          if (target === '') throw badRequest('path is required')
          const resolved = resolvePath(target)
          const inside = engine.allowedRoots().some((root) => {
            const rel = relative(root, resolved)
            return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
          })
          if (!inside) throw forbidden('asset is outside a recordings directory')
          const type = CONTENT_TYPES[extname(resolved).toLowerCase()]
          if (type === undefined) throw badRequest('unsupported asset type')
          let stat
          try {
            stat = statSync(resolved)
          } catch {
            respondJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'asset not found' } })
            return
          }
          res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' })
          createReadStream(resolved).pipe(res)
          return
        }
        respondJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown recorder route: ${method} ${route}` } })
      } catch (error) {
        const status = Number(error?.status) || 500
        respondJson(res, status, {
          ok: false,
          error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
        })
      }
    }
    try {
      const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
      logger?.info?.(`[recorder] page bridge mounted at ${PREFIX}`)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      logger?.warn?.(`[recorder] could not mount ${PREFIX}: ${error?.message ?? error}`)
      return () => {}
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      return ctx.inject(['webServer'], (scoped) => mount(scoped?.webServer ?? scoped?.get?.('webServer')))
    } catch {
      /* fall through to the synchronous attempt */
    }
  }
  return mount(ctx.get?.('webServer'))
}

/**
 * OneDrive marks synced directories with FILE_ATTRIBUTE_READONLY (and a reparse point), and Node's
 * rmSync cannot clear that attribute — it fails EPERM on the directory itself. Walk the tree and clear
 * the read-only bit before removing; chmod on Windows only toggles that bit, which is all we need.
 */
function clearReadOnly(target) {
  try {
    chmodSync(target, 0o777)
  } catch {
    return
  }
  let entries = []
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(target, entry.name)
    if (entry.isDirectory()) clearReadOnly(child)
    else {
      try {
        chmodSync(child, 0o666)
      } catch {
        /* a locked file is still handled by rmSync's retries */
      }
    }
  }
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('request body is too large'), { code: 'BAD_REQUEST', status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { code: 'BAD_REQUEST', status: 400 })
  }
}

function respondJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST', status: 400 })
}

function forbidden(message) {
  return Object.assign(new Error(message), { code: 'FORBIDDEN', status: 403 })
}
