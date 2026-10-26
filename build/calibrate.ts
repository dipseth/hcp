// Phase 0 of the reach contract: run the labelled fixtures through Jev with the
// mod's own state and questions, print what the thresholds would do, and the
// rows they get wrong. Costs about $0.001 a run.
//   node build/calibrate.ts tests/fixtures/reach-calls.json
// The key comes from HCP_TYPESAFE_API_KEY, else its line in ~/.claude/.env; it is never printed.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { GATE_THRESHOLDS, GRANT_QUESTIONS, LEVEL_THRESHOLDS, REACH_QUESTIONS, classifyCall, gateOf, judgeState, levelOf } from '../hooks/reach.ts'
import type { CallFacts, GrantFacts, ReachLevel } from '../hooks/reach.ts'
import { JEV_ENDPOINT, JEV_MODEL } from '../hooks/vendor/dp.js'

type Fixture = {
  calls: { truth: ReachLevel; tool: string; input: Record<string, unknown> }[]
  grants: { fits: boolean; grant: GrantFacts; call: { channel: string; audience: string[]; content: string } }[]
}

const key =
  process.env.HCP_TYPESAFE_API_KEY ??
  readFileSync(`${homedir()}/.claude/.env`, 'utf8')
    .split('\n')
    .find(line => line.startsWith('HCP_TYPESAFE_API_KEY='))
    ?.slice('HCP_TYPESAFE_API_KEY='.length)
    .replace(/^["']|["']$/g, '')
if (!key) throw new Error('no HCP_TYPESAFE_API_KEY')

const fixture = JSON.parse(readFileSync(process.argv[2] ?? 'tests/fixtures/reach-calls.json', 'utf8')) as Fixture
let tokens = 0

async function ask(state: unknown, questions: Record<string, unknown>): Promise<Record<string, number[]>> {
  const response = await fetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  })
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
  const { answers, usage } = (await response.json()) as { answers: Record<string, { noul?: number }>; usage?: { input_tokens?: number } }
  tokens += usage?.input_tokens ?? 0

  return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, [a.noul ?? 0]]))
}

const held = (level: ReachLevel | undefined) => level === 'notifies'
const pct = (n: number) => n.toFixed(2)

console.log(`Reach (${fixture.calls.length} calls; a rule's level stands where one applies), thresholds ${JSON.stringify(LEVEL_THRESHOLDS)}`)
let caught = 0
let notifying = 0
let falseHolds = 0
for (const row of fixture.calls) {
  const facts: CallFacts = classifyCall(row.tool, row.input)
  // What the mod does: the rules' level when they place it, else the judge's.
  const d = await ask(judgeState({ facts }), REACH_QUESTIONS)
  const got = facts.source === 'none' ? levelOf(facts, d, LEVEL_THRESHOLDS).level : facts.level
  if (held(row.truth)) notifying++
  if (held(row.truth) && held(got)) caught++
  if (!held(row.truth) && held(got)) falseHolds++
  const mark = (got === row.truth ? '  ' : held(row.truth) !== held(got) ? '✘ ' : '~ ') + (facts.source === 'none' ? '' : '[rule] ')
  console.log(
    `${mark}${row.truth.padEnd(8)} → ${String(got).padEnd(8)} n=${pct(d.notifies![0]!)} p=${pct(d.person![0]!)} v=${pct(d.visible![0]!)} r=${pct(d.remote![0]!)}  ${facts.channel}: ${facts.content.slice(0, 60).replace(/\s+/g, ' ')}`,
  )
}
console.log(`  notifies recall ${caught}/${notifying}; false holds ${falseHolds}/${fixture.calls.length - notifying}`)

console.log(`\nGrants (${fixture.grants.length} pairs), thresholds ${JSON.stringify(GATE_THRESHOLDS)}`)
let wrongPass = 0
let wrongHold = 0
for (const pair of fixture.grants) {
  const d = await ask({ call: pair.call, grant: pair.grant }, GRANT_QUESTIONS)
  const passed = gateOf('notifies', d, true, GATE_THRESHOLDS).branch === 'grant'
  if (passed && !pair.fits) wrongPass++
  if (!passed && pair.fits) wrongHold++
  const mark = passed === pair.fits ? '  ' : '✘ '
  console.log(
    `${mark}fits=${String(pair.fits).padEnd(5)} → ${passed ? 'grant' : 'hold '} kind=${pct(d.same_kind![0]!)} aud=${pct(d.same_audience![0]!)} sens=${pct(d.sensitive![0]!)}  ${pair.call.content.slice(0, 60)}`,
  )
}
console.log(`  passed when it shouldn't: ${wrongPass}; held when a grant should cover it: ${wrongHold}`)
console.log(`\n${tokens} input tokens ≈ $${(tokens * 0.042e-6).toFixed(5)}`)
