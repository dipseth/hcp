// The surface pipeline: whether a decision Claude makes should be asked
// (a card before acting), told (acted on, with a card to override), or only
// logged. It runs in shadow: it records what it would do beside what really
// happened, and changes nothing until a trial says it should.
//
// It is a JSON spec, not code, so Claude can write challengers to it (and
// pipelines for the person's own tasks) against the same registry.

import { compilePipelineSpec, defineRegistry, hashToUnit, jsonataEngine, z } from './vendor/dp.js'
import type { CompileResult, Distributions, SpecRegistry } from './vendor/dp.js'

import type { HcpDecision } from '../types'

/** The outcomes that say the person wanted a say: asking was right. */
const NEEDED = new Set<HcpDecision['outcome']>(['overrode', 'no-pick', 'disagreed'])
/** The outcomes that say Claude's choice stood: telling would have done. */
const STOOD = new Set<HcpDecision['outcome']>(['took', 'agreed'])

export const isResolved = (d: HcpDecision) => NEEDED.has(d.outcome) || STOOD.has(d.outcome)

/** Did the shadow verdict match what the person did? Undefined until they did something telling. */
export function surfacedRight(verdict: string | undefined, outcome: HcpDecision['outcome']): boolean | undefined {
  if (verdict === undefined || !(NEEDED.has(outcome) || STOOD.has(outcome))) return undefined

  return verdict === 'ask' ? NEEDED.has(outcome) : STOOD.has(outcome)
}

/** A precedent as Jev reads it: what was decided, never how the person answered. */
const brief = (d: HcpDecision) => ({ kind: d.kind, title: d.title, choice: d.choice, alternatives: d.alternatives })

export const MAX_PRECEDENTS = 5

/**
 * The past decisions most like this one, resolved only: the same kind first,
 * then the same repo, then this session, newest first. Code picks the few;
 * Jev says which of them really are the same kind of choice.
 */
export function similarPrecedents(decision: HcpDecision, pool: readonly HcpDecision[]): HcpDecision[] {
  const score = (d: HcpDecision) =>
    (d.kind === decision.kind ? 4 : 0) + (d.repo !== undefined && d.repo === decision.repo ? 2 : 0) + (d.session === decision.session ? 1 : 0)

  return pool
    // Card ids restart each session: a decision is its id within its session.
    .filter(d => !(d.id === decision.id && d.session === decision.session) && isResolved(d))
    .sort((a, b) => score(b) - score(a) || b.at - a.at)
    .slice(0, MAX_PRECEDENTS)
}

/** One state, many atomic questions: one per precedent, and three about the decision itself. */
export function surfaceFrame(decision: HcpDecision, precedents: readonly HcpDecision[]) {
  const questions: Record<string, { type: 'noul'; instructions: string }> = {
    reversible: { type: 'noul', instructions: 'Can the choice in `decision` be undone easily later?' },
    others: {
      type: 'noul',
      instructions: 'Does the choice in `decision` affect people other than the user, such as teammates, customers or a public audience?',
    },
    close: {
      type: 'noul',
      instructions: 'Are the options in `decision` close enough that a careful person could reasonably pick any of them?',
    },
  }
  precedents.forEach((_, at) => {
    questions[`same_kind_${at}`] = {
      type: 'noul',
      instructions: `Is \`decision\` the same kind of choice, about the same sort of thing, as \`precedents[${at}]\`?`,
    }
  })

  return { state: { decision: brief(decision), precedents: precedents.map(brief) }, questions }
}

export type Evidence = {
  /** Precedents Jev judged the same kind of choice. */
  n: number
  /** The person's record on them: (stood + 1) / (weighted + 2), this session counting double. */
  rate: number
  reversible: number
  others: number
  close: number
  /** A fixed share of decisions is asked whatever the record says, so the record keeps learning. */
  explore: boolean
  matched: string[]
}

/** Counting and weighting is code: Jev only said which precedents match. */
export function evidenceOf(decision: HcpDecision, items: readonly HcpDecision[], p: Distributions, t: Record<string, number>): Evidence {
  const matched = items.filter((_, at) => (p[`same_kind_${at}`]?.[0] ?? 0) >= t.match!)
  let weighted = 0
  let stood = 0
  for (const d of matched) {
    const w = d.session === decision.session ? 2 : 1
    weighted += w
    if (STOOD.has(d.outcome)) stood += w
  }

  return {
    n: matched.length,
    rate: Math.round(((stood + 1) / (weighted + 2)) * 1000) / 1000,
    // No judge answered: assume the worst, so the decision is asked.
    reversible: p.reversible?.[0] ?? 0,
    others: p.others?.[0] ?? 1,
    close: p.close?.[0] ?? 0,
    explore: hashToUnit(`${decision.id}:explore`) < t.explore!,
    matched: matched.map(d => d.id),
  }
}

/** The champion. Thresholds are a starting point: the shadow report is how they earn their values. */
export const SURFACE_SPEC = {
  id: 'hcp-surface',
  fact: 'surface-verdict',
  input: 'hcp.decision',
  output: 'json',
  trigger: ['on-demand'],
  group: 'decision-{kind}',
  result: ['ask', 'tell', 'log'],
  nodes: {
    precedents: { kind: 'read', call: 'hcp.precedents@1', version: '1' },
    judge: { kind: 'decide', questions: 'hcp-surface', version: '1' },
    evidence: {
      kind: 'code',
      role: 'transform',
      call: 'hcp.evidence@1',
      args: { items: 'precedents.items', p: 'judge' },
      thresholds: { match: 0.7, explore: 0.1 },
      version: '1',
    },
    gate: {
      kind: 'code',
      role: 'gate',
      inputs: { e: 'evidence' },
      branches: ['ask', 'tell', 'log'],
      thresholds: { min_n: 3, others: 0.5, reversible: 0.5, tell: 0.75, log: 0.9, close: 0.5 },
      rules: [
        { when: 'e.explore', branch: 'ask', reason: "'exploring: asked to keep the record honest'" },
        { when: 'e.n < $t.min_n', branch: 'ask', reason: "'too little precedent: ' & $string(e.n) & ' like it'" },
        { when: 'e.others >= $t.others', branch: 'ask', reason: "'affects other people'" },
        { when: 'e.reversible < $t.reversible', branch: 'ask', reason: "'hard to undo'" },
        {
          when: 'e.rate >= $t.log and e.close < $t.close',
          branch: 'log',
          reason: "'you kept the call ' & $string(e.rate * 100) & '% of the time on ' & $string(e.n) & ' like it'",
          confidence: 'e.rate',
        },
        { when: 'e.rate >= $t.tell', branch: 'tell', reason: "'your record: ' & $string(e.rate * 100) & '% kept'", confidence: 'e.rate' },
        { branch: 'ask', reason: "'you often chose differently: ' & $string(e.rate * 100) & '% kept'" },
      ],
      version: '1',
    },
    ask: { kind: 'code', role: 'derive', expr: '{ "verdict": "ask", "reason": $branches.gate.reason, "evidence": gate }', version: '1' },
    tell: { kind: 'code', role: 'derive', expr: '{ "verdict": "tell", "reason": $branches.gate.reason, "evidence": gate }', version: '1' },
    log: { kind: 'code', role: 'derive', expr: '{ "verdict": "log", "reason": $branches.gate.reason, "evidence": gate }', version: '1' },
  },
  edges: [
    { from: 'precedents', to: 'judge' },
    { from: 'precedents', to: 'evidence' },
    { from: 'judge', to: 'evidence' },
    { from: 'evidence', to: 'gate' },
    { from: 'gate', to: 'ask', when: { gate: 'gate', branch: 'ask' } },
    { from: 'gate', to: 'tell', when: { gate: 'gate', branch: 'tell' } },
    { from: 'gate', to: 'log', when: { gate: 'gate', branch: 'log' } },
  ],
  feedback: [
    {
      id: 'surface-outcome',
      from: 'surface:decision',
      to: 'gate',
      source: 'explicit',
      scope: 'user',
      form: 'score',
      latency: 'deferred',
      score: { name: 'surfaced_right', dataType: 'BOOLEAN' },
    },
  ],
  eval: { dataset: 'hcp-surface-eval', gateMetric: 'score_positive' },
} as const

/**
 * What a spec may call. `pool` is read at each run, so precedents recorded a
 * moment ago count. Pipelines Claude writes get the same registry.
 */
export function hcpRegistry(pool: () => readonly HcpDecision[]): SpecRegistry {
  const json = z.unknown()

  return defineRegistry({
    primitives: [
      {
        id: 'hcp.precedents',
        version: '1',
        describe: 'The past resolved decisions most like the input decision (same kind, repo, session first), at most 5, under `items`.',
        args: json,
        run: (_args: unknown, ctx: { input: unknown }) => ({ items: similarPrecedents(ctx.input as HcpDecision, pool()) }),
      },
      {
        id: 'hcp.evidence',
        version: '1',
        describe:
          "The person's record on the precedents Jev matched (`p.same_kind_<i>` ≥ threshold `match`): n, rate, reversible, others, close, explore.",
        args: z.object({ items: json, p: json }),
        run: (args: { items: unknown; p: unknown }, ctx: { input: unknown; thresholds: Readonly<Record<string, number>> }) =>
          evidenceOf(ctx.input as HcpDecision, (args.items ?? []) as HcpDecision[], (args.p ?? {}) as Distributions, ctx.thresholds),
      },
    ],
    schemas: { 'hcp.decision': json, json },
  })
}

const engine = jsonataEngine({ timeoutMs: 250 })

/** A spec, compiled against hcp's registry: every problem at once, for a repair loop. */
export function compileSpec(spec: unknown, registry: SpecRegistry): CompileResult {
  return compilePipelineSpec(spec, registry, engine)
}
