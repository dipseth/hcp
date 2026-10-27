export type HcpOption = { value: string; label: string; hint?: string }

/**
 * A picture on a card, or one the person sent: the file Claude reads, and the
 * thumbnails the mod made of it. Only paths live here; thumbnail bytes are
 * read when drawn, so `$.state` stays small.
 */
export type HcpMedia = {
  /** The file Claude reads: an image, or a frame sampled from `video`. */
  path: string
  caption?: string
  /** The video a frame was sampled from; Open plays it. */
  video?: string
  /** A jpeg of at most 640px, drawn as an Svg on desktop, VS Code and mobile. */
  thumbPath?: string
  /** A 200px jpeg for grids. */
  miniPath?: string
  /** A png the terminal's Image reads itself. */
  pngPath?: string
  /** `thumbPath`'s size in pixels. */
  width?: number
  height?: number
}

/** How an answer reaches Claude: a prompt now, a silent note, or a prompt at `dueAt`. */
export type HcpDelivery = 'now' | 'nntr' | 'later'

/** `local`: this machine. `own`: the person's accounts, nobody told. `shared`: others see it. `notifies`: a person gets a message. */
export type ReachLevel = 'local' | 'own' | 'shared' | 'notifies'

/** A held call that reaches people, as its card shows it. */
export type HcpReach = {
  tool: string
  /** `gh issue comment`, `weReci send_recipe_email`. */
  channel: string
  audience: string[]
  level: ReachLevel
  /** Why hcp thinks so: the rule, the tag, or the judge's numbers. */
  why: string
  /** What goes out, redacted and clipped. */
  content: string
  /** The exact call: Send approves this key once. */
  callKey: string
  /** The reach run that held it: the card's answer is its feedback. */
  runId?: string
  /** The grant it nearly fit, by id. */
  nearGrant?: string
}

export type HcpCard = {
  /** `c<n>` for asks and shares, `h<n>` for handoffs, `r<n>` for held calls; what Claude refers to. */
  id: string
  kind: 'ask' | 'handoff' | 'share' | 'reach'
  /** Reach: the held call. */
  reach?: HcpReach
  /** The tool call that posted it, or the Bash call whose failure raised it. */
  toolUseId?: string
  /** The subagent whose call raised it; its notes go to that loop. */
  agentId?: string
  title: string
  detail?: string
  /** Markdown shown above the options (an issue body, a plan), or a share's text. */
  draft?: string
  /** Share: who the text is for (`Slack channel`). */
  audience?: string
  options: HcpOption[]
  isMulti: boolean
  picked: string[]
  /** Handoff: the known service (`gcloud`), or `mcp:<server>`. */
  service?: string
  /** Handoff: the command the person runs to clear it. */
  fix?: string
  note: string
  /** A transient line under the card: verifying, still failing, running login. */
  progress?: string
  /** `queued`: the answer is handed to the engine and waits behind Claude's running turn. */
  status: 'open' | 'queued' | 'answered' | 'dismissed'
  delivery?: HcpDelivery
  answer?: string
  createdAt: number
  /** Pictures Claude attached, side by side (`grid`) or one at a time (`slides`). */
  media?: HcpMedia[]
  layout?: 'grid' | 'slides'
  /** The slide on show. */
  slide?: number
  /**
   * Ask: the recommendation, held back until the person picks. `stakes`: the
   * choice is hard to undo or reaches others; `probe`: a sampled low-stakes card,
   * so the ledger can compare picks with and without the default.
   */
  blind?: 'stakes' | 'probe'
  recommended?: string[]
  /** Reach: when Send was first pressed on a call that notifies people; a second press sends. */
  armedAt?: number
  /** The person's note on a slide, by its index. */
  slideNotes?: Record<string, string>
}

export type HcpScheduled = {
  id: string
  /** `prompt` submits `text` to Claude; `remind` only nudges the person. */
  kind: 'prompt' | 'remind'
  text: string
  dueAt: number
  cardId?: string
}

/** Standing approval for calls like one the person sent, on one channel, to one audience. */
export type HcpGrant = {
  id: string
  channel: string
  audience: string[]
  /** A model's one line on what kind of message it covers; the example's start until written. */
  intent: string
  /** The approved call's content, redacted and clipped. */
  example: string
  cardId: string
  createdAt: number
  expiresAt: number
  uses: number
}

/** A call that left the machine this session, or was held: the pane's ledger and the row badge. */
export type HcpOutward = {
  toolUseId: string
  at: number
  tool: string
  channel: string
  audience: string[]
  /** Absent when nothing could tell. */
  level?: ReachLevel
  verdict: 'pass' | 'badge' | 'grant' | 'hold' | 'approved'
  why: string
  grantId?: string
  cardId?: string
  /** Which judge answered: `jev`, `haiku`, `rules`, `none`. */
  judgedBy?: string
}

/**
 * Send on a reach card: this exact call may run once, until `expiresAt`. An
 * edited send approves the person's text instead: a call on the same channel,
 * to no one new, whose content is that text.
 */
export type HcpApproval = { callKey: string; cardId: string; expiresAt: number; content?: string; channel?: string; audience?: string[] }

/**
 * A decision Claude made or asked about: the surface pipeline's input, and a
 * precedent for the next one once the person's answer says how it went.
 */
export type HcpDecision = {
  /** The ask card's id, or `d<n>` for one Claude recorded with mcp__hcp__decided. */
  id: string
  source: 'ask' | 'decided'
  /** Claude's slug for the sort of choice: `env-choice`, `library`, `scope`. */
  kind: string
  title: string
  /** Claude's pick: the recommended option on an ask, the choice made on a decided. */
  choice?: string
  alternatives: string[]
  why?: string
  reversible?: boolean
  /** Who the choice reaches, when Claude said: `shared` or `notifies` always asks, whatever the record says. */
  reach?: ReachLevel
  /** Asked with the recommendation hidden (see HcpCard.blind). */
  blind?: 'stakes' | 'probe'
  /** The working directory's last segment. */
  repo?: string
  session: string
  at: number
  /**
   * `took`: the person kept Claude's pick; `overrode`: picked another; `no-pick`: answered with a note
   * only; `agreed` / `disagreed`: on a recorded decision; `dismissed`, `pending`: nothing telling yet.
   */
  outcome: 'pending' | 'took' | 'overrode' | 'no-pick' | 'dismissed' | 'agreed' | 'disagreed'
  picked?: string
  /** Milliseconds from the card appearing to the person's answer: near-instant answers may be rubber stamps. */
  answeredMs?: number
  /** A Fine later turned into a Disagree: an error the first review let through. */
  reversedFrom?: 'agreed'
  /** The person's replacement for Claude's choice, from Change on a decided card. */
  change?: string
  /**
   * What each surface pipeline would have done, by pipeline id: the champion and
   * any challenger. `wanted`: the pipeline's own verdict when the floor overrode it.
   */
  shadow?: Record<string, { verdict: string; reason: string; runId?: string; wanted?: string }>
}

export type HcpMode = 'pairing' | 'heads-down' | 'away'

declare module 'claude-code' {
  interface PluginState {
    hcp: {
      cards: HcpCard[]
      queue: HcpScheduled[]
      mode: HcpMode
      isConcise: boolean
      seq: number
      /** Bumped after each quick message, so its field draws empty again. */
      quickSent: number
      /** The card j/k moved to: its buttons carry the hotkeys. Empty: the first open one. */
      active: string
      /** Pictures the person attached, sent with their next quick message. */
      outbox: HcpMedia[]
      /** Pictures the person pasted into the prompt box, newest first, drawn in the pane. */
      fromYou: HcpMedia[]
      grants: HcpGrant[]
      outward: HcpOutward[]
      approvals: HcpApproval[]
      /** This session's decisions; earlier sessions' are read from the ledger. */
      decisions: HcpDecision[]
    }
  }
}
