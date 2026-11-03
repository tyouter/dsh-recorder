/**
 * The model-facing tools: list windows, read a page's controls, drive them like a person, record.
 *
 * Every call that touches the page goes through the engine's job bridge, so the tool stays a thin
 * adapter: validate the argument shape, hand it over, return what came back.
 */

import { runPython } from './python.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'recorder 操作结果；字段随动作变化，路径均为绝对路径。',
}

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      enum: ['openPanel', 'click', 'type', 'setValue', 'key', 'select', 'wait', 'sleep', 'scroll', 'focus'],
      description: '这一步做什么。',
    },
    selector: { type: 'string', description: 'CSS 选择器；openPanel/sleep 不需要。' },
    text: {
      type: 'string',
      description: 'click 时按文字挑选匹配元素；type/setValue 要写入的文字；select 时要选中的文本片段。',
    },
    panel: { type: 'string', description: 'openPanel：main 面板的 key，例如 notes。' },
    key: { type: 'string', description: 'key：键名，例如 Tab / Enter / Escape / ArrowDown。' },
    from: { type: 'number', description: 'select：选区起点（字符下标，与 text 二选一）。' },
    to: { type: 'number', description: 'select：选区终点（字符下标）。' },
    ms: { type: 'number', description: 'sleep：毫秒数；type：每个字的间隔（默认 60）。' },
    timeoutMs: { type: 'number', description: 'wait：最长等待毫秒数（默认 8000）。' },
  },
  required: ['op'],
}

const STEPS_PARAM = {
  type: 'array',
  description: [
    '按顺序执行的操作，做成得像人在操作：',
    'openPanel {panel} 切到目标插件面板；click {selector,text} 点按钮/标签页；type {selector,text,ms} 逐字输入；',
    'setValue {selector,text} 一次性填入；key {selector,key} 按键；select {selector,text|from,to} 选中文字；',
    'wait {selector,timeoutMs} 等元素出现；sleep {ms} 停顿；scroll/focus {selector}。',
    '选择一个都不存在的元素会记为该步失败并继续下一步（除非 strict）。',
  ].join(''),
  items: STEP_SCHEMA,
}

const stepsParam = () => JSON.parse(JSON.stringify(STEPS_PARAM))

function text(title, lines) {
  return [{ type: 'text', text: `${title}\n\n${lines.filter((line) => line !== undefined && line !== null && line !== '').join('\n')}` }]
}

/** Tool results must be lossless JSON: drop undefined fields and non-plain values at the boundary. */
function lossless(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

function summaryOf(report) {
  if (report === null || typeof report !== 'object') return []
  const log = Array.isArray(report.log) ? report.log : []
  const lines = []
  for (const entry of log.slice(0, 40)) {
    const status = entry?.ok === false ? '✗' : '✓'
    lines.push(`${status} ${entry?.op ?? '?'}${entry?.detail ? ` — ${entry.detail}` : ''}${entry?.error ? ` — ${entry.error}` : ''}`)
  }
  if (log.length > 40) lines.push(`…还有 ${log.length - 40} 步`)
  return lines
}

function recordSummary(value) {
  const lines = []
  if (value?.gif !== undefined) lines.push(`GIF：${value.gif}`)
  if (value?.seconds !== undefined) lines.push(`时长 ${value.seconds}s · ${value.frames} 帧 · ${Math.round((value.bytes ?? 0) / 1024)} KB`)
  if (value?.probe !== undefined) lines.push(`采样帧：${value.probe}`)
  if (value?.warning !== undefined) lines.push(`⚠ ${value.warning}`)
  for (const still of Array.isArray(value?.stills) ? value.stills : []) lines.push(`截图 @${still.at}s：${still.path}`)
  return lines
}

export function registerRecorderTools(ctx, engine, logger) {
  const tools = ctx.tools ?? ctx.get?.('tools')
  if (tools === undefined) {
    logger?.warn?.('[recorder] tool registry is unavailable: no recorder tools are exposed')
    return () => {}
  }
  const disposers = []
  const register = (definition) => {
    try {
      disposers.push(tools.register(definition))
    } catch (error) {
      logger?.warn?.(`[recorder] could not register ${definition.name}: ${error?.message ?? error}`)
    }
  }

  register({
    name: 'recorder_windows',
    description: [
      '列出可以录制的窗口（标题、屏幕坐标、大小）。开始录制前先看这里，确认目标窗口和它当前在屏幕上的位置。',
      '窗口标题不唯一，主窗口通常是面积最大的那个；如果录到错的窗口，改用 recorder_start 的 rect 精确指定。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text('recorder_windows 结果', [JSON.stringify(value, null, 2)]) },
    async execute() {
      const health = engine.health()
      const result = await runPython(engine.python, ['--list', '--json'], { timeoutMs: 20_000 })
      if (result.code !== 0) throw new Error(`window enumeration failed\n${(result.stderr || result.stdout).slice(-1200)}`)
      let windows = []
      try {
        windows = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '[]')
      } catch {
        throw new Error(`could not parse the window list: ${result.stdout.slice(0, 400)}`)
      }
      return lossless({
        windows,
        capture: health.capture,
        python: health.python,
        hint: 'title 取一个子串即可；rect 是屏幕坐标 [left, top, width, height]。',
      })
    },
  })

  register({
    name: 'recorder_scan',
    description: [
      '扫描 Harness 页面里当前可见的可交互元素（按钮、输入框、标签页、开关），返回它们的文字、CSS 选择器和位置。',
      '它读的是真实 DOM，所以拿到的是目标插件此刻真实的选择器——给 recorder_start / recorder_drive 写步骤前用它，不要凭猜测写选择器。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '只扫描这个容器内的元素；留空扫描整页。' },
        max: { type: 'number', description: '最多返回多少个元素，默认 60，上限 120。' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text('recorder_scan 结果', [JSON.stringify(value, null, 2)]) },
    async execute(args) {
      const report = await engine.scan(args ?? {})
      if (report?.ok === false) throw new Error(String(report.error ?? 'scan failed'))
      return lossless(report?.data ?? report)
    },
  })

  register({
    name: 'recorder_start',
    description: [
      '开始录制一个窗口或矩形。录制会一直进行到 recorder_stop（或页面上的停止按钮），所以可以先 start，再用 recorder_drive 让页面自动操作。',
      '返回录制状态、采样帧 probe 和实际捕获目标。录制开始后先看一眼 probe（用 read_image），确认画面里是目标窗口而不是被别的窗口盖住。',
      '先确认浏览器端已连接：返回的 clientConnected 为 false 时，页面还没加载 recorder 客户端（安装后刷新一次即可）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['window', 'rect'], description: 'window 按标题找窗口；rect 精确指定屏幕矩形。默认 window。' },
        title: { type: 'string', description: 'target=window：窗口标题子串，默认 DeepSeek Harness。' },
        rect: {
          type: 'array',
          items: { type: 'number' },
          description: 'target=rect：屏幕坐标 [left, top, width, height]，取自 recorder_windows。',
        },
        fps: { type: 'number', description: '帧率，默认 6，范围 0.5–30。演示打字用 6–8 足够。' },
        width: { type: 'number', description: 'GIF 宽度像素，默认 900，范围 240–2400。' },
        maxSeconds: { type: 'number', description: '安全上限，默认 300 秒。' },
        outDir: { type: 'string', description: '输出根目录；默认是当前工作区的 recordings/。' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text('recorder_start 结果', [JSON.stringify(value, null, 2)]) },
    async execute(args, exec) {
      return lossless(await engine.start(args ?? {}, exec?.agent))
    },
  })

  register({
    name: 'recorder_drive',
    description: [
      '在当前 Harness 页面里按步骤操作目标插件的真实界面：打字、点击、按键、选中文字、切换面板。',
      '它等所有步骤执行完才返回，并逐步报告成功/失败；录制中用它制造素材，也可以不录制单独排练一遍。',
      '选择器先用 recorder_scan 取真实值。只操作目标插件自己的界面；界面里的每次点击都是真实的，会真的改状态。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        steps: stepsParam(),
        strict: { type: 'boolean', description: 'true 时某一步失败就停止；默认继续下一步。' },
        settleMs: { type: 'number', description: '最后一步结束后再停留多久（毫秒），默认 0；录制时通常 800–1500。' },
        timeoutMs: { type: 'number', description: '整段操作的上限，默认 120000 毫秒。' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text('recorder_drive 结果', summaryOf(value)) },
    async execute(args) {
      const report = await engine.drive(args?.steps, args ?? {})
      return lossless(report)
    },
    timeoutMs: 960_000,
  })

  register({
    name: 'recorder_stop',
    description: [
      '结束录制并生成 GIF。可顺便按时间点导出 PNG 截图（相对录制开始，秒）。',
      '返回 gif / frames / seconds 与截图路径；GIF 通常用 present 交给用户。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        stills: {
          type: 'array',
          items: { type: 'number' },
          description: '要导出的时间点（秒），例如 [1.5, 4, 8]；最多 12 个。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text('recorder_stop 结果', recordSummary(value)) },
    async execute(args) {
      return lossless(await engine.stop(args ?? {}))
    },
    timeoutMs: 300_000,
  })

  register({
    name: 'recorder_demo',
    description: [
      '一次完成整段演示：开始录制 → 按步骤操作页面 → 收尾停留 → 生成 GIF（可同时导出截图）。',
      '给某个插件做演示视频时首选它，比手工 start/drive/stop 少三次往返。',
      '步骤用 recorder_scan 取到的真实选择器；开始前确认目标插件已经打开或第一步用 openPanel 切过去。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        steps: stepsParam(),
        strict: { type: 'boolean', description: 'true 时某一步失败就停止；默认继续下一步。' },
        settleMs: { type: 'number', description: '最后一步后停留多久再停止，默认 1200 毫秒。' },
        stills: { type: 'array', items: { type: 'number' }, description: '要导出的时间点（秒），最多 12 个。' },
        target: { type: 'string', enum: ['window', 'rect'], description: '默认 window。' },
        title: { type: 'string', description: '窗口标题子串，默认 DeepSeek Harness。' },
        rect: { type: 'array', items: { type: 'number' }, description: 'target=rect 时的屏幕矩形。' },
        fps: { type: 'number', description: '帧率，默认 6。' },
        width: { type: 'number', description: 'GIF 宽度像素，默认 900。' },
        outDir: { type: 'string', description: '输出根目录；默认当前工作区的 recordings/。' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => text('recorder_demo 结果', [...recordSummary(value), '', ...summaryOf(value?.walk)]),
    },
    timeoutMs: 960_000,
    async execute(args, exec) {
      return lossless(await engine.demo(args ?? {}, exec?.agent))
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* one failing disposer must not keep the others registered */
      }
    }
  }
}
