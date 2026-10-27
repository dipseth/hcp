// The pane's layout as a spec: which sections draw, in what order, and a few
// options per section. Claude writes it with mcp__hcp__layout from what the
// person asked for (the pane's ✎ layout button), so the pane changes without
// a code change; the spec is validated here and kept in ~/.claude/hcp/layout.json.

import type { HcpLayout, HcpLayoutFile, HcpSectionId } from '../types'

export const SECTIONS = [
  'mode',
  'auth',
  'waiting',
  'evidence',
  'reply',
  'steer',
  'decided',
  'grants',
  'outward',
  'scheduled',
  'you-sent',
  'recent',
] as const satisfies readonly HcpSectionId[]

export type SectionId = HcpSectionId

const ABOUT: Record<SectionId, string> = {
  mode: 'the Pairing / Heads-down / Away and Concise buttons, with the mode blurb',
  auth: 'a line when an MCP server needs authorizing',
  waiting: 'the cards waiting on the person',
  evidence: 'the Evidence reel: links the decisions rest on',
  reply: "quick replies and the message field for Claude's last message",
  steer: 'steers for the current run',
  decided: 'choices Claude recorded, with Fine / Disagree / Change',
  grants: 'live grants for held calls',
  outward: 'calls that left the machine this session',
  scheduled: 'messages and reminders scheduled for later',
  'you-sent': 'pictures the person pasted',
  recent: 'recently answered cards',
}

export type Layout = HcpLayout
export type LayoutFile = HcpLayoutFile

export const DEFAULT_LAYOUT: Layout = {
  order: [...SECTIONS],
  hidden: [],
  modeBlurb: true,
  evidence: { size: 8, add: 'button', hint: true },
}

const isSection = (v: unknown): v is SectionId => typeof v === 'string' && (SECTIONS as readonly string[]).includes(v)

/**
 * A spec as Claude or the file gave it, made whole: unknown sections and bad
 * values become problems, missing ones take the default. `waiting` is never hidden.
 */
export function parseLayout(raw: unknown, base: Layout = DEFAULT_LAYOUT): { layout: Layout; problems: string[] } {
  const problems: string[] = []
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null) return { layout: base, problems: ['the spec must be an object'] }

  let order = base.order
  if (r.order !== undefined) {
    if (!Array.isArray(r.order)) problems.push('order must be a list of section ids')
    else {
      const bad = r.order.filter(v => !isSection(v))
      if (bad.length > 0) problems.push(`unknown sections in order: ${bad.join(', ')}`)
      const given = [...new Set(r.order.filter(isSection))]
      order = [...given, ...SECTIONS.filter(id => !given.includes(id))]
    }
  }

  let hidden = base.hidden
  if (r.hidden !== undefined) {
    if (!Array.isArray(r.hidden)) problems.push('hidden must be a list of section ids')
    else {
      const bad = r.hidden.filter(v => !isSection(v))
      if (bad.length > 0) problems.push(`unknown sections in hidden: ${bad.join(', ')}`)
      if (r.hidden.includes('waiting')) problems.push('waiting stays: cards must reach the person')
      hidden = [...new Set(r.hidden.filter(isSection))].filter(id => id !== 'waiting')
    }
  }

  let modeBlurb = base.modeBlurb
  if (r.modeBlurb !== undefined) {
    if (typeof r.modeBlurb === 'boolean') modeBlurb = r.modeBlurb
    else problems.push('modeBlurb must be true or false')
  }

  const evidence = { ...base.evidence }
  if (r.evidence !== undefined) {
    const e = (r.evidence ?? {}) as Record<string, unknown>
    if (e.size !== undefined) {
      if (typeof e.size === 'number' && Number.isInteger(e.size) && e.size >= 1 && e.size <= 30) evidence.size = e.size
      else problems.push('evidence.size must be a whole number from 1 to 30')
    }
    if (e.add !== undefined) {
      if (e.add === 'button' || e.add === 'field' || e.add === 'off') evidence.add = e.add
      else problems.push('evidence.add must be "button", "field" or "off"')
    }
    if (e.hint !== undefined) {
      if (typeof e.hint === 'boolean') evidence.hint = e.hint
      else problems.push('evidence.hint must be true or false')
    }
  }

  const request = typeof r.request === 'string' && r.request.trim() ? r.request.trim().slice(0, 200) : base.request

  return { layout: { order, hidden, modeBlurb, evidence, ...(request ? { request } : {}) }, problems }
}

/** The sections to draw, in order. */
export const drawnSections = (layout: Layout): SectionId[] => layout.order.filter(id => !layout.hidden.includes(id))

export const LAYOUT_TOOL = {
  name: 'layout',
  description:
    'Change how the HCP pane is laid out, from what the person asked for ("[HCP layout] …"). `get` returns the spec in force, every section id with what it holds, and the options; `set` replaces the spec (fields left out keep their current value) and returns any problems; `undo` restores the spec before the last set; `reset` restores the default. The pane redraws at once. Put the person\'s words in `request`.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'undo', 'reset'] },
      spec: {
        type: 'object',
        description: 'set: { order?: section ids in draw order, hidden?: section ids, modeBlurb?: boolean, evidence?: { size?: 1-30, add?: "button"|"field"|"off", hint?: boolean }, request?: the person\'s words }.',
      },
    },
    required: ['action'],
  },
  isDeferred: false,
} as const

/** What `get` hands Claude: the spec and what each part means. */
export function layoutDescription(layout: Layout): string {
  const sections = SECTIONS.map(id => `- ${id}: ${ABOUT[id]}`).join('\n')

  return [
    `Current spec:\n${JSON.stringify(layout, null, 2)}`,
    `Sections:\n${sections}`,
    'Options: modeBlurb (the line under the mode buttons); evidence.size (entries before "show all"); evidence.add: "button" (a small dim + link that opens the field), "field" (always open), "off"; evidence.hint (the line shown while the reel is empty). `waiting` cannot be hidden. The ✎ layout button at the bottom always draws.',
    "Set only what the request needs, then tell the person in a line what changed and that ✎ layout → undo reverts it.",
  ].join('\n\n')
}

/** What the person's ✎ layout request sends Claude. */
export const layoutRequestText = (text: string) =>
  `[HCP layout] ${text.trim()} (Change the pane with mcp__hcp__layout: get, then set.)`
