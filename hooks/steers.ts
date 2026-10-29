// Interrupts and steers. When the person stops Claude mid-run, or types while
// it works, what they say next is the clearest signal hcp gets of what this
// project needs. hcp keeps those moments, hands them to the fast classifier
// as context (never as a scored "no"), and builds the pane's steer buttons
// from them per project, with a decision pipeline: a model drafts, code ranks,
// the person's presses and missed steers land back as feedback.

import { definePipeline, hashToUnit, z } from './vendor/dp.js'
import type { NodeRunArgs } from './vendor/dp.js'

import type { HcpSteer } from '../types'
import type { InterruptNote } from './reach'
import { redact } from './reach'

/** One call Claude made in the run the person stopped. */
export type TurnCall = { tool: string; channel: string; summary: string }

/**
 * A time the person stopped Claude (`aborted`) or wrote to it mid-run
 * (`mid-turn`), and what they said. `said` is missing when they stopped it and
 * said nothing before the next turn.
 */
export type InterruptRow = {
  at: number
  kind: 'aborted' | 'mid-turn'
  project: string
  session?: string
  /** Claude's last words before the stop, clipped. */
  doing: string
  calls: TurnCall[]
  said?: string
  source: 'live' | 'backfill'
}

/** A steer button: what it says, what it tells Claude, and where it came from. */
export type SteerDef = HcpSteer

export const DEFAULT_STEERS: SteerDef[] = [
  { id: 'no-code', label: "✋ Don't code yet", text: "Don't write or edit code yet: investigate and plan only.", source: 'default' },
  { id: 'check-first', label: '❓ Check with me first', text: 'Check with me before your next write or outward-facing action.', source: 'default' },
  { id: 'narrow', label: '🎯 Narrow scope', text: 'Narrow the scope to the one thing I asked for; park the rest.', source: 'default' },
  { id: 'wrap-up', label: '🏁 Wrap up', text: 'Finish the current step, then stop and summarize in a few lines.', source: 'default' },
]

export const MAX_STEERS = 4
/** Interrupts with words a project needs before a model drafts steers for it. */
export const MIN_FOR_STEERS = 3
/** New interrupts since the last build that start a rebuild. */
export const REBUILD_AFTER = 3

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** What the person typed, made safe to keep: secrets out, hcp's own replies skipped. */
export function saidOf(text: string): string | undefined {
  // Tags the host adds around a message (an opened file, a command's output) are not what the person said.
  const t = text.replace(/<(local-command-[a-z]+|ide_[a-z_]+|system-reminder|command-[a-z]+)>[\s\S]*?<\/\1>/g, '').trim()
  if (!t || t.startsWith('[HCP') || t.startsWith('/') || t.startsWith('<command-')) return undefined

  return clip(redact(t.replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, '[paste]').replace(/\s+/g, ' ')), 600)
}

const agoOf = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`

  return `${Math.round(m / 1440)}d ago`
}

/**
 * The notes the classifier reads: this project's newest interrupts with words,
 * those during a call on `channel` first. Context only: nothing here counts
 * for or against Claude.
 */
export function notesFor(rows: readonly InterruptRow[], project: string | undefined, now: number, channel?: string, max = 5): InterruptNote[] {
  const touched = (r: InterruptRow) => (channel !== undefined && r.calls.some(c => c.channel === channel) ? 1 : 0)

  return rows
    .filter(r => r.said !== undefined && (project === undefined || r.project === project))
    .sort((a, b) => touched(b) - touched(a) || b.at - a.at)
    .slice(0, max)
    .map(r => ({
      ago: agoOf(now - r.at),
      doing: clip([r.calls.map(c => c.channel).join(', '), r.doing].filter(Boolean).join(' · '), 240),
      said: clip(r.said!, 300),
    }))
}

/** A project's key: the folder name hcp's records use for "this project". */
export const projectOf = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() || 'root'

// The steers pipeline. Its input is what the model reads; ranking is code.
export type SteerInput = {
  project: string
  redirects: { n: number; ago: string; doing: string; said: string }[]
  /** Presses per learned label so far: a used steer keeps its place. */
  presses: Record<string, number>
}

export const STEER_ROUTE = {
  model: 'haiku',
  version: '2',
  maxTokens: 700,
  system:
    'You design one-click "steer" buttons for a developer working with an AI coding agent in one project. ' +
    'You get the things the developer typed right after stopping the agent, or while it was working (`redirects`), each with what the agent was doing. ' +
    'Find the recurring kinds of redirection and write up to 6 buttons that would have said the same thing in one click. ' +
    'Each button: "label" (at most 22 characters including one leading emoji: two to four words), "text" (the instruction the agent receives, imperative, at most 160 characters, ' +
    'specific to this project where the redirects are), and "covers" (the `n` numbers of the redirects it would have handled). ' +
    'Skip one-off requests and anything that only makes sense once. Name no people, secrets or credentials. ' +
    'Reply with a JSON array and nothing else.',
}

type Drafted = { label?: unknown; text?: unknown; covers?: unknown }

/** Parses the model's draft, ranks each steer by the redirects it covers (recent ones weigh more) and its presses, keeps the best. */
export function rankSteers(text: string, input: SteerInput, t: Record<string, number>): { steers: SteerDef[]; dropped: number } {
  let drafted: Drafted[] = []
  try {
    const json = /\[[\s\S]*\]/.exec(text)?.[0]
    drafted = json ? (JSON.parse(json) as Drafted[]) : []
  } catch {
    drafted = []
  }
  const weightOf = new Map(input.redirects.map((r, at) => [r.n, Math.exp(-at / (t.half_life ?? 10))]))
  const ranked = drafted
    .flatMap(d => {
      if (typeof d.label !== 'string' || typeof d.text !== 'string') return []
      const covers = Array.isArray(d.covers) ? [...new Set(d.covers.filter((n): n is number => typeof n === 'number' && weightOf.has(n)))] : []
      const score = covers.reduce((sum, n) => sum + weightOf.get(n)!, 0) + (input.presses[d.label] ?? 0) * (t.press ?? 0.5)

      return [{ label: clip(d.label.trim(), 32), text: clip(d.text.trim(), 200), covers: covers.length, score }]
    })
    .filter(d => d.covers >= (t.min_covers ?? 2))
    .sort((a, b) => b.score - a.score)
  const kept = ranked.slice(0, MAX_STEERS)

  return {
    steers: kept.map(d => ({ id: `s-${Math.floor(hashToUnit(d.label) * 1e8).toString(36)}`, label: d.label, text: d.text, source: 'learned' as const, covers: d.covers })),
    dropped: drafted.length - kept.length,
  }
}

/** Learned steers first, the defaults after them, four in all. */
export function withDefaults(learned: readonly SteerDef[]): SteerDef[] {
  return [...learned, ...DEFAULT_STEERS.filter(d => !learned.some(l => l.label === d.label))].slice(0, MAX_STEERS)
}

/**
 * hcp-steers: draft (a model reads the redirects) → rank (code) → gate
 * (code: learned when anything survived, else the defaults). Presses and
 * missed steers (the person typed what a button offered) are its feedback.
 */
export const steersPipeline = definePipeline({
  id: 'hcp-steers',
  fact: 'steer-set',
  input: z.unknown(),
  output: z.unknown(),
  trigger: ['on-demand'],
  group: (input: SteerInput) => `project-${input.project}`,
  result: ['learned', 'default'],
  nodes: {
    draft: { kind: 'generate', prompt: 'steer-draft', route: 'steer-draft', version: '2' },
    rank: {
      kind: 'code',
      role: 'transform',
      thresholds: { min_covers: 2, half_life: 10, press: 0.5 },
      run: (args: NodeRunArgs) => rankSteers(String((args.primary as { text?: string } | undefined)?.text ?? ''), args.input as SteerInput, args.thresholds),
      version: '1',
    },
    gate: {
      kind: 'code',
      role: 'gate',
      branches: ['learned', 'default'],
      run: (args: NodeRunArgs) => {
        const { steers } = args.primary as { steers: SteerDef[] }

        return steers.length > 0
          ? { branch: 'learned' as const, reason: `${steers.length} steer${steers.length === 1 ? '' : 's'} from your redirects` }
          : { branch: 'default' as const, reason: 'no redirect came up often enough' }
      },
      version: '1',
    },
    learned: { kind: 'code', role: 'derive', run: (args: NodeRunArgs) => ({ steers: withDefaults((args.primary as { steers: SteerDef[] }).steers) }), version: '1' },
    default: { kind: 'code', role: 'derive', run: () => ({ steers: DEFAULT_STEERS }), version: '1' },
  },
  edges: [
    { from: 'draft', to: 'rank' },
    { from: 'rank', to: 'gate' },
    { from: 'gate', to: 'learned', when: { gate: 'gate', branch: 'learned' } },
    { from: 'gate', to: 'default', when: { gate: 'gate', branch: 'default' } },
  ],
  feedback: [
    { id: 'steer-press', from: 'surface:steer', to: 'rank', source: 'explicit', scope: 'user', form: 'score', latency: 'deferred', score: { name: 'steer_used', dataType: 'BOOLEAN' } },
    { id: 'steer-missed', from: 'surface:interrupt', to: 'rank', source: 'implicit', scope: 'user', form: 'score', latency: 'deferred', score: { name: 'steer_missed', dataType: 'BOOLEAN' } },
  ],
  eval: { dataset: 'hcp-steers-eval', gateMetric: 'score_positive' },
})

/** The pipeline's input: the project's newest redirects with words, numbered for `covers`. */
export function steerInput(rows: readonly InterruptRow[], project: string, presses: Record<string, number>, now: number): SteerInput {
  const mine = rows.filter(r => r.project === project && r.said !== undefined).sort((a, b) => b.at - a.at).slice(0, 40)

  return {
    project,
    redirects: mine.map((r, at) => ({ n: at + 1, ago: agoOf(now - r.at), doing: clip([r.calls.map(c => c.channel).join(', '), r.doing].filter(Boolean).join(' · '), 200), said: r.said! })),
    presses,
  }
}

/** The steers saved for a project, and how many interrupts they were built from. */
export type SteerFile = { project: string; steers: SteerDef[]; builtFrom: number; builtAt: number; runId?: string }

/** Rebuild when a project has enough redirects and either no set or enough new ones since. */
export function needsBuild(file: SteerFile | undefined, redirects: number): boolean {
  if (redirects < MIN_FOR_STEERS) return false

  return file === undefined || redirects - file.builtFrom >= REBUILD_AFTER
}

/** The Jev questions that ask whether a redirect is what one of the offered steers says. */
export function missedQuestions(steers: readonly SteerDef[]) {
  return Object.fromEntries(
    steers.map((s, at) => [
      `steer_${at}`,
      { type: 'noul' as const, instructions: `Does \`said\` ask the agent for essentially what \`steers[${at}].text\` says?` },
    ]),
  )
}
