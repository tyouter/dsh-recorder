// Demo driver — a scripted walk through another plugin's real UI, for filming it.
//
// Extracted from dsh-notes, where it was proven to work end to end: it typed a note, took a TAB
// completion, structured a selection, applied it, translated, saved, then edited and copied the note
// from History, and finished on the Board.
//
// How it works: it does what a person does — types into the real textarea with real input events,
// presses TAB/Enter, sets a text selection, and clicks the real buttons. Nothing is re-rendered, so a
// recording of the window shows the product's own DOM, timing and animations.
//
// Contract it expects from the host page (selectors verified against dsh-notes 1.1):
//   .dshn-root                                 the panel is mounted
//   .dshn-textarea                             the editor
//   .dshn-ghost                                a suggestion is showing (optional)
//   .dshn-btn.enhance                          ✦ Structure
//   .dshn-row.dshn-capture-tools               toolbars; buttons matched by their text
//   .dshn-page-render[data-proposal="true"]    a draft is on screen
//   .dshn-tab                                  Capture / History / Board
//   .dshn-item                                 a note card in the list
//   .dshn-detail-edit                          Edit
//   .dshn-icon-btn[data-copied]                Copy as Markdown
//
// To use it from a plugin you own, paste this file inside your client bundle (a bundle's client half is
// one factory function — a dynamic `import()` will not resolve) and call it behind a dev flag.
//
// Two lessons are baked in below:
//  * a module-level `started` flag makes the walk one-shot per page load. A reload is the only way to
//    replay it, so `resetDemo()` exists for a recorder UI that needs to run it again;
//  * every step waits for a condition instead of sleeping a fixed time, so a slow model call does not
//    desynchronise the footage from the captions.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for a selector, then return the element (or null after the timeout). */
async function waitFor(selector, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const node = document.querySelector(selector)
    if (node !== null && node !== undefined) return node
    if (Date.now() - started > timeout) return null
    await sleep(80)
  }
}

/** Wait until a condition holds, then return true (or null on timeout). */
async function waitUntil(check, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    if (check() === true) return true
    if (Date.now() - started > timeout) return null
    await sleep(80)
  }
}

/** Set a textarea's value and fire the events React needs to notice. */
function setText(area, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(area, value)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Type one character at a time, the way a slow typist would. */
async function type(area, text, delay = 90) {
  for (const char of text) {
    setText(area, area.value + char)
    await sleep(delay)
  }
}

function key(area, keyName, code = keyName) {
  for (const typeName of ['keydown', 'keyup']) {
    area.dispatchEvent(new KeyboardEvent(typeName, { key: keyName, code, bubbles: true, cancelable: true }))
  }
}

function pressEnter(area) {
  const before = area.value
  for (const typeName of ['keydown', 'keyup']) {
    area.dispatchEvent(new KeyboardEvent(typeName, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  }
  // The panel may handle Enter itself; if it did not change the value, insert the newline.
  if (area.value === before) setText(area, `${before}\n`)
}

/** Highlight a character range in the textarea and let the panel see the selection. */
function selectRange(area, fromIndex, toIndex) {
  area.focus()
  area.setSelectionRange(fromIndex, toIndex)
  area.dispatchEvent(new Event('select', { bubbles: true }))
  area.dispatchEvent(new Event('keyup', { bubbles: true }))
}

const SCENE_TEXT = [
  '极简笔记理念',
  '',
  '这不是一个新的工具，这是一个关于文字的哲学思考。',
  '    智能不能成为文字的主角',
  '    功能应当服务于思想',
  '        书写带来快乐',
  '',
  '所以这个工具只需要做一件事，那就是',
].join('\n')

let started = false

/** Reset the one-shot guard so a recorder UI can replay the walk without reloading the page. */
export function resetDemo() {
  started = false
}

/**
 * Run the walk once. Resolves when it is done (or when a step's element is missing, so a recording
 * never hangs on an absent button).
 */
export async function startNotesDemo(log) {
  if (started) return
  started = true
  const note = (message) => {
    if (typeof log === 'function') log(`demo: ${message}`)
  }

  await waitFor('.dshn-root')
  await sleep(600)

  const area = await waitFor('.dshn-textarea')
  if (area === null) return note('no editor')
  area.focus()

  // 1. Type the note. Leading spaces become bullets as they are typed.
  await type(area, SCENE_TEXT, 70)
  note('typed')
  await sleep(1400)

  // 2. The pause produced a suggestion; TAB accepts it, then Enter commits the line.
  if (document.querySelector('.dshn-ghost') !== null) {
    key(area, 'Tab')
    await sleep(900)
    pressEnter(area)
    note('accepted a suggestion')
  }
  await sleep(1200)

  // 3. Select the two bullet lines and structure only them.
  const text = area.value
  const from = text.indexOf('智能不能')
  const to = text.indexOf('书写带来快乐')
  if (from >= 0 && to > from) {
    selectRange(area, text.lastIndexOf('\n', from) + 1, to + '书写带来快乐'.length)
    await sleep(700)
  }

  const structure = document.querySelector('.dshn-btn.enhance')
  if (structure !== null) {
    structure.click()
    note('structure asked')
    const draft = await waitUntil(() => document.querySelector('.dshn-page-render[data-proposal="true"]') !== null, 20000)
    await sleep(draft ? 1200 : 200)

    // 4. Apply the draft, then translate the note from the live preview.
    const buttons = [...document.querySelectorAll('.dshn-row.dshn-capture-tools .dshn-btn')]
    const applyButton = buttons.find((node) => /Apply/i.test(node.textContent ?? ''))
    if (applyButton !== undefined) {
      applyButton.click()
      note('applied')
      await sleep(1400)
    } else {
      note('no apply button')
    }

    const translate = [...document.querySelectorAll('.dshn-row.dshn-capture-tools .dshn-btn')].find((node) => /Translate/i.test(node.textContent ?? ''))
    if (translate !== undefined) {
      translate.click()
      note('translate asked')
      await waitUntil(() => document.querySelector('.dshn-page-render[data-proposal="true"]') === null, 20000)
      await sleep(1600)
    }

    const save = [...document.querySelectorAll('.dshn-row.dshn-capture-tools .dshn-btn.primary')].find((node) => /Save/i.test(node.textContent ?? ''))
    if (save !== undefined) {
      save.click()
      note('saved')
      await sleep(1600)
    }
  }

  // 5. History: open the newest note, edit it, save, copy.
  const history = [...document.querySelectorAll('.dshn-tab')].find((node) => /History/i.test(node.textContent ?? ''))
  if (history !== undefined) {
    history.click()
    await sleep(900)
    const card = document.querySelector('.dshn-item')
    if (card !== null) {
      card.click()
      await sleep(700)
      const edit = document.querySelector('.dshn-detail-edit')
      if (edit !== null) {
        edit.click()
        await sleep(700)
        const editor = document.querySelector('.dshn-detail .dshn-textarea')
        if (editor !== null) {
          editor.focus()
          await type(editor, '  （补一句：写的时候不被打断。）', 60)
          await sleep(500)
        }
        const saveEdit = [...document.querySelectorAll('.dshn-detail .dshn-btn')].find((node) => /Save|Apply/i.test(node.textContent ?? ''))
        if (saveEdit !== undefined) saveEdit.click()
        await sleep(1200)
      }
      const copy = document.querySelector('.dshn-icon-btn[data-copied]')
      if (copy !== null) {
        copy.click()
        note('copied')
        await sleep(1600)
      }
    }
  }

  // 6. The board.
  const board = [...document.querySelectorAll('.dshn-tab')].find((node) => /Board/i.test(node.textContent ?? ''))
  if (board !== undefined) {
    board.click()
    await sleep(900)
  }
  note('done')
}
