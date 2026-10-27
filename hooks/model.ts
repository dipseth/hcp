// The plain logic of the hcp mod: what Claude is told, what an answer says,
// which failures are an auth handoff, and when "later" is.

import type { HcpCard, HcpDelivery, HcpMedia, HcpMode, HcpOption } from '../types'
import type { Judge } from './ports'
import { parseTags } from './reach'
import type { ReachTag } from './reach'

const PROTOCOL_HEAD = `# Human Context Protocol (hcp mod)

The person has an HCP surface: clickable cards drawn inline in the chat and in an "HCP" pane. Use it whenever you need something from them, instead of prose.
`

const protocolRules = (watched: string) => [
  '- A decision among discrete options (approach, environment, scope, yes/no, approving a draft): call mcp__hcp__ask. Put a draft issue, comment or plan in `draft`. Don\'t restate the options after the call.',
  '- Text the person will paste elsewhere (a Slack message, an email, a PR description, a status update): call mcp__hcp__share instead of printing it for them to select. It is outward-facing: write it for its audience.',
  `- A step only they can do (an interactive login, VPN, an access request, /mcp auth, running something locally): call mcp__hcp__handoff. Auth failures from ${watched} in Bash, and MCP servers that need authorizing, are raised as handoffs for you, and you'll get a note saying so: don't retry the command, debug it, or run the login yourself.`,
  '- Calls that reach other people (an email, a chat message, an issue or PR comment, an @mention) are held by hcp until the person approves the exact content on a card: the call fails with "[hcp] Held … card r<n>". Don\'t ask first and don\'t retry or work around a held call; carry on or end your turn. "[HCP r<n>] Send" means make the same call again, unchanged. Public pushes and shared docs only get a badge.',
  '- When you make a non-trivial choice yourself (an approach, a library, a scope cut, a default that matters), record it with mcp__hcp__decided in one call and carry on. Give every mcp__hcp__ask a `kind` too, and `reversible: false` or `reach` when the choice is hard to undo or reaches others. hcp learns from how the person answers like decisions, and shows yours in the pane where they can disagree or change them. "[HCP d<n>] Change …" means rework what you built on that choice to match.',
  '- To give a decision in the task a decision pipeline (a model estimates, code decides, the person corrects it later), or to propose a better way for hcp to choose what to ask, use mcp__hcp__pipeline: `describe` first, then `define`, then `run`.',
  "- Cards don't block. Keep going on work that doesn't need the answer, or end your turn with one short line.",
  '- Pictures belong on the card: pass screenshots, renders or charts the person should look at in `media` (absolute paths, a one-line `caption` each; a video is sampled into frames) on any of the three tools, instead of describing them in prose.',
  '- Evidence belongs in the reel: when a link backs a decision or is something the person will want again (a PR, issue, CI run, deploy, doc, thread), pass it in `links` on the card or decided call, or call mcp__hcp__evidence `add`. When the target moves (a draft becomes a PR, a run is re-run), `update` the same `e<n>` id; `drop` what no longer applies. Keep writing inline links in replies too; hcp harvests them into the reel. "[HCP e<n> · NNTR]" is a link the person added themselves: key context.',
  '- A message ending in "Attached, view each with Read before acting:" carries the person\'s images or video frames: Read every listed path before you answer.',
]

const PROTOCOL_MESSAGES = `
Messages from the surface start with "[HCP":
- "[HCP c3] ..." is the person's answer, sent to start a turn: act on it.
- "[HCP c3 · NNTR] ..." needs no reply. Take it into account and carry on; don't acknowledge it, and don't start new work because of it alone.
- "[HCP steer] ..." is a course correction sent while you work: follow it from your next step, without acknowledging it.
- "[HCP mode] ..." sets how to work until changed:
  - pairing (the default): ask freely.
  - heads-down: batch your questions into one card, keep updates to a line, don't ask about anything reversible.
  - away: don't wait on answers. Take safe, reversible defaults; leave questions as cards; make no outward-facing write (issues, PRs, Slack, deploys) until they're back.
- "[HCP concise] on" means short replies and no recaps until it says off.
- "[HCP layout] ..." is the person describing how the HCP pane should look: call mcp__hcp__layout \`get\`, then \`set\` the smallest spec change that does it (with their words in \`request\`), and say in one line what changed.`

/** What Claude is told, with the watched logins and any extension's rules. */
export function protocolText(): string {
  const rules = [...protocolRules(watchedLabels()), ...current.protocol]

  return `${PROTOCOL_HEAD}\n${rules.join('\n')}\n${PROTOCOL_MESSAGES}`
}

type Schema = Record<string, unknown>

/** At most this many pictures on a card, video frames included. */
export const MAX_MEDIA = 12

const MEDIA_PROPS = {
  media: {
    type: 'array',
    maxItems: MAX_MEDIA,
    description:
      'Pictures to show on the card: screenshots, renders, charts. A video is sampled into frames the person can flip through.',
    items: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to an image (png, jpg, gif, webp, heic) or a video (mov, mp4, webm).' },
        caption: { type: 'string', description: 'One line on what it shows.' },
      },
      required: ['path'],
    },
  },
  layout: {
    type: 'string',
    enum: ['grid', 'slides'],
    description: 'grid: side by side; slides: one at a time with a note per slide. Default: grid up to 4, slides above.',
  },
} as const

/** At most this many links on one card or in one evidence call. */
export const MAX_LINKS = 12

// Defined here, not in evidence.ts, since the tool schemas below spread it at load time.
export const LINK_PROPS = {
  links: {
    type: 'array',
    maxItems: MAX_LINKS,
    description:
      'The evidence for this: links to the PR, issue, CI run, deploy, doc or thread the person should be able to click. They draw on the card and stay in the Evidence reel of the HCP pane.',
    items: {
      type: 'object',
      properties: {
        href: { type: 'string', description: 'https, mailto or file URL.' },
        label: { type: 'string', description: 'A few words: "PR #412", "CI run", "design doc".' },
        why: { type: 'string', description: 'One line on why it matters here.' },
      },
      required: ['href', 'label'],
    },
  },
} as const

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
      kind: {
        type: 'string',
        description: 'A short slug for the sort of choice (env-choice, library, scope, naming): hcp compares it with like decisions the person answered before.',
      },
      recommended: {
        type: 'array',
        items: { type: 'string' },
        description: 'Values to preselect: your recommendation.',
      },
      reversible: { type: 'boolean', description: 'false when the choice is hard to undo: hcp then shows your recommendation only after the person picks.' },
      reach: {
        type: 'string',
        enum: ['local', 'own', 'shared', 'notifies'],
        description: 'Who acting on the choice reaches: shared (others see it) or notifies (people get a message) is always asked, and hides your recommendation until the person picks.',
      },
      ...MEDIA_PROPS,
      ...LINK_PROPS,
    },
    required: ['title', 'options'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const HANDOFF_TOOL = {
  name: 'handoff',
  description:
    "Hand the person a step only they can do (an interactive login, VPN, an access request, /mcp auth, running something on their machine) as a card with Done / Later / Can't buttons, instead of explaining it in prose. Returns at once: carry on with work that doesn't need it, or end your turn in one line.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What they need to do, imperative, one line.' },
      detail: { type: 'string', description: 'What it unblocks.' },
      fix: { type: 'string', description: 'The command they run, if there is one.' },
      ...MEDIA_PROPS,
      ...LINK_PROPS,
    },
    required: ['title'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const SHARE_TOOL = {
  name: 'share',
  description:
    "Hand the person text to paste somewhere else (a Slack message, an email, a PR description, a status update) as a card with Copy buttons, instead of printing it for them to select. The formatted copy puts HTML on the clipboard, so bold, lists and links survive the paste into Slack, email or a doc. Write it for its audience, in markdown. It is outward-facing. Returns at once; a requested change arrives as \"[HCP <id>] …\".",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What it is, a few words.' },
      text: { type: 'string', description: 'The text to paste, in markdown.' },
      audience: { type: 'string', description: 'Where it goes: Slack channel, email, PR or issue comment.' },
      ...MEDIA_PROPS,
      ...LINK_PROPS,
    },
    required: ['title', 'text'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const DECIDED_TOOL = {
  name: 'decided',
  description:
    'Record a choice you made yourself without asking (an approach, a library, a scope cut, a default), in one call, then carry on. The person sees it in the HCP pane and can agree or disagree; their answers teach hcp which choices to ask about next time. Returns at once.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The choice, as a question: "Which date library?"' },
      choice: { type: 'string', description: 'What you chose.' },
      alternatives: { type: 'array', items: { type: 'string' }, description: 'What else you considered.' },
      why: { type: 'string', description: 'One line.' },
      kind: { type: 'string', description: 'A short slug for the sort of choice: library, scope, naming, approach.' },
      reversible: { type: 'boolean', description: 'Whether it is cheap to undo later.' },
      reach: {
        type: 'string',
        enum: ['local', 'own', 'shared', 'notifies'],
        description: 'Who the choice reaches: shared or notifies means it should have been an mcp__hcp__ask instead.',
      },
      ...LINK_PROPS,
    },
    required: ['title', 'choice', 'kind'],
  } satisfies Schema,
  isDeferred: false,
} as const

export const PIPELINE_TOOL = {
  name: 'pipeline',
  description:
    'Decision pipelines you write as JSON specs: a model estimates (Jev yes/no questions), code decides (a gate with thresholds), the person corrects it later (a feedback edge). `describe` returns the contract, the registry and an example; `define` compiles a spec and saves it, or returns every problem to fix; `run` runs a saved one on an input; `list` lists them. scope "external" is for a decision in the task; scope "internal" proposes a challenger to how hcp chooses what to ask, which only runs in shadow.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['describe', 'define', 'run', 'list'] },
      scope: { type: 'string', enum: ['internal', 'external'] },
      spec: { type: 'object', description: 'define: the pipeline spec.' },
      questions: { type: 'object', description: 'define: question sets by name: { "<set>": { "<key>": { "type": "noul", "instructions": "..." } } }.' },
      routes: { type: 'object', description: 'define: routes by name for generate nodes: { "<route>": { "model": "haiku", "version": "1", "system": "...", "maxTokens": 300 } }.' },
      name: { type: 'string', description: 'run: the saved pipeline id.' },
      input: { type: 'object', description: 'run: the pipeline input.' },
    },
    required: ['action'],
  } satisfies Schema,
  isDeferred: true,
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

/** Words on the surface an extension may change. */
export type Labels = { copyRich: string }

export const LABELS: Labels = { copyRich: 'Copy formatted' }

/** Appended to a tool's description; `properties` replaces a property's description. */
export type ToolTweak = { append?: string; properties?: Record<string, string> }

/**
 * An environment's layer over the base: protocol rules, watched logins, tool
 * wording and labels. Read from JSON at session start; see the README.
 */
export type Extension = {
  protocol: string[]
  services: Record<string, Service>
  tools: Record<string, ToolTweak>
  labels: Partial<Labels>
  /** Tool patterns and their reach level; a later file's win. */
  reach: ReachTag[]
  /** Who estimates a call's reach when the rules can't tell. */
  judge: Judge
}

type Layered = {
  protocol: string[]
  services: Record<string, Service>
  tools: Record<string, ToolTweak>
  labels: Labels
  reach: ReachTag[]
  judge: Judge
}

const base = (): Layered => ({ protocol: [], services: { ...SERVICES }, tools: {}, labels: { ...LABELS }, reach: [], judge: 'jev' })

let current = base()

/** The watched logins, base and extensions together. */
export const services = () => current.services

export const labels = () => current.labels

/** The reach tags, a later file's first, so the first match is the one that wins. */
export const reachTags = () => current.reach

export const judge = () => current.judge

/** Back to the base, then each extension in order: a later one wins a service or label. */
export function applyExtensions(list: readonly Partial<Extension>[]) {
  const next = base()
  for (const ext of list) {
    next.protocol.push(...(ext.protocol ?? []))
    Object.assign(next.services, ext.services)
    Object.assign(next.labels, ext.labels)
    next.reach.unshift(...(ext.reach ?? []))
    if (ext.judge) next.judge = ext.judge
    for (const [name, tweak] of Object.entries(ext.tools ?? {})) {
      const was = next.tools[name] ?? {}
      next.tools[name] = {
        append: [was.append, tweak.append].filter(Boolean).join(' ') || undefined,
        properties: { ...was.properties, ...tweak.properties },
      }
    }
  }
  current = next
}

const strings = (raw: unknown) => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [])

/**
 * An extension file's JSON, keeping what is well formed. A service names its
 * `pattern` (and optional `command`) as case-insensitive regex source; without
 * `command` any Bash command counts.
 */
export function parseExtension(json: string): { extension: Partial<Extension>; problems: string[] } {
  const problems: string[] = []
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch (error) {
    return { extension: {}, problems: [`not JSON: ${(error as Error).message}`] }
  }
  const extension: Partial<Extension> = {}

  if (raw.protocol !== undefined) extension.protocol = strings(raw.protocol)

  if (raw.services !== undefined && typeof raw.services === 'object' && raw.services !== null) {
    extension.services = {}
    for (const [name, spec] of Object.entries(raw.services as Record<string, Record<string, unknown>>)) {
      const verify = strings(spec?.verify)
      if (typeof spec?.label !== 'string' || typeof spec.fix !== 'string' || typeof spec.pattern !== 'string' || verify.length === 0) {
        problems.push(`service ${name} needs label, fix, pattern and verify`)
        continue
      }
      try {
        const pattern = new RegExp(spec.pattern, 'i')
        const command = typeof spec.command === 'string' ? new RegExp(spec.command) : undefined
        extension.services[name] = {
          label: spec.label,
          fix: spec.fix,
          verify,
          isRunnable: spec.runnable === true,
          isCommand: c => command?.test(c) ?? true,
          pattern,
        }
      } catch (error) {
        problems.push(`service ${name}: ${(error as Error).message}`)
      }
    }
  }

  if (raw.tools !== undefined && typeof raw.tools === 'object' && raw.tools !== null) {
    extension.tools = {}
    for (const [name, tweak] of Object.entries(raw.tools as Record<string, Record<string, unknown>>)) {
      const properties = Object.fromEntries(
        Object.entries((tweak?.properties ?? {}) as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      extension.tools[name] = { ...(typeof tweak?.append === 'string' ? { append: tweak.append } : {}), properties }
    }
  }

  if (raw.labels !== undefined && typeof raw.labels === 'object' && raw.labels !== null) {
    const l = raw.labels as Record<string, unknown>
    extension.labels = typeof l.copyRich === 'string' ? { copyRich: l.copyRich } : {}
  }

  if (raw.reach !== undefined) {
    const parsed = parseTags(raw.reach)
    extension.reach = parsed.tags
    problems.push(...parsed.problems)
  }

  if (raw.judge !== undefined) {
    if (raw.judge === 'jev' || raw.judge === 'haiku' || raw.judge === 'off') extension.judge = raw.judge
    else problems.push('judge must be "jev", "haiku" or "off"')
  }

  return { extension, problems }
}

type ToolDef = { name: string; description: string; inputSchema: { properties: Record<string, unknown> } & Schema; isDeferred: boolean }

/** A tool as registered: the base with its extension tweak applied. */
export function withTweak<T extends ToolDef>(tool: T): T {
  const handled = tool.name === 'handoff' ? ` ${watchedLabels()} auth failures in Bash are raised for you; don't call this for those.` : ''
  const tweak = current.tools[tool.name]
  const properties = { ...tool.inputSchema.properties }
  for (const [prop, description] of Object.entries(tweak?.properties ?? {})) {
    const was = properties[prop] as Record<string, unknown> | undefined
    if (was !== undefined) properties[prop] = { ...was, description }
  }

  return {
    ...tool,
    description: [tool.description + handled, tweak?.append].filter(Boolean).join(' '),
    inputSchema: { ...tool.inputSchema, properties },
  }
}

/** `gcloud / bq, twg and glab`: the logins whose failure raises a handoff. */
export function watchedLabels(): string {
  const names = Object.values(current.services).map(s => s.label)

  return names.length <= 1 ? (names[0] ?? 'no CLI') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The service whose credentials a failed Bash call ran into. `scanned` is
 * stderr for a call that succeeded and the whole output for one that failed,
 * so a grep that prints "gcloud auth login" never counts.
 */
// Commands that only print files: their output can quote a login hint without any login failing.
const VIEWER = /^\s*(cd\s+[^;&|]+(&&|;)\s*)?(cat|sed|grep|rg|head|tail|less|awk|wc|find|ls|jq|git\s+(show|diff|log|grep))\b/

export function detectService(command: string, scanned: string): string | undefined {
  if (VIEWER.test(command)) return undefined

  return Object.keys(current.services).find(name => {
    const service = current.services[name]!

    return service.isCommand(command) && service.pattern.test(scanned)
  })
}

export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const tag = (card: HcpCard, delivery: HcpDelivery) =>
  delivery === 'nntr' ? `[HCP ${card.id} · NNTR]` : `[HCP ${card.id}]`

const noteOf = (card: HcpCard) => (card.note.trim() ? ` Note: "${card.note.trim()}"` : '')

/** The person's notes on slides, in slide order, each naming its picture. */
function slideNotesOf(card: HcpCard): string {
  const notes = Object.entries(card.slideNotes ?? {})
    .filter(([, text]) => text.trim())
    .sort(([a], [b]) => Number(a) - Number(b))

  return notes
    .map(([at, text]) => {
      const media = card.media?.[Number(at)]
      const what = media?.caption ? ` ("${media.caption}")` : media ? ` (${media.path})` : ''

      return ` On image ${Number(at) + 1}${what}: "${text.trim()}"`
    })
    .join('')
}

/** What Claude reads for an answer, or undefined when there is nothing to say yet. */
export function answerText(card: HcpCard, delivery: HcpDelivery): string | undefined {
  const onSlides = slideNotesOf(card)
  if (card.kind === 'ask') {
    const labels = card.options.filter(o => card.picked.includes(o.value)).map(o => o.label)
    if (labels.length === 0 && !card.note.trim() && !onSlides) return undefined
    const choice = labels.length > 0 ? labels.join(', ') : 'no option picked'

    return `${tag(card, delivery)} ${card.title} → ${choice}.${noteOf(card)}${onSlides}`
  }

  if (card.kind === 'share') {
    if (!card.note.trim() && !onSlides) return undefined

    return `${tag(card, delivery)} Change "${card.title}": ${card.note.trim() || 'see the notes on its images.'}${onSlides}`
  }

  return `${tag(card, delivery)} Done: ${card.title}.${noteOf(card)}${onSlides} Retry what was blocked.`
}

export const cantText = (card: HcpCard) =>
  `[HCP ${card.id} · NNTR] Can't do "${card.title}" right now.${noteOf(card)} Work around it; don't ask again unless it's the only way forward.`

export const deferText = (card: HcpCard, when: string) =>
  `[HCP ${card.id} · NNTR] Will do "${card.title}" around ${when}. Don't wait on it; carry on with what doesn't need it.`

const serviceLabel = (service: string | undefined) =>
  service?.startsWith('mcp:') ? `The ${service.slice(4)} MCP server` : `${current.services[service ?? '']?.label ?? service}`

export const autoHandoffNote = (card: HcpCard) =>
  `[HCP ${card.id}] ${serviceLabel(card.service)} needs the person to authenticate. A handoff card is up and the person has been notified. Don't retry the command, debug it, or run the login yourself: carry on with work that doesn't need it, or end your turn in one line. "[HCP ${card.id}] Done" arrives when it's fixed.`

const LEVEL_WORDS = { local: 'stays local', own: 'goes to your own account', shared: 'is visible to others', notifies: 'notifies people' } as const

/** What Claude reads when hcp holds a call: why, which card, and what to do meanwhile. */
export function heldText(card: HcpCard, mode: HcpMode): string {
  const r = card.reach!
  const to = r.audience.length > 0 ? ` (${clip(r.audience.join(', '), 80)})` : ''
  const meanwhile = mode === 'away' ? 'The person is away: it waits for them.' : 'The person has been shown the exact content.'

  return `[hcp] Held: this ${r.channel} call ${LEVEL_WORDS[r.level]}${to}. Card ${card.id} is up. ${meanwhile} Don't retry it or reach them another way; carry on with work that doesn't need it, or end your turn in one line. "[HCP ${card.id}] Send" means make the same call again, unchanged.`
}

/** The person's choice on a reach card. */
export type ReachChoice = 'send' | 'similar-1h' | 'similar-day' | 'change' | 'edit' | 'draft' | 'not-now'

export const GRANT_HOURS: Partial<Record<ReachChoice, number>> = { 'similar-1h': 1, 'similar-day': 10 }

/** What Claude reads for a reach card's answer. */
export function reachAnswerText(card: HcpCard, choice: ReachChoice, note: string): string {
  const r = card.reach!
  const said = note.trim() ? ` Note: "${note.trim()}"` : ''
  const hours = GRANT_HOURS[choice]
  if (choice === 'send' || hours !== undefined) {
    const grant =
      hours === undefined
        ? ''
        : ` Similar ${r.channel} calls to the same audience may go through for the next ${hours === 1 ? 'hour' : `${hours} hours`} without a card.`

    return `[HCP ${card.id}] Send it: make the held ${r.channel} call again, unchanged.${grant}${said}`
  }
  if (choice === 'change') {
    return `[HCP ${card.id}] Don't send the ${r.channel} call as it is. Change it:${said || ' see the note.'} Then make the call again; hcp shows it to the person once more.`
  }
  if (choice === 'edit') {
    const fence = note.includes('```') ? '~~~' : '```'

    return `[HCP ${card.id}] Send it with the person's edits: make the ${r.channel} call again to the same audience, with exactly this as its content (for a Bash call, this is the whole command):\n${fence}\n${note.trim()}\n${fence}\nIt goes through without another card if the content matches.`
  }
  if (choice === 'draft') {
    return `[HCP ${card.id}] Don't send the ${r.channel} call. Save it as a draft instead (a draft in that service if it has one, else an mcp__hcp__share card with the text).${said}`
  }

  return `[HCP ${card.id} · NNTR] Not now: don't make the ${r.channel} call, and don't retry it.${said}`
}

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

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i
export const VIDEO_FILE = /\.(mov|mp4|m4v|webm|mkv|avi)$/i
export const isMediaFile = (path: string) => IMAGE_FILE.test(path) || VIDEO_FILE.test(path)

/** A tool's `media` as Claude passed it: paths with optional captions, at most MAX_MEDIA. */
export function parseMedia(raw: unknown): { path: string; caption?: string }[] {
  if (!Array.isArray(raw)) return []

  return raw
    .flatMap(item => {
      const m = (typeof item === 'string' ? { path: item } : item) as Record<string, unknown>
      if (typeof m.path !== 'string' || !m.path.trim()) return []

      return [{ path: m.path.trim(), ...(typeof m.caption === 'string' && m.caption.trim() ? { caption: m.caption.trim() } : {}) }]
    })
    .slice(0, MAX_MEDIA)
}

// A quoted path, a file:// URL, or a bare one starting at / or ~ with backslash escapes,
// which is what dragging a file into a terminal or an editor field pastes.
const PATHISH = /'([^']+)'|"([^"]+)"|(file:\/\/[^\s'"]+)|((?:~|\/)(?:\\.|[^\s'"\\])+)/g

/** The image and video paths in what the person typed, and the words left around them. */
export function splitPaths(text: string): { paths: string[]; rest: string } {
  const paths: string[] = []
  const rest = text.replace(PATHISH, (whole, single?: string, double?: string, url?: string, bare?: string) => {
    let path = single ?? double ?? ''
    if (url !== undefined) {
      try {
        path = decodeURIComponent(url.slice('file://'.length))
      } catch {
        return whole
      }
    }
    if (bare !== undefined) path = bare.replace(/\\(.)/g, '$1').replace(/[,.;:)]+$/, '')
    if (!isMediaFile(path)) return whole
    if (!paths.includes(path)) paths.push(path)

    return ''
  })

  return { paths, rest: rest.replace(/\s+/g, ' ').trim() }
}

/** The lines that hand Claude the person's pictures: paths it reads with Read. */
export function attachedText(media: readonly HcpMedia[]): string {
  if (media.length === 0) return ''
  const lines = media.map(m => {
    const about = [m.caption, m.video ? `a frame of ${m.video}` : ''].filter(Boolean).join(', ')

    return `- ${m.path}${about ? ` (${about})` : ''}`
  })

  return `\nAttached, view each with Read before acting:\n${lines.join('\n')}`
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
