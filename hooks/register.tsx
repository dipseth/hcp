// hcp, a Human Context Protocol: Claude posts cards (choices, handoffs, text
// to share) that the person answers with clicks, and the person sends
// answers, no-reply notes, steers and scheduled messages back without typing
// paragraphs. Cards draw inline at their tool row and in the HCP pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HcpCard, HcpDelivery, HcpMode, HcpScheduled } from '../types'
import {
  ASK_TOOL,
  HANDOFF_TOOL,
  PROTOCOL,
  SERVICES,
  SHARE_TOOL,
  STEERS,
  answerText,
  autoHandoffNote,
  cantText,
  clip,
  deferText,
  detectService,
  formatLocal,
  markdownToHtml,
  markdownToPlain,
  needsAuthServers,
  parseOffset,
  parseOptions,
  parseWhen,
  postedText,
  smartLater,
} from './model'
import type { Steer, When } from './model'
import { cardView, inbox } from './views'
import type { Actions, Snapshot } from './views'

type Engine = EngineInterface

const PANE = 'hcp'
const TOOL_PREFIX = 'mcp__hcp__'

const cards = atom({ plugin: 'hcp', key: 'cards' } as const, [] as HcpCard[])
const queue = atom({ plugin: 'hcp', key: 'queue' } as const, [] as HcpScheduled[])
const mode = atom({ plugin: 'hcp', key: 'mode' } as const, 'pairing' as HcpMode)
const isConcise = atom({ plugin: 'hcp', key: 'isConcise' } as const, false)
const seq = atom({ plugin: 'hcp', key: 'seq' } as const, 0)
const quickSent = atom({ plugin: 'hcp', key: 'quickSent' } as const, 0)

// UTC offset in minutes, from `date +%z`; the hooks environment's own zone may differ.
let offset = -new Date().getTimezoneOffset()
const timers = new Map<string, { cancel: () => void }>()
// Typed but unsent text, kept out of $.state so typing redraws nothing.
const drafts = new Map<string, string>()
let quickDraftText = ''
// Bash calls that raised a handoff: their result rows draw the card.
const handoffCalls = new Set<string>()
// Cards whose press is being handled: a second press before the state lands does nothing.
const busy = new Set<string>()
// Whether a main-conversation turn is running: a prompt submitted now queues behind it.
let isTurnRunning = false

const QUEUED_TOAST = "Queued: Claude picks it up when its current turn ends. The card shows ⏳ until then."

/** What to tell the person after a prompt was handed to the engine. */
function sentToast(wasQueued: boolean) {
  return wasQueued ? QUEUED_TOAST : 'Sent.'
}

function patchCard($: Engine, id: string, fn: (card: HcpCard) => HcpCard) {
  return update($, cards, list => list.map(c => (c.id === id ? fn(c) : c)))
}

async function findCard($: Engine, id: string) {
  return (await read($, cards)).find(c => c.id === id)
}

async function refreshStatus($: Engine) {
  const waiting = (await read($, cards)).filter(c => c.status === 'open').length
  const current = await read($, mode)
  const parts = [waiting > 0 ? `${waiting} waiting on you` : '', current === 'pairing' ? '' : current]
  const text = parts.filter(Boolean).join(' · ')
  $.ui.status(text ? `HCP · ${text}` : undefined)
}

/** A prompt now (the person's own words), or a note Claude reads without replying. */
async function deliver($: Engine, text: string, delivery: 'now' | 'nntr', agentId?: string) {
  if (delivery === 'now') {
    await $.prompt.submit({ text, asUser: true })

    return
  }
  const message = { type: 'user' as const, content: [{ type: 'text' as const, text }] }
  if (agentId !== undefined) {
    try {
      await $.session.append({ message, agentId })

      return
    } catch {
      // The subagent has finished: the note goes to the main conversation.
    }
  }
  await $.session.append({ message })
}

async function later($: Engine): Promise<When> {
  return smartLater(await $.clock.now(), offset)
}

async function fire($: Engine, id: string) {
  timers.delete(id)
  const item = (await read($, queue)).find(q => q.id === id)
  if (!item) return
  await update($, queue, list => list.filter(q => q.id !== id))
  if (item.kind === 'prompt') {
    await $.prompt.submit({ text: item.text, asUser: true })
  } else {
    if (item.cardId) await patchCard($, item.cardId, c => ({ ...c, progress: undefined }))
    $.ui.toast(item.text, { timeoutMs: 10_000 })
    void $.ui.notify(item.text, { title: 'HCP reminder' })
    void $.ui.open({ id: PANE, title: 'HCP' })
  }
}

async function arm($: Engine, item: HcpScheduled) {
  timers.get(item.id)?.cancel()
  const wait = Math.max(0, item.dueAt - (await $.clock.now()))
  timers.set(item.id, $.clock.after(wait, () => void fire($, item.id)))
}

async function schedule($: Engine, item: Omit<HcpScheduled, 'id'>) {
  const scheduled: HcpScheduled = { ...item, id: `q${item.dueAt.toString(36)}${Math.floor(Math.random() * 1e4)}` }
  await update($, queue, list => [...list, scheduled])
  await arm($, scheduled)
}

async function postCard($: Engine, fields: Omit<HcpCard, 'id' | 'status' | 'note' | 'createdAt'>) {
  let n = 0
  await update($, seq, value => {
    n = value + 1

    return n
  })
  const card: HcpCard = {
    ...fields,
    id: `${fields.kind === 'handoff' ? 'h' : 'c'}${n}`,
    status: 'open',
    note: '',
    createdAt: await $.clock.now(),
  }
  await update($, cards, list => [...list, card].slice(-100))
  void $.ui.open({ id: PANE, title: 'HCP' })
  await refreshStatus($)

  return card
}

const blank = { options: [], isMulti: false, picked: [] }

async function raiseAuthHandoff($: Engine, name: string, toolUseId: string | undefined, command: string, agentId?: string) {
  const service = SERVICES[name]!
  const isOpen = (await read($, cards)).some(c => c.kind === 'handoff' && c.service === name && c.status === 'open')
  if (isOpen) return
  const card = await postCard($, {
    ...blank,
    kind: 'handoff',
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    service: name,
    fix: service.fix,
    title: `Re-authenticate ${service.label}`,
    detail: `Failed: ${clip(command.replace(/\s+/g, ' '), 100)}`,
  })
  if (toolUseId !== undefined) handoffCalls.add(toolUseId)
  await deliver($, autoHandoffNote(card), 'nntr', agentId)
  $.ui.toast(`Claude is blocked: ${service.label} credentials expired`, { timeoutMs: 8000 })
  void $.ui.notify(`${service.label} credentials expired. Re-authenticate from the HCP card.`, {
    title: 'Claude is blocked',
  })
}

const MCP_CACHE = '.claude/mcp-needs-auth-cache.json'

/** The MCP servers the engine says need authorizing; empty where it can't be read. */
async function readNeedsAuth($: Engine): Promise<string[]> {
  const home = await $.env.get('HOME')
  if (home === undefined) return []
  try {
    return needsAuthServers(await $.fs.read(`${home}/${MCP_CACHE}`), await $.clock.now())
  } catch {
    return []
  }
}

/** Once per server per session: a card answered or dismissed is not raised again. */
async function raiseMcpHandoff($: Engine, server: string, agentId?: string) {
  const service = `mcp:${server}`
  if ((await read($, cards)).some(c => c.service === service)) return
  const card = await postCard($, {
    ...blank,
    kind: 'handoff',
    ...(agentId !== undefined ? { agentId } : {}),
    service,
    fix: '/mcp',
    title: `Authorize the ${server} MCP server`,
    detail: `Its tools stay unavailable until it's authorized: run /mcp and pick ${server}.`,
  })
  await deliver($, autoHandoffNote(card), 'nntr', agentId)
  void $.ui.notify(`The ${server} MCP server needs authorizing.`, { title: 'Claude is blocked' })
}

// Sets HTML and plain text on the macOS pasteboard together, so a rich editor (Slack, mail,
// a doc) keeps the formatting and a plain-text field still gets words.
const COPY_RICH =
  'ObjC.import("AppKit"); function run(argv) { const pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setStringForType($(argv[0]), $.NSPasteboardTypeHTML); pb.setStringForType($(argv[1]), $.NSPasteboardTypeString); return "ok" }'

async function copyShare($: Engine, id: string, isRich: boolean) {
  const card = await findCard($, id)
  if (!card?.draft) return
  const plain = markdownToPlain(card.draft)
  let isCopied = false
  try {
    const ran = isRich
      ? await $.process.run(['osascript', '-l', 'JavaScript', '-e', COPY_RICH, markdownToHtml(card.draft), plain], { timeoutMs: 10_000 })
      : await $.process.run(['pbcopy'], { stdin: plain, timeoutMs: 10_000 })
    isCopied = ran.exitCode === 0
  } catch {
    isCopied = (await $.ui.copy({ text: plain })).isCopied
  }
  const progress = !isCopied
    ? "Couldn't reach the clipboard: select the text above."
    : isRich
      ? 'Copied with formatting: paste it where it goes.'
      : 'Copied as plain text.'
  await patchCard($, id, c => ({ ...c, progress }))
}

async function answer($: Engine, id: string, delivery: HcpDelivery, note?: string, suffix = '') {
  if (busy.has(id)) return
  busy.add(id)
  try {
    await answerCard($, id, delivery, note, suffix)
  } finally {
    busy.delete(id)
  }
}

async function answerCard($: Engine, id: string, delivery: HcpDelivery, note?: string, suffix = '') {
  const card = await findCard($, id)
  if (!card || card.status !== 'open') return
  const withNote = { ...card, note: note ?? drafts.get(id) ?? card.note }

  if (delivery === 'later' && card.kind === 'handoff') {
    const when = await later($)
    await deliver($, deferText(withNote, when.label), 'nntr', card.agentId)
    await schedule($, { kind: 'remind', text: `Reminder: ${card.title}`, dueAt: when.dueAt, cardId: id })
    await patchCard($, id, c => ({ ...c, progress: `Snoozed until ${when.label}` }))
    $.ui.toast(`Claude knows you'll do it ${when.label}; reminder set.`)

    return
  }

  const text = answerText(withNote, delivery === 'nntr' ? 'nntr' : 'now')
  if (text === undefined) {
    $.ui.toast('Pick an option or write a note first.')

    return
  }
  const full = text + suffix

  drafts.delete(id)
  if (delivery === 'later') {
    const when = await later($)
    await schedule($, { kind: 'prompt', text: full, dueAt: when.dueAt, cardId: id })
    $.ui.toast(`Will send ${when.label}.`)
  } else if (delivery === 'nntr') {
    await deliver($, full, delivery, card.agentId)
    $.ui.toast('Noted. Claude sees it without replying.')
  } else {
    // The card turns ⏳ before the engine is asked: a prompt submitted mid-turn resolves
    // only once the running turn ends, and the person must see the press landed.
    const wasQueued = isTurnRunning
    await patchCard($, id, c => ({ ...c, note: withNote.note, status: 'queued', delivery, answer: full, progress: undefined }))
    await refreshStatus($)
    $.ui.toast(sentToast(wasQueued))
    await deliver($, full, delivery, card.agentId)
  }
  await patchCard($, id, c => ({ ...c, note: withNote.note, status: 'answered', delivery, answer: full, progress: undefined }))
  await refreshStatus($)
}

async function verifyAndSend($: Engine, id: string) {
  if (busy.has(id)) return
  busy.add(id)
  try {
    await verifyThenAnswer($, id)
  } finally {
    busy.delete(id)
  }
}

async function verifyThenAnswer($: Engine, id: string) {
  const card = await findCard($, id)
  if (card?.service?.startsWith('mcp:')) {
    const server = card.service.slice(4)
    const isListed = (await readNeedsAuth($)).includes(server)
    if (isListed && !card.progress?.startsWith('Still listed')) {
      await patchCard($, id, c => ({ ...c, progress: 'Still listed as needing auth. Press Done again to send anyway.' }))

      return
    }
    await answerCard($, id, 'now', undefined, isListed ? '' : ` (${server} is no longer listed as needing auth.)`)

    return
  }
  const service = card?.service === undefined ? undefined : SERVICES[card.service]
  if (!card || !service) {
    await answerCard($, id, 'now')

    return
  }
  await patchCard($, id, c => ({ ...c, progress: `Checking with ${service.verify.join(' ')}…` }))
  try {
    const ran = await $.process.run(service.verify, { timeoutMs: 60_000 })
    if (ran.exitCode !== 0) {
      const why = (ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''
      await patchCard($, id, c => ({ ...c, progress: `Still failing: ${clip(why, 140)}` }))

      return
    }
    await answerCard($, id, 'now', undefined, ` (Verified: \`${service.verify.join(' ')}\` passed.)`)
  } catch {
    await answerCard($, id, 'now', undefined, " (The mod couldn't run the check itself.)")
  }
}

function actionsFor($: Engine): Actions {
  return {
    pick: (id, value) =>
      void patchCard($, id, c => {
        const isPicked = c.picked.includes(value)
        if (c.isMulti) return { ...c, picked: isPicked ? c.picked.filter(v => v !== value) : [...c.picked, value] }

        return { ...c, picked: isPicked ? [] : [value] }
      }),
    draft: (id, text) => void drafts.set(id, text),
    answer: (id, delivery, note) => void answer($, id, delivery, note),
    dismiss: id =>
      void patchCard($, id, c => ({ ...c, status: 'dismissed', progress: undefined })).then(() => refreshStatus($)),
    fill: id =>
      void findCard($, id).then(async card => {
        if (!card?.fix) return
        const text = card.fix.startsWith('/') ? card.fix : `! ${card.fix}`
        const { isFilled } = await $.prompt.fill({ text, mode: 'replace' })
        $.ui.toast(isFilled ? 'In your prompt box: press Enter to run it.' : `Run this yourself: ${text}`)
      }),
    runFix: id =>
      void (async () => {
        const card = await findCard($, id)
        if (!card?.fix) return
        await patchCard($, id, c => ({ ...c, progress: `Running ${card.fix}: finish it in the browser…` }))
        try {
          const ran = await $.process.run(card.fix.split(' '), { timeoutMs: 300_000 })
          if (ran.exitCode !== 0) {
            const why = ran.stderr.trim().split('\n').pop() ?? ''
            await patchCard($, id, c => ({ ...c, progress: `Login exited ${ran.exitCode}: ${clip(why, 120)}` }))

            return
          }
        } catch {
          await patchCard($, id, c => ({ ...c, progress: "Couldn't start it from here: use Put in prompt." }))

          return
        }
        await verifyAndSend($, id)
      })(),
    done: id => void verifyAndSend($, id),
    copy: (id, isRich) => void copyShare($, id, isRich),
    finish: id =>
      void patchCard($, id, c => ({ ...c, status: 'answered', answer: `Shared: ${c.title}`, progress: undefined })).then(() =>
        refreshStatus($),
      ),
    authorizeMcp: () =>
      void $.prompt.fill({ text: '/mcp', mode: 'replace' }).then(({ isFilled }) =>
        $.ui.toast(isFilled ? 'In your prompt box: press Enter, then pick the server.' : 'Run /mcp and pick the server.'),
      ),
    cant: id =>
      void (async () => {
        if (busy.has(id)) return
        busy.add(id)
        try {
          const card = await findCard($, id)
          if (!card || card.status !== 'open') return
          const withNote = { ...card, note: drafts.get(id) ?? card.note }
          const text = cantText(withNote)
          await deliver($, text, 'nntr', card.agentId)
          await patchCard($, id, c => ({ ...c, note: withNote.note, status: 'answered', delivery: 'nntr', answer: text }))
          $.ui.toast('Claude will work around it.')
          await refreshStatus($)
        } finally {
          busy.delete(id)
        }
      })(),
    setMode: next =>
      void (async () => {
        if ((await read($, mode)) === next) return
        await update($, mode, () => next)
        await deliver($, `[HCP mode] ${next}`, 'nntr')
        await refreshStatus($)
      })(),
    toggleConcise: () =>
      void (async () => {
        let isOn = false
        await update($, isConcise, value => (isOn = !value))
        await deliver($, `[HCP concise] ${isOn ? 'on' : 'off'}`, 'nntr')
      })(),
    steer: (kind: Steer) =>
      void deliver($, `[HCP steer] ${STEERS[kind]}`, 'nntr').then(() =>
        $.ui.toast('Steer sent: Claude picks it up at its next step.'),
      ),
    quick: kind =>
      void (async () => {
        if (kind === 'yes' || kind === 'no') {
          $.ui.toast(sentToast(isTurnRunning))
          await deliver($, kind === 'yes' ? 'Yes.' : 'No.', 'now')
        } else {
          const text = kind === 'ack' ? '👍 Seen.' : kind === 'yes-nntr' ? 'Yes.' : 'No.'
          await deliver($, `[HCP · NNTR] ${text}`, 'nntr')
          $.ui.toast('Noted. Claude sees it without replying.')
        }
      })(),
    quickDraft: text => void (quickDraftText = text),
    quickSend: (delivery, typed) =>
      void (async () => {
        const text = (typed ?? quickDraftText).trim()
        if (!text) {
          $.ui.toast('Type a message first.')

          return
        }
        quickDraftText = ''
        // The field clears before the engine is asked, since a mid-turn prompt resolves late.
        await update($, quickSent, n => n + 1)
        if (delivery === 'later') {
          const when = await later($)
          await schedule($, { kind: 'prompt', text, dueAt: when.dueAt })
          $.ui.toast(`Will send ${when.label}.`)
        } else if (delivery === 'nntr') {
          await deliver($, `[HCP · NNTR] ${text}`, 'nntr')
          $.ui.toast('Noted. Claude sees it without replying.')
        } else {
          $.ui.toast(sentToast(isTurnRunning))
          await deliver($, text, 'now')
        }
      })(),
    sendQueued: id =>
      void (async () => {
        timers.get(id)?.cancel()
        await fire($, id)
      })(),
    cancelQueued: id =>
      void (async () => {
        timers.get(id)?.cancel()
        timers.delete(id)
        await update($, queue, list => list.filter(q => q.id !== id))
      })(),
    clearHistory: () => void update($, cards, list => list.filter(c => c.status === 'open')),
  }
}


async function snapshot($: Engine): Promise<Snapshot> {
  const at = await $.clock.now()

  return {
    cards: await read($, cards),
    queue: await read($, queue),
    mode: await read($, mode),
    isConcise: await read($, isConcise),
    quickSent: await read($, quickSent),
    laterLabel: smartLater(at, offset).label,
    needsAuth: await readNeedsAuth($),
    formatAt: ms => formatLocal(ms, offset, at),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5000 })
      offset = parseOffset(zone.stdout) ?? offset
    } catch {
      // No process access (tests, a restricted host): keep the environment's own offset.
    }

    await Promise.all([
      $.tool.register(ASK_TOOL),
      $.tool.register(HANDOFF_TOOL),
      $.tool.register(SHARE_TOOL),
      $.command.register({
        name: 'hcp',
        description: 'Open the HCP pane: cards waiting on you, quick replies, steers, mode',
        argumentHint: '[pairing|heads-down|away|clear]',
      }),
      $.command.register({
        name: 'nntr',
        description: 'Tell Claude something it should take in without replying',
        argumentHint: '<note>',
        immediate: true,
      }),
      $.command.register({
        name: 'later',
        description: 'Send Claude a message later: 30m, 2h, 9am, 14:30, tomorrow, or smart by default',
        argumentHint: '[when] <message>',
      }),
    ])

    for (const card of await read($, cards)) {
      if (card.kind === 'handoff' && card.toolUseId) handoffCalls.add(card.toolUseId)
    }
    for (const item of await read($, queue)) await arm($, item)
    await refreshStatus($)

    return next(e)
  })

  // Whether the main conversation is mid-turn decides what a press is told: sent, or queued.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = true

    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'hcp:protocol', text: PROTOCOL, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__hcp__ask' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const options = parseOptions(input.options)
    if (typeof input.title !== 'string' || options.length < 2) {
      return { deny: 'ask needs a `title` and at least two `options` of { value, label }.' }
    }
    const isMulti = input.multi === true
    const wanted = Array.isArray(input.recommended)
      ? input.recommended
      : typeof input.recommended === 'string'
        ? [input.recommended]
        : []
    const picked = options.map(o => o.value).filter(v => wanted.includes(v))
    const card = await postCard($, {
      ...blank,
      kind: 'ask',
      toolUseId: e.tool_use_id,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      title: input.title,
      ...(typeof input.detail === 'string' ? { detail: input.detail } : {}),
      ...(typeof input.draft === 'string' ? { draft: input.draft } : {}),
      options,
      isMulti,
      picked: isMulti ? picked : picked.slice(0, 1),
    })

    return { result: postedText(card) }
  }).catch(() => ({ deny: 'hcp could not post the card; ask in prose this time.' }))

  on('tool.call', { tool: 'mcp__hcp__handoff' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.title !== 'string') return { deny: 'handoff needs a `title`.' }
    const card = await postCard($, {
      ...blank,
      kind: 'handoff',
      toolUseId: e.tool_use_id,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      title: input.title,
      ...(typeof input.detail === 'string' ? { detail: input.detail } : {}),
      ...(typeof input.fix === 'string' ? { fix: input.fix } : {}),
    })
    void $.ui.notify(card.title, { title: 'Claude needs you' })

    return { result: postedText(card) }
  }).catch(() => ({ deny: 'hcp could not post the card; ask in prose this time.' }))

  on('tool.call', { tool: 'mcp__hcp__share' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.title !== 'string' || typeof input.text !== 'string') {
      return { deny: 'share needs a `title` and the `text` to paste.' }
    }
    const card = await postCard($, {
      ...blank,
      kind: 'share',
      toolUseId: e.tool_use_id,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      title: input.title,
      draft: input.text,
      ...(typeof input.audience === 'string' ? { audience: input.audience } : {}),
    })

    return { result: postedText(card) }
  }).catch(() => ({ deny: 'hcp could not post the card; print the text this time.' }))

  // Searching for an unauthorized server's tools is the moment it matters: raise its handoff then.
  on('tool.call', { tool: 'ToolSearch' }, async ($, e, next) => {
    const ran = await next(e)
    const query = e.query.toLowerCase()
    for (const server of await readNeedsAuth($)) {
      if (query.includes(server.toLowerCase())) await raiseMcpHandoff($, server, e.agentId)
    }

    return ran
  }).catch(($, e, next) => next(e))

  // An expired login fails a Bash call: raise a handoff instead of letting Claude debug it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const result = ran.result as { stderr?: unknown } | undefined
    const scanned = ran.isError ? (ran.text ?? '') : typeof result?.stderr === 'string' ? result.stderr : ''
    const name = detectService(e.command, scanned)
    if (name !== undefined) await raiseAuthHandoff($, name, e.tool_use_id, e.command, e.agentId)

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hcp' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'pairing' || arg === 'heads-down' || arg === 'away') {
      actionsFor($).setMode(arg as HcpMode)

      return { text: `HCP mode: ${arg}.` }
    }
    if (arg === 'clear') {
      await update($, cards, list => list.filter(c => c.status === 'open'))

      return { text: 'HCP history cleared.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'HCP' })

    return { text: opened.isPlaced ? 'HCP pane opened.' : 'HCP' }
  })

  on('command.run', { command: 'nntr' }, async ($, e) => {
    const note = e.args.trim()
    if (!note) return { text: 'Usage: /nntr <note>. Claude takes it in without replying.' }

    return { text: `[HCP · NNTR] ${note}` }
  })

  on('command.run', { command: 'later' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const at = await $.clock.now()
    const parsed = parseWhen(first, at, offset)
    const when = parsed ?? smartLater(at, offset)
    const text = (parsed ? rest.join(' ') : e.args).trim()
    if (!text) return { text: 'Usage: /later [30m|2h|9am|14:30|tomorrow] <message>' }
    await schedule($, { kind: 'prompt', text, dueAt: when.dueAt })

    return { text: `Scheduled for ${when.label}, not for now: "${clip(text, 80)}"` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    inbox($.ui.resolve(e), await snapshot($), actionsFor($)),
  )

  // Where no surface places the pane (VS Code may not), /hcp draws the inbox inline.
  on('ui.render', { component: 'CommandOutput', props: { command: 'hcp' } }, async ($, e, next) => {
    const isPlaced = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (isPlaced || e.props.text !== 'HCP') return next(e)

    return inbox($.ui.resolve(e), await snapshot($), actionsFor($))
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!e.props.tool.startsWith(TOOL_PREFIX) || e.props.isExpanded) return next(e)
    const card = (await read($, cards)).find(c => c.toolUseId === e.props.tool_use_id)
    if (!card) return next(e)

    return cardView($.ui.resolve(e), card, actionsFor($), (await snapshot($)).laterLabel)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    if (e.props.tool.startsWith(TOOL_PREFIX)) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    if (!handoffCalls.has(e.props.tool_use_id)) return next(e)
    const card = (await read($, cards)).find(c => c.toolUseId === e.props.tool_use_id)
    if (!card) return next(e)
    const els = $.ui.resolve(e)
    const { Box } = els

    return (
      <Box flexDirection="column">
        {await next(e)}
        {cardView(els, card, actionsFor($), (await snapshot($)).laterLabel)}
      </Box>
    )
  })
}
