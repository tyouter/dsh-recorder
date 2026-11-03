/**
 * Locating the Python that ships with this Harness, and running the capture script with it.
 *
 * The desktop build bundles a Python under `~/.dsh/dsh-runtimes/<runtime>/dependencies/python/`;
 * other deployments may have a plain `python` on PATH. A configured path always wins.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const SCRIPT = join(PACKAGE_ROOT, 'tools', 'record-window.py')

/** Every candidate, most specific first. */
function candidates(configured) {
  const list = []
  if (typeof configured === 'string' && configured.trim() !== '') list.push(configured.trim())
  if (typeof process.env.DSH_RECORDER_PYTHON === 'string' && process.env.DSH_RECORDER_PYTHON.trim() !== '') {
    list.push(process.env.DSH_RECORDER_PYTHON.trim())
  }
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const entry of readdirSync(runtimes)) {
      list.push(join(runtimes, entry, 'dependencies', 'python', 'python.exe'))
      list.push(join(runtimes, entry, 'dependencies', 'python', 'bin', 'python3'))
    }
  } catch {
    /* no runtime directory: fall through to PATH */
  }
  list.push('python', 'python3', 'py')
  return list
}

/** The first candidate that exists (bare command names count: the shell resolves them). */
export function resolvePython(configured) {
  for (const candidate of candidates(configured)) {
    if (!candidate.includes('\\') && !candidate.includes('/')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'python'
}

/** Run the script to completion and collect its output. */
export function runPython(python, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(python, [SCRIPT, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`could not start Python (${python}): ${error?.message ?? error}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      reject(new Error(`Python timed out after ${timeoutMs} ms\n${stderr.slice(-2000)}`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > 64_000) stdout = stdout.slice(-32_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`could not run ${python}: ${error?.message ?? error}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** The `RECORDER {json}` lines, parsed. */
export function recorderEvents(stdout) {
  const events = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith('RECORDER ')) continue
    try {
      events.push(JSON.parse(line.slice('RECORDER '.length)))
    } catch {
      /* a truncated line is not worth failing over */
    }
  }
  return events
}
