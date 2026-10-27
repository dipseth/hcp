// The Evidence reel's plain logic: which links count, where they come from,
// how a new one merges with what's there, and the order the pane draws them in.

import type { HcpEvidence, HcpEvidenceSource, HcpLink, HcpLinkKind } from '../types'
import { MAX_LINKS, clip } from './model'

/** The reel keeps this many entries; older unpinned ones fall off. */
export const MAX_EVIDENCE = 100

/** How many entries the reel shows before "show all". */
export const REEL_SIZE = 8

const SCHEME = /^(https?:\/\/|mailto:|file:\/\/)/i

export const EVIDENCE_TOOL = {
  name: 'evidence',
  description:
    "Keep the Evidence reel of the HCP pane current: the links the person's decisions rest on (a PR, issue, CI run, deploy, doc, thread), so they never scroll back to find one. `add` puts links in; `update` changes an entry by its id (the href moved, a draft became a PR, a run was re-run) and keeps its history; `drop` retires one that no longer applies. Links on a card's `links` field are already in the reel, as are links in your replies. Returns at once with the ids to refer to.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'drop'] },
      items: {
        type: 'array',
        maxItems: MAX_LINKS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'update, drop: the entry (`e3`). update without an id matches by href.' },
            href: { type: 'string', description: 'https, mailto or file URL.' },
            label: { type: 'string', description: 'A few words.' },
            why: { type: 'string', description: 'One line on why it matters.' },
            for: { type: 'string', description: 'The card or decision it supports (`c3`, `d2`), if any.' },
          },
        },
      },
    },
    required: ['action', 'items'],
  },
  isDeferred: false,
} as const

/** `host/path`, clipped: a label for a link that came with none. */
export function defaultLabel(href: string): string {
  if (/^mailto:/i.test(href)) return href.slice(7)
  if (/^file:/i.test(href)) return href.slice(href.lastIndexOf('/') + 1) || href
  try {
    const u = new URL(href)
    const path = u.pathname.replace(/\/+$/, '')

    return clip(`${u.host}${path}`, 60)
  } catch {
    return clip(href, 60)
  }
}

/** Links as a tool passed them: strings or `{ href, label, why }`, a known scheme, at most MAX_LINKS. */
export function parseLinks(raw: unknown): HcpLink[] {
  if (!Array.isArray(raw)) return []

  return raw
    .flatMap(item => {
      const l = (typeof item === 'string' ? { href: item } : item) as Record<string, unknown>
      if (typeof l?.href !== 'string' || !SCHEME.test(l.href.trim())) return []
      const href = l.href.trim()

      return [
        {
          href,
          label: typeof l.label === 'string' && l.label.trim() ? clip(l.label.trim(), 80) : defaultLabel(href),
          ...(typeof l.why === 'string' && l.why.trim() ? { why: clip(l.why.trim(), 160) } : {}),
        },
      ]
    })
    .slice(0, MAX_LINKS)
}

/** Two spellings of one place read the same: no fragment, no trailing slash, lower-case host. */
export function normalizeHref(href: string): string {
  try {
    const u = new URL(href)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    u.pathname = u.pathname.replace(/\/+$/, '')

    return u.toString().replace(/\/+$/, '')
  } catch {
    return href.replace(/#.*$/, '').replace(/\/+$/, '')
  }
}

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>()"'`\]]+/g

/** The links in a reply or a tool's output: markdown ones with their text, then bare URLs. */
export function harvestLinks(text: string): HcpLink[] {
  const found: HcpLink[] = []
  const seen = new Set<string>()
  const keep = (href: string, label?: string) => {
    const key = normalizeHref(href)
    if (seen.has(key)) return
    seen.add(key)
    found.push({ href, label: label?.trim() ? clip(label.trim(), 80) : defaultLabel(href) })
  }
  let rest = text.replace(MARKDOWN_LINK, (_, label: string, href: string) => {
    keep(href, label)

    return ' '
  })
  // A fenced block often quotes URLs as examples; a reply's prose is where the evidence is.
  rest = rest.replace(/```[\s\S]*?```/g, ' ')
  for (const m of rest.match(BARE_URL) ?? []) keep(m.replace(/[.,;:!?)\]]+$/, ''))

  return found.slice(0, MAX_LINKS)
}

const KIND_HOSTS: [RegExp, HcpLinkKind][] = [
  [/^file:/i, 'file'],
  [/^mailto:|mail\.google\.com|outlook\.(live|office)\.com/i, 'email'],
  [/github\.com/i, 'github'],
  [/gitlab/i, 'gitlab'],
  [/atlassian\.net|jira\./i, 'jira'],
  [/docs\.google\.com|notion\.(so|site)|confluence|claude\.ai\/docs/i, 'doc'],
  [/claude\.ai\/(code\/)?artifact/i, 'artifact'],
  [/vercel\.(app|com)|netlify\.app|fly\.dev|railway\.app/i, 'deploy'],
  [/sentry\.io|langfuse\.com|grafana|datadoghq\.com/i, 'monitor'],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/i, 'local'],
]

export function kindOf(href: string): HcpLinkKind {
  return KIND_HOSTS.find(([pattern]) => pattern.test(href))?.[1] ?? 'app'
}

export const KIND_ICON: Record<HcpLinkKind, string> = {
  github: '⌥',
  gitlab: '⌥',
  jira: '◫',
  email: '✉',
  doc: '▤',
  artifact: '◧',
  deploy: '▲',
  monitor: '◉',
  local: '⌂',
  file: '▢',
  app: '↗',
}

// A stronger source wins when the same link arrives twice: what the person added beats what Claude posted, which beats what was found in passing.
const STRENGTH: Record<HcpEvidenceSource, number> = { you: 4, claude: 3, card: 2, tool: 1, harvest: 0 }

export type EvidenceMeta = { source: HcpEvidenceSource; cardId?: string; toolUseId?: string }

/**
 * New links merged into the reel: one already there (by normalized href) is
 * refreshed and keeps its id; a new one gets the next id. Returns the ids the
 * links now have, in the order given.
 */
export function mergeEvidence(
  list: HcpEvidence[],
  incoming: readonly HcpLink[],
  meta: EvidenceMeta,
  at: number,
  nextId: () => string,
): { list: HcpEvidence[]; ids: string[] } {
  let next = [...list]
  const ids: string[] = []
  for (const link of incoming) {
    const key = normalizeHref(link.href)
    const found = next.findIndex(e => normalizeHref(e.href) === key)
    if (found >= 0) {
      const was = next[found]!
      const isStronger = STRENGTH[meta.source] >= STRENGTH[was.source]
      next[found] = {
        ...was,
        status: 'live',
        updatedAt: at,
        source: isStronger ? meta.source : was.source,
        label: isStronger && link.label ? link.label : was.label,
        ...(link.why && (isStronger || !was.why) ? { why: link.why } : {}),
        ...(was.cardId === undefined && meta.cardId !== undefined ? { cardId: meta.cardId } : {}),
        ...(was.toolUseId === undefined && meta.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
      }
      ids.push(was.id)
      continue
    }
    const id = nextId()
    next.push({
      ...link,
      id,
      kind: kindOf(link.href),
      source: meta.source,
      ...(meta.cardId !== undefined ? { cardId: meta.cardId } : {}),
      ...(meta.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
      at,
      updatedAt: at,
      status: 'live',
    })
    ids.push(id)
  }
  if (next.length > MAX_EVIDENCE) {
    // The oldest unpinned entries fall off first, stale before live.
    const drop = next.length - MAX_EVIDENCE
    const victims = next
      .filter(e => !e.isPinned)
      .sort((a, b) => (a.status === b.status ? a.updatedAt - b.updatedAt : a.status === 'stale' ? -1 : 1))
      .slice(0, drop)
      .map(e => e.id)
    next = next.filter(e => !victims.includes(e.id))
  }

  return { list: next, ids }
}

/** An entry changed in place: the old link goes on its history, the id stays. */
export function updateEvidence(list: HcpEvidence[], id: string, next: Partial<HcpLink> & { cardId?: string }, at: number): HcpEvidence[] {
  return list.map(e => {
    if (e.id !== id) return e
    const old: HcpLink = { href: e.href, label: e.label, ...(e.why ? { why: e.why } : {}) }
    const href = next.href ?? e.href

    return {
      ...e,
      href,
      kind: kindOf(href),
      label: next.label ?? e.label,
      ...(next.why !== undefined ? { why: next.why } : e.why ? { why: e.why } : {}),
      ...(next.cardId !== undefined ? { cardId: next.cardId } : e.cardId ? { cardId: e.cardId } : {}),
      status: 'live',
      updatedAt: at,
      was: [old, ...(e.was ?? [])].slice(0, 5),
    }
  })
}

export const dropEvidence = (list: HcpEvidence[], id: string): HcpEvidence[] =>
  list.map(e => (e.id === id ? { ...e, status: 'stale', isPinned: false } : e))

/**
 * The reel's order: pinned, then what backs an open card, then what Claude or
 * the person put in on purpose, then what was found in passing; newest first
 * within each; stale ones last.
 */
export function rankEvidence(list: readonly HcpEvidence[], openCardIds: readonly string[]): HcpEvidence[] {
  const tier = (e: HcpEvidence) => {
    if (e.status === 'stale') return 4
    if (e.isPinned) return 0
    if (e.cardId !== undefined && openCardIds.includes(e.cardId)) return 1
    if (e.source === 'you' || e.source === 'claude' || e.source === 'card') return 2

    return 3
  }

  // Two entries from the same moment: the later id is the newer one.
  const n = (e: HcpEvidence) => Number(e.id.slice(1)) || 0

  return [...list].sort((a, b) => tier(a) - tier(b) || b.updatedAt - a.updatedAt || n(b) - n(a))
}

/** `url label words`: what the person typed into the reel's field. */
export function parseTypedLink(text: string): HcpLink | undefined {
  const m = /(https?:\/\/\S+|mailto:\S+|file:\/\/\S+)/i.exec(text)
  if (!m) return undefined
  const href = m[1]!.replace(/[.,;:!?)\]]+$/, '')
  const label = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim()

  return { href, label: label ? clip(label, 80) : defaultLabel(href) }
}

/** What Claude reads back from the evidence tool. */
export function evidenceText(action: 'add' | 'update' | 'drop', ids: readonly string[], problems: readonly string[]): string {
  const done =
    ids.length === 0
      ? ''
      : action === 'add'
        ? `In the reel: ${ids.join(', ')}.`
        : action === 'update'
          ? `Updated ${ids.join(', ')}.`
          : `Dropped ${ids.join(', ')}.`
  const trouble = problems.length > 0 ? ` ${problems.join(' ')}` : ''

  return `${done || 'Nothing changed.'}${trouble} Refer to entries by id; don't list the links again in prose.`
}

/** Commands whose output names the thing they made: a PR, an issue, a deploy. */
export const LINK_COMMANDS = /^\s*(gh|glab|vercel|npx\s+vercel)\b|\bgit\s+push\b/

/** The first words of a command, as a harvested link's context. */
export const commandLabel = (command: string) => command.trim().split(/\s+/).slice(0, 3).join(' ')

/** The person's own link, as Claude is told about it. */
export const addedLinkNote = (link: HcpLink, id: string) =>
  `[HCP ${id} · NNTR] The person added evidence to the reel: ${link.label} ${link.href}. Treat it as key context; refer to it as ${id}.`
