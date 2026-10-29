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
import type { InterruptNote } from './reach'

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

export const MAX_PRECEDENTS = 10

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

/**
 * One state, many atomic questions: one per precedent, three about the
 * decision itself, and, when the person stopped or redirected Claude lately,
 * one that reconciles the decision with what they said then.
 */
export function surfaceFrame(decision: HcpDecision, precedents: readonly HcpDecision[], interrupts: readonly InterruptNote[] = []) {
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
  if (interrupts.length > 0) {
    questions.contested = {
      type: 'noul',
      instructions:
        'The notes in `interrupts` are times the person stopped Claude, or wrote to it mid-run, and what they said. Do they suggest the person would want a say on `decision` before Claude acts on it?',
    }
  }
  precedents.forEach((_, at) => {
    questions[`same_kind_${at}`] = {
      type: 'noul',
      instructions: `Is \`decision\` the same kind of choice, about the same sort of thing, as \`precedents[${at}]\`?`,
    }
  })

  return { state: { decision: brief(decision), precedents: precedents.map(brief), ...(interrupts.length > 0 ? { interrupts } : {}) }, questions }
}

export type Evidence = {
  /** Precedents Jev judged the same kind of choice. */
  n: number
  /** The person's record on them, weighted: (stood + 1) / (stood + needed + 2). For display. */
  rate: number
  /**
   * A cautious reading of that record: the 5% lower bound of its Beta posterior.
   * Few precedents give a low bound even when every one stood, so a kind earns
   * tell or log only with enough evidence.
   */
  lower: number
  /** The newest matched precedent went against Claude: ask again at once. */
  lastNo: boolean
  reversible: number
  others: number
  close: number
  /** How strongly recent redirects suggest the person wants a say: context, not a record of Claude being wrong. 0 with none. */
  contested: number
  /** A fixed share of decisions is asked whatever the record says, so the record keeps learning. */
  explore: boolean
  matched: string[]
}

/**
 * How much one answer counts. Trust falls faster than it rises: a Disagree
 * outweighs three Fines, an override two. Unanswered and dismissed cards never
 * get here (see similarPrecedents): silence is missing data, not agreement.
 */
export const OUTCOME_WEIGHT: Partial<Record<HcpDecision['outcome'], number>> = {
  took: 1,
  agreed: 1,
  'no-pick': 1,
  overrode: 2,
  disagreed: 3,
}

/** The lower 5% bound of Beta(a, b), by its normal approximation: enough to gate on. */
export function betaLower(a: number, b: number): number {
  const n = a + b
  const mean = a / n
  const sd = Math.sqrt((a * b) / (n * n * (n + 1)))

  return Math.max(0, Math.round((mean - 1.645 * sd) * 1000) / 1000)
}

/** Counting and weighting is code: Jev only said which precedents match. */
export function evidenceOf(decision: HcpDecision, items: readonly HcpDecision[], p: Distributions, t: Record<string, number>): Evidence {
  const matched = items.filter((_, at) => (p[`same_kind_${at}`]?.[0] ?? 0) >= t.match!)
  let stood = 0
  let needed = 0
  for (const d of matched) {
    // This session's answers count double: the person's view today.
    const w = (d.session === decision.session ? 2 : 1) * (OUTCOME_WEIGHT[d.outcome] ?? 0)
    if (STOOD.has(d.outcome)) stood += w
    else if (NEEDED.has(d.outcome)) needed += w
  }
  const newest = [...matched].sort((a, b) => b.at - a.at)[0]

  return {
    n: matched.length,
    rate: Math.round(((stood + 1) / (stood + needed + 2)) * 1000) / 1000,
    lower: betaLower(stood + 1, needed + 1),
    lastNo: newest !== undefined && NEEDED.has(newest.outcome) && newest.outcome !== 'no-pick',
    // No judge answered: assume the worst, so the decision is asked.
    reversible: p.reversible?.[0] ?? 0,
    others: p.others?.[0] ?? 1,
    close: p.close?.[0] ?? 0,
    contested: p.contested?.[0] ?? 0,
    explore: hashToUnit(`${decision.id}:explore`) < t.explore!,
    matched: matched.map(d => d.id),
  }
}

/**
 * The floor under every surface pipeline, champion or challenger: a choice
 * Claude marked hard to undo, or one that reaches other people, is always
 * asked. It is code outside the specs, so no learned threshold can lower it.
 */
export function floorOf(decision: Pick<HcpDecision, 'reversible' | 'reach'>): string | undefined {
  if (decision.reach === 'notifies') return 'it notifies people'
  if (decision.reach === 'shared') return 'others can see it'
  if (decision.reversible === false) return 'hard to undo'

  return undefined
}

/** A pipeline's verdict with the floor applied: what it wanted is kept beside it. */
export function withFloor<V extends { verdict: string; reason: string }>(decision: HcpDecision, v: V): V & { wanted?: string } {
  const floor = floorOf(decision)
  if (floor === undefined || v.verdict === 'ask') return v

  return { ...v, verdict: 'ask', reason: `floor: ${floor}`, wanted: v.verdict }
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
    judge: { kind: 'decide', questions: 'hcp-surface', version: '2' },
    evidence: {
      kind: 'code',
      role: 'transform',
      call: 'hcp.evidence@1',
      args: { items: 'precedents.items', p: 'judge' },
      thresholds: { match: 0.7, explore: 0.1 },
      version: '3',
    },
    gate: {
      kind: 'code',
      role: 'gate',
      inputs: { e: 'evidence' },
      branches: ['ask', 'tell', 'log'],
      // tell and log read the record's lower bound, not its mean: thin evidence stays asked.
      thresholds: { min_n: 5, others: 0.5, reversible: 0.5, tell: 0.7, log: 0.85, close: 0.5, contested: 0.6 },
      rules: [
        { when: 'e.explore', branch: 'ask', reason: "'exploring: asked to keep the record honest'" },
        { when: 'e.n < $t.min_n', branch: 'ask', reason: "'too little precedent: ' & $string(e.n) & ' like it'" },
        { when: 'e.lastNo', branch: 'ask', reason: "'you went another way on the last one like it'" },
        { when: 'e.others >= $t.others', branch: 'ask', reason: "'affects other people'" },
        { when: 'e.reversible < $t.reversible', branch: 'ask', reason: "'hard to undo'" },
        { when: 'e.contested >= $t.contested', branch: 'ask', reason: "'what you said when you last redirected Claude suggests you want a say'" },
        {
          when: 'e.lower >= $t.log and e.close < $t.close',
          branch: 'log',
          reason: "'you kept the call on ' & $string(e.n) & ' like it (at least ' & $string($round(e.lower * 100)) & '%)'",
          confidence: 'e.lower',
        },
        { when: 'e.lower >= $t.tell', branch: 'tell', reason: "'your record: at least ' & $string($round(e.lower * 100)) & '% kept'", confidence: 'e.lower' },
        { branch: 'ask', reason: "'not enough of a record yet: ' & $string($round(e.rate * 100)) & '% kept on ' & $string(e.n)" },
      ],
      version: '3',
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
        describe: 'The past resolved decisions most like the input decision (same kind, repo, session first), at most 10, under `items`.',
        args: json,
        run: (_args: unknown, ctx: { input: unknown }) => ({ items: similarPrecedents(ctx.input as HcpDecision, pool()) }),
      },
      {
        id: 'hcp.evidence',
        version: '1',
        describe:
          "The person's record on the precedents Jev matched (`p.same_kind_<i>` ≥ threshold `match`): n, rate (weighted mean), lower (its cautious 5% bound: gate on this), lastNo, reversible, others, close, contested (recent redirects suggest a say; 0 with none), explore.",
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
