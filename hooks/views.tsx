// What the hcp surface draws: one card (inline at its tool row, or in the
// inbox), and the inbox the pane and the /hcp output row share. Every press
// goes through `Actions`, so these functions only read. The mode's color is
// the inbox's accent, and each kind of card has its own.

import type { ElementTable } from 'claude-code'

import type { HcpCard, HcpDelivery, HcpMode, HcpScheduled } from '../types'
import { SERVICES, STEERS, clip } from './model'
import type { Steer } from './model'

export type Actions = {
  pick: (id: string, value: string) => void
  draft: (id: string, text: string) => void
  answer: (id: string, delivery: HcpDelivery, note?: string) => void
  dismiss: (id: string) => void
  fill: (id: string) => void
  runFix: (id: string) => void
  done: (id: string) => void
  cant: (id: string) => void
  copy: (id: string, isRich: boolean) => void
  finish: (id: string) => void
  authorizeMcp: () => void
  setMode: (mode: HcpMode) => void
  toggleConcise: () => void
  steer: (steer: Steer) => void
  quick: (kind: 'yes' | 'no' | 'yes-nntr' | 'no-nntr' | 'ack') => void
  quickDraft: (text: string) => void
  quickSend: (delivery: HcpDelivery, text?: string) => void
  sendQueued: (id: string) => void
  cancelQueued: (id: string) => void
  clearHistory: () => void
}

export type Snapshot = {
  cards: HcpCard[]
  queue: HcpScheduled[]
  mode: HcpMode
  isConcise: boolean
  quickSent: number
  laterLabel: string
  /** MCP servers the engine says need authorizing. */
  needsAuth: string[]
  formatAt: (ms: number) => string
}

export const THEME = {
  pairing: '#14B8A6',
  'heads-down': '#8B5CF6',
  away: '#F59E0B',
  ask: '#38BDF8',
  handoff: '#FB7185',
  share: '#34D399',
  on: '#22C55E',
  ink: '#0B1220',
} as const

export const MODES: Record<HcpMode, { label: string; icon: string; blurb: string }> = {
  pairing: { label: 'Pairing', icon: '◆', blurb: 'Claude asks freely, with a card whenever a decision comes up.' },
  'heads-down': {
    label: 'Heads-down',
    icon: '◉',
    blurb: 'Questions batched into one card, updates kept to a line, reversible calls made without asking.',
  },
  away: {
    label: 'Away',
    icon: '☾',
    blurb: "Claude won't wait: safe, reversible defaults, questions left as cards, no issue, PR, Slack or deploy writes.",
  },
}

const DELIVERED: Record<HcpDelivery, string> = { now: 'sent', nntr: 'noted, no reply', later: 'scheduled' }

/** A label drawn larger and heavier than a Button's own, where the surface sizes text. */
function big(els: ElementTable, text: string, color?: string) {
  const { Text } = els

  return (
    <Text size="title" weight="semibold" color={color}>
      {text}
    </Text>
  )
}

function badge(els: ElementTable, text: string, color: string) {
  const { Text } = els

  return (
    <Text backgroundColor={color} color={THEME.ink} bold>
      {` ${text} `}
    </Text>
  )
}

function answeredRow(els: ElementTable, card: HcpCard) {
  const { Text } = els
  const how =
    card.status === 'dismissed' ? 'dismissed' : card.kind === 'share' && !card.delivery ? 'done' : DELIVERED[card.delivery ?? 'now']
  const what = card.answer?.replace(/^\[HCP [^\]]*\]\s*/, '') ?? ''

  return (
    <Text dimColor>
      <Text color={THEME[card.kind]}>✓</Text> {card.id} · {clip(what || card.title, 90)} ({how})
    </Text>
  )
}

/** The press landed and the engine holds the answer until Claude's running turn ends. */
function queuedRow(els: ElementTable, card: HcpCard) {
  const { Box, Text } = els
  const color = THEME[card.kind]
  const what = card.answer?.replace(/^\[HCP [^\]]*\]\s*/, '') ?? ''

  return (
    <Box key={`card-${card.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text>
        {badge(els, card.id, color)} <Text color={color}>⏳ Queued</Text> <Text dimColor>{clip(what || card.title, 90)}</Text>
      </Text>
      <Text dimColor>Claude picks it up when its current turn ends. No need to press again.</Text>
    </Box>
  )
}

export function cardView(els: ElementTable, card: HcpCard, act: Actions, laterLabel: string) {
  if (card.status === 'queued') return queuedRow(els, card)
  if (card.status !== 'open') return answeredRow(els, card)

  const { Box, Text, Button, Markdown } = els
  const Input = 'Input' in els ? els.Input : undefined
  const id = card.id
  const color = THEME[card.kind]
  const service = card.service === undefined ? undefined : SERVICES[card.service]
  const later = (
    <Button key={`${id}-later`} label={`⏰ Later · ${laterLabel}`} onPress={() => act.answer(id, 'later')}>
      {big(els, `⏰ Later · ${laterLabel}`)}
    </Button>
  )

  const options =
    card.kind === 'ask' ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {card.options.map(o => {
          const isPicked = card.picked.includes(o.value)
          const mark = isPicked ? '✓' : card.isMulti ? '☐' : '○'

          return (
            <Button
              key={`${id}-opt-${o.value}`}
              label={`${mark} ${o.label}`}
              variant={isPicked ? 'primary' : 'secondary'}
              onPress={() => act.pick(id, o.value)}
            >
              {big(els, `${mark} ${o.label}`, isPicked ? color : undefined)}
            </Button>
          )
        })}
      </Box>
    ) : null

  const hints = card.options.filter(o => card.picked.includes(o.value) && o.hint)

  const fix =
    card.kind === 'handoff' && card.fix ? (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>Run:</Text>
        <Text mono bold>
          {card.fix}
        </Text>
        {service?.isRunnable && (
          <Button key={`${id}-run`} label="▶ Run it (opens browser)" onPress={() => act.runFix(id)}>
            {big(els, '▶ Run it (opens browser)', color)}
          </Button>
        )}
        <Button key={`${id}-fill`} label="Put in prompt" dimColor onPress={() => act.fill(id)} />
      </Box>
    ) : null

  const footer =
    card.kind === 'ask' ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-send`} label="Send" variant="primary" onPress={() => act.answer(id, 'now')}>
          {big(els, '➤ Send', color)}
        </Button>
        <Button key={`${id}-nntr`} label="Noted · no reply" onPress={() => act.answer(id, 'nntr')}>
          {big(els, '✓ Noted · no reply')}
        </Button>
        {later}
      </Box>
    ) : card.kind === 'share' ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-copy-rich`} label="Copy formatted" variant="primary" onPress={() => act.copy(id, true)}>
          {big(els, '📋 Copy formatted', color)}
        </Button>
        <Button key={`${id}-copy-plain`} label="Copy plain" onPress={() => act.copy(id, false)} />
        <Button key={`${id}-finish`} label="Done" dimColor onPress={() => act.finish(id)} />
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-done`} label="Done" variant="primary" onPress={() => act.done(id)}>
          {big(els, service ? '✓ Done · verify & retry' : '✓ Done', color)}
        </Button>
        {later}
        <Button key={`${id}-cant`} label="Can't now" dimColor onPress={() => act.cant(id)} />
      </Box>
    )

  const placeholder =
    card.kind === 'handoff'
      ? 'Why not, or what you found (optional)'
      : card.kind === 'share'
        ? 'Ask for a change, Enter sends'
        : 'Add a note (optional), Enter sends'

  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {badge(els, id, color)}{' '}
          <Text weight="bold" size="title">
            {card.kind === 'handoff' ? '⛔ ' : ''}
            {card.title}
          </Text>
        </Text>
        <Button key={`${id}-x`} label="×" role="dismiss" plain dimColor onPress={() => act.dismiss(id)} />
      </Box>
      {card.detail && <Text dimColor>{card.detail}</Text>}
      {card.audience && <Text dimColor>For: {card.audience}</Text>}
      {card.draft && <Markdown text={card.draft} />}
      {options}
      {hints.map(o => (
        <Text dimColor>
          {o.label}: {o.hint}
        </Text>
      ))}
      {fix}
      {Input && (
        <Input
          key={`${id}-note`}
          placeholder={placeholder}
          submitLabel="send"
          onInput={value => act.draft(id, value)}
          onSubmit={value => (card.kind === 'handoff' ? act.cant(id) : act.answer(id, 'now', value))}
        />
      )}
      {footer}
      {card.progress && <Text color={color}>{card.progress}</Text>}
    </Box>
  )
}

const STEER_LABELS: Record<Steer, string> = {
  'no-code': "✋ Don't code yet",
  'check-first': '❓ Check with me first',
  narrow: '🎯 Narrow scope',
  'wrap-up': '🏁 Wrap up',
}

export function inbox(els: ElementTable, s: Snapshot, act: Actions) {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const accent = THEME[s.mode]
  const open = s.cards.filter(c => c.status === 'open')
  // Queued cards keep their place in the list, so the ⏳ shows where the buttons were.
  const live = s.cards.filter(c => c.status === 'open' || c.status === 'queued')
  const recent = s.cards.filter(c => c.status === 'answered' || c.status === 'dismissed').slice(-5)
  const section = (title: string) => (
    <Text size="heading" weight="bold" color={accent}>
      {title}
    </Text>
  )

  return (
    <Box flexDirection="column" gap={2} borderStyle="round" borderColor={accent} paddingX={1} paddingY={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(Object.keys(MODES) as HcpMode[]).map(m => {
            const isOn = s.mode === m
            const label = `${isOn ? '✓ ' : ''}${MODES[m].icon} ${MODES[m].label}`

            return (
              <Button key={`mode-${m}`} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={() => act.setMode(m)}>
                {big(els, label, isOn ? THEME[m] : undefined)}
              </Button>
            )
          })}
          <Button
            key="concise"
            label={s.isConcise ? 'Concise ON' : 'Concise off'}
            variant={s.isConcise ? 'primary' : 'secondary'}
            onPress={act.toggleConcise}
          >
            {big(els, s.isConcise ? '● Concise ON' : '○ Concise off', s.isConcise ? THEME.on : undefined)}
          </Button>
        </Box>
        <Text>
          {badge(els, MODES[s.mode].label.toUpperCase(), accent)} <Text dimColor>{MODES[s.mode].blurb}</Text>
        </Text>
      </Box>

      {s.needsAuth.length > 0 && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={THEME.handoff}>🔑 MCP needs auth: {s.needsAuth.join(', ')}</Text>
          <Button key="mcp-auth" label="Authorize" dimColor onPress={act.authorizeMcp} />
        </Box>
      )}

      <Box flexDirection="column">
        {section(open.length === 0 ? 'Nothing waiting on you' : `Waiting on you (${open.length})`)}
        {live.map(card => cardView(els, card, act, s.laterLabel))}
      </Box>

      <Box flexDirection="column">
        {section("Reply to Claude's last message")}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="q-yes" label="Yes" variant="primary" onPress={() => act.quick('yes')}>
            {big(els, '👍 Yes', accent)}
          </Button>
          <Button key="q-no" label="No" onPress={() => act.quick('no')}>
            {big(els, '👎 No')}
          </Button>
          <Button key="q-yes-nntr" label="Yes · NNTR" onPress={() => act.quick('yes-nntr')}>
            {big(els, 'Yes · NNTR')}
          </Button>
          <Button key="q-no-nntr" label="No · NNTR" onPress={() => act.quick('no-nntr')}>
            {big(els, 'No · NNTR')}
          </Button>
          <Button key="q-ack" label="👀 Seen" onPress={() => act.quick('ack')}>
            {big(els, '👀 Seen')}
          </Button>
        </Box>
        {Input && (
          <Input
            key={`quick-${s.quickSent}`}
            placeholder="Message for Claude, Enter sends now"
            submitLabel="send"
            onInput={act.quickDraft}
            onSubmit={value => act.quickSend('now', value)}
          />
        )}
        {Input && (
          <Box flexDirection="row" gap={1}>
            <Button key="q-note-nntr" label="Send as NNTR" onPress={() => act.quickSend('nntr')}>
              {big(els, '✓ Send as NNTR')}
            </Button>
            <Button key="q-note-later" label={`⏰ Send later · ${s.laterLabel}`} onPress={() => act.quickSend('later')}>
              {big(els, `⏰ Send later · ${s.laterLabel}`)}
            </Button>
          </Box>
        )}
      </Box>

      <Box flexDirection="column">
        {section('Steer the current run')}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {(Object.keys(STEERS) as Steer[]).map(k => (
            <Button key={`steer-${k}`} label={STEER_LABELS[k]} onPress={() => act.steer(k)}>
              {big(els, STEER_LABELS[k])}
            </Button>
          ))}
        </Box>
      </Box>

      {s.queue.length > 0 && (
        <Box flexDirection="column">
          {section('Scheduled')}
          {s.queue.map(item => (
            <Box key={`queued-${item.id}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text>
                ⏰ <Text bold>{s.formatAt(item.dueAt)}</Text>{' '}
                <Text dimColor>{item.kind === 'remind' ? 'remind you:' : 'send:'}</Text> {clip(item.text, 60)}
              </Text>
              {item.kind === 'prompt' && (
                <Button key={`${item.id}-now`} label="Send now" dimColor onPress={() => act.sendQueued(item.id)} />
              )}
              <Button key={`${item.id}-cancel`} label="Cancel" dimColor onPress={() => act.cancelQueued(item.id)} />
            </Box>
          ))}
        </Box>
      )}

      {recent.length > 0 && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {section('Recent')}
            <Button key="clear-history" label="Clear" plain dimColor onPress={act.clearHistory} />
          </Box>
          {recent.map(card => answeredRow(els, card))}
        </Box>
      )}
    </Box>
  )
}
