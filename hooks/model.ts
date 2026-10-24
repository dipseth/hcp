// The plain logic of the hcp mod: what Claude is told, what an answer says,
// which failures are an auth handoff, and when "later" is.

import type { HcpCard, HcpDelivery, HcpOption } from '../types'

export const PROTOCOL = `# Human Context Protocol (hcp mod)

The person has an HCP surface: clickable cards drawn inline in the chat and in an "HCP" pane. Use it whenever you need something from them, instead of prose.

- A decision among discrete options (approach, environment, scope, yes/no, approving a draft): call mcp__hcp__ask. Put a draft issue, comment or plan in \`draft\`. Don't restate the options after the call.
- Text the person will paste elsewhere (a Slack message, an email, a PR description, a status update): call mcp__hcp__share instead of printing it for them to select. It is outward-facing: write it for its audience.
- A step only they can do (an interactive login, VPN, an access request, /mcp auth, running something locally): call mcp__hcp__handoff. Auth failures from gcloud/bq in Bash, and MCP servers that need authorizing, are raised as handoffs for you, and you'll get a note saying so: don't retry the command, debug it, or run the login yourself.
- Cards don't block. Keep going on work that doesn't need the answer, or end your turn with one short line.

Messages from the surface start with "[HCP":
- "[HCP c3] ..." is the person's answer, sent to start a turn: act on it.
- "[HCP c3 · NNTR] ..." needs no reply. Take it into account and carry on; don't acknowledge it, and don't start new work because of it alone.
- "[HCP steer] ..." is a course correction sent while you work: follow it from your next step, without acknowledging it.
- "[HCP mode] ..." sets how to work until changed:
  - pairing (the default): ask freely.
  - heads-down: batch your questions into one card, keep updates to a line, don't ask about anything reversible.
  - away: don't wait on answers. Take safe, reversible defaults; leave questions as cards; make no outward-facing write (issues, PRs, Slack, deploys) until they're back.
- "[HCP concise] on" means short replies and no recaps until it says off.`

type Schema = Record<string, unknown>

export const ASK_TOOL = {
  name: 'ask',
  description:
    "Ask the person to choose, as a clickable card in their chat and HCP pane, instead of writing the options out in prose. Use for any decision among discrete options: approach, environment, scope, yes/no, or approving a draft (put the draft in `draft`). Returns at once. Don't restate the options afterwards. The answer arrives as a message starting \"[HCP <id>]\" (a prompt) or \"[HCP <id> · NNTR]\" (a note, possibly mid-turn).",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The question, one line.' },
      detail: { type: 'string', description: 'At most two sentences of context.' },
      draft: { type: 'string', description: 'Markdown to approve: a ticket body, a comment, a plan.' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string', description: 'A few words.' },
            hint: { type: 'string', description: 'One line on what picking it means.' },
          },
          required: ['value', 'label'],
        },
      },
      multi: { type: 'boolean', description: 'Allow several picks.' },
      recommended: {
        type: 'array',
        items: { type: 'string' },
        description: 'Values to preselect: your recommendation.',
      },
    },
    required: ['title', 'options'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const HANDOFF_TOOL = {
  name: 'handoff',
  description:
    "Hand the person a step only they can do (an interactive login, VPN, an access request, /mcp auth, running something on their machine) as a card with Done / Later / Can't buttons, instead of explaining it in prose. gcloud/bq auth failures in Bash are raised for you; don't call this for those. Returns at once: carry on with work that doesn't need it, or end your turn in one line.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What they need to do, imperative, one line.' },
      detail: { type: 'string', description: 'What it unblocks.' },
      fix: { type: 'string', description: 'The command they run, if there is one.' },
    },
    required: ['title'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const SHARE_TOOL = {
  name: 'share',
  description:
    "Hand the person text to paste somewhere else (a Slack message, an email, a PR description, a status update) as a card with Copy buttons, instead of printing it for them to select. Copy formatted puts HTML on the clipboard, so bold, lists and links survive the paste into Slack, email or a doc. Write it for its audience, in markdown. It is outward-facing. Returns at once; a requested change arrives as \"[HCP <id>] …\".",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What it is, a few words.' },
      text: { type: 'string', description: 'The text to paste, in markdown.' },
      audience: { type: 'string', description: 'Where it goes: Slack channel, email, PR or issue comment.' },
    },
    required: ['title', 'text'],
  } satisfies Schema,
  isDeferred: false,
} as const

export type Service = {
  label: string
  fix: string
  /** A read-only command that exits 0 once the credentials work again. */
  verify: readonly string[]
  /** Whether the mod can run `fix` itself: true where it needs no terminal. */
  isRunnable: boolean
  isCommand: (command: string) => boolean
  pattern: RegExp
}

// `bq version` passes against dead credentials; a dry run exercises the whole auth path.
export const SERVICES: Record<string, Service> = {
  gcloud: {
    label: 'gcloud / bq',
    fix: 'gcloud auth login --update-adc',
    verify: ['bq', 'query', '--use_legacy_sql=false', '--dry_run', 'SELECT 1'],
    isRunnable: true,
    isCommand: () => true,
    pattern:
      /Reauthentication failed|cannot prompt during non-interactive execution|invalid_grant|RefreshError|Request had invalid authentication credentials|problem refreshing your current auth tokens|gcloud auth (application-default )?login/i,
  },
}

/**
 * The service whose credentials a failed Bash call ran into. `scanned` is
 * stderr for a call that succeeded and the whole output for one that failed,
 * so a grep that prints "gcloud auth login" never counts.
 */
export function detectService(command: string, scanned: string): string | undefined {
  return Object.keys(SERVICES).find(name => {
    const service = SERVICES[name]!

    return service.isCommand(command) && service.pattern.test(scanned)
  })
}

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const tag = (card: HcpCard, delivery: HcpDelivery) =>
  delivery === 'nntr' ? `[HCP ${card.id} · NNTR]` : `[HCP ${card.id}]`

const noteOf = (card: HcpCard) => (card.note.trim() ? ` Note: "${card.note.trim()}"` : '')

/** What Claude reads for an answer, or undefined when there is nothing to say yet. */
export function answerText(card: HcpCard, delivery: HcpDelivery): string | undefined {
  if (card.kind === 'ask') {
    const labels = card.options.filter(o => card.picked.includes(o.value)).map(o => o.label)
    if (labels.length === 0 && !card.note.trim()) return undefined
    const choice = labels.length > 0 ? labels.join(', ') : 'no option picked'

    return `${tag(card, delivery)} ${card.title} → ${choice}.${noteOf(card)}`
  }

  if (card.kind === 'share') {
    if (!card.note.trim()) return undefined

    return `${tag(card, delivery)} Change "${card.title}": ${card.note.trim()}`
  }

  return `${tag(card, delivery)} Done: ${card.title}.${noteOf(card)} Retry what was blocked.`
}

export const cantText = (card: HcpCard) =>
  `[HCP ${card.id} · NNTR] Can't do "${card.title}" right now.${noteOf(card)} Work around it; don't ask again unless it's the only way forward.`

export const deferText = (card: HcpCard, when: string) =>
  `[HCP ${card.id} · NNTR] Will do "${card.title}" around ${when}. Don't wait on it; carry on with what doesn't need it.`

const serviceLabel = (service: string | undefined) =>
  service?.startsWith('mcp:') ? `The ${service.slice(4)} MCP server` : `${SERVICES[service ?? '']?.label ?? service}`

export const autoHandoffNote = (card: HcpCard) =>
  `[HCP ${card.id}] ${serviceLabel(card.service)} needs the person to authenticate. A handoff card is up and the person has been notified. Don't retry the command, debug it, or run the login yourself: carry on with work that doesn't need it, or end your turn in one line. "[HCP ${card.id}] Done" arrives when it's fixed.`

export const postedText = (card: HcpCard) =>
  `Posted as card ${card.id}. Don't restate it in prose. The answer arrives as "[HCP ${card.id}] …" or "[HCP ${card.id} · NNTR] …".`

export const STEERS = {
  'no-code': "Don't write or edit code yet: investigate and plan only.",
  'check-first': 'Check with me before your next write or outward-facing action.',
  narrow: 'Narrow the scope to the one thing I asked for; park the rest.',
  'wrap-up': 'Finish the current step, then stop and summarize in a few lines.',
} as const

export type Steer = keyof typeof STEERS

export function parseOptions(raw: unknown): HcpOption[] {
  if (!Array.isArray(raw)) return []

  return raw.flatMap(item => {
    const o = item as Record<string, unknown>
    if (typeof o.value !== 'string' || typeof o.label !== 'string') return []

    return [{ value: o.value, label: o.label, ...(typeof o.hint === 'string' ? { hint: o.hint } : {}) }]
  })
}

// Local time is read through a fixed UTC offset in minutes (`date +%z` at start),
// since the hooks environment's own zone may not be the machine's.

const MINUTE = 60_000
const DAY = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const partsOf = (ms: number, offset: number) => {
  const d = new Date(ms + offset * MINUTE)

  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
}

const atLocal = (ms: number, offset: number, hour: number, minute = 0) => {
  const p = partsOf(ms, offset)

  return Date.UTC(p.y, p.mo, p.d, hour, minute) - offset * MINUTE
}

const isWorkday = (ms: number, offset: number) => {
  const wd = partsOf(ms, offset).wd

  return wd >= 1 && wd <= 5
}

export function parseOffset(zone: string): number | undefined {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(zone.trim())
  if (!m) return undefined

  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export function formatLocal(ms: number, offset: number, now: number): string {
  const p = partsOf(ms, offset)
  const hhmm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  const isToday = partsOf(now, offset).d === p.d && ms - now < DAY

  return isToday ? hhmm : `${WEEKDAYS[p.wd]} ${hhmm}`
}

/** The next workday at `hour`, local, strictly after `now`. */
export function nextWorkMorning(now: number, offset: number, hour = 9): number {
  for (let k = 0; k < 8; k++) {
    const at = atLocal(now + k * DAY, offset, hour)
    if (at > now && isWorkday(at, offset)) return at
  }

  return now + DAY
}

export type When = { dueAt: number; label: string }

/** Five minutes during working hours (weekdays 08:00–18:00), else the next workday at 09:00. */
export function smartLater(now: number, offset: number): When {
  const { h } = partsOf(now, offset)
  if (isWorkday(now, offset) && h >= 8 && h < 18) return { dueAt: now + 5 * MINUTE, label: 'in 5 min' }
  const dueAt = nextWorkMorning(now, offset)

  return { dueAt, label: formatLocal(dueAt, offset, now) }
}

/** `30m`, `2h`, `9am`, `14:30`, `tomorrow`, `morning`; undefined for anything else. */
export function parseWhen(word: string, now: number, offset: number): When | undefined {
  const w = word.toLowerCase()
  const at = (dueAt: number) => ({ dueAt, label: formatLocal(dueAt, offset, now) })
  const rel = /^(\d+)(m|min|h|hr)$/.exec(w)
  if (rel) return at(now + Number(rel[1]) * (rel[2]!.startsWith('h') ? 60 : 1) * MINUTE)
  if (w === 'tomorrow') return at(nextWorkMorning(atLocal(now, offset, 23, 59), offset))
  if (w === 'morning') return at(nextWorkMorning(now, offset))
  const clock = /^(\d{1,2})(?::(\d\d))?(am|pm)?$/.exec(w)
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    const n = Number(clock[1])
    const hour = clock[3] === undefined ? n : (n % 12) + (clock[3] === 'pm' ? 12 : 0)
    if (hour > 23) return undefined
    const today = atLocal(now, offset, hour, Number(clock[2] ?? 0))

    return at(today > now ? today : today + DAY)
  }

  return undefined
}

/**
 * MCP servers the engine has marked as needing authorization, from its
 * `~/.claude/mcp-needs-auth-cache.json` (`{ "<server>": { "timestamp": ms } }`).
 * An entry older than a day is treated as stale.
 */
export function needsAuthServers(json: string, now: number): string[] {
  try {
    const cache = JSON.parse(json) as Record<string, { timestamp?: number }>

    return Object.keys(cache).filter(name => now - (cache[name]?.timestamp ?? 0) < DAY)
  } catch {
    return []
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** Enough markdown for a chat message: headings, bullets, numbers, bold, italics, code, links. */
export function markdownToHtml(markdown: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | undefined
  const close = () => {
    if (list) out.push(`</${list}>`)
    list = undefined
  }
  for (const line of markdown.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const item = bullet ?? numbered
    if (item) {
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inlineHtml(item[1]!)}</li>`)
    } else {
      close()
      if (heading) out.push(`<p><b>${inlineHtml(heading[1]!)}</b></p>`)
      else if (line.trim()) out.push(`<p>${inlineHtml(line)}</p>`)
    }
  }
  close()

  return out.join('')
}

/** The same text with markdown marks taken out, for a plain paste. */
export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
}
