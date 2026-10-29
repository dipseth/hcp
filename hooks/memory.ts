// What hcp remembers across sessions, read once at session start and kept
// current as the session adds to it: interrupts, the person's answers on held
// calls, steer presses and sets. Plus the one write hcp makes to Claude Code's
// own settings: an "Always" answer becomes a permission rule, so hcp and the
// engine read the same standing word.

import type { EngineInterface } from 'claude-code'

import { appendJsonl } from './ports'
import type { AnswerRow, CallFacts } from './reach'
import type { InterruptRow, SteerFile } from './steers'

type Engine = EngineInterface

let interrupts: InterruptRow[] = []
let answers: AnswerRow[] = []
/** Steer presses by project, then label. */
let presses: Record<string, Record<string, number>> = {}

export const interruptRows = (): readonly InterruptRow[] => interrupts
export const answerRows = (): readonly AnswerRow[] => answers
export const pressesFor = (project: string) => presses[project] ?? {}

async function hcpDir($: Engine) {
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/hcp` : undefined
}

async function linesOf($: Engine, dir: string, keep: number): Promise<string[]> {
  try {
    const files = (await $.fs.list(dir)).map(f => f.name).filter(n => n.endsWith('.jsonl')).sort().slice(-keep)
    const out: string[] = []
    for (const name of files) out.push(...(await $.fs.read(`${dir}/${name}`)).split('\n').filter(Boolean))

    return out
  } catch {
    return []
  }
}

const parse = <T>(line: string): T | undefined => {
  try {
    return JSON.parse(line) as T
  } catch {
    return undefined
  }
}

/** Reads the last 60 days of interrupts (with the transcript backfill) and of the ledger's answers and presses. */
export async function loadMemory($: Engine) {
  const dir = await hcpDir($)
  if (dir === undefined) return
  interrupts = (await linesOf($, `${dir}/interrupts`, 61)).flatMap(l => parse<InterruptRow>(l) ?? []).slice(-2000)
  answers = []
  presses = {}
  for (const line of await linesOf($, `${dir}/ledger`, 60)) {
    if (line.includes('"name":"hold_needed"')) {
      const row = parse<{ at: number; channel?: string; scope?: string; label?: string; content?: string }>(line)
      if (row?.channel && row.label) answers.push({ at: row.at, channel: row.channel, label: row.label, ...(row.scope ? { scope: row.scope } : {}), ...(row.content ? { content: row.content } : {}) })
    } else if (line.includes('"type":"steer"')) {
      const row = parse<{ project?: string; label?: string }>(line)
      if (row?.project && row.label) (presses[row.project] ??= {})[row.label] = ((presses[row.project] ??= {})[row.label] ?? 0) + 1
    }
  }
}

/** Keeps an interrupt: in memory now, in ~/.claude/hcp/interrupts/<date>.jsonl for later sessions. */
export async function rememberInterrupt($: Engine, row: InterruptRow) {
  interrupts = [...interrupts, row].slice(-2000)
  await appendJsonl($, 'interrupts/{date}.jsonl', row as unknown as Record<string, unknown>)
}

/** Counts an answer at once, so the record moves within the session; the ledger row is written by the scores port. */
export function rememberAnswer(row: AnswerRow) {
  answers = [...answers, row]
}

export function rememberPress(project: string, label: string) {
  const mine = (presses[project] ??= {})
  mine[label] = (mine[label] ?? 0) + 1
}

const steerPath = (dir: string, project: string) => `${dir}/steers/${project.replace(/[^\w.-]+/g, '_')}.json`

export async function readSteers($: Engine, project: string): Promise<SteerFile | undefined> {
  const dir = await hcpDir($)
  if (dir === undefined) return undefined
  try {
    return JSON.parse(await $.fs.read(steerPath(dir, project))) as SteerFile
  } catch {
    return undefined
  }
}

export async function saveSteers($: Engine, file: SteerFile) {
  const dir = await hcpDir($)
  if (dir !== undefined) await $.fs.write(steerPath(dir, file.project), `${JSON.stringify(file, null, 2)}\n`)
}

/**
 * The Claude Code permission rule that stands for "calls like this one":
 * `Bash(gh pr create *)` for a command hcp knows by its verb, the tool's own
 * name for an MCP tool. None for a bare Bash call: too broad to allow.
 */
export function ruleFor(facts: Pick<CallFacts, 'tool' | 'channel'>): string | undefined {
  if (facts.tool === 'Bash') return /^(gh|git|glab)\s+\S+(\s+\S+)?$/.test(facts.channel) ? `Bash(${facts.channel} *)` : undefined
  if (facts.tool.startsWith('mcp__')) return facts.tool

  return undefined
}

/**
 * Adds `rule` to the project's .claude/settings.local.json (personal, not
 * committed) under permissions.allow, keeping everything else in the file.
 * Returns the file written, or why not.
 */
export async function allowInSettings($: Engine, cwd: string, rule: string): Promise<{ file?: string; problem?: string }> {
  const file = `${cwd.replace(/\/+$/, '')}/.claude/settings.local.json`
  let settings: Record<string, unknown> = {}
  try {
    if (await $.fs.exists(file)) settings = JSON.parse(await $.fs.read(file)) as Record<string, unknown>
  } catch (error) {
    return { problem: `couldn't read ${file}: ${(error as Error).message}` }
  }
  const permissions = (typeof settings.permissions === 'object' && settings.permissions !== null ? settings.permissions : {}) as Record<string, unknown>
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : []
  if (!allow.includes(rule)) {
    settings = { ...settings, permissions: { ...permissions, allow: [...allow, rule] } }
    try {
      await $.fs.write(file, `${JSON.stringify(settings, null, 2)}\n`)
    } catch (error) {
      return { problem: `couldn't write ${file}: ${(error as Error).message}` }
    }
  }

  return { file }
}
