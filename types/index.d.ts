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

export type HcpCard = {
  /** `c<n>` for asks and shares, `h<n>` for handoffs; what Claude refers to. */
  id: string
  kind: 'ask' | 'handoff' | 'share'
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
    }
  }
}
