// Decisions as evidence: every choice Claude asks about or records becomes a
// decision record; the surface pipeline (and any challenger Claude wrote)
// runs on it in shadow; the person's answer resolves it and lands as
// feedback. Claude can also write pipelines of its own: internal ones
// challenge how hcp surfaces decisions, external ones serve the task at hand.

import type { EngineInterface } from 'claude-code'

import type { HcpDecision } from '../types'
import type { InterruptNote } from './reach'
import { appendJsonl, appendLedger, decidePort, generatePort, ROUTES, scoresPort, tracerFor } from './ports'
import type { Frame, Judge, Judged, Route } from './ports'
import { SURFACE_SPEC, compileSpec, hcpRegistry, surfaceFrame, surfacedRight, withFloor } from './surface'
import { describeRegistry, renderPipelineSvg, runPipeline, submitFeedback } from './vendor/dp.js'
import type { JevQuestion, Pipeline, PipelinePorts, RunRecord } from './vendor/dp.js'

type Engine = EngineInterface

/** A pipeline Claude wrote, as saved: the spec, and the wording and routes its nodes name. */
export type SavedPipeline = {
  scope: 'internal' | 'external'
  spec: Record<string, unknown> & { id: string }
  /** Question sets by name, for its decide nodes. */
  questions: Record<string, Record<string, JevQuestion>>
  /** Routes by name, for its generate nodes: haiku or sonnet only. */
  routes: Record<string, Route>
  createdAt: number
}

type Loaded = SavedPipeline & { pipeline: Pipeline }

/** Decisions from earlier sessions, newest state per id; this session's live in $.state. */
let history: HcpDecision[] = []
let sessionDecisions: () => readonly HcpDecision[] = () => []
let recentInterrupts: () => readonly InterruptNote[] = () => []
const registry = hcpRegistry(() => [...history, ...sessionDecisions()])
const champion = compileSpec(SURFACE_SPEC, registry).pipeline!
const saved = new Map<string, Loaded>()

/** Where the surface frame reads the project's recent interrupts from. */
export function bindInterrupts(read: () => readonly InterruptNote[]) {
  recentInterrupts = read
}

/** How the module reads this session's decisions without importing the atom. */
export function bindSession(read: () => readonly HcpDecision[]) {
  sessionDecisions = read
}

async function dirOf($: Engine, sub: string) {
  return `${(await $.env.get('HOME')) ?? ''}/.claude/hcp/${sub}`
}

/** The last 30 days of the ledger's decision rows, and the pipelines Claude saved. */
export async function loadHistory($: Engine) {
  const byId = new Map<string, HcpDecision>()
  try {
    const dir = await dirOf($, 'ledger')
    const files = (await $.fs.list(dir)).map(f => f.name).filter(n => n.endsWith('.jsonl')).sort().slice(-30)
    for (const name of files) {
      for (const line of (await $.fs.read(`${dir}/${name}`)).split('\n')) {
        if (!line.includes('"type":"decision"')) continue
        try {
          const row = JSON.parse(line) as { decision?: HcpDecision }
          if (row.decision?.id) byId.set(`${row.decision.session}:${row.decision.id}`, row.decision)
        } catch {
          // A torn line is skipped.
        }
      }
    }
  } catch {
    // No ledger yet.
  }
  history = [...byId.values()].slice(-1000)
  saved.clear()
  for (const scope of ['internal', 'external'] as const) {
    try {
      const dir = await dirOf($, `pipelines/${scope}`)
      for (const f of await $.fs.list(dir)) {
        if (!f.name.endsWith('.json')) continue
        const file = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as SavedPipeline
        const compiled = compileSpec(file.spec, registry)
        if (compiled.pipeline) saved.set(file.spec.id, { ...file, pipeline: compiled.pipeline })
      }
    } catch {
      // None saved.
    }
  }
}

/** The decide frame for spec pipelines: the surface set is hcp's own; others are the pipeline's saved wording. */
const specFrame =
  (questions: SavedPipeline['questions']): Frame =>
  request => {
    if (request.questions === 'hcp-surface') {
      const items = ((request.from.precedents as { items?: HcpDecision[] } | undefined)?.items ?? []) as HcpDecision[]

      return surfaceFrame(request.input as HcpDecision, items, recentInterrupts())
    }

    return { state: { input: request.input, from: request.from }, questions: questions[request.questions ?? ''] ?? {} }
  }

function specPorts($: Engine, judge: Judge, judged: Judged, file: Pick<SavedPipeline, 'questions' | 'routes' | 'spec'>, sink: (r: RunRecord) => void): PipelinePorts {
  const routes = { ...ROUTES, ...file.routes }
  const generate = generatePort($, routes)

  return {
    ...tracerFor($, [file.spec.id]),
    decide: decidePort($, judge, judged, specFrame(file.questions)),
    generate,
    records: sink,
    store: request => appendJsonl($, `facts/${file.spec.id}.jsonl`, { pipeline: file.spec.id, ...request }),
    clock: () => Date.now(),
  }
}

/** The champion and every internal challenger, each on the same decision; nothing they say changes behaviour. */
export async function shadow($: Engine, decision: HcpDecision, judge: Judge): Promise<HcpDecision['shadow']> {
  const arms: [string, Pipeline, SavedPipeline['questions']][] = [
    ['hcp-surface', champion, {}],
    ...[...saved.values()].filter(s => s.scope === 'internal').map(s => [s.spec.id, s.pipeline, s.questions] as [string, Pipeline, SavedPipeline['questions']]),
  ]
  const out: NonNullable<HcpDecision['shadow']> = {}
  for (const [id, pipeline, questions] of arms) {
    const judged: Judged = { by: 'rules', problems: [] }
    let record: RunRecord | undefined
    try {
      const ran = await runPipeline(pipeline, decision, specPorts($, judge, judged, { questions, routes: {}, spec: { id } }, r => void (record = r)))
      const verdict = ran.output as { verdict?: string; reason?: string }
      // No tracer, no run id: the run key names the run for its feedback. The floor has the last word.
      out[id] = withFloor(decision, { verdict: verdict.verdict ?? ran.route, reason: verdict.reason ?? '', runId: ran.runId ?? ran.runKey })
      void appendLedger($, { type: 'shadow', decisionId: decision.id, session: decision.session, pipeline: id, ...out[id], judgedBy: judged.by, record })
    } catch (error) {
      void appendLedger($, { type: 'shadow-failed', decisionId: decision.id, pipeline: id, error: String((error as Error).message).slice(0, 200) })
    }
  }

  return out
}

/** The person's answer, as evidence: the record is kept, and each shadow run learns whether it surfaced right. */
export async function resolved($: Engine, decision: HcpDecision) {
  void appendLedger($, { type: 'decision', decision })
  for (const [id, s] of Object.entries(decision.shadow ?? {})) {
    const right = surfacedRight(s.verdict, decision.outcome)
    if (right === undefined || !s.runId) continue
    const pipeline = id === 'hcp-surface' ? champion : saved.get(id)?.pipeline
    if (!pipeline) continue
    void submitFeedback(
      pipeline,
      { runId: s.runId, edgeId: 'surface-outcome', value: right ? 1 : 0, label: decision.outcome, sourceId: 'person' },
      { scores: scoresPort($, { decisionId: decision.id, pipeline: id }) },
    ).catch(() => undefined)
  }
}

/** How each surface pipeline would have done against what the person really did, and how much attention the answers carried. */
export function shadowReport(decisions: readonly HcpDecision[]): string {
  const all = latest([...history, ...decisions])
  const ids = new Set(all.flatMap(d => Object.keys(d.shadow ?? {})))
  if (ids.size === 0) return 'No decisions recorded yet: give mcp__hcp__ask a `kind`, or record choices with mcp__hcp__decided.'
  const lines = [`${all.length} decisions recorded (${decisions.length} this session).`]
  for (const id of ids) {
    const runs = all.filter(d => d.shadow?.[id])
    const counts = { ask: 0, tell: 0, log: 0 } as Record<string, number>
    let right = 0
    let judged = 0
    let cardsSaved = 0
    let wrongSilence = 0
    let floored = 0
    for (const d of runs) {
      const s = d.shadow![id]!
      counts[s.verdict] = (counts[s.verdict] ?? 0) + 1
      if (s.wanted) floored++
      const ok = surfacedRight(s.verdict, d.outcome)
      if (ok === undefined) continue
      judged++
      if (ok) right++
      if (s.verdict !== 'ask' && d.source === 'ask' && ok) cardsSaved++
      if (s.verdict !== 'ask' && !ok) wrongSilence++
    }
    lines.push(
      `${id === 'hcp-surface' ? 'champion' : 'challenger'} ${id}: would ask ${counts.ask ?? 0}, tell ${counts.tell ?? 0}, log ${counts.log ?? 0}.` +
        (floored > 0 ? ` The floor turned ${floored} back to ask.` : '') +
        (judged > 0
          ? ` Right on ${right}/${judged} the person resolved; ${cardsSaved} cards it would have saved, ${wrongSilence} times it would have skipped asking when the person wanted a say.`
          : ' None resolved yet.'),
    )
  }
  lines.push(...attentionReport(all))

  return lines.join('\n')
}

/** The newest record of each decision: a Fine turned Disagree is written twice. */
function latest(list: readonly HcpDecision[]): HcpDecision[] {
  const byId = new Map<string, HcpDecision>()
  for (const d of list) byId.set(`${d.session}:${d.id}`, d)

  return [...byId.values()]
}

/** An answer this fast is unlikely to be a read: a possible rubber stamp. */
export const FAST_MS = 3000

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)

  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
}

const pct = (part: number, whole: number) => `${Math.round((part / Math.max(1, whole)) * 100)}%`

/**
 * Whether answers carry judgment: per kind, how fast they came, how often a
 * Fine was later reversed, and whether the person matches Claude as often when
 * the recommendation is hidden as when it is preselected.
 */
export function attentionReport(all: readonly HcpDecision[]): string[] {
  const answered = all.filter(d => d.answeredMs !== undefined)
  if (answered.length === 0) return []
  const lines = ['Attention (are answers judgments or rubber stamps?):']
  const kinds = [...new Set(answered.map(d => d.kind))]
  for (const kind of kinds) {
    const rows = answered.filter(d => d.kind === kind)
    const ms = rows.map(d => d.answeredMs!)
    const fast = ms.filter(m => m < FAST_MS).length
    const kept = rows.filter(d => d.outcome === 'took' || d.outcome === 'agreed').length
    const escaped = rows.filter(d => d.reversedFrom).length
    const flag = rows.length >= 5 && fast / rows.length >= 0.8 && kept / rows.length >= 0.9 ? ' ⚠ looks like rubber-stamping' : ''
    lines.push(
      `- ${kind}: ${rows.length} answered, median ${(median(ms) / 1000).toFixed(1)}s, ${pct(fast, rows.length)} under ${FAST_MS / 1000}s, ${pct(kept, rows.length)} kept Claude's call` +
        (escaped > 0 ? `, ${escaped} Fine later reversed` : '') +
        flag,
    )
  }
  const asks = answered.filter(d => d.source === 'ask' && d.choice !== undefined)
  const shown = asks.filter(d => !d.blind)
  const blind = asks.filter(d => d.blind === 'probe')
  if (blind.length > 0) {
    const took = (xs: HcpDecision[]) => xs.filter(d => d.outcome === 'took').length
    lines.push(
      `Default effect: matched Claude ${pct(took(shown), shown.length)} with the recommendation preselected (${shown.length}), ${pct(took(blind), blind.length)} with it hidden (${blind.length} probes).`,
    )
  }
  const escaped = all.filter(d => d.reversedFrom).length
  const fine = all.filter(d => d.outcome === 'agreed' || d.reversedFrom).length
  if (fine > 0) lines.push(`Escaped: ${escaped} of ${fine} Fines were later reversed.`)

  return lines
}

const PIPELINE_GUIDE = `Write a decision pipeline as a JSON spec: models estimate, code decides, a person corrects it later.
Contract: one \`fact\` and \`result\`; at least one code node with role "gate" (branches + thresholds + rules in JSONata, the last rule with no \`when\`); an edge out of the gate for every branch; at least one \`feedback\` edge landing on an earlier node (form "score" with a score config); \`eval\` { dataset, gateMetric: "score_positive" }; an acyclic graph.
Nodes: read (call a registry primitive), decide (\`questions\`: a set name you supply in \`questions\`, each yes/no as { "type": "noul", "instructions": "... \`input.x\` ..." }: atomic facts, point at state paths with backticks; the state Jev sees is { input, from: upstream outputs }), generate (\`route\`: a route you supply in \`routes\` { model: "haiku"|"sonnet", version, system, maxTokens }), code (transform/derive/validate with \`expr\` in JSONata, or gate with \`rules\`), store (writes to ~/.claude/hcp/facts/<id>.jsonl).
Inputs and outputs name the schema "json". Count, compare and do arithmetic in code, never in a question.
scope "internal": a challenger to how hcp surfaces decisions (input: a decision { kind, title, choice, alternatives, reversible, reach, repo, session }; branches must be ask, tell, log, and each branch's derive node returns { verdict, reason }). It only ever runs in shadow beside the champion until a trial supports it. A fixed floor sits under every surface pipeline: a decision marked reversible: false or reach shared/notifies is asked whatever the pipeline says, so don't spend nodes on that.
scope "external": a pipeline for the person's task; run it with action "run".`

/** The `mcp__hcp__pipeline` tool: describe, define, run, list. */
export async function pipelineTool($: Engine, input: Record<string, unknown>, judge: Judge): Promise<string> {
  const action = input.action
  if (action === 'describe') {
    return [
      PIPELINE_GUIDE,
      `Registry: ${JSON.stringify(describeRegistry(registry))}`,
      `The champion surface pipeline, as an example: ${JSON.stringify(SURFACE_SPEC)}`,
    ].join('\n\n')
  }
  if (action === 'list') {
    const rows = [...saved.values()].map(s => `- ${s.spec.id} (${s.scope}), ${Object.keys(s.spec.nodes as object).length} nodes`)

    return rows.length > 0 ? rows.join('\n') : 'No pipelines saved yet. The champion hcp-surface always runs in shadow.'
  }
  if (action === 'define') {
    const scope = input.scope === 'internal' ? 'internal' : 'external'
    const spec = input.spec as SavedPipeline['spec'] | undefined
    if (!spec || typeof spec.id !== 'string') return 'define needs `spec` with an `id`.'
    if (spec.id === 'hcp-surface') return 'hcp-surface is the champion: give a challenger its own id.'
    const routes = (input.routes ?? {}) as Record<string, Route>
    const bad = Object.entries(routes).filter(([, r]) => r.model !== 'haiku' && r.model !== 'sonnet')
    if (bad.length > 0) return `Routes may use haiku or sonnet only: ${bad.map(([k]) => k).join(', ')}.`
    const compiled = compileSpec(spec, registry)
    if (!compiled.pipeline) return `Not saved; fix every problem and define again:\n- ${compiled.problems.join('\n- ')}`
    const file: SavedPipeline = {
      scope,
      spec,
      questions: (input.questions ?? {}) as SavedPipeline['questions'],
      routes,
      createdAt: await $.clock.now(),
    }
    const dir = await dirOf($, `pipelines/${scope}`)
    await $.fs.write(`${dir}/${spec.id}.json`, JSON.stringify(file, null, 2))
    const svg = `${dir}/${spec.id}.svg`
    await $.fs.write(svg, renderPipelineSvg(compiled.pipeline.toJSON(), { title: spec.id, standalone: true }))
    saved.set(spec.id, { ...file, pipeline: compiled.pipeline })
    void appendLedger($, { type: 'pipeline-defined', pipeline: spec.id, scope })

    return scope === 'internal'
      ? `Saved challenger ${spec.id}; it now runs in shadow beside hcp-surface on every decision, and /hcp shadow compares them. Diagram: ${svg}`
      : `Saved ${spec.id}. Run it with action "run". Diagram: ${svg}`
  }
  if (action === 'run') {
    const name = String(input.name ?? '')
    const found = saved.get(name)
    if (!found) return `No saved pipeline "${name}". Saved: ${[...saved.keys()].join(', ') || 'none'}.`
    const judged: Judged = { by: 'rules', problems: [] }
    let record: RunRecord | undefined
    const ran = await runPipeline(found.pipeline, input.input ?? {}, specPorts($, judge, judged, found, r => void (record = r)))
    void appendLedger($, { type: 'pipeline-run', pipeline: name, route: ran.route, judgedBy: judged.by, record })
    const nodes = (record?.nodes ?? [])
      .filter(n => !n.skipped)
      .map(n => {
        const p = n.distributions ? ` p=${JSON.stringify(Object.fromEntries(Object.entries(n.distributions).map(([k, v]) => [k, v[0]])))}` : ''
        const b = n.branch ? ` → ${n.branch}${n.branch_reason ? ` (${n.branch_reason})` : ''}` : ''

        return `  ${n.id}${p}${b}`
      })

    return [`${name} → ${ran.route}, judged by ${judged.by}, $${(record?.cost_usd ?? 0).toFixed(6)}`, ...nodes, `Output: ${JSON.stringify(ran.output)}`].join('\n')
  }

  return 'action must be describe, define, run or list.'
}
