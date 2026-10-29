// hcp, a Human Context Protocol: Claude posts cards (choices, handoffs, text
// to share) that the person answers with clicks, and the person sends
// answers, no-reply notes, steers and scheduled messages back without typing
// paragraphs. Cards draw inline at their tool row and in the HCP pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { HcpApproval, HcpCard, HcpDecision, HcpDelivery, HcpEvidence, HcpGrant, HcpLink, HcpMedia, HcpMode, HcpOutward, HcpScheduled } from '../types'
import { bindInterrupts, bindSession, loadHistory, pipelineTool, resolved, shadow, shadowReport } from './decide'
import {
  EVIDENCE_TOOL,
  LINK_COMMANDS,
  addedLinkNote,
  commandLabel,
  dropEvidence,
  evidenceText,
  harvestLinks,
  mergeEvidence,
  normalizeHref,
  parseLinks,
  parseTypedLink,
  rankEvidence,
  updateEvidence,
} from './evidence'
import type { EvidenceMeta } from './evidence'
import { DEFAULT_LAYOUT, LAYOUT_TOOL, layoutDescription, layoutRequestText, parseLayout } from './layout'
import type { LayoutFile } from './layout'
import { useOptions } from './langfuse'
import { existing, expandAll, pastedImages, prepare, saveBytes, thumbnails } from './media'
import { allowInSettings, answerRows, interruptRows, loadMemory, pressesFor, readSteers, rememberAnswer, rememberInterrupt, rememberPress, ruleFor, saveSteers } from './memory'
import { appendLedger, decidePort, generatePort, initObservability, reachPorts, ROUTES, scoresPort, tracerFor, within } from './ports'
import { floorOf } from './surface'
import type { Judged } from './ports'
import { blankQuotes, callKey, classifyCall, reachPipeline, recordOf, scopeOf } from './reach'
import { DEFAULT_STEERS, STEER_ROUTE, missedQuestions, needsBuild, notesFor, projectOf, saidOf, steerInput, steersPipeline } from './steers'
import type { InterruptRow, SteerDef, TurnCall } from './steers'
import { hashToUnit } from './vendor/dp.js'
import type { CallFacts, ReachVerdict, SettingsVerdict } from './reach'
import { runPipeline, submitFeedback } from './vendor/dp.js'
import type { RunRecord } from './vendor/dp.js'
import {
  ASK_TOOL,
  DECIDED_TOOL,
  HANDOFF_TOOL,
  PIPELINE_TOOL,
  MAX_MEDIA,
  SHARE_TOOL,
  VIDEO_FILE,
  answerText,
  applyExtensions,
  attachedText,
  autoHandoffNote,
  cantText,
  clip,
  deferText,
  detectService,
  GRANT_HOURS,
  formatLocal,
  heldText,
  judge,
  markdownToHtml,
  markdownToPlain,
  needsAuthServers,
  parseExtension,
  parseMedia,
  parseOffset,
  parseOptions,
  parseWhen,
  postedText,
  protocolText,
  reachAnswerText,
  reachTags,
  services,
  smartLater,
  splitPaths,
  withTweak,
} from './model'
import type { Extension, ReachChoice, When } from './model'
import { cardView, inbox, reachBadge } from './views'
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
const active = atom({ plugin: 'hcp', key: 'active' } as const, '')
const outbox = atom({ plugin: 'hcp', key: 'outbox' } as const, [] as HcpMedia[])
const fromYou = atom({ plugin: 'hcp', key: 'fromYou' } as const, [] as HcpMedia[])
const grants = atom({ plugin: 'hcp', key: 'grants' } as const, [] as HcpGrant[])
const outward = atom({ plugin: 'hcp', key: 'outward' } as const, [] as HcpOutward[])
const approvals = atom({ plugin: 'hcp', key: 'approvals' } as const, [] as HcpApproval[])
const decisions = atom({ plugin: 'hcp', key: 'decisions' } as const, [] as HcpDecision[])
const evidence = atom({ plugin: 'hcp', key: 'evidence' } as const, [] as HcpEvidence[])
const evidenceSeq = atom({ plugin: 'hcp', key: 'evidenceSeq' } as const, 0)
const showAllEvidence = atom({ plugin: 'hcp', key: 'showAllEvidence' } as const, false)
// Bumped after each link the person adds, so the reel's field draws empty again.
let linkSent = 0
const layout = atom({ plugin: 'hcp', key: 'layout' } as const, { current: DEFAULT_LAYOUT } as LayoutFile)
const isAddingLink = atom({ plugin: 'hcp', key: 'isAddingLink' } as const, false)
const isAskingLayout = atom({ plugin: 'hcp', key: 'isAskingLayout' } as const, false)
const steerSet = atom({ plugin: 'hcp', key: 'steers' } as const, DEFAULT_STEERS as SteerDef[])

const LAYOUT_FILE = '.claude/hcp/layout.json'

async function layoutPath($: Engine) {
  const home = await $.env.get('HOME')

  return home === undefined ? undefined : `${home}/${LAYOUT_FILE}`
}

/** The spec from disk, made whole; the default where there is none or it won't parse. */
async function loadLayout($: Engine) {
  const path = await layoutPath($)
  if (path === undefined) return
  try {
    if (!(await $.fs.exists(path))) return
    const raw = JSON.parse(await $.fs.read(path)) as { current?: unknown; previous?: unknown }
    const current = parseLayout(raw.current).layout
    const previous = raw.previous === undefined ? undefined : parseLayout(raw.previous).layout
    await update($, layout, () => ({ current, ...(previous ? { previous } : {}) }))
  } catch {
    $.ui.toast('hcp: ~/.claude/hcp/layout.json is malformed; using the default layout.')
  }
}

/** A new spec in force: the pane redraws from the atom, and the file keeps it for the next session. */
async function saveLayout($: Engine, next: LayoutFile) {
  await update($, layout, () => next)
  const path = await layoutPath($)
  if (path !== undefined) await $.fs.write(path, JSON.stringify(next, null, 2)).catch(() => undefined)
}

/** The layout tool: get, set, undo, reset. */
async function layoutTool($: Engine, input: Record<string, unknown>): Promise<string> {
  const file = await read($, layout)
  if (input.action === 'get') return layoutDescription(file.current)
  if (input.action === 'set') {
    const { layout: next, problems } = parseLayout(input.spec, file.current)
    await saveLayout($, { current: next, previous: file.current })
    await update($, isAskingLayout, () => false)

    return `${problems.length > 0 ? `Set, with problems (those parts kept their old value): ${problems.join('; ')}.` : 'Set.'} The pane redrew. Spec now:\n${JSON.stringify(next)}`
  }
  if (input.action === 'undo') {
    if (!file.previous) return 'Nothing to undo.'
    await saveLayout($, { current: file.previous, previous: file.current })

    return 'Back to the spec before the last set.'
  }
  if (input.action === 'reset') {
    await saveLayout($, { current: DEFAULT_LAYOUT, previous: file.current })

    return 'Back to the default layout.'
  }

  return 'layout needs `action`: get, set, undo or reset.'
}

/** Links into the reel, merged with what's there; the ids they have now, in order. */
async function addEvidence($: Engine, links: readonly HcpLink[], meta: EvidenceMeta): Promise<string[]> {
  if (links.length === 0) return []
  const at = await $.clock.now()
  let n = await read($, evidenceSeq)
  let ids: string[] = []
  await update($, evidence, list => {
    const merged = mergeEvidence(list, links, meta, at, () => `e${++n}`)
    ids = merged.ids

    return merged.list
  })
  await update($, evidenceSeq, () => n)

  return ids
}

/** A tool's `links`, as card fields. */
function linkFields(input: Record<string, unknown>): Pick<HcpCard, 'links'> {
  const links = parseLinks(input.links)

  return links.length > 0 ? { links } : {}
}

/** A card's links into the reel as backing it, and its draft's links as found there; the ids of the former. */
async function keepCardLinks($: Engine, card: Pick<HcpCard, 'id' | 'links'>, draft?: string): Promise<string[]> {
  const ids = await addEvidence($, card.links ?? [], { source: 'card', cardId: card.id })
  if (draft) void harvestInto($, draft, { source: 'card', cardId: card.id })

  return ids
}

/** The URLs in a reply or a card's text, into the reel as found in passing. */
async function harvestInto($: Engine, text: string, meta: EvidenceMeta) {
  if (!text || !/https?:\/\//.test(text)) return
  await addEvidence($, harvestLinks(text), meta).catch(() => undefined)
}

// This session's decisions, mirrored so the surface pipeline's precedents read them without a $ call.
let liveDecisions: HcpDecision[] = []
// Shadow runs still going, by decision: a resolution waits for its run, so the feedback lands.
const shadowing = new Map<string, Promise<void>>()
let sessionId = 'session'
let repo: string | undefined

async function saveDecisions($: Engine, fn: (list: HcpDecision[]) => HcpDecision[]) {
  await update($, decisions, list => (liveDecisions = fn(list).slice(-200)))
}

/** A new decision: kept, and run past the surface pipelines in the background. */
async function recordDecision($: Engine, fields: Omit<HcpDecision, 'session' | 'at' | 'outcome' | 'repo'>) {
  const decision: HcpDecision = { ...fields, session: sessionId, at: await $.clock.now(), outcome: 'pending', ...(repo ? { repo } : {}) }
  await saveDecisions($, list => [...list.filter(d => d.id !== decision.id), decision])
  const run = shadow($, decision, judge())
    .then(verdicts => saveDecisions($, list => list.map(d => (d.id === decision.id ? { ...d, shadow: verdicts } : d))))
    .catch(() => undefined)
    .finally(() => shadowing.delete(decision.id))
  shadowing.set(decision.id, run)

  return decision
}

type Resolution = Pick<HcpDecision, 'picked' | 'answeredMs' | 'change'>

/**
 * The person's answer settles a decision: kept in the ledger as a precedent,
 * and fed back to each shadow run. A Disagree after a Fine re-opens it: that
 * Fine let an error through, and the record says so.
 */
async function resolveDecision($: Engine, id: string, outcome: HcpDecision['outcome'], extra: Resolution = {}) {
  await shadowing.get(id)
  let done: HcpDecision | undefined
  const fields = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) as Resolution
  await saveDecisions($, list =>
    list.map(d => {
      if (d.id !== id) return d
      if (d.outcome === 'pending') return (done = { ...d, outcome, ...fields })
      if (d.outcome === 'agreed' && outcome === 'disagreed') return (done = { ...d, outcome, reversedFrom: 'agreed', ...fields, answeredMs: d.answeredMs })

      return d
    }),
  )
  if (done) await resolved($, done)
}

/** How an ask card's answer reads as a decision outcome, and how long the person took. */
async function resolveAsk($: Engine, card: HcpCard) {
  const decision = liveDecisions.find(d => d.id === card.id)
  if (!decision) return
  const labels = card.options.filter(o => card.picked.includes(o.value)).map(o => o.label)
  const outcome = labels.length === 0 ? 'no-pick' : decision.choice !== undefined && labels.includes(decision.choice) ? 'took' : 'overrode'
  await resolveDecision($, card.id, outcome, { picked: labels.join(', ') || undefined, answeredMs: (await $.clock.now()) - card.createdAt })
}

/** A share of low-stakes ask cards hide the recommendation, so the ledger can measure how much preselection sways picks. */
export const PROBE_RATE = 0.05

// UTC offset in minutes, from `date +%z`; the hooks environment's own zone may differ.
let offset = -new Date().getTimezoneOffset()
const timers = new Map<string, { cancel: () => void }>()
// Typed but unsent text, kept out of $.state so typing redraws nothing.
const drafts = new Map<string, string>()
// A slide's typed note, by `<card>:<slide>`, until Enter keeps it or the card is answered.
const slideDrafts = new Map<string, string>()
let quickDraftText = ''
// Bash calls that raised a handoff: their result rows draw the card.
const handoffCalls = new Set<string>()
// Calls hcp held: their result rows draw the reach card.
const heldCalls = new Set<string>()
// Calls the person approved on a card, or a grant covers: tool.check lets them run without a second prompt.
const passes = new Map<string, string>()
// Cards whose press is being handled: a second press before the state lands does nothing.
const busy = new Set<string>()
// Whether a main-conversation turn is running: a prompt submitted now queues behind it.
let isTurnRunning = false
// The surface the pane last drew on: where a picture opens full size.
let lastSurface: RenderSurface | undefined
// The session's working directory and its project name, which records and steers are kept under.
let cwd = ''
let project = 'root'
// The main loop's calls in the running turn: what the person saw when they stopped it.
let turnCalls: TurnCall[] = []
// A turn the person stopped, waiting for what they type next.
let pendingStop: Omit<InterruptRow, 'said' | 'source' | 'project'> | undefined
// Rules "Always" added this session: honoured at once, before the engine reloads its settings.
const alwaysRules = new Set<string>()
// The run that built this project's steers: presses and misses are its feedback.
let steerRunId: string | undefined
let isBuildingSteers = false
const STOP_WINDOW_MS = 30 * 60_000

/**
 * Opens a file full size: in VS Code an image opens in the editor's own viewer
 * (the `code` CLI, else the app by name), elsewhere the system's default app.
 */
async function openFile($: Engine, path: string, isImage: boolean, surface = lastSurface) {
  const tries: string[][] =
    isImage && surface === 'vscode'
      ? [['code', '-r', path], ['open', '-a', 'Visual Studio Code', path], ['open', path]]
      : [['open', path], ['xdg-open', path]]
  for (const argv of tries) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return
    } catch {
      // Not on this machine: the next way.
    }
  }
  $.ui.toast(`Open it yourself: ${path}`)
}

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
    id: `${fields.kind === 'handoff' ? 'h' : fields.kind === 'reach' ? 'r' : 'c'}${n}`,
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
  const service = services()[name]!
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
  // A picture dropped into the note goes to Claude as a path it reads.
  const typed = splitPaths(note ?? drafts.get(id) ?? card.note)
  const attached = await expandAll($, (await existing($, typed.paths)).map(path => ({ path })))
  const withNote = {
    ...card,
    note: typed.rest || (attached.length > 0 ? 'See the attached pictures.' : ''),
    slideNotes: keptSlideNotes(card),
  }
  suffix += attachedText(attached)

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
  for (const at of slideDrafts.keys()) if (at.startsWith(`${id}:`)) slideDrafts.delete(at)
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
  if (card.kind === 'ask') await resolveAsk($, card)
}

/** The slide notes kept with Enter, overlaid with ones typed and not yet kept. */
function keptSlideNotes(card: HcpCard): Record<string, string> {
  const notes = { ...card.slideNotes }
  for (const [at, text] of slideDrafts) {
    const [cardId, slide] = at.split(':')
    if (cardId === card.id && slide !== undefined) notes[slide] = text
  }

  return notes
}

/**
 * Attaches the pictures and videos named in typed text to the outbox, and
 * answers the words left around them. A video's frames are sampled first.
 */
async function attachFrom($: Engine, text: string): Promise<{ rest: string; added: number }> {
  const typed = splitPaths(text)
  const found = await existing($, typed.paths)
  if (found.length === 0) return { rest: text, added: 0 }
  $.ui.toast(found.some(p => VIDEO_FILE.test(p)) ? 'Sampling video frames…' : 'Attaching…')
  const media = await expandAll($, found.map(path => ({ path })))
  await update($, outbox, list => [...list, ...media].slice(-MAX_MEDIA))

  return { rest: typed.rest, added: media.length }
}

/** The open cards in the order the pane draws them. */
async function openCards($: Engine) {
  return (await read($, cards)).filter(c => c.status === 'open')
}

/** The element j/k puts the focus on: a card's first option, or its main button. */
function focusKey(card: HcpCard) {
  if (card.kind === 'ask') return card.options[0] ? `${card.id}-opt-${card.options[0].value}` : `${card.id}-send`

  if (card.kind === 'reach') return `${card.id}-send`

  return card.kind === 'share' ? `${card.id}-copy-rich` : `${card.id}-done`
}

/** Pictures a person pasted into the prompt box, shown in the pane; the prompt itself is untouched. */
async function mirrorPasted(
  $: Engine,
  images: readonly { filename?: string }[],
  reads: readonly Promise<{ base64?: string; mediaType?: string; next?: number } | undefined>[],
) {
  const paths: string[] = []
  for (const [at, read] of reads.entries()) {
    const got = await read
    // Only a whole item fits: a second slice would need another call before the submission settles.
    if (got?.base64 === undefined || got.next !== undefined) continue
    const extension = got.mediaType?.split('/')[1] ?? 'png'
    const saved = await saveBytes($, got.base64, images[at]?.filename ?? `pasted.${extension}`)
    if (saved !== undefined) paths.push(saved)
  }
  if (paths.length < images.length) paths.push(...(await pastedImages($, images.length - paths.length)))
  const media: HcpMedia[] =
    paths.length > 0
      ? await Promise.all(paths.map(path => prepare($, path)))
      : images.map(image => ({ path: image.filename ?? 'image', caption: image.filename ?? 'pasted image' }))
  await update($, fromYou, list => [...media, ...list].slice(0, 8))
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
  const service = card?.service === undefined ? undefined : services()[card.service]
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

const APPROVAL_MS = 30 * 60_000
// How long the first Send press on a notifying call stays armed.
const ARM_MS = 15_000

async function noteOutward($: Engine, row: HcpOutward) {
  await update($, outward, list => [...list.filter(o => o.toolUseId !== row.toolUseId), row].slice(-50))
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/** The person's edited text approves a call on that channel, to no one new, carrying exactly that text. */
const fitsEdit = (a: HcpApproval, facts: CallFacts) =>
  a.content !== undefined &&
  a.channel === facts.channel &&
  facts.audience.every(who => (a.audience ?? []).includes(who)) &&
  sameText(a.content, facts.content)

/** The call's one-time approval, exact or by edited text, taken: it runs once. */
async function takeApproval($: Engine, key: string, facts: CallFacts): Promise<HcpApproval | undefined> {
  const at = await $.clock.now()
  let taken: HcpApproval | undefined
  await update($, approvals, list =>
    list.filter(a => {
      if (a.expiresAt <= at) return false
      if (taken === undefined && (a.callKey === key || fitsEdit(a, facts))) {
        taken = a

        return false
      }

      return true
    }),
  )

  return taken
}

/** The newest live grant on the call's channel whose audience holds everyone the call names. */
async function grantFor($: Engine, facts: CallFacts): Promise<HcpGrant | undefined> {
  const at = await $.clock.now()

  return (await read($, grants))
    .filter(g => g.expiresAt > at && g.channel === facts.channel && facts.audience.every(who => g.audience.includes(who)))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** Remembers a main-loop call of the running turn: what was on screen if the person stops it. */
function noteTurnCall(tool: string, facts: CallFacts, input: Record<string, unknown>) {
  const target = ['file_path', 'path', 'pattern', 'url', 'query'].map(k => input[k]).find(v => typeof v === 'string') as string | undefined
  const summary = clip((tool === 'Bash' ? blankQuotes(facts.content) : target ?? facts.content).replace(/\s+/g, ' '), 160)
  turnCalls = [...turnCalls, { tool, channel: facts.channel, summary }].slice(-6)
}

/**
 * Claude Code's own verdict on the call, from the person's settings: only a
 * rule counts (a mode or the auto classifier is not the person's word on this
 * call). Bounded, and quiet on failure: hcp then decides as before.
 */
async function settingsVerdict($: Engine, tool: string, input: Record<string, unknown>): Promise<SettingsVerdict | undefined> {
  const args = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId'))
  try {
    const verdict = await within($, 3000, $.tool.check({ tool, input: args }))

    return verdict.rule === undefined ? undefined : { decision: verdict.decision, rule: verdict.rule }
  } catch {
    return undefined
  }
}

/**
 * Before every tool call: the rules' view, then (for anything that may leave
 * the machine) the reach pipeline. A call that notifies people runs only when
 * the person approved it on a card or a grant covers it; otherwise it is held.
 */
async function guard($: Engine, e: { tool: string; tool_use_id: string; agentId?: string }, run: () => Promise<unknown>) {
  const input = e as unknown as Record<string, unknown>
  const facts = classifyCall(e.tool, input, reachTags())
  if (e.agentId === undefined) noteTurnCall(e.tool, facts, input)
  if (facts.level === 'local' || facts.level === 'own') return run()
  const at = await $.clock.now()
  const key = callKey(e.tool, input)
  const row = { toolUseId: e.tool_use_id, at, tool: e.tool, channel: facts.channel, audience: facts.audience }

  const approval = await takeApproval($, key, facts)
  if (approval !== undefined) {
    passes.set(e.tool_use_id, `approved on hcp card ${approval.cardId}`)
    await noteOutward($, { ...row, level: facts.level ?? 'notifies', verdict: 'approved', why: `sent from card ${approval.cardId}`, cardId: approval.cardId })
    void appendLedger($, { type: 'approved', tool: e.tool, channel: facts.channel, cardId: approval.cardId })
    try {
      return await run()
    } finally {
      passes.delete(e.tool_use_id)
    }
  }

  const grant = await grantFor($, facts)
  const scope = scopeOf(facts, repo)
  const rule = ruleFor(facts)
  const settings = rule !== undefined && alwaysRules.has(rule) ? { decision: 'allow' as const, rule } : await settingsVerdict($, e.tool, input)
  const reachRecord = recordOf(answerRows(), facts.channel, scope)
  const context = { ...(settings ? { settings } : {}), record: reachRecord, interrupts: notesFor(interruptRows(), project, at, facts.channel) }
  const judged: Judged = { by: 'rules', problems: [] }
  let record: RunRecord | undefined
  const ran = await runPipeline(
    reachPipeline,
    { facts, context, ...(grant ? { grant: { channel: grant.channel, audience: grant.audience, intent: grant.intent, example: grant.example } } : {}) },
    reachPorts($, judge(), judged, r => void (record = r)),
  )
  const verdict = ran.output as ReachVerdict
  void appendLedger($, {
    type: 'run',
    tool: e.tool,
    channel: facts.channel,
    audience: facts.audience,
    level: verdict.level,
    branch: verdict.branch,
    judgedBy: judged.by,
    scope,
    ...(settings ? { settings } : {}),
    sentBefore: reachRecord.sent,
    heldBefore: reachRecord.held,
    ...(judged.problems.length > 0 ? { problems: judged.problems } : {}),
    record,
  })
  const noted = { ...row, ...(verdict.level ? { level: verdict.level } : {}), why: verdict.reason, judgedBy: judged.by }

  if (verdict.branch === 'pass') return run()
  if (verdict.branch === 'badge') {
    await noteOutward($, { ...noted, verdict: 'badge' })

    return run()
  }
  if (verdict.branch === 'standing') {
    await noteOutward($, { ...noted, verdict: 'standing', scope, runId: ran.runId ?? ran.runKey })
    // The engine's own check still runs: a settings allow lets it through, anything else asks as it would.
    return run()
  }
  if (verdict.branch === 'grant' && grant) {
    await update($, grants, list => list.map(g => (g.id === grant.id ? { ...g, uses: g.uses + 1 } : g)))
    await noteOutward($, { ...noted, verdict: 'grant', grantId: grant.id })
    passes.set(e.tool_use_id, `covered by an hcp grant from card ${grant.cardId}`)
    try {
      return await run()
    } finally {
      passes.delete(e.tool_use_id)
    }
  }

  const card = await postCard($, {
    ...blank,
    kind: 'reach',
    toolUseId: e.tool_use_id,
    ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    title: `Send this ${facts.channel}?`,
    detail: verdict.reason,
    reach: {
      tool: e.tool,
      channel: facts.channel,
      audience: facts.audience,
      level: verdict.level ?? 'notifies',
      why: verdict.reason,
      content: facts.content,
      callKey: key,
      // No tracer, no run id: the run key names the run for its feedback.
      runId: ran.runId ?? ran.runKey,
      ...(grant ? { nearGrant: grant.id } : {}),
      scope,
      isFamiliar: reachRecord.sent >= 2 && !reachRecord.lastHeld,
      ...(rule ? { rule } : {}),
    },
  })
  heldCalls.add(e.tool_use_id)
  await noteOutward($, { ...noted, verdict: 'hold', cardId: card.id })
  $.ui.toast(`Held for you: ${facts.channel}. Card ${card.id} has the exact content.`, { timeoutMs: 8000 })
  void $.ui.notify(`Claude wants to send: ${facts.channel}`, { title: 'Approve on the HCP card' })

  return { deny: heldText(card, await read($, mode)) }
}

/** Send, allow similar, change, save as draft, or not now: the person's answer to a held call. */
async function answerReach($: Engine, id: string, pressed: ReachChoice, typed?: string) {
  let choice = pressed
  if (busy.has(id)) return
  busy.add(id)
  try {
    const card = await findCard($, id)
    const r = card?.reach
    if (!card || !r || card.status !== 'open') return
    const note = (typed ?? drafts.get(choice === 'edit' ? `${id}:edit` : id) ?? '').trim()
    if ((choice === 'change' || choice === 'edit') && !note) {
      $.ui.toast(choice === 'edit' ? 'The text is empty: edit it, then press Enter.' : 'Type the change first, then press Enter.')

      return
    }
    const at = await $.clock.now()
    const hours = GRANT_HOURS[choice]
    // A call that notifies people can't be unsent: the first press shows who gets it, the second sends.
    // Not when the person has sent like calls here before and kept none back: that friction taught nothing.
    if ((choice === 'send' || choice === 'edit' || choice === 'always' || hours !== undefined) && r.level === 'notifies' && !r.isFamiliar) {
      if (card.armedAt === undefined || at - card.armedAt > ARM_MS) {
        const who = r.audience.length > 0 ? clip(r.audience.join(', '), 80) : 'its audience'
        await patchCard($, id, c => ({ ...c, armedAt: at, progress: `This notifies ${who} and can't be unsent. Press again to send.` }))

        return
      }
    }
    if (choice === 'edit' && sameText(note, r.content)) choice = 'send'
    if (choice === 'always') {
      const wrote = r.rule ? await allowInSettings($, cwd, r.rule) : { problem: 'no rule for this call' }
      if (wrote.problem !== undefined) {
        $.ui.toast(`Couldn't save the rule: ${wrote.problem}. Sent once instead.`, { timeoutMs: 10_000 })
        choice = 'send'
      } else {
        alwaysRules.add(r.rule!)
        $.ui.toast(`Saved ${r.rule} to ${wrote.file}: Claude Code and hcp both let calls like it through.`, { timeoutMs: 10_000 })
      }
    }
    if (choice === 'send' || choice === 'always' || hours !== undefined) {
      await update($, approvals, list => [...list.filter(a => a.expiresAt > at), { callKey: r.callKey, cardId: id, expiresAt: at + APPROVAL_MS }])
    }
    if (choice === 'edit') {
      await update($, approvals, list => [
        ...list.filter(a => a.expiresAt > at),
        { callKey: '', cardId: id, expiresAt: at + APPROVAL_MS, content: note, channel: r.channel, audience: r.audience },
      ])
    }
    if (hours !== undefined) {
      const grant: HcpGrant = {
        id: `g${id.slice(1)}`,
        channel: r.channel,
        audience: r.audience,
        intent: clip(r.content.replace(/\s+/g, ' '), 120),
        example: r.content,
        cardId: id,
        createdAt: at,
        expiresAt: at + hours * 3_600_000,
        uses: 0,
      }
      await update($, grants, list => [...list.filter(g => g.expiresAt > at), grant])
      void describeIntent($, grant)
    }
    if (r.runId) {
      // The feedback edge on the gate: was holding this call worth a card?
      void submitFeedback(
        reachPipeline,
        { runId: r.runId, edgeId: 'reach-card', value: choice === 'send' || choice === 'always' || hours !== undefined ? 0 : 1, label: choice, sourceId: 'person' },
        { scores: scoresPort($, { cardId: id, channel: r.channel, ...(r.scope ? { scope: r.scope } : {}), content: clip(r.content, 400) }) },
      ).catch(() => undefined)
    }
    rememberAnswer({ at, channel: r.channel, label: choice, ...(r.scope ? { scope: r.scope } : {}), content: clip(r.content, 400) })
    const text = reachAnswerText(card, choice, note)
    drafts.delete(id)
    drafts.delete(`${id}:edit`)
    const delivery = choice === 'not-now' ? 'nntr' : 'now'
    if (delivery === 'now') {
      const wasQueued = isTurnRunning
      await patchCard($, id, c => ({ ...c, note, status: 'queued', delivery, answer: text, progress: undefined }))
      await refreshStatus($)
      $.ui.toast(sentToast(wasQueued))
    }
    await deliver($, text, delivery, card.agentId)
    await patchCard($, id, c => ({ ...c, note, status: 'answered', delivery, answer: text, progress: undefined }))
    await refreshStatus($)
  } finally {
    busy.delete(id)
  }
}

/** A grant's one-line intent, written by the generate port; the content's start stands until then. */
async function describeIntent($: Engine, grant: HcpGrant) {
  try {
    const written = await generatePort($)({ nodeId: 'grant', prompt: 'grant-intent', route: 'grant-intent', input: { channel: grant.channel, content: grant.example } })
    const text = (written.value as { text?: string }).text?.split('\n')[0]?.trim()
    if (text) await update($, grants, list => list.map(g => (g.id === grant.id ? { ...g, intent: clip(text, 160) } : g)))
  } catch {
    // The clipped content stays the intent.
  }
}

/** A steer press: the text goes to Claude as a no-reply note, and the press is the steer set's feedback. */
async function pressSteer($: Engine, steer: SteerDef) {
  await deliver($, `[HCP steer] ${steer.text}`, 'nntr')
  $.ui.toast('Steer sent: Claude picks it up at its next step.')
  rememberPress(project, steer.label)
  void appendLedger($, { type: 'steer', project, id: steer.id, label: steer.label, source: steer.source })
  if (steerRunId !== undefined && steer.source === 'learned') {
    void submitFeedback(
      steersPipeline,
      { runId: steerRunId, edgeId: 'steer-press', value: 1, label: steer.label, sourceId: 'person' },
      { scores: scoresPort($, { project, steer: steer.label }) },
    ).catch(() => undefined)
  }
}

/** "Card next time" on a call that went through on the person's record: it counts against the record, and like calls are held again. */
async function holdAgain($: Engine, toolUseId: string) {
  const row = (await read($, outward)).find(o => o.toolUseId === toolUseId)
  if (row === undefined || row.verdict !== 'standing' || row.isUndone) return
  const at = await $.clock.now()
  rememberAnswer({ at, channel: row.channel, label: 'hold-again', ...(row.scope ? { scope: row.scope } : {}) })
  await update($, outward, list => list.map(o => (o.toolUseId === toolUseId ? { ...o, isUndone: true } : o)))
  const scores = scoresPort($, { channel: row.channel, ...(row.scope ? { scope: row.scope } : {}) })
  if (row.runId !== undefined) {
    void submitFeedback(reachPipeline, { runId: row.runId, edgeId: 'standing-undo', value: 1, label: 'hold-again', sourceId: 'person' }, { scores }).catch(() => undefined)
  }
  $.ui.toast(`${row.channel} calls get a card again here.`)
}

/**
 * What the person typed: after they stopped a run, or while one was going,
 * it is a redirect. Kept as an interrupt for the classifier's context and the
 * steer set; never scored as Claude getting something wrong.
 */
async function noteRedirect($: Engine, text: string) {
  const at = await $.clock.now()
  const said = saidOf(text)
  let row: InterruptRow | undefined
  if (pendingStop !== undefined && at - pendingStop.at < STOP_WINDOW_MS) {
    row = { ...pendingStop, project, source: 'live', ...(said ? { said } : {}) }
  } else if (isTurnRunning && said !== undefined) {
    row = { at, kind: 'mid-turn', session: sessionId, project, doing: '', calls: turnCalls, said, source: 'live' }
  }
  pendingStop = undefined
  if (row === undefined) return
  await rememberInterrupt($, row)
  if (row.said !== undefined) {
    await checkMissed($, row.said)
    await maybeBuildSteers($)
  }
}

/** Did the person just type what a steer button offered? The classifier says; a miss is the steer set's feedback. */
async function checkMissed($: Engine, said: string) {
  const steers = await read($, steerSet)
  const judged: Judged = { by: 'rules', problems: [] }
  const frame = () => ({ state: { said, steers: steers.map(t => ({ label: t.label, text: t.text })) }, questions: missedQuestions(steers) })
  const result = await decidePort($, judge(), judged, frame)({ nodeId: 'missed', nodeVersion: '1', questions: 'steer-missed', input: null, from: {} })
  const best = steers
    .map((t, at) => ({ t, p: result.distributions[`steer_${at}`]?.[0] ?? 0 }))
    .sort((a, b) => b.p - a.p)[0]
  if (best === undefined || best.p < 0.7) return
  void appendLedger($, { type: 'steer-missed', project, label: best.t.label, source: best.t.source, p: best.p })
  if (steerRunId !== undefined && best.t.source === 'learned') {
    void submitFeedback(
      steersPipeline,
      { runId: steerRunId, edgeId: 'steer-missed', value: 1, label: best.t.label, sourceId: 'person' },
      { scores: scoresPort($, { project, steer: best.t.label }) },
    ).catch(() => undefined)
  }
}

/** Builds this project's steers from its redirects when there are enough new ones; detached, so a session never waits on it. */
async function maybeBuildSteers($: Engine) {
  if (isBuildingSteers) return
  const file = await readSteers($, project)
  const redirects = interruptRows().filter(r => r.project === project && r.said !== undefined).length
  if (!needsBuild(file, redirects)) return
  isBuildingSteers = true
  try {
    const at = await $.clock.now()
    const ran = await runPipeline(steersPipeline, steerInput(interruptRows(), project, pressesFor(project), at), {
      ...tracerFor($, ['steers']),
      generate: generatePort($, { ...ROUTES, 'steer-draft': STEER_ROUTE }),
      records: r => void appendLedger($, { type: 'steers-run', project, record: r }),
      clock: () => Date.now(),
    })
    const steers = (ran.output as { steers?: SteerDef[] }).steers ?? DEFAULT_STEERS
    steerRunId = ran.runId ?? ran.runKey
    await saveSteers($, { project, steers, builtFrom: redirects, builtAt: at, runId: steerRunId })
    await update($, steerSet, () => steers)
    void appendLedger($, { type: 'steers', project, branch: ran.route, labels: steers.map(t => t.label), builtFrom: redirects })
  } catch (error) {
    void appendLedger($, { type: 'steers-failed', project, error: String((error as Error).message).slice(0, 200) })
  } finally {
    isBuildingSteers = false
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
      void patchCard($, id, c => ({ ...c, status: 'dismissed', progress: undefined }))
        .then(() => refreshStatus($))
        .then(() => resolveDecision($, id, 'dismissed')),
    agree: id =>
      void (async () => {
        const decision = liveDecisions.find(d => d.id === id)
        if (!decision || decision.outcome !== 'pending') return
        await resolveDecision($, id, 'agreed', { answeredMs: (await $.clock.now()) - decision.at })
        $.ui.toast('Noted. You can still disagree later.')
      })(),
    disagree: id =>
      void (async () => {
        const decision = liveDecisions.find(d => d.id === id)
        if (!decision || (decision.outcome !== 'pending' && decision.outcome !== 'agreed')) return
        const note = (drafts.get(id) ?? '').trim()
        drafts.delete(id)
        await resolveDecision($, id, 'disagreed', { answeredMs: (await $.clock.now()) - decision.at })
        $.ui.toast(sentToast(isTurnRunning))
        await deliver(
          $,
          `[HCP ${id}] I disagree with "${decision.title}" (you chose ${decision.choice}).${note ? ` ${note}` : ''} Undo what you did on the strength of it where you can, tell me what you reverted, and check with me before choosing again.`,
          'now',
        )
      })(),
    change: (id, typed) =>
      void (async () => {
        const decision = liveDecisions.find(d => d.id === id)
        const text = (typed ?? drafts.get(`${id}:change`) ?? '').trim()
        if (!decision || (decision.outcome !== 'pending' && decision.outcome !== 'agreed')) return
        if (!text) {
          $.ui.toast('Type what to do instead, then press Enter.')

          return
        }
        drafts.delete(`${id}:change`)
        await resolveDecision($, id, 'disagreed', { change: text, answeredMs: (await $.clock.now()) - decision.at })
        $.ui.toast(sentToast(isTurnRunning))
        await deliver(
          $,
          `[HCP ${id}] Change "${decision.title}": instead of ${decision.choice}, ${text} Rework what you built on ${decision.choice} to match, and say what changed.`,
          'now',
        )
      })(),
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
    steer: steer => void pressSteer($, steer),
    holdAgain: toolUseId => void holdAgain($, toolUseId),
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
        const { rest, added } = await attachFrom($, (typed ?? quickDraftText).trim())
        const attached = await read($, outbox)
        if (!rest && attached.length === 0) {
          $.ui.toast('Type a message first.')

          return
        }
        quickDraftText = ''
        // The field clears before the engine is asked, since a mid-turn prompt resolves late.
        await update($, quickSent, n => n + 1)
        if (!rest && added > 0) {
          $.ui.toast(`Attached ${added}. Type a message and press Enter to send with it, or Send as NNTR.`)

          return
        }
        const text = (rest || 'See the attached pictures.') + attachedText(attached)
        if (attached.length > 0) await update($, outbox, () => [])
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
    reach: (id, choice, note) => void answerReach($, id, choice, note),
    revokeGrant: id =>
      void update($, grants, list => list.filter(g => g.id !== id)).then(() => $.ui.toast('Grant revoked: similar calls get a card again.')),
    slide: (id, step) =>
      void patchCard($, id, c => {
        const count = c.media?.length ?? 0

        return count === 0 ? c : { ...c, slide: ((((c.slide ?? 0) + step) % count) + count) % count }
      }),
    slideNote: (id, at, text, isKept) => {
      slideDrafts.set(`${id}:${at}`, text)
      if (isKept) void patchCard($, id, c => ({ ...c, slideNotes: { ...c.slideNotes, [String(at)]: text.trim() } }))
    },
    openMedia: media => void openFile($, media.video ?? media.path, media.video === undefined),
    openImage: path => void openFile($, path, true),
    unattach: at => void update($, outbox, list => list.filter((_, i) => i !== at)),
    clearAttachments: () => void update($, outbox, () => []),
    clearFromYou: () => void update($, fromYou, () => []),
    openLink: href => {
      if (!/^(https?:\/\/|mailto:|file:\/\/)/i.test(href)) {
        $.ui.toast(`Not a link hcp opens: ${clip(href, 60)}`)

        return
      }
      void $.process.run(['open', href], { timeoutMs: 10_000 }).then(
        ran => ran.exitCode === 0 || $.ui.toast(`Couldn't open ${clip(href, 60)}`),
        () => $.ui.toast(`Open it yourself: ${href}`),
      )
    },
    pinEvidence: id => void update($, evidence, list => list.map(e => (e.id === id ? { ...e, isPinned: !e.isPinned } : e))),
    dropEvidence: id => void update($, evidence, list => dropEvidence(list, id)),
    addLink: text =>
      void (async () => {
        const link = parseTypedLink(text)
        if (!link) {
          $.ui.toast('Paste a URL (https, mailto or file), then a label.')

          return
        }
        linkSent += 1
        const [id] = await addEvidence($, [link], { source: 'you' })
        if (id === undefined) return
        await update($, evidence, list => list.map(e => (e.id === id ? { ...e, isPinned: true } : e)))
        await update($, isAddingLink, () => false)
        await deliver($, addedLinkNote(link, id), 'nntr')
        $.ui.toast(`Pinned as ${id}. Claude knows.`)
      })(),
    toggleAllEvidence: () => void update($, showAllEvidence, value => !value),
    toggleAddLink: () => void update($, isAddingLink, value => !value),
    toggleLayoutAsk: () => void update($, isAskingLayout, value => !value),
    askLayout: text =>
      void (async () => {
        if (!text.trim()) {
          $.ui.toast('Describe the change first, then press Enter.')

          return
        }
        $.ui.toast(sentToast(isTurnRunning))
        await deliver($, layoutRequestText(text), 'now')
      })(),
    undoLayout: () =>
      void layoutTool($, { action: 'undo' }).then(text => $.ui.toast(text === 'Nothing to undo.' ? text : 'Layout undone.')),
    resetLayout: () => void layoutTool($, { action: 'reset' }).then(() => $.ui.toast('Default layout.')),
    clearStale: () => void update($, evidence, list => list.filter(e => e.status !== 'stale')),
    move: step =>
      void (async () => {
        const open = await openCards($)
        if (open.length === 0) return
        const current = await read($, active)
        const at = Math.max(0, open.findIndex(c => c.id === current))
        const next = open[(((at + step) % open.length) + open.length) % open.length]!
        await update($, active, () => next.id)
        await $.ui.focus({ requestId: PANE, key: focusKey(next) }).catch(() => undefined)
      })(),
  }
}

/** A tool's `media`, made into pictures, and the paths that weren't there to tell Claude about. */
async function mediaFields($: Engine, input: Record<string, unknown>) {
  const wanted = parseMedia(input.media)
  if (wanted.length === 0) return { fields: {}, note: '' }
  const resolved = await Promise.all(
    wanted.map(async item => {
      const [path] = await existing($, [item.path])

      return path === undefined ? undefined : { ...item, path }
    }),
  )
  const found = resolved.filter((item): item is NonNullable<typeof item> => item !== undefined)
  const missing = wanted.filter((_, at) => resolved[at] === undefined).map(item => item.path)
  const media = await expandAll($, found)
  const layout: HcpCard['layout'] =
    input.layout === 'grid' || input.layout === 'slides' ? input.layout : media.length > 4 ? 'slides' : 'grid'
  const note = missing.length > 0 ? ` Not on the card, no such image or video file: ${missing.join(', ')}.` : ''

  return { fields: media.length > 0 ? { media, layout } : {}, note }
}

/** Thumbnail bytes where pictures draw as Svg; the terminal's Image reads its files itself. */
async function thumbsFor($: Engine, surface: RenderSurface, media: readonly HcpMedia[]) {
  return surface === 'terminal' ? new Map<string, string>() : thumbnails($, media)
}

async function snapshot($: Engine, surface: RenderSurface): Promise<Snapshot> {
  lastSurface = surface
  const at = await $.clock.now()
  const all = await read($, cards)
  const open = all.filter(c => c.status === 'open')
  const current = await read($, active)
  const attached = await read($, outbox)
  const pasted = await read($, fromYou)
  const live = (await read($, grants)).filter(g => g.expiresAt > at)
  const shown = [...open.flatMap(c => c.media ?? []), ...attached, ...pasted]

  return {
    cards: all,
    queue: await read($, queue),
    mode: await read($, mode),
    isConcise: await read($, isConcise),
    quickSent: await read($, quickSent),
    laterLabel: smartLater(at, offset).label,
    needsAuth: await readNeedsAuth($),
    formatAt: ms => formatLocal(ms, offset, at),
    active: open.some(c => c.id === current) ? current : open[0]?.id,
    outbox: attached,
    fromYou: pasted,
    surface,
    thumbs: await thumbsFor($, surface, shown),
    openImage: path => void openFile($, path, true, surface),
    grants: live,
    outward: (await read($, outward)).filter(o => o.verdict !== 'pass').slice(-8).reverse(),
    now: at,
    // Read through the atom, so the pane redraws when a decision changes.
    decided: (await read($, decisions)).filter(d => d.source === 'decided').slice(-5).reverse(),
    evidence: rankEvidence(
      await read($, evidence),
      open.map(c => c.id),
    ),
    showAllEvidence: await read($, showAllEvidence),
    linkSent,
    ...(await (async () => {
      const file = await read($, layout)

      return { layout: file.current, canUndoLayout: file.previous !== undefined }
    })()),
    isAddingLink: await read($, isAddingLink),
    isAskingLayout: await read($, isAskingLayout),
    steers: await read($, steerSet),
    project,
  }
}

/** The evidence tool: add, update by id (or href), drop. */
async function evidenceTool($: Engine, input: Record<string, unknown>): Promise<string> {
  const action = input.action
  if (action !== 'add' && action !== 'update' && action !== 'drop') return 'evidence needs `action`: add, update or drop.'
  const items = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : []
  const problems: string[] = []
  const ids: string[] = []
  const at = await $.clock.now()
  const forOf = (item: Record<string, unknown>) => (typeof item.for === 'string' && item.for.trim() ? item.for.trim() : undefined)

  if (action === 'add') {
    for (const item of items) {
      const [link] = parseLinks([item])
      if (!link) {
        problems.push(`Skipped ${typeof item.href === 'string' ? item.href : 'an item'}: needs an https, mailto or file href.`)
        continue
      }
      const cardId = forOf(item)
      ids.push(...(await addEvidence($, [link], { source: 'claude', ...(cardId !== undefined ? { cardId } : {}) })))
    }

    return evidenceText('add', ids, problems)
  }

  const list = await read($, evidence)
  for (const item of items) {
    const wantedId = typeof item.id === 'string' ? item.id.trim() : undefined
    const byId = wantedId === undefined ? undefined : list.find(e => e.id === wantedId)
    // Without an id, the href names the entry; with one that matches nothing, it's an error, not a guess.
    const byHref =
      wantedId === undefined && typeof item.href === 'string'
        ? list.find(e => normalizeHref(e.href) === normalizeHref(item.href as string))
        : undefined
    const found = byId ?? byHref
    if (!found) {
      problems.push(`No entry ${wantedId ?? (typeof item.href === 'string' ? `for ${item.href}` : 'named')}; use add.`)
      continue
    }
    if (action === 'drop') {
      await update($, evidence, l => dropEvidence(l, found.id))
    } else {
      const [link] = parseLinks([{ href: typeof item.href === 'string' ? item.href : found.href, label: item.label, why: item.why }])
      if (!link) {
        problems.push(`Skipped ${found.id}: the new href isn't https, mailto or file.`)
        continue
      }
      const cardId = forOf(item)
      await update($, evidence, l =>
        updateEvidence(
          l,
          found.id,
          {
            href: link.href,
            ...(typeof item.label === 'string' && item.label.trim() ? { label: link.label } : {}),
            ...(typeof item.why === 'string' ? { why: link.why ?? '' } : {}),
            ...(cardId !== undefined ? { cardId } : {}),
          },
          at,
        ),
      )
    }
    ids.push(found.id)
  }

  return evidenceText(action, ids, problems)
}

const DEFAULT_EXTENSION = '~/.claude/hcp.json'

/**
 * Layers the extension files over the base: `HCP_EXTENSIONS` (paths joined by
 * `:`, read in order) or else ~/.claude/hcp.json. A missing default is fine;
 * a missing named file or a malformed one is reported in a toast.
 */
async function loadExtensions($: Engine) {
  const home = (await $.env.get('HOME')) ?? ''
  const named = (await $.env.get('HCP_EXTENSIONS'))?.trim()
  const paths = named ? named.split(':').filter(Boolean) : [DEFAULT_EXTENSION]
  const loaded: Partial<Extension>[] = []
  const problems: string[] = []
  for (const path of paths) {
    const full = path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
    let json: string
    try {
      json = await $.fs.read(full)
    } catch {
      if (named) problems.push(`${path}: can't read it`)
      continue
    }
    const parsed = parseExtension(json)
    loaded.push(parsed.extension)
    problems.push(...parsed.problems.map(p => `${path}: ${p}`))
  }
  applyExtensions(loaded)
  $.ui.invalidate('tool.describe')
  if (problems.length > 0) $.ui.toast(`hcp extension: ${problems.join('; ')}`, { timeoutMs: 15_000 })
}

export const register: Register = (on, options) => {
  useOptions(options)
  on('session.start', async ($, e, next) => {
    try {
      const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5000 })
      offset = parseOffset(zone.stdout) ?? offset
    } catch {
      // No process access (tests, a restricted host): keep the environment's own offset.
    }
    await loadExtensions($)
    await loadLayout($)
    sessionId = await $.session.id().catch(() => 'session')
    repo = e.cwd.replace(/\/+$/, '').split('/').pop() || undefined
    cwd = e.cwd
    project = projectOf(e.cwd)
    await loadMemory($)
    bindInterrupts(() => notesFor(interruptRows(), project, Date.now()))
    const steerFile = await readSteers($, project)
    if (steerFile !== undefined && steerFile.steers.length > 0) {
      await update($, steerSet, () => steerFile.steers)
      steerRunId = steerFile.runId
    }
    void maybeBuildSteers($)
    liveDecisions = await read($, decisions)
    bindSession(() => liveDecisions)
    await loadHistory($)
    await initObservability($)

    await Promise.all([
      $.tool.register(withTweak(ASK_TOOL)),
      $.tool.register(withTweak(HANDOFF_TOOL)),
      $.tool.register(withTweak(SHARE_TOOL)),
      $.tool.register(withTweak(DECIDED_TOOL)),
      $.tool.register(withTweak(PIPELINE_TOOL)),
      $.tool.register(withTweak(EVIDENCE_TOOL)),
      $.tool.register(withTweak(LAYOUT_TOOL)),
      $.command.register({
        name: 'hcp',
        description: 'Open the HCP pane: cards waiting on you, quick replies, steers, mode',
        argumentHint: '[pairing|heads-down|away|clear|shadow]',
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
      if (card.kind === 'reach' && card.toolUseId) heldCalls.add(card.toolUseId)
    }
    for (const item of await read($, queue)) await arm($, item)
    await refreshStatus($)

    return next(e)
  })

  // Whether the main conversation is mid-turn decides what a press is told: sent, or queued.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      turnCalls = []
    }

    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      // The person stopped it: what was on screen is kept until they say why, in their next message.
      if (e.isAborted) {
        pendingStop = { at: await $.clock.now(), kind: 'aborted', session: sessionId, doing: clip(e.answer.replace(/\s+/g, ' '), 300), calls: turnCalls }
      }
      // The links Claude wrote inline stay reachable in the reel once the reply scrolls away.
      void harvestInto($, e.answer, { source: 'harvest' })
    }

    return next(e)
  })

  on('tool.call', { tool: /^mcp__hcp__layout$/ }, async ($, e) => ({
    result: await layoutTool($, e as unknown as Record<string, unknown>),
  })).catch(() => ({ deny: 'hcp could not change the layout; tell the person in a line.' }))

  on('tool.call', { tool: /^mcp__hcp__evidence$/ }, async ($, e) => ({
    result: await evidenceTool($, e as unknown as Record<string, unknown>),
  })).catch(() => ({ deny: 'hcp could not change the reel; carry on.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'hcp:protocol', text: protocolText(), scope: 'session' as const }] }
  })

  // Every call: anything that may reach people goes through the reach contract first.
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith(TOOL_PREFIX)) return next(e)

    return (await guard($, e, () => next(e))) as Awaited<ReturnType<typeof next>>
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The guard failed before the call ran: one that notifies people stays held.
    const facts = classifyCall(e.tool, e as unknown as Record<string, unknown>, reachTags())

    return facts.level === 'notifies'
      ? { deny: `[hcp] Held: hcp couldn't check this ${facts.channel} call. Ask the person with mcp__hcp__ask (the text in \`draft\`) before trying again.` }
      : next(e)
  })

  // A call the person approved on a card, or a grant covers, needs no second prompt. A deny stays a deny.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const why = e.tool_use_id === undefined ? undefined : passes.get(e.tool_use_id)

    return why !== undefined && verdict.decision === 'ask' ? { ...verdict, decision: 'allow' as const, reason: why } : verdict
  })

  // Claude reads the contract before it calls: tools that notify people say so.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    if (e.tool === 'Bash') {
      return { ...described, description: `${described.description}\n\nhcp holds commands that notify people (gh issue/pr comments, mail, chat webhooks) until the person approves the exact content on a card, unless a permission rule in their Claude Code settings allows the command or their record on like calls here lets it through.` }
    }
    if (!e.tool.startsWith('mcp__') || e.tool.startsWith(TOOL_PREFIX)) return described
    const facts = classifyCall(e.tool, {}, reachTags())
    if (facts.level !== 'notifies') return described

    return { ...described, description: `${described.description} (hcp: this notifies people, so a call is held for the person's OK on a card unless a grant covers it. Make the call; don't ask first.)` }
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
    const reach = ['local', 'own', 'shared', 'notifies'].includes(input.reach as string) ? (input.reach as HcpDecision['reach']) : undefined
    const reversible = typeof input.reversible === 'boolean' ? input.reversible : undefined
    const n = (await read($, seq)) + 1
    // A choice that can't be undone or reaches others is picked before the recommendation shows.
    const blind: HcpCard['blind'] =
      picked.length === 0
        ? undefined
        : floorOf({ reach, reversible }) !== undefined
          ? 'stakes'
          : !isMulti && hashToUnit(`${sessionId}:c${n}:probe`) < PROBE_RATE
            ? 'probe'
            : undefined
    const pictures = await mediaFields($, input)
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
      picked: blind ? [] : isMulti ? picked : picked.slice(0, 1),
      ...(blind ? { blind, recommended: isMulti ? picked : picked.slice(0, 1) } : {}),
      ...pictures.fields,
      ...linkFields(input),
    })
    const evidenceIds = await keepCardLinks($, card, card.draft)
    const recommended = options.find(o => (card.recommended ?? card.picked).includes(o.value))
    await recordDecision($, {
      ...(evidenceIds.length > 0 ? { evidence: evidenceIds } : {}),
      id: card.id,
      source: 'ask',
      kind: typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'general',
      title: card.title,
      ...(recommended ? { choice: recommended.label } : {}),
      alternatives: options.map(o => o.label),
      ...(reach ? { reach } : {}),
      ...(reversible !== undefined ? { reversible } : {}),
      ...(blind ? { blind } : {}),
    })

    return { result: postedText(card) + pictures.note }
  }).catch(() => ({ deny: 'hcp could not post the card; ask in prose this time.' }))

  on('tool.call', { tool: /^mcp__hcp__decided$/ }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.title !== 'string' || typeof input.choice !== 'string' || typeof input.kind !== 'string') {
      return { deny: 'decided needs `title`, `choice` and `kind`.' }
    }
    const n = liveDecisions.filter(d => d.source === 'decided').length + 1
    const evidenceIds = await keepCardLinks($, { id: `d${n}`, ...linkFields(input) })
    const decision = await recordDecision($, {
      ...(evidenceIds.length > 0 ? { evidence: evidenceIds } : {}),
      id: `d${n}`,
      source: 'decided',
      kind: input.kind.trim() || 'general',
      title: input.title,
      choice: input.choice,
      alternatives: Array.isArray(input.alternatives) ? input.alternatives.filter((a): a is string => typeof a === 'string') : [],
      ...(typeof input.why === 'string' ? { why: input.why } : {}),
      ...(typeof input.reversible === 'boolean' ? { reversible: input.reversible } : {}),
      ...(['local', 'own', 'shared', 'notifies'].includes(input.reach as string) ? { reach: input.reach as HcpDecision['reach'] } : {}),
    })

    return { result: `Recorded ${decision.id}. Carry on; the person can disagree from the pane ("[HCP ${decision.id}] I disagree …").` }
  }).catch(() => ({ result: 'hcp could not record it; carry on.' }))

  on('tool.call', { tool: /^mcp__hcp__pipeline$/ }, async ($, e) => ({
    result: await pipelineTool($, e as unknown as Record<string, unknown>, judge()),
  })).catch(() => ({ deny: 'hcp could not run the pipeline action.' }))

  on('tool.call', { tool: 'mcp__hcp__handoff' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.title !== 'string') return { deny: 'handoff needs a `title`.' }
    const pictures = await mediaFields($, input)
    const card = await postCard($, {
      ...blank,
      kind: 'handoff',
      toolUseId: e.tool_use_id,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      title: input.title,
      ...(typeof input.detail === 'string' ? { detail: input.detail } : {}),
      ...(typeof input.fix === 'string' ? { fix: input.fix } : {}),
      ...pictures.fields,
      ...linkFields(input),
    })
    await keepCardLinks($, card)
    void $.ui.notify(card.title, { title: 'Claude needs you' })

    return { result: postedText(card) + pictures.note }
  }).catch(() => ({ deny: 'hcp could not post the card; ask in prose this time.' }))

  on('tool.call', { tool: 'mcp__hcp__share' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.title !== 'string' || typeof input.text !== 'string') {
      return { deny: 'share needs a `title` and the `text` to paste.' }
    }
    const pictures = await mediaFields($, input)
    const card = await postCard($, {
      ...blank,
      kind: 'share',
      toolUseId: e.tool_use_id,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
      title: input.title,
      draft: input.text,
      ...(typeof input.audience === 'string' ? { audience: input.audience } : {}),
      ...pictures.fields,
      ...linkFields(input),
    })
    await keepCardLinks($, card, input.text)

    return { result: postedText(card) + pictures.note }
  }).catch(() => ({ deny: 'hcp could not post the card; print the text this time.' }))

  // Pictures pasted into the prompt box also show in the pane. The prompt passes on unchanged
  // and unawaited work; the reads start first, since the engine answers them only in flight.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.command) void noteRedirect($, e.text).catch(() => undefined)
    const images = (e.attachments ?? []).filter(a => a.type === 'image')
    if (images.length === 0 || e.origin.kind !== 'composer') return next(e)
    const reads = images.map(a =>
      a.id === undefined
        ? Promise.resolve(undefined)
        : $.prompt.media({ id: a.id }).then(
            media => (media.base64 === undefined ? undefined : media),
            () => undefined,
          ),
    )
    const result = await next(e)
    void mirrorPasted($, images, reads).catch(() => undefined)

    return result
  })

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
    const result = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
    const scanned = ran.isError ? (ran.text ?? '') : typeof result?.stderr === 'string' ? result.stderr : ''
    const name = detectService(e.command, scanned)
    if (name !== undefined) await raiseAuthHandoff($, name, e.tool_use_id, e.command, e.agentId)
    // A PR, issue or deploy a CLI just made prints its URL once: keep it.
    if (LINK_COMMANDS.test(e.command) && !ran.isError) {
      const out = [typeof result?.stdout === 'string' ? result.stdout : '', typeof result?.stderr === 'string' ? result.stderr : ''].join('\n')
      const label = commandLabel(e.command)
      await addEvidence(
        $,
        harvestLinks(out).map(l => ({ ...l, label: l.label === l.href || /^[\w.-]+\//.test(l.label) ? `${label}: ${l.label}` : l.label })),
        { source: 'tool', toolUseId: e.tool_use_id },
      ).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hcp' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'pairing' || arg === 'heads-down' || arg === 'away') {
      actionsFor($).setMode(arg as HcpMode)

      return { text: `HCP mode: ${arg}.` }
    }
    if (arg === 'shadow') return { text: shadowReport(liveDecisions) }
    if (arg === 'clear') {
      await update($, cards, list => list.filter(c => c.status === 'open'))

      return { text: 'HCP history cleared.' }
    }
    // Asked for, the pane takes the keyboard so its keys work at once; new cards never take it.
    const opened = await $.ui.open({ id: PANE, title: 'HCP', focus: true })

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
    inbox($.ui.resolve(e), await snapshot($, e.surface), actionsFor($)),
  )

  // Where no surface places the pane (VS Code may not), /hcp draws the inbox inline.
  on('ui.render', { component: 'CommandOutput', props: { command: 'hcp' } }, async ($, e, next) => {
    const isPlaced = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (isPlaced || e.props.text !== 'HCP') return next(e)

    return inbox($.ui.resolve(e), await snapshot($, e.surface), actionsFor($))
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    if (!e.props.tool.startsWith(TOOL_PREFIX)) {
      const row = (await read($, outward)).find(o => o.toolUseId === e.props.tool_use_id)
      if (!row || row.verdict === 'pass') return next(e)
      const els = $.ui.resolve(e)
      const { Box } = els

      return (
        <Box flexDirection="column">
          {await next(e)}
          {reachBadge(els, row, await $.clock.now())}
        </Box>
      )
    }
    const card = (await read($, cards)).find(c => c.toolUseId === e.props.tool_use_id)
    if (!card) return next(e)
    return cardView($.ui.resolve(e), card, actionsFor($), {
      openImage: path => void openFile($, path, true, e.surface),
      surface: e.surface,
      laterLabel: smartLater(await $.clock.now(), offset).label,
      thumbs: await thumbsFor($, e.surface, card.media ?? []),
    })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    if (e.props.tool.startsWith(TOOL_PREFIX)) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    if (!handoffCalls.has(e.props.tool_use_id) && !heldCalls.has(e.props.tool_use_id)) return next(e)
    const card = (await read($, cards)).find(c => c.toolUseId === e.props.tool_use_id)
    if (!card) return next(e)
    const els = $.ui.resolve(e)
    const { Box } = els

    const laterLabel = smartLater(await $.clock.now(), offset).label

    return (
      <Box flexDirection="column">
        {await next(e)}
        {cardView(els, card, actionsFor($), { surface: e.surface, laterLabel, thumbs: new Map(), openImage: path => void openFile($, path, true, e.surface) })}
      </Box>
    )
  })
}
