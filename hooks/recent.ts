// RUNNING's recent list, the pure part: what is worth keeping, reading it back from the store, and
// which background subagents just ended. Nothing here touches $.
import type { AgentRun, RecentRun } from '../types'

/** A run shorter than this is not worth keeping under recent. */
export const RECENT_MIN_MS = 10_000
/** Ended runs kept in the store; the card lists recentRows of them. */
export const RECENT_KEEP = 30
/** The tools whose ended calls are kept: Bash commands and subagents. */
export const RECORDED_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Bash'])

export const isRecentRun = (v: unknown): v is RecentRun => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['label'] === 'string' &&
    typeof r['startedAt'] === 'number' &&
    typeof r['endedAt'] === 'number' &&
    (r['status'] === 'done' || r['status'] === 'failed' || r['status'] === 'cancelled')
  )
}

/** The list with `run` first (replacing an older entry of the same id), capped at RECENT_KEEP. */
export const addRecent = (list: readonly RecentRun[], run: RecentRun): RecentRun[] =>
  [run, ...list.filter(one => one.id !== run.id)].slice(0, RECENT_KEEP)

const END_STATUS: Readonly<Record<string, RecentRun['status']>> = { completed: 'done', failed: 'failed', killed: 'cancelled' }

/**
 * Background subagents end after their call does: those $.agent.list() now reports ended are marked
 * recorded, and the ones that ran at least RECENT_MIN_MS are returned to join recent, ended at `now`.
 */
export const endedAgents = (
  runs: readonly AgentRun[],
  now: number,
  label: (run: AgentRun) => string,
): { runs: AgentRun[]; ended: RecentRun[] } => {
  const ended: RecentRun[] = []
  const next = runs.map(run => {
    const status = run.status === null ? undefined : END_STATUS[run.status]
    if (!run.isBackground || run.isRecorded === true || status === undefined) return run
    if (now - run.startedAt >= RECENT_MIN_MS) ended.push({ id: run.id, label: label(run), startedAt: run.startedAt, endedAt: now, status })
    return { ...run, isRecorded: true }
  })
  return { runs: next, ended }
}

/** The stored recent list, keeping only well-formed runs; null when the store holds something else. */
export const storedRecent = (v: unknown): RecentRun[] | null => (Array.isArray(v) ? v.filter(isRecentRun).slice(0, RECENT_KEEP) : null)
