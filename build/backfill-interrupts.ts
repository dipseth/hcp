// One-off: reads Claude Code transcripts (~/.claude/projects/*/*.jsonl) for
// the times the person interrupted a run, and what they typed next, and
// writes them to ~/.claude/hcp/interrupts/backfill.jsonl in hcp's interrupt
// shape. Steers and the classifier's notes then start from history, not zero.
//
//   node build/backfill-interrupts.ts [--dry]
//
// Rewrites the backfill file each run; live interrupts go to dated files.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { classifyCall, redact } from '../hooks/reach.ts'
import type { InterruptRow, TurnCall } from '../hooks/steers.ts'

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
type Line = { type?: string; cwd?: string; timestamp?: string; sessionId?: string; isSidechain?: boolean; message?: { content?: string | Block[] } }

const MARK = /^\[Request interrupted by user/
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
// As hooks/steers.ts saidOf (which node can't load directly: its imports carry no extensions).
function saidOf(text: string): string | undefined {
  // Tags the host adds around a message (an opened file, a command's output) are not what the person said.
  const t = text.replace(/<(local-command-[a-z]+|ide_[a-z_]+|system-reminder|command-[a-z]+)>[\s\S]*?<\/\1>/g, '').trim()
  if (!t || t.startsWith('[HCP') || t.startsWith('/') || t.startsWith('<command-')) return undefined
  return clip(redact(t.replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, '[paste]').replace(/\s+/g, ' ')), 600)
}
const blocks = (line: Line): Block[] => {
  const c = line.message?.content
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
}
const textOf = (line: Line) => blocks(line).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim()

function callOf(b: Block): TurnCall {
  const input = b.input ?? {}
  const facts = classifyCall(b.name ?? '?', input)
  const target = ['file_path', 'path', 'pattern', 'url', 'query'].map(k => input[k]).find(v => typeof v === 'string') as string | undefined
  return { tool: b.name ?? '?', channel: facts.channel, summary: clip((b.name === 'Bash' ? facts.content : (target ?? facts.content)).replace(/\s+/g, ' '), 160) }
}

function scan(file: string): InterruptRow[] {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => {
    try {
      return [JSON.parse(l) as Line]
    } catch {
      return []
    }
  }).filter(l => !l.isSidechain)
  const out: InterruptRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.type !== 'user' || !blocks(line).some(b => b.type === 'text' && MARK.test(b.text ?? ''))) continue
    // What was on screen: the assistant's calls and words since the last real user message.
    const calls: TurnCall[] = []
    let doing = ''
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j]!
      if (prev.type === 'user' && textOf(prev) && !MARK.test(textOf(prev))) break
      if (prev.type !== 'assistant') continue
      for (const b of blocks(prev).reverse()) {
        if (b.type === 'tool_use' && calls.length < 6) calls.unshift(callOf(b))
        if (b.type === 'text' && !doing && b.text?.trim()) doing = clip(b.text.trim().replace(/\s+/g, ' '), 300)
      }
    }
    // What they said next: the next user message with words of its own.
    let said: string | undefined
    for (let j = i + 1; j < lines.length && j < i + 12; j++) {
      const next = lines[j]!
      if (next.type === 'assistant') break
      const text = textOf(next)
      if (next.type === 'user' && text && !MARK.test(text)) {
        said = saidOf(text)
        break
      }
    }
    const at = Date.parse(line.timestamp ?? '') || statSync(file).mtimeMs
    out.push({ at, kind: 'aborted', project: basename(line.cwd ?? 'root') || 'root', ...(line.sessionId ? { session: line.sessionId } : {}), doing, calls, ...(said ? { said } : {}), source: 'backfill' })
  }
  return out
}

const root = join(homedir(), '.claude', 'projects')
const rows = readdirSync(root)
  .flatMap(dir => {
    try {
      return readdirSync(join(root, dir)).filter(f => f.endsWith('.jsonl')).map(f => join(root, dir, f))
    } catch {
      return []
    }
  })
  .flatMap(scan)
  .sort((a, b) => a.at - b.at)

const byProject = new Map<string, number>()
for (const r of rows) if (r.said) byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1)
console.log(`${rows.length} interrupts, ${rows.filter(r => r.said).length} with words. By project (with words):`)
for (const [p, n] of [...byProject].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${p}`)

if (!process.argv.includes('--dry')) {
  const dir = join(homedir(), '.claude', 'hcp', 'interrupts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'backfill.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(`Wrote ${join(dir, 'backfill.jsonl')}`)
}
