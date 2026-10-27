// What the hcp surface draws: one card (inline at its tool row, or in the
// inbox), and the inbox the pane and the /hcp output row share. Every press
// goes through `Actions`, so these functions only read. The mode's color is
// the inbox's accent, and each kind of card has its own.

import type { ElementTable, RenderNode, RenderSurface } from 'claude-code'

import type { HcpCard, HcpDecision, HcpDelivery, HcpEvidence, HcpGrant, HcpLink, HcpMedia, HcpMode, HcpOutward, HcpScheduled } from '../types'
import { KIND_ICON, REEL_SIZE } from './evidence'
import { STEERS, clip, labels, services } from './model'
import type { ReachChoice, Steer } from './model'

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
  slide: (id: string, step: number) => void
  /** Keystrokes in a slide's note field; `isKept` on Enter, which shows it under the slide. */
  slideNote: (id: string, at: number, text: string, isKept?: boolean) => void
  openMedia: (media: HcpMedia) => void
  unattach: (at: number) => void
  clearAttachments: () => void
  clearFromYou: () => void
  /** j/k: the next or previous open card takes the hotkeys and the focus. */
  move: (step: number) => void
  /** The person's answer to a held call. */
  reach: (id: string, choice: ReachChoice, note?: string) => void
  revokeGrant: (id: string) => void
  /** A decision Claude recorded: keep it, or tell Claude to stop and check. */
  agree: (id: string) => void
  disagree: (id: string) => void
  /** Replace Claude's recorded choice with the person's own. */
  change: (id: string, text?: string) => void
  /** The Evidence reel: open a link in the browser, keep one on top, retire one, add your own. */
  openLink: (href: string) => void
  pinEvidence: (id: string) => void
  dropEvidence: (id: string) => void
  /** `url label words` typed into the reel's field. */
  addLink: (text: string) => void
  toggleAllEvidence: () => void
  clearStale: () => void
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
  /** The open card that carries the hotkeys, if any is open. */
  active: string | undefined
  outbox: HcpMedia[]
  fromYou: HcpMedia[]
  /** Grants still live. */
  grants: HcpGrant[]
  /** Calls that left the machine or were held this session, newest first. */
  outward: HcpOutward[]
  now: number
  /** Decisions Claude recorded itself, newest first. */
  decided: HcpDecision[]
  /** The Evidence reel in the order it draws: pinned, backing an open card, explicit, found, stale. */
  evidence: HcpEvidence[]
  showAllEvidence: boolean
  /** Bumped after each link the person adds, so the field draws empty again. */
  linkSent: number
} & Pictures

/** How pictures draw: the terminal's Image reads files, other surfaces' Svg carries bytes. */
export type Pictures = {
  surface: RenderSurface
  /** Thumbnail base64 by thumbnail path, for the surfaces that draw an Svg. */
  thumbs: ReadonlyMap<string, string>
}

/** What a card draws with besides itself. */
export type CardContext = Pictures & {
  laterLabel: string
  /** This card carries the hotkeys: drawn in the pane, and the one j/k moved to. */
  hasKeys?: boolean
}

export const THEME = {
  pairing: '#14B8A6',
  'heads-down': '#8B5CF6',
  away: '#F59E0B',
  ask: '#38BDF8',
  handoff: '#FB7185',
  share: '#34D399',
  reach: '#F97316',
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

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** One link as the surface draws it: a Link (OSC 8 on the terminal, an anchor elsewhere), else its label and dim href. */
function linkText(els: ElementTable, link: HcpLink, isDim = false) {
  const { Text } = els
  if ('Link' in els) {
    const { Link } = els

    return (
      <Text dimColor={isDim} underline={!isDim}>
        <Link href={link.href} label={link.label} />
      </Text>
    )
  }

  return (
    <Text dimColor={isDim}>
      {link.label} <Text dimColor>{clip(link.href, 60)}</Text>
    </Text>
  )
}

/** A card's links under its detail: the evidence next to the choice. */
function linksRow(els: ElementTable, id: string, links: readonly HcpLink[] | undefined, act: Actions) {
  if (!links || links.length === 0) return null
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="column">
      {links.map((l, at) => (
        <Box key={`${id}-link-${at}`} flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>🔗</Text>
          {linkText(els, l)}
          {l.why && <Text dimColor>· {clip(l.why, 70)}</Text>}
          <Button key={`${id}-link-open-${at}`} label="⤢" plain dimColor onPress={() => act.openLink(l.href)} />
        </Box>
      ))}
    </Box>
  )
}

const SOURCE_LABEL = { claude: 'Claude', card: 'card', harvest: 'from a reply', tool: 'from output', you: 'you added' } as const

const agoText = (at: number, now: number) => {
  const m = Math.round((now - at) / 60_000)

  return m < 1 ? 'now' : m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/** One entry of the reel: the link, what it is, what it backs, and pin / drop. */
function evidenceRow(els: ElementTable, e: HcpEvidence, act: Actions, now: number) {
  const { Box, Text, Button } = els
  const isStale = e.status === 'stale'
  const was = e.was?.[0]
  const context = [
    e.kind !== 'app' ? e.kind : '',
    e.cardId !== undefined ? `for ${e.cardId}` : '',
    e.source === 'card' || e.source === 'claude' ? '' : SOURCE_LABEL[e.source],
    agoText(e.updatedAt, now),
  ].filter(Boolean)

  return (
    <Box key={`evidence-${e.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor={isStale}>
          {e.isPinned ? '📌' : KIND_ICON[e.kind]} {badge(els, e.id, isStale ? '#64748B' : THEME.ask)}
        </Text>
        {linkText(els, e, isStale)}
        <Text dimColor>
          · {isStale ? 'superseded · ' : ''}
          {context.join(' · ')}
        </Text>
        <Button key={`${e.id}-open`} label="⤢ Open" plain dimColor onPress={() => act.openLink(e.href)} />
        {!isStale && (
          <Button key={`${e.id}-pin`} label={e.isPinned ? 'Unpin' : '📌 Pin'} plain dimColor onPress={() => act.pinEvidence(e.id)} />
        )}
        {!isStale && <Button key={`${e.id}-drop`} label="×" plain dimColor onPress={() => act.dropEvidence(e.id)} />}
      </Box>
      {e.why && <Text dimColor>   {clip(e.why, 100)}</Text>}
      {was && (
        <Text dimColor>
          {'   '}↻ was: {clip(was.label, 50)} <Text dimColor>{clip(was.href, 50)}</Text>
        </Text>
      )}
    </Box>
  )
}

/** The reel: the links the session's decisions rest on, always in view, never scrolled for. */
function evidenceReel(els: ElementTable, s: Snapshot, act: Actions, section: (title: string) => RenderNode) {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const live = s.evidence.filter(e => e.status === 'live')
  const stale = s.evidence.length - live.length
  const shown = s.showAllEvidence ? s.evidence : live.slice(0, REEL_SIZE)
  const hidden = s.evidence.length - shown.length

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {section(live.length === 0 ? 'Evidence' : `Evidence (${live.length})`)}
        {hidden > 0 && (
          <Button key="evidence-all" label={`show all ${s.evidence.length}`} plain dimColor onPress={act.toggleAllEvidence} />
        )}
        {s.showAllEvidence && s.evidence.length > 0 && <Button key="evidence-top" label="show top" plain dimColor onPress={act.toggleAllEvidence} />}
        {s.showAllEvidence && stale > 0 && <Button key="evidence-clear-stale" label="Clear stale" plain dimColor onPress={act.clearStale} />}
      </Box>
      {s.evidence.length === 0 && (
        <Text dimColor>Links behind the decisions land here: from cards, Claude's replies, gh/vercel output, or one you add below.</Text>
      )}
      {shown.map(e => evidenceRow(els, e, act, s.now))}
      {Input && (
        <Input
          key={`add-link-${s.linkSent}`}
          placeholder="Add a link: the URL then a label, Enter keeps it and tells Claude"
          submitLabel="add"
          onSubmit={act.addLink}
        />
      )}
    </Box>
  )
}

const svgOf = (base64: string, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<image href="data:image/jpeg;base64,${base64}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`

/**
 * One picture as the surface can draw it: the terminal's Image reading the png
 * itself, an Svg carrying the jpeg elsewhere, or its caption where neither can.
 */
function picture(els: ElementTable, m: HcpMedia, on: Pictures, isSmall: boolean) {
  const { Text } = els
  const { surface, thumbs } = on
  const alt = m.caption ?? baseName(m.path)
  const ratio = m.width && m.height ? m.height / m.width : 0.6
  // The resolved table names every element and a surface draws the ones it lacks as nothing,
  // so the surface, not the table, says which picture element there is.
  if (surface === 'terminal' && 'Image' in els) {
    const { Image } = els
    if (m.pngPath) {
      const columns = isSmall ? 18 : 48
      // A terminal cell is about twice as tall as it is wide.
      const rows = Math.max(2, Math.min(40, Math.round((columns * ratio) / 2)))

      return <Image source={{ file: m.pngPath, format: 'png' }} columns={columns} rows={rows} alt={alt} />
    }
  } else if (surface !== 'terminal' && 'Svg' in els) {
    const { Svg } = els
    const path = isSmall ? (m.miniPath ?? m.thumbPath) : m.thumbPath
    const base64 = path === undefined ? undefined : thumbs.get(path)
    if (base64 !== undefined) {
      const width = isSmall ? 160 : Math.min(480, m.width ?? 480)
      const height = Math.round(width * ratio)

      return <Svg source={svgOf(base64, width, height)} alt={alt} width={width} height={height} />
    }
  }

  return <Text dimColor>🖼 {clip(alt, 60)}</Text>
}

/** A card's pictures: one large, a grid of small ones, or slides with a note each. */
function mediaBlock(els: ElementTable, card: HcpCard, act: Actions, ctx: CardContext) {
  const media = card.media ?? []
  if (media.length === 0) return null
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const id = card.id
  const key = (hotkey: string) => (ctx.hasKeys ? { hotkey } : {})

  if (media.length === 1 || card.layout !== 'slides') {
    const isSmall = media.length > 1

    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {media.map((m, at) => (
          <Box key={`${id}-media-${at}`} flexDirection="column">
            {picture(els, m, ctx, isSmall)}
            <Box flexDirection="row" gap={1}>
              {m.caption && <Text dimColor>{clip(m.caption, isSmall ? 22 : 80)}</Text>}
              <Button
                key={`${id}-open-${at}`}
                label={m.video ? '▶ Play' : '⤢ Open'}
                plain
                dimColor
                {...(media.length === 1 ? key('o') : {})}
                onPress={() => act.openMedia(m)}
              />
            </Box>
          </Box>
        ))}
      </Box>
    )
  }

  const at = Math.min(Math.max(card.slide ?? 0, 0), media.length - 1)
  const m = media[at]!
  const kept = card.slideNotes?.[String(at)]

  return (
    <Box flexDirection="column">
      {picture(els, m, ctx, false)}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-prev`} label="‹ prev" {...key('h')} onPress={() => act.slide(id, -1)} />
        <Text bold>
          {at + 1}/{media.length}
        </Text>
        <Button key={`${id}-next`} label="next ›" {...key('l')} onPress={() => act.slide(id, 1)} />
        <Button key={`${id}-open`} label={m.video ? '▶ Play video' : '⤢ Open'} dimColor {...key('o')} onPress={() => act.openMedia(m)} />
      </Box>
      {m.caption && <Text dimColor>{m.caption}</Text>}
      {kept && <Text dimColor>📝 {kept}</Text>}
      {Input && (
        <Input
          key={`${id}-slide-note-${at}`}
          placeholder={`Note on image ${at + 1} (optional), Enter keeps it`}
          submitLabel="keep"
          onInput={value => act.slideNote(id, at, value)}
          onSubmit={value => act.slideNote(id, at, value, true)}
        />
      )}
    </Box>
  )
}

/** A row of small pictures with a remove button each, or one clear for the row. */
function thumbRow(els: ElementTable, media: HcpMedia[], on: Pictures, prefix: string, remove?: (at: number) => void) {
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {media.map((m, at) => (
        <Box key={`${prefix}-${at}`} flexDirection="column">
          {picture(els, m, on, true)}
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{clip(m.caption ?? baseName(m.path), 22)}</Text>
            {remove && <Button key={`${prefix}-x-${at}`} label="×" plain dimColor onPress={() => remove(at)} />}
          </Box>
        </Box>
      ))}
    </Box>
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

const LEVEL_LABEL = { local: 'local', own: 'your account', shared: 'others can see', notifies: 'notifies people' } as const

const minutesLeft = (until: number, now: number) => {
  const m = Math.max(0, Math.round((until - now) / 60_000))

  return m >= 90 ? `${Math.round(m / 60)}h left` : `${m}m left`
}

/** One line under a tool row, or in the pane's ledger: where the call went and on whose say-so. */
export function reachBadge(els: ElementTable, row: HcpOutward, now: number) {
  const { Text } = els
  const level = row.level ? LEVEL_LABEL[row.level] : 'reach unknown'
  const to = row.audience.length > 0 ? ` → ${clip(row.audience.join(', '), 60)}` : ''
  const how =
    row.verdict === 'hold'
      ? `held · card ${row.cardId}`
      : row.verdict === 'approved'
        ? `sent from card ${row.cardId}`
        : row.verdict === 'grant'
          ? `allowed by grant ${row.grantId}`
          : level
  const color = row.level === 'notifies' ? THEME.reach : undefined
  const ago = Math.round((now - row.at) / 60_000)

  return (
    <Text dimColor={color === undefined}>
      <Text color={color}>{row.verdict === 'hold' ? '⏸' : '↗'}</Text> {row.channel}
      {to} · {how}
      {row.verdict === 'hold' || row.verdict === 'badge' ? '' : ` · ${level}`}
      {ago > 0 ? ` · ${ago}m ago` : ''}
    </Text>
  )
}

/** A held call: the exact content, who it reaches, and how to answer. */
function reachCard(els: ElementTable, card: HcpCard, act: Actions, ctx: CardContext) {
  const { Box, Text, Button, Markdown } = els
  const Input = 'Input' in els ? els.Input : undefined
  const r = card.reach!
  const id = card.id
  const color = THEME.reach
  const key = (hotkey: string) => (ctx.hasKeys ? { hotkey } : {})
  const fence = r.content.includes('```') ? '~~~' : '```'

  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {ctx.hasKeys && <Text color={color}>▸ </Text>}
          {badge(els, id, color)}{' '}
          <Text weight="bold" size="title">
            ✉ {card.title}
          </Text>
        </Text>
        <Button key={`${id}-x`} label="×" role="dismiss" plain dimColor {...key('x')} onPress={() => act.reach(id, 'not-now')} />
      </Box>
      <Text dimColor>
        {LEVEL_LABEL[r.level]}
        {r.audience.length > 0 ? ` · to ${clip(r.audience.join(', '), 120)}` : ''}
      </Text>
      {card.detail && <Text dimColor>Why: {card.detail}</Text>}
      {linksRow(els, id, card.links, act)}
      <Markdown text={`${fence}\n${r.content}\n${fence}`} />
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-send`} label="Send" variant="primary" {...key('s')} onPress={() => act.reach(id, 'send')}>
          {big(els, '➤ Send', color)}
        </Button>
        <Button key={`${id}-similar-1h`} label="Send · allow similar 1h" onPress={() => act.reach(id, 'similar-1h')}>
          {big(els, '➤ Send · allow similar 1h')}
        </Button>
        <Button key={`${id}-similar-day`} label="… for today" onPress={() => act.reach(id, 'similar-day')} />
        <Button key={`${id}-draft`} label="Save as draft" onPress={() => act.reach(id, 'draft')} />
        <Button key={`${id}-not-now`} label="Not now" dimColor onPress={() => act.reach(id, 'not-now')} />
      </Box>
      {Input && (
        <Input
          key={`${id}-edit`}
          label="Edit:"
          value={r.content}
          rows={Math.min(8, Math.max(2, r.content.split('\n').length))}
          submitLabel="send edited"
          onInput={value => act.draft(`${id}:edit`, value)}
          onSubmit={value => act.reach(id, 'edit', value)}
        />
      )}
      {Input && (
        <Input
          key={`${id}-note`}
          placeholder="Or tell Claude what to change, Enter sends"
          submitLabel="send"
          onInput={value => act.draft(id, value)}
          onSubmit={value => act.reach(id, 'change', value)}
        />
      )}
      {card.progress && <Text color={color}>{card.progress}</Text>}
    </Box>
  )
}

export function cardView(els: ElementTable, card: HcpCard, act: Actions, ctx: CardContext) {
  if (card.status === 'queued') return queuedRow(els, card)
  if (card.status !== 'open') return answeredRow(els, card)
  if (card.kind === 'reach') return reachCard(els, card, act, ctx)

  const { Box, Text, Button, Markdown } = els
  const Input = 'Input' in els ? els.Input : undefined
  const id = card.id
  const color = THEME[card.kind]
  const service = card.service === undefined ? undefined : services()[card.service]

  const laterLabel = ctx.laterLabel
  const key = (hotkey: string) => (ctx.hasKeys ? { hotkey } : {})
  const later = (
    <Button key={`${id}-later`} label={`⏰ Later · ${laterLabel}`} onPress={() => act.answer(id, 'later')}>
      {big(els, `⏰ Later · ${laterLabel}`)}
    </Button>
  )

  const options =
    card.kind === 'ask' ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {card.options.map((o, at) => {
          const isPicked = card.picked.includes(o.value)
          const mark = isPicked ? '✓' : card.isMulti ? '☐' : '○'

          return (
            <Button
              key={`${id}-opt-${o.value}`}
              label={`${mark} ${o.label}`}
              variant={isPicked ? 'primary' : 'secondary'}
              {...key(String(at + 1))}
              onPress={() => act.pick(id, o.value)}
            >
              {big(els, `${mark} ${o.label}`, isPicked ? color : undefined)}
            </Button>
          )
        })}
      </Box>
    ) : null

  const hints = card.options.filter(o => card.picked.includes(o.value) && o.hint)

  // A blind card shows Claude's recommendation only once the person has picked.
  const recommendedLabels = card.options.filter(o => card.recommended?.includes(o.value)).map(o => o.label)
  const blindLine =
    card.kind === 'ask' && card.blind ? (
      card.picked.length === 0 ? (
        <Text dimColor>
          {card.blind === 'stakes' ? 'Hard to undo or reaches others: ' : ''}pick first; Claude's recommendation shows after you choose.
        </Text>
      ) : (
        <Text dimColor>Claude recommended: {recommendedLabels.join(', ') || 'nothing'}</Text>
      )
    ) : null

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
        <Button key={`${id}-send`} label="Send" variant="primary" {...key('s')} onPress={() => act.answer(id, 'now')}>
          {big(els, '➤ Send', color)}
        </Button>
        <Button key={`${id}-nntr`} label="Noted · no reply" onPress={() => act.answer(id, 'nntr')}>
          {big(els, '✓ Noted · no reply')}
        </Button>
        {later}
      </Box>
    ) : card.kind === 'share' ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-copy-rich`} label={labels().copyRich} variant="primary" {...key('s')} onPress={() => act.copy(id, true)}>
          {big(els, `📋 ${labels().copyRich}`, color)}
        </Button>
        <Button key={`${id}-copy-plain`} label="Copy plain" onPress={() => act.copy(id, false)} />
        <Button key={`${id}-finish`} label="Done" dimColor onPress={() => act.finish(id)} />
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key={`${id}-done`} label="Done" variant="primary" {...key('s')} onPress={() => act.done(id)}>
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
          {ctx.hasKeys && <Text color={color}>▸ </Text>}
          {badge(els, id, color)}{' '}
          <Text weight="bold" size="title">
            {card.kind === 'handoff' ? '⛔ ' : ''}
            {card.title}
          </Text>
        </Text>
        <Button key={`${id}-x`} label="×" role="dismiss" plain dimColor {...key('x')} onPress={() => act.dismiss(id)} />
      </Box>
      {card.detail && <Text dimColor>{card.detail}</Text>}
      {card.audience && <Text dimColor>For: {card.audience}</Text>}
      {linksRow(els, id, card.links, act)}
      {card.draft && <Markdown text={card.draft} />}
      {mediaBlock(els, card, act, ctx)}
      {blindLine}
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
  // The terminal is where the keys are the way in.
  const isTerminal = s.surface === 'terminal'
  const section = (title: string): RenderNode => (
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

      {evidenceReel(els, s, act, section)}

      {s.needsAuth.length > 0 && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={THEME.handoff}>🔑 MCP needs auth: {s.needsAuth.join(', ')}</Text>
          <Button key="mcp-auth" label="Authorize" dimColor onPress={act.authorizeMcp} />
        </Box>
      )}

      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {section(open.length === 0 ? 'Nothing waiting on you' : `Waiting on you (${open.length})`)}
          {open.length > 1 && <Button key="nav-prev" label="↑ k" plain dimColor hotkey="k" onPress={() => act.move(-1)} />}
          {open.length > 1 && <Button key="nav-next" label="↓ j" plain dimColor hotkey="j" onPress={() => act.move(1)} />}
        </Box>
        {isTerminal && open.length > 0 && (
          <Text dimColor>
            Keys once the pane has focus (ctrl+x tab, or /hcp; Tab off a text field first): j/k card · 1-8 pick · s send ·
            x dismiss · h/l slide · o open · y/n reply
          </Text>
        )}
        {live.map(card =>
          cardView(els, card, act, { surface: s.surface, laterLabel: s.laterLabel, thumbs: s.thumbs, hasKeys: card.id === s.active }),
        )}
      </Box>

      <Box flexDirection="column">
        {section("Reply to Claude's last message")}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="q-yes" label="Yes" variant="primary" hotkey="y" onPress={() => act.quick('yes')}>
            {big(els, '👍 Yes', accent)}
          </Button>
          <Button key="q-no" label="No" hotkey="n" onPress={() => act.quick('no')}>
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
            placeholder="Message for Claude, Enter sends now (drop an image or video file in to attach it)"
            submitLabel="send"
            onInput={act.quickDraft}
            onSubmit={value => act.quickSend('now', value)}
          />
        )}
        {s.outbox.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={accent}>📎 Sent with your next message ({s.outbox.length})</Text>
              <Button key="outbox-clear" label="Clear" plain dimColor onPress={act.clearAttachments} />
            </Box>
            {thumbRow(els, s.outbox, s, 'outbox', act.unattach)}
          </Box>
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

      {s.decided.length > 0 && (
        <Box flexDirection="column">
          {section('Claude decided')}
          {s.decided.map(d => {
            const surface = d.shadow?.['hcp-surface']

            return (
              <Box key={`decided-${d.id}`} flexDirection="column">
                <Text>
                  {badge(els, d.id, THEME.ask)} {d.title} <Text bold>→ {d.choice}</Text>
                  {d.why ? <Text dimColor> · {clip(d.why, 80)}</Text> : ''}
                </Text>
                {surface && (
                  <Text dimColor>
                    shadow would {surface.verdict}: {clip(surface.reason, 90)}
                  </Text>
                )}
                {linksRow(
                  els,
                  d.id,
                  s.evidence.filter(e => e.cardId === d.id && e.status === 'live'),
                  act,
                )}
                {d.outcome === 'pending' || d.outcome === 'agreed' ? (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={1} flexWrap="wrap">
                      {d.outcome === 'pending' ? (
                        <Button key={`${d.id}-agree`} label="👍 Fine" onPress={() => act.agree(d.id)} />
                      ) : (
                        <Text dimColor>✓ you kept it</Text>
                      )}
                      <Button
                        key={`${d.id}-disagree`}
                        label={d.outcome === 'agreed' ? '✋ Disagree after all' : '✋ Disagree'}
                        onPress={() => act.disagree(d.id)}
                      />
                      {Input && (
                        <Input
                          key={`${d.id}-why`}
                          placeholder="Why not (optional), Enter disagrees"
                          submitLabel="disagree"
                          onInput={value => act.draft(d.id, value)}
                          onSubmit={value => {
                            act.draft(d.id, value)
                            act.disagree(d.id)
                          }}
                        />
                      )}
                    </Box>
                    {Input && (
                      <Input
                        key={`${d.id}-change`}
                        placeholder={`Do this instead of ${clip(d.choice ?? 'it', 40)}, Enter sends`}
                        submitLabel="change"
                        onInput={value => act.draft(`${d.id}:change`, value)}
                        onSubmit={value => act.change(d.id, value)}
                      />
                    )}
                  </Box>
                ) : (
                  <Text dimColor>
                    {d.outcome === 'disagreed' ? (d.change ? `✎ you changed it: ${clip(d.change, 80)}` : '✋ you disagreed') : d.outcome}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )}

      {s.grants.length > 0 && (
        <Box flexDirection="column">
          {section('Active grants')}
          {s.grants.map(g => (
            <Box key={`grant-${g.id}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text>
                {badge(els, g.id, THEME.reach)} {g.channel}
                {g.audience.length > 0 ? ` → ${clip(g.audience.join(', '), 50)}` : ''}{' '}
                <Text dimColor>
                  · {minutesLeft(g.expiresAt, s.now)} · used {g.uses}× · "{clip(g.intent, 80)}"
                </Text>
              </Text>
              <Button key={`${g.id}-revoke`} label="Revoke" dimColor onPress={() => act.revokeGrant(g.id)} />
            </Box>
          ))}
        </Box>
      )}

      {s.outward.length > 0 && (
        <Box flexDirection="column">
          {section('Outward this session')}
          {s.outward.map(o => (
            <Box key={`outward-${o.toolUseId}`}>{reachBadge(els, o, s.now)}</Box>
          ))}
        </Box>
      )}

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

      {s.fromYou.length > 0 && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {section('You sent')}
            <Button key="from-you-clear" label="Clear" plain dimColor onPress={act.clearFromYou} />
          </Box>
          {thumbRow(els, s.fromYou, s, 'from-you')}
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
