// The reach contract: which tool calls reach other people, and what hcp does
// about each one. Rules and tags answer most calls with no network; a
// decision pipeline (dipseth/decision-pipeline) judges the rest: Jev estimates,
// code decides, and the person's answer on a card lands back on the gate.

import { definePipeline, sha256Hex, stableStringify, z } from './vendor/dp.js'
import type { Distributions, NodeRunArgs } from './vendor/dp.js'

/**
 * `local`: stays on this machine. `own`: the person's own accounts, nobody
 * told. `shared`: others can see it. `notifies`: a person gets a message.
 */
export type ReachLevel = 'local' | 'own' | 'shared' | 'notifies'

export const LEVELS: readonly ReachLevel[] = ['local', 'own', 'shared', 'notifies']

/** What the rules could tell about one call, before any model looks at it. */
export type CallFacts = {
  tool: string
  /** What it goes through: `gh issue comment`, `weReci send_recipe_email`. */
  channel: string
  /** Who or where it reaches, as the input names them: repos, issues, addresses. */
  audience: string[]
  /** The words that go out, redacted and clipped. */
  content: string
  /** Undefined when the rules can't tell: the judge is asked. */
  level?: ReachLevel
  /** `tag`: the person's hcp.json said so; `rule`: hcp's built-in table. */
  source: 'tag' | 'rule' | 'none'
  why: string
}

/** A standing approval for calls like one the person sent, until `expiresAt`. */
export type GrantFacts = { channel: string; audience: string[]; intent: string; example: string }

/** One rule from hcp.json's `reach`: a tool name (`*` globs) or `bash:<regex>`, and its level. */
export type ReachTag = { match: (tool: string, command: string | undefined) => boolean; level: ReachLevel; key: string }

const LOCAL_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'LSP', 'TodoWrite', 'ToolSearch', 'Skill', 'Agent',
  'Task', 'TaskStop', 'TaskOutput', 'BashOutput', 'KillShell', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree',
  'ExitWorktree', 'AskUserQuestion', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  'ListAgents', 'SendMessage', 'ReportFindings', 'WebFetch', 'WebSearch', 'Workflow', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
])

const OWN_TOOLS: Record<string, string> = {
  Artifact: 'a private page in your claude.ai account',
  ArtifactData: "your artifact's data",
  PushNotification: 'a notification to you',
  RemoteTrigger: 'your cloud agent',
}

const SHARED_TOOLS: Record<string, string> = {
  ArtifactComments: 'a comment others on the artifact can read',
}

// MCP servers that only ever act inside this session or editor.
const LOCAL_SERVERS = /^mcp__(hcp|claude-vscode|plugin-authoring|context7)__/

type BashRule = { re: RegExp; level?: ReachLevel; why: string }

// Matched against the command with its quoted text blanked, so `grep "gh issue comment"` is not one.
const BASH_RULES: BashRule[] = [
  { re: /\bgh\s+(issue|pr)\s+(comment|create|review|close|reopen|merge|edit|ready)\b/, level: 'notifies', why: 'GitHub notifies the people watching it' },
  { re: /\bgh\s+release\s+create\b/, level: 'notifies', why: 'GitHub notifies the repo’s watchers' },
  { re: /(^|[;&|]\s*|\s)(sendmail|mailx?|mutt|msmtp)\s/, level: 'notifies', why: 'sends an email' },
  { re: /hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org|api\.twilio\.com/, level: 'notifies', why: 'posts to a chat' },
  { re: /\bgit\s+push\b/, level: 'shared', why: 'everyone with access to the remote sees it' },
  { re: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bdocker\s+push\b|\bgh\s+(repo\s+create|gist\s+create)\b|\bvercel\b[^;&|]*--prod\b/, level: 'shared', why: 'publishes it for others' },
  { re: /\bgh\s+api\b[^;&|]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)\b/i, why: 'writes through the GitHub API' },
  { re: /\bcurl\b[^;&|]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[a-z-]*|-F|--form|--json)\s)/i, why: 'sends data to a web service' },
  { re: /\b(wget\s+--post|http(ie)?\s+(POST|PUT|PATCH))\b/i, why: 'sends data to a web service' },
]

const NOTIFY_VERBS = /(^|_|-)(send|post|reply|comment|invite|share|notify|message|email|mention|forward|tweet|publish|announce|respond|dm)(_|-|$)/
const WRITE_VERBS =
  /(^|_|-)(create|update|add|delete|remove|upload|set|write|edit|move|rename|start|trigger|schedule|execute|run|make|batch|submit|approve|merge|close|assign|transfer|pay|book|order|cancel|archive|import|sync|grant)(_|-|$)/

const CONTENT_KEYS = ['subject', 'title', 'body', 'text', 'message', 'content', 'comment', 'markdown', 'html', 'description', 'note', 'prompt']
const AUDIENCE_KEYS = [
  'to', 'cc', 'bcc', 'recipients', 'recipient', 'email', 'emails', 'channel', 'channel_id', 'user', 'users', 'repo',
  'repository', 'owner', 'issue', 'issue_number', 'pr', 'pull_number', 'thread', 'thread_id', 'space', 'chat_id',
  'doc_id', 'document_id', 'file_id', 'url', 'audience', 'assignee', 'assignees', 'assignedTo', 'assigned_to', 'reviewers',
  'attendees', 'members', 'invitees', 'mentions',
]

// Naming someone here hands them a notification: code can see it, so code decides.
const PERSON_KEYS = ['assignee', 'assignees', 'assignedTo', 'assigned_to', 'reviewers', 'attendees', 'invitees']

const SECRET = /(sk-ant-[\w-]+|apikey_[\w-]+|gh[pousr]_\w+|github_pat_\w+|xox[abprs]-[\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+)/g

/** Token-like strings taken out, so neither Jev nor a card ever carries a credential. */
export const redact = (text: string) => text.replace(SECRET, '[redacted]')

const clipTo = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const blankQuotes = (command: string) => command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""')

const flat = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(flat) : value === undefined || value === null || typeof value === 'object' ? [] : [String(value)]

function mcpParts(tool: string) {
  const [, server = '', name = ''] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? []

  return { server: server.replace(/^claude_ai_/, ''), name: name.toLowerCase() }
}

/** `gh issue comment 12 -R dipseth/hcp` → audience `dipseth/hcp#12`; `git push origin main` → `origin main`. */
function bashAudience(command: string): string[] {
  const out: string[] = []
  const repo = /(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/.exec(command)?.[1]
  const issue = /\bgh\s+(?:issue|pr)\s+\w+\s+(\d+|https:\/\/github\.com\/\S+)/.exec(command)?.[1]
  if (issue?.startsWith('https://')) out.push(issue)
  else if (issue) out.push(`${repo ?? 'this repo'}#${issue}`)
  else if (repo) out.push(repo)
  const push = /\bgit\s+push\s+(?:-\S+\s+)*([\w./-]+)(?:\s+([\w./:-]+))?/.exec(command)
  if (push) out.push([push[1], push[2]].filter(Boolean).join(' '))
  for (const email of command.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) out.push(email)
  const host = /https?:\/\/([\w.-]+)/.exec(command)?.[1]
  if (out.length === 0 && host) out.push(host)

  return [...new Set(out)]
}

function mentions(text: string): string[] {
  return [...new Set(text.match(/(^|\s)@[\w-]{2,}/g)?.map(m => m.trim()) ?? [])]
}

/** The command a rule matched, shortened to its verb: `gh issue comment`, `git push`, `curl`. */
const channelOf = (command: string, re: RegExp) => {
  const hit = re.exec(blankQuotes(command))?.[0]?.trim() ?? command.split(/\s+/)[0] ?? 'Bash'
  if (/^(gh|git)\s/.test(hit)) return hit.split(/\s+/).slice(0, 3).join(' ').replace(/\s-\S*$/, '')
  if (/slack|discord|telegram|twilio/.test(hit)) return /slack|discord|telegram|twilio/.exec(hit)![0]

  return hit.split(/\s+/)[0] ?? 'Bash'
}

/** The rules and tags' view of one call. `input` is the call's arguments as the model sent them. */
export function classifyCall(tool: string, input: Record<string, unknown>, tags: readonly ReachTag[] = []): CallFacts {
  const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
  const tag = tags.find(t => t.match(tool, command))

  if (command !== undefined) {
    const scanned = blankQuotes(command)
    const rule = BASH_RULES.find(r => r.re.test(scanned))
    const base = {
      tool,
      channel: rule ? channelOf(command, rule.re) : 'Bash',
      audience: bashAudience(command),
      content: clipTo(redact(command), 1500),
    }
    if (tag) return { ...base, level: tag.level, source: 'tag', why: `hcp.json: ${tag.key}` }
    if (!rule) return { ...base, level: 'local', source: 'rule', why: 'a local command' }

    return { ...base, ...(rule.level ? { level: rule.level } : {}), source: rule.level ? 'rule' : 'none', why: rule.why }
  }

  const { server, name } = mcpParts(tool)
  const isMcp = server !== ''
  const content = clipTo(
    redact(
      CONTENT_KEYS.flatMap(k => flat(input[k])).join('\n') ||
        (isMcp ? stableStringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'tool' && k !== 'tool_use_id'))) : ''),
    ),
    1500,
  )
  const audience = [...new Set([...AUDIENCE_KEYS.flatMap(k => flat(input[k])), ...mentions(content)])].slice(0, 12)
  const base = { tool, channel: isMcp ? `${server} ${name}` : tool, audience, content }

  if (tag) return { ...base, level: tag.level, source: 'tag', why: `hcp.json: ${tag.key}` }
  if (!isMcp) {
    if (OWN_TOOLS[tool]) return { ...base, level: 'own', source: 'rule', why: OWN_TOOLS[tool] }
    if (SHARED_TOOLS[tool]) return { ...base, level: 'shared', source: 'rule', why: SHARED_TOOLS[tool] }

    return { ...base, level: 'local', source: 'rule', why: LOCAL_TOOLS.has(tool) ? 'a local tool' : 'a built-in tool' }
  }
  if (LOCAL_SERVERS.test(tool)) return { ...base, level: 'local', source: 'rule', why: 'acts in this session' }
  if (NOTIFY_VERBS.test(name)) return { ...base, level: 'notifies', source: 'rule', why: `"${name}" sends to people` }
  const named = PERSON_KEYS.find(k => flat(input[k]).length > 0)
  if (named && WRITE_VERBS.test(name)) return { ...base, level: 'notifies', source: 'rule', why: `sets ${named}, which notifies them` }
  if (WRITE_VERBS.test(name)) return { ...base, source: 'none', why: `"${name}" writes to ${server}` }

  return { ...base, level: 'local', source: 'rule', why: `"${name}" reads from ${server}` }
}

/** hcp.json's `reach`: `{ "<tool or glob or bash:regex>": "<level>" }`, keeping what parses. */
export function parseTags(raw: unknown): { tags: ReachTag[]; problems: string[] } {
  const tags: ReachTag[] = []
  const problems: string[] = []
  if (raw === undefined) return { tags, problems }
  if (typeof raw !== 'object' || raw === null) return { tags, problems: ['reach must be an object of pattern → level'] }
  for (const [key, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof level !== 'string' || !LEVELS.includes(level as ReachLevel)) {
      problems.push(`reach ${key}: level must be one of ${LEVELS.join(', ')}`)
      continue
    }
    try {
      if (key.startsWith('bash:')) {
        const re = new RegExp(key.slice(5))
        tags.push({ key, level: level as ReachLevel, match: (tool, command) => tool === 'Bash' && command !== undefined && re.test(command) })
      } else {
        const re = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
        tags.push({ key, level: level as ReachLevel, match: tool => re.test(tool) })
      }
    } catch (error) {
      problems.push(`reach ${key}: ${(error as Error).message}`)
    }
  }

  return { tags, problems }
}

/** The same call, the same key: what a one-time approval is held against. */
export function callKey(tool: string, input: Record<string, unknown>): string {
  const args = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId'))

  return sha256Hex(`${tool}\n${stableStringify(args)}`)
}

// The Jev question sets, atomic and answered together over one state. The wording
// is versioned with the pipeline: change it and bump the judge node's version.
export const REACH_QUESTIONS = {
  notifies: {
    type: 'noul',
    instructions: 'Will `call` send a message, comment, invitation or notification that a person other than the user receives?',
  },
  visible: {
    type: 'noul',
    instructions: 'Will `call` make something visible to people other than the user, such as a public repository, a shared document or a published page?',
  },
  remote: {
    type: 'noul',
    instructions: "Does `call` send data to, or change something on, a service outside the user's computer?",
  },
  // Calibration (2026-10-26): Jev doesn't read "assign to bob" as notifying bob, so ask the fact itself.
  person: {
    type: 'noul',
    instructions: 'Does `call` assign, invite, add or mention a specific person other than the user?',
  },
} as const

export const GRANT_QUESTIONS = {
  same_kind: {
    type: 'noul',
    instructions: 'Is `call.content` the same kind of message, for the same purpose, as `grant.intent` describes (compare with `grant.example`)?',
  },
  same_audience: {
    type: 'noul',
    instructions: 'Does `call` go only to people or places already named in `grant.audience`?',
  },
  sensitive: {
    type: 'noul',
    instructions: 'Does `call.content` contain credentials, personal data, money amounts or commitments that `grant.example` does not?',
  },
} as const

export type ReachInput = { facts: CallFacts; grant?: GrantFacts }

/** What Jev reads: the call, and the grant it might fall under. No tool names beyond the channel. */
export function judgeState(input: ReachInput) {
  const { facts, grant } = input

  return {
    call: { channel: facts.channel, audience: facts.audience, content: facts.content },
    ...(grant ? { grant } : {}),
  }
}

/** The questions this call needs: reach when the rules couldn't tell, fit when a grant might cover it. */
export function questionsFor(input: ReachInput) {
  return {
    ...(input.facts.source === 'none' ? REACH_QUESTIONS : {}),
    ...(input.grant ? GRANT_QUESTIONS : {}),
  }
}

// Tuned on tests/fixtures/reach-calls.json with build/calibrate.ts (jev-1.14.0); see the README.
export const LEVEL_THRESHOLDS = { notifies: 0.5, person: 0.6, visible: 0.6, remote: 0.5 }
export const GATE_THRESHOLDS = { same_kind: 0.7, same_audience: 0.8, sensitive: 0.4 }

export type ReachVerdict = {
  branch: 'pass' | 'badge' | 'grant' | 'hold'
  /** Undefined when the rules couldn't tell and no judge answered. */
  level?: ReachLevel
  reason: string
  /** The judge's numbers, one per question it was asked. */
  p: Record<string, number>
}

const p1 = (d: Distributions, key: string) => d[key]?.[0]

/** The level, from the rules or tag, or from the judge when they couldn't tell. */
export function levelOf(facts: CallFacts, d: Distributions, t: Record<string, number>): { level?: ReachLevel; reason: string } {
  if (facts.level !== undefined) return { level: facts.level, reason: facts.why }
  const notifies = p1(d, 'notifies')
  if (notifies === undefined) return { reason: `${facts.why}; no judge answered` }
  const person = p1(d, 'person') ?? 0
  const visible = p1(d, 'visible') ?? 0
  const remote = p1(d, 'remote') ?? 0
  const pct = (n: number) => `${Math.round(n * 100)}%`
  if (notifies >= t.notifies!) return { level: 'notifies', reason: `${facts.why}; judged ${pct(notifies)} likely to notify someone` }
  if (person >= t.person! && remote >= t.remote!) {
    return { level: 'notifies', reason: `${facts.why}; judged ${pct(person)} likely to assign, invite or mention someone` }
  }
  if (visible >= t.visible!) return { level: 'shared', reason: `${facts.why}; judged ${pct(visible)} likely visible to others` }
  if (remote >= t.remote!) return { level: 'own', reason: `${facts.why}; judged remote, nobody told` }

  return { level: 'local', reason: `${facts.why}; judged local` }
}

/** Pass, badge, grant or hold, from the level and how well the call fits a grant. */
export function gateOf(level: ReachLevel | undefined, d: Distributions, hasGrant: boolean, t: Record<string, number>) {
  if (level === 'local' || level === 'own') return { branch: 'pass' as const, reason: `${level}: nothing to show` }
  if (level === undefined || level === 'shared') return { branch: 'badge' as const, reason: level ? 'others can see it' : 'reach unknown' }
  if (!hasGrant) return { branch: 'hold' as const, reason: 'notifies people, no grant covers it' }
  const kind = p1(d, 'same_kind') ?? 0
  const audience = p1(d, 'same_audience') ?? 0
  const sensitive = p1(d, 'sensitive') ?? 1
  if (kind >= t.same_kind! && audience >= t.same_audience! && sensitive < t.sensitive!) {
    return { branch: 'grant' as const, reason: 'fits the grant', confidence: Math.min(kind, audience) }
  }
  const misses = [
    kind < t.same_kind! ? 'a different kind of message' : '',
    audience < t.same_audience! ? 'a new audience' : '',
    sensitive >= t.sensitive! ? 'new sensitive material' : '',
  ].filter(Boolean)

  return { branch: 'hold' as const, reason: `near a grant, but ${misses.join(' and ')}` }
}

const flatP = (d: Distributions) =>
  Object.fromEntries(Object.entries(d).flatMap(([k, v]) => (v[0] === undefined ? [] : [[k, Math.round(v[0] * 1000) / 1000]])))

const verdict = (branch: ReachVerdict['branch']) => (args: NodeRunArgs) => {
  const { level, reason } = args.primary as { level?: ReachLevel; reason: string; d: Distributions }

  return {
    branch,
    ...(level ? { level } : {}),
    reason: `${reason}${args.branches.gate?.reason ? ` → ${args.branches.gate.reason}` : ''}`,
    p: flatP((args.primary as { d: Distributions }).d),
  }
}

/**
 * The reach pipeline: judge (Jev, or nothing to ask) → level (code) → gate
 * (code) → one verdict node per branch. A card's answer is the feedback: it
 * lands on the gate, so the thresholds can be re-tuned from the records alone.
 */
export const reachPipeline = definePipeline({
  id: 'hcp-reach',
  fact: 'reach-verdict',
  // unknown, not objects: zod would demand `grant` and strip the verdict's level and numbers.
  input: z.unknown(),
  output: z.unknown(),
  trigger: ['on-demand'],
  group: (input: ReachInput) => `channel-${input.facts.channel}`,
  result: ['pass', 'badge', 'grant', 'hold'],
  nodes: {
    judge: { kind: 'decide', questions: 'hcp-reach', version: '2' },
    level: {
      kind: 'code',
      role: 'transform',
      thresholds: LEVEL_THRESHOLDS,
      run: (args: NodeRunArgs) => {
        const d = (args.primary ?? {}) as Distributions

        return { ...levelOf((args.input as ReachInput).facts, d, args.thresholds), d }
      },
      version: '2',
    },
    gate: {
      kind: 'code',
      role: 'gate',
      branches: ['pass', 'badge', 'grant', 'hold'],
      thresholds: GATE_THRESHOLDS,
      run: (args: NodeRunArgs) => {
        const { level, d } = args.primary as { level?: ReachLevel; d: Distributions }

        return gateOf(level, d, (args.input as ReachInput).grant !== undefined, args.thresholds)
      },
      version: '2',
    },
    pass: { kind: 'code', role: 'derive', run: verdict('pass'), version: '1' },
    badge: { kind: 'code', role: 'derive', run: verdict('badge'), version: '1' },
    grant: { kind: 'code', role: 'derive', run: verdict('grant'), version: '1' },
    hold: { kind: 'code', role: 'derive', run: verdict('hold'), version: '1' },
  },
  edges: [
    { from: 'judge', to: 'level' },
    { from: 'level', to: 'gate' },
    { from: 'gate', to: 'pass', when: { gate: 'gate', branch: 'pass' } },
    { from: 'gate', to: 'badge', when: { gate: 'gate', branch: 'badge' } },
    { from: 'gate', to: 'grant', when: { gate: 'gate', branch: 'grant' } },
    { from: 'gate', to: 'hold', when: { gate: 'gate', branch: 'hold' } },
  ],
  feedback: [
    {
      id: 'reach-card',
      from: 'surface:reach-card',
      to: 'gate',
      source: 'explicit',
      scope: 'user',
      form: 'score',
      latency: 'deferred',
      score: { name: 'hold_needed', dataType: 'BOOLEAN' },
    },
  ],
  eval: { dataset: 'hcp-reach-eval', gateMetric: 'score_positive' },
})
