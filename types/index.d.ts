export type HcpOption = { value: string; label: string; hint?: string }

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
  status: 'open' | 'answered' | 'dismissed'
  delivery?: HcpDelivery
  answer?: string
  createdAt: number
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
    }
  }
}
