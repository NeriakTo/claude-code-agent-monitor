// One model, two views: buildModel computes every figure and threshold once; the band and the
// pane (view.ts) only lay it out, so the two always agree.
import type {
  Action,
  AgentRun,
  ContextMark,
  CustomView,
  DispatchRow,
  DispatchView,
  Pending,
  QuotaRow,
  QuotaView,
  RecentRun,
  SessionInfo,
} from '../types'
import type { Config } from './config'
import { channelLabel } from './logic'

export type Level = 'normal' | 'warning' | 'error'

/** The status words both views show; their symbol and color come from one table (view.ts statusMark). */
export type Status = 'running' | 'stalled' | 'done' | 'failed' | 'cancelled' | 'rejected' | 'idle'

export type InboxGroup = { label: string; count: number; waitedMs: number; level: Level }

/** A quota row with its level (from the quota thresholds) and whether its reading is stale. */
export type QuotaLine = QuotaRow & { level: Level; isStale: boolean; ageMs: number | null }

export type QuotaModel = {
  /** Whether there is a QUOTA card: a quotaCommand is set, or Claude reports its windows. */
  isEnabled: boolean
  rows: QuotaLine[]
  /** The fresh row with the highest use; null when no fresh row has a reading. */
  tightest: QuotaLine | null
  error: string | null
}

export type Model = {
  now: number
  inbox: { total: number; groups: InboxGroup[]; level: Level }
  lastReplyAgoMs: number | null
  /** Tool calls in flight plus background subagents still running, oldest first. */
  actions: { label: string; elapsedMs: number; level: Level }[]
  context: { percent: number; level: Level; warn: number; critical: number } | null
  subagents: { status: Status; startedAt: number; elapsedMs: number; description: string }[]
  dispatches: {
    isEnabled: boolean
    error: string | null
    fetchedAt: number | null
    rows: (DispatchRow & { status: Status; ageMs: number })[]
  }
  custom: readonly CustomView[]
  session: SessionInfo
  quota: QuotaModel
  /** Ended runs, newest first, with how long they took. */
  recent: (RecentRun & { elapsedMs: number })[]
}

export type ModelInput = {
  pending: readonly Pending[]
  lastReplyAt: number | null
  actions: readonly Action[]
  context: ContextMark
  agents: readonly AgentRun[]
  dispatch: DispatchView
  custom: readonly CustomView[]
  session: SessionInfo
  quota?: QuotaView
  recent?: readonly RecentRun[]
}

const worst = (levels: readonly Level[]): Level =>
  levels.includes('error') ? 'error' : levels.includes('warning') ? 'warning' : 'normal'

const AGENT_STATUS: Readonly<Record<string, Status>> = {
  pending: 'idle',
  running: 'running',
  waiting: 'idle',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'cancelled',
  remote: 'running',
}

const agentStatus = (run: AgentRun): Status => {
  if (run.status !== null) return AGENT_STATUS[run.status] ?? 'running'
  return run.endedAt === null || run.isBackground ? 'running' : 'done'
}

const EMPTY_QUOTA: QuotaView = { claude: [], external: [], error: null, fetchedAt: null }

/** Levels by the quota thresholds; a row past twice its source's polling period is stale. */
export const quotaModel = (view: QuotaView, now: number, cfg: Config): QuotaModel => {
  const rows: QuotaLine[] = [...view.claude, ...view.external].map(row => {
    const ageMs = row.fetchedAt === null ? null : Math.max(0, now - row.fetchedAt)
    const isStale = row.maxAgeMs !== null && (ageMs === null || ageMs > 2 * row.maxAgeMs)
    const p = row.usedPercent
    const level: Level = p === null ? 'normal' : p >= cfg.quotaCritical ? 'error' : p >= cfg.quotaWarn ? 'warning' : 'normal'
    return { ...row, level, isStale, ageMs }
  })
  const fresh = rows.filter(r => r.usedPercent !== null && !r.isStale)
  const tightest = fresh.reduce<QuotaLine | null>((top, r) => (top === null || (r.usedPercent ?? 0) > (top.usedPercent ?? 0) ? r : top), null)
  return { isEnabled: cfg.quotaArgv.length > 0 || view.claude.length > 0, rows, tightest, error: view.error }
}

export const buildModel = (input: ModelInput, now: number, cfg: Config): Model => {
  const groups = new Map<string, InboxGroup>()
  for (const p of input.pending) {
    const label = channelLabel(cfg, p.server, p.chatId)
    const waitedMs = Math.max(0, now - p.at)
    const level: Level = waitedMs >= cfg.waitingAlertMs ? 'warning' : 'normal'
    const prev = groups.get(label)
    groups.set(
      label,
      prev === undefined
        ? { label, count: 1, waitedMs, level }
        : { label, count: prev.count + 1, waitedMs: Math.max(prev.waitedMs, waitedMs), level: worst([prev.level, level]) },
    )
  }
  const inboxGroups = [...groups.values()].sort((a, b) => b.waitedMs - a.waitedMs)

  const background = input.agents
    .filter(run => run.isBackground && run.endedAt !== null && run.status === 'running')
    .map(run => ({ label: `agent ${run.description}`, startedAt: run.startedAt }))
  const actions = [...input.actions, ...background]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(a => {
      const elapsedMs = Math.max(0, now - a.startedAt)
      return { label: a.label, elapsedMs, level: (elapsedMs >= cfg.longActionMs ? 'warning' : 'normal') as Level }
    })

  const percent = input.context.percent
  const context =
    percent === null
      ? null
      : {
          percent: Math.round(percent),
          level: (percent >= cfg.contextCritical ? 'error' : percent >= cfg.contextWarn ? 'warning' : 'normal') as Level,
          warn: cfg.contextWarn,
          critical: cfg.contextCritical,
        }

  const subagents = input.agents.slice(-10).map(run => {
    const status = agentStatus(run)
    const end = status === 'running' || status === 'idle' ? now : (run.endedAt ?? now)
    return { status, startedAt: run.startedAt, elapsedMs: Math.max(0, end - run.startedAt), description: run.description }
  })

  return {
    now,
    inbox: { total: input.pending.length, groups: inboxGroups, level: worst(inboxGroups.map(g => g.level)) },
    lastReplyAgoMs: input.lastReplyAt === null ? null : Math.max(0, now - input.lastReplyAt),
    actions,
    context,
    subagents,
    dispatches: {
      isEnabled: cfg.dispatchArgv.length > 0,
      error: input.dispatch.error,
      fetchedAt: input.dispatch.fetchedAt,
      rows: input.dispatch.rows.map(row => {
        const start = row.startedAt ?? row.lastSeenAt ?? now
        const end = row.state === 'running' || row.state === 'stalled' ? now : (row.endedAt ?? now)
        return { ...row, status: row.state, ageMs: Math.max(0, end - start) }
      }),
    },
    custom: input.custom,
    session: input.session,
    quota: quotaModel(input.quota ?? EMPTY_QUOTA, now, cfg),
    recent: (input.recent ?? []).map(r => ({ ...r, elapsedMs: Math.max(0, r.endedAt - r.startedAt) })),
  }
}
