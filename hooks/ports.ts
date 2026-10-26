// The decision pipeline's ports, backed by Claude Code: Jev through
// `$.http.fetch`, the session's own model through `$.model.complete`, and run
// records into a plain JSONL ledger. Any other text hcp needs a model to write
// is one more route in ROUTES, served by the same generate port.

import type { EngineInterface } from 'claude-code'

import { JEV_ENDPOINT, JEV_MODEL, checkJevRequest, jevAnswersToDecideResult, jevHeaders } from './vendor/dp.js'
import type { DecideRequest, DecideResult, GenerateRequest, GenerateResult, JevQuestion, PipelinePorts } from './vendor/dp.js'
import { judgeState, questionsFor, redact } from './reach'
import type { ReachInput } from './reach'

type Engine = EngineInterface

/** Who estimates: Jev (falling back to haiku), haiku alone, or nobody (rules and tags only). */
export type Judge = 'jev' | 'haiku' | 'off'

export const KEY_NAME = 'HCP_TYPESAFE_API_KEY'

const USD_PER_JEV_TOKEN = 0.042e-6
const HAIKU_USD = { input: 1e-6, output: 5e-6 }
const JEV_TIMEOUT_MS = 4000
const HAIKU_TIMEOUT_MS = 8000

/** Rejects when `work` hasn't settled in `ms`: the host's fetch has no deadline of its own. */
export function within<T>($: Engine, ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(`no answer in ${ms}ms`)))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error)
      },
    )
  })
}

/**
 * The Jev key: the session's environment first, then its line in
 * ~/.claude/.env, which Claude Code doesn't load. Never logged or shown.
 */
export async function jevKey($: Engine): Promise<string | undefined> {
  const fromEnv = await $.env.get('HCP_TYPESAFE_API_KEY')
  if (fromEnv) return fromEnv
  const home = await $.env.get('HOME')
  if (!home) return undefined
  try {
    const line = (await $.fs.read(`${home}/.claude/.env`))
      .split('\n')
      .find(one => new RegExp(`^\\s*(export\\s+)?${KEY_NAME}\\s*=`).test(one))

    return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || undefined
  } catch {
    return undefined
  }
}

async function jevDecide($: Engine, input: ReachInput, questions: Record<string, JevQuestion>): Promise<DecideResult> {
  const key = await jevKey($)
  if (key === undefined) throw new Error(`no ${KEY_NAME}`)
  const body = { model: JEV_MODEL, state: judgeState(input), questions }
  const problems = checkJevRequest(body)
  if (problems.length > 0) throw new Error(problems.join('; '))
  const response = await within(
    $,
    JEV_TIMEOUT_MS,
    $.http.fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...jevHeaders(key, body) },
      body: JSON.stringify(body),
    }),
  )
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
  const { answers, usage } = JSON.parse(response.text) as { answers: Record<string, { noul?: number }>; usage?: { input_tokens?: number } }

  return jevAnswersToDecideResult(answers, { usage: usage ?? {}, costUsd: u => (u.input_tokens ?? 0) * USD_PER_JEV_TOKEN })
}

const HAIKU_SYSTEM =
  'You estimate probabilities for a permission system. You get a JSON state and yes/no questions about it, keyed by name. ' +
  'Reply with one JSON object and nothing else, mapping every key to the probability (0 to 1) that the answer is yes.'

async function haikuDecide($: Engine, input: ReachInput, questions: Record<string, JevQuestion>): Promise<DecideResult> {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    system: HAIKU_SYSTEM,
    prompt: JSON.stringify({
      state: judgeState(input),
      questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.instructions])),
    }),
    maxTokens: 200,
    timeoutMs: HAIKU_TIMEOUT_MS,
  })
  if (!reply.isAnswered) throw new Error(`haiku: ${reply.reason}`)
  const json = /\{[\s\S]*\}/.exec(reply.text)?.[0]
  if (json === undefined) throw new Error('haiku: no JSON in the reply')
  const parsed = JSON.parse(json) as Record<string, unknown>
  const distributions: Record<string, number[]> = {}
  for (const key of Object.keys(questions)) {
    const p = Number(parsed[key])
    if (Number.isFinite(p)) distributions[key] = [Math.min(1, Math.max(0, p))]
  }
  const usage = reply.usage as { input_tokens?: number; output_tokens?: number }

  return { distributions, costUsd: (usage.input_tokens ?? 0) * HAIKU_USD.input + (usage.output_tokens ?? 0) * HAIKU_USD.output }
}

/** Which judge answered a run, and why the ones before it didn't. */
export type Judged = { by: Judge | 'none' | 'rules'; problems: string[] }

/**
 * The decide port: the questions this call needs, asked of Jev, then haiku.
 * Nothing to ask, or nobody answers: no distributions, and the level node
 * says so. It never throws, so a judge outage never fails the run.
 */
export function decidePort($: Engine, judge: Judge, judged: Judged) {
  return async (request: DecideRequest): Promise<DecideResult> => {
    const input = request.input as ReachInput
    const questions = questionsFor(input) as Record<string, JevQuestion>
    if (Object.keys(questions).length === 0) {
      judged.by = 'rules'

      return { distributions: {} }
    }
    const order: Judge[] = judge === 'jev' ? ['jev', 'haiku'] : judge === 'haiku' ? ['haiku'] : []
    for (const who of order) {
      try {
        const result = who === 'jev' ? await jevDecide($, input, questions) : await haikuDecide($, input, questions)
        judged.by = who

        return result
      } catch (error) {
        judged.problems.push(redact(`${who}: ${(error as Error).message}`).slice(0, 160))
      }
    }
    judged.by = 'none'

    return { distributions: {} }
  }
}

/** A route a generate node (or hcp itself) asks a model to write through. */
export type Route = { model: string; version: string; system: string; maxTokens: number }

export const ROUTES: Record<string, Route> = {
  // Stored on a grant: what a later call is compared against, in place of the person reading it again.
  'grant-intent': {
    model: 'haiku',
    version: '1',
    maxTokens: 80,
    system:
      'You get one outgoing message as JSON: the channel it goes through and its content. In one line of at most 20 words, ' +
      'say what kind of message it is and what it is for, e.g. "a short status update on a GitHub issue, thanking a contributor". ' +
      'Name no people, addresses or secrets. Reply with the line only.',
  },
}

/** The generate port: one completion on the session's own client, by route. */
export function generatePort($: Engine) {
  return async (request: GenerateRequest): Promise<GenerateResult> => {
    const route = ROUTES[request.route]
    if (route === undefined) throw new Error(`no route "${request.route}"`)
    const reply = await $.model.complete({
      model: route.model,
      effort: 'low',
      system: route.system,
      prompt: JSON.stringify(request.input),
      maxTokens: route.maxTokens,
      timeoutMs: 20_000,
    })
    if (!reply.isAnswered) throw new Error(`generate ${request.route}: ${reply.reason}`)
    const usage = reply.usage as { input_tokens?: number; output_tokens?: number }

    return {
      value: { text: reply.text.trim() },
      costUsd: (usage.input_tokens ?? 0) * HAIKU_USD.input + (usage.output_tokens ?? 0) * HAIKU_USD.output,
      promptVersion: route.version,
    }
  }
}

/** The ports a reach run uses; `records` and `scores` land in the caller's hands for the ledger. */
export function reachPorts($: Engine, judge: Judge, judged: Judged, sink: PipelinePorts['records']): PipelinePorts {
  return { decide: decidePort($, judge, judged), generate: generatePort($), records: sink, clock: () => Date.now() }
}

// One write at a time, so two runs finishing together don't drop a line.
let writing: Promise<void> = Promise.resolve()

/** Appends one JSON line to today's ledger, ~/.claude/hcp/ledger/<yyyy-mm-dd>.jsonl. Best effort. */
export function appendLedger($: Engine, row: Record<string, unknown>): Promise<void> {
  writing = writing.then(async () => {
    try {
      const home = await $.env.get('HOME')
      if (!home) return
      const at = await $.clock.now()
      const file = `${home}/.claude/hcp/ledger/${new Date(at).toISOString().slice(0, 10)}.jsonl`
      const was = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
      await $.fs.write(file, `${was}${JSON.stringify({ at, ...row })}\n`)
    } catch {
      // A ledger that can't be written never blocks a call.
    }
  })

  return writing
}
