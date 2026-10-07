/** One channel message waiting for a reply. */
export type Pending = {
  key: string
  /** The channel server's name, as the delivery names it (e.g. plugin:discord:discord). */
  server: string
  /** The chat inside that server; '' when the message carries none. */
  chatId: string
  at: number
  isAlerted: boolean
}

/** One tool call in flight. */
export type Action = { id: string; tool: string; label: string; startedAt: number }

/** The last context measurement, and whether this crossing of the warning line was announced. */
export type ContextMark = { percent: number | null; isAlerted: boolean }

export type DispatchState = 'running' | 'stalled' | 'done' | 'failed' | 'cancelled' | 'rejected'

/** One external dispatch, paired from its events. */
export type DispatchRow = {
  runtime: string
  id: string
  startedAt: number | null
  endedAt: number | null
  /** The last start or heartbeat event. */
  lastSeenAt: number | null
  state: DispatchState
  summary: string
}

export type DispatchView = { rows: DispatchRow[]; error: string | null; fetchedAt: number | null }

/** One subagent of this session. */
export type AgentRun = {
  id: string
  description: string
  startedAt: number
  endedAt: number | null
  isBackground: boolean
  /** A background agent's id (from an async_launched result), matched against $.agent.list(). */
  agentId: string | null
  status: string | null
  /** Already added to the recent list (background agents end after their call does). */
  isRecorded?: boolean
}

export type CustomMark = 'running' | 'stalled' | 'done' | 'failed' | 'idle' | 'waiting' | 'warn'

/** One custom card's last read: the command's JSON, or why it could not be read. */
export type CustomView = {
  id: string
  title: string
  summary: string
  /** `group`: optional heading the item is listed under; items without one are not grouped. */
  items: { mark: CustomMark; text: string; right: string; group?: string }[]
  empty: string
  error: string | null
  fetchedAt: number | null
}

/** One rate-limit window: Claude's own, or a row of the quotaCommand's JSON. */
export type QuotaRow = {
  name: string
  /** 0 to 100 (more past an exceeded limit); null when the source has no reading. */
  usedPercent: number | null
  resetsAt: number | null
  /** When the source read the figure; null when unknown. */
  fetchedAt: number | null
  /** The source's own polling period; the row is called stale past twice this. Null: never stale. */
  maxAgeMs: number | null
}

/** Claude's windows ($.session.usage) and the quotaCommand's rows, kept apart so one failing never hides the other. */
export type QuotaView = {
  claude: QuotaRow[]
  external: QuotaRow[]
  /** Why the quotaCommand could not be read; null when it was (or is not set). */
  error: string | null
  fetchedAt: number | null
}

/** A tool call or subagent that ended, kept for the RUNNING card's recent list. */
export type RecentRun = {
  id: string
  label: string
  startedAt: number
  endedAt: number
  status: 'done' | 'failed' | 'cancelled'
}

/** Where a card is shown: in the pane, as a segment of the band. Hidden cards are listed in `hidden`. */
export type Placement = 'pane' | 'band'

/** What the SESSION card shows. */
export type SessionInfo = {
  startedAt: number | null
  wakeAt: number | null
  wakeText: string
  compactCount: number
  compactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': {
      pending: Pending[]
      seen: string[]
      lastReplyAt: number | null
      actions: Action[]
      tick: number
      context: ContextMark
      dispatch: DispatchView
      agents: AgentRun[]
      custom: CustomView[]
      session: SessionInfo
      /** Card id -> expanded; mirrored to $.store so it survives sessions. */
      expanded: Record<string, boolean>
      /** Card ids hidden with /monitor hide; mirrored to $.store. */
      hidden: string[]
      /** Card id -> most items listed when expanded (/monitor rows); mirrored to $.store. */
      rows: Record<string, number>
      quota: QuotaView
      /** Ended tool calls and subagents, newest first; mirrored to $.store so a reload keeps them. */
      recent: RecentRun[]
      /** Card ids in the order the person arranged them; mirrored to $.store. */
      order: string[]
      /** Card id -> pane or band; mirrored to $.store. */
      placement: Record<string, Placement>
      /** Whether the pane is in arrange mode (session only). */
      arranging: boolean
      /** The card whose arrange buttons take the u/d/b/h keys: the one the focus ring is on. */
      selected: string | null
      /** Whether the footer lists the hidden cards, each with its own Show button. */
      revealHidden: boolean
    }
  }
}
