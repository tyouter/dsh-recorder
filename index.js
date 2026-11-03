/**
 * @tyouter/dsh-recorder — drive another DSH plugin's real UI and film it.
 *
 * Two halves, one bridge:
 *   - this Host half owns the capture process and the tools the model calls;
 *   - the Client half lives in the same page as the plugin being filmed, so it can type, click and
 *     select in that plugin's real DOM — no debug port, no injected script, no change to the target.
 *   - `/recorder/api` carries the steps down and the reports back up.
 *
 * Nothing in the plugin under test has to change: the driver is the recorder's own client half.
 */

import { registerRecorderApi } from './lib/api.js'
import { RecorderEngine } from './lib/engine.js'
import { registerRecorderTools } from './lib/tools.js'

export const inject = ['tools']

const DEFAULTS = {
  /** Python that has Pillow; empty means "find the one this Harness ships". */
  pythonPath: '',
  /** Where recordings go when the Session has no workspace. */
  outDir: '',
  /**
   * On plugin activation, move the app window to the cursor's monitor and maximize it.
   * This is what makes a freshly launched Harness fill the screen at 1:1 instead of opening at the
   * window size it last remembered. Set false to leave window geometry alone.
   */
  maximizeOnStart: true,
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const logger = ctx.logger
  const engine = new RecorderEngine({ ctx, config, logger })

  const disposers = [registerRecorderTools(ctx, engine, logger), registerRecorderApi(ctx, engine, { logger })]

  // The window exists a moment after the Host half activates; retry a few times and give up quietly.
  let fillTimer = null
  let fillAttempt = 0
  const attemptFill = async () => {
    fillAttempt += 1
    try {
      const result = await engine.fillScreen()
      if (result.ok) {
        logger?.info?.('[recorder] window filled to the cursor monitor')
        return
      }
    } catch (error) {
      logger?.warn?.(`[recorder] fill-screen failed: ${error?.message ?? error}`)
    }
    if (fillAttempt < 4 && !engine.disposed) {
      fillTimer = setTimeout(() => {
        void attemptFill()
      }, 2500)
    }
  }
  if (config.maximizeOnStart !== false) {
    fillTimer = setTimeout(() => {
      void attemptFill()
    }, 2500)
  }

  ctx.effect(
    () => () => {
      if (fillTimer !== null) clearTimeout(fillTimer)
      for (const dispose of disposers.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* one failing disposer must not keep the others registered */
        }
      }
      void engine.dispose()
    },
    'dsh-recorder.teardown',
  )

  logger?.info?.(`[recorder] ready; python=${engine.python}`)
  return engine
}

export { RecorderEngine }
