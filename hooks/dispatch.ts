// External dispatches: the configured command's argv, its JSONL events, and pairing them by dispatch_id.
import type { DispatchRow, DispatchState, DispatchView } from '../types'
import type { Config } from './config'
import { MINUTE, cut, runtimeLabel } from './logic'

export const WINDOW_MS = 24 * 60 * MINUTE
/** Dispatches send a heartbeat every 30 s; this long without one and with no end event is stalled. */
export const STALLED_AFTER_MS = 3 * MINUTE
export const ENDED_LIMIT = 8
export const SINCE_TOKEN = '{since24h}'

/** RFC3339 without milliseconds. */
export const toRfc3339 = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The configured command with {since24h} filled in; empty when no command is set. */
export const dispatchArgv = (cfg: Config, now: number): string[] =>
  cfg.dispatchArgv.map(arg => arg.split(SINCE_TOKEN).join(toRfc3339(now - WINDOW_MS)))

export type DispatchEvent = { type: string; at: number; payload: Readonly<Record<string, unknown>> }

export type Parsed = { events: DispatchEvent[]; error: string | null }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One JSON object per line; any bad line fails the whole read rather than pairing half of it. */
export const parseJsonl = (stdout: string): Parsed => {
  const events: DispatchEvent[] = []
  const lines = stdout.split('\n').filter(line => line.trim() !== '')
  for (const [i, line] of lines.entries()) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      return { events: [], error: `line ${i + 1} is not JSON` }
    }
    if (!isRecord(row) || typeof row['event_type'] !== 'string' || !isRecord(row['payload'])) {
      return { events: [], error: `line ${i + 1} has no event_type or payload` }
    }
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : NaN
    if (Number.isNaN(at)) return { events: [], error: `line ${i + 1} has no readable timestamp` }
    events.push({ type: row['event_type'], at, payload: row['payload'] })
  }
  return { events, error: null }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** runtime_id through runtimeNames, else runtime_id, else runtime. */
export const runtimeOf = (cfg: Config, payload: Readonly<Record<string, unknown>>): string => {
  const id = str(payload['runtime_id'])
  const name = str(payload['runtime'])
  if (id) return runtimeLabel(cfg, id)
  return name ? runtimeLabel(cfg, name) : 'unknown'
}

const END_STATE: Readonly<Record<string, DispatchState>> = {
  DispatchCompleted: 'done',
  DispatchFailed: 'failed',
  DispatchCancelled: 'cancelled',
  DispatchRejected: 'rejected',
}

const SUMMARY_KEYS = ['prompt_summary', 'summary', 'title', 'task_name', 'task', 'task_id'] as const

export const summaryOf = (payload: Readonly<Record<string, unknown>>): string => {
  for (const key of SUMMARY_KEYS) {
    const v = str(payload[key]).replace(/\s+/g, ' ').trim()
    if (v) return cut(v, 30)
  }
  return ''
}

/**
 * Pairs events by payload.dispatch_id. Open ones whose last start or heartbeat is older than
 * STALLED_AFTER_MS are stalled. Order: running (newest first), stalled (newest first), then the
 * ENDED_LIMIT most recently ended.
 */
export const pairDispatches = (cfg: Config, events: readonly DispatchEvent[], now: number): DispatchRow[] => {
  type Pair = { start?: DispatchEvent; end?: DispatchEvent; beat?: DispatchEvent }
  const pairs = new Map<string, Pair>()
  for (const ev of events) {
    const id = str(ev.payload['dispatch_id'])
    if (!id) continue
    const pair = pairs.get(id) ?? {}
    if (ev.type === 'DispatchStarted') pair.start = pair.start ?? ev
    else if (ev.type === 'DispatchHeartbeat') pair.beat = pair.beat && pair.beat.at >= ev.at ? pair.beat : ev
    else if (END_STATE[ev.type] !== undefined) pair.end = pair.end && pair.end.at >= ev.at ? pair.end : ev
    pairs.set(id, pair)
  }
  const rows: DispatchRow[] = []
  for (const [id, pair] of pairs) {
    const source = pair.start ?? pair.end ?? pair.beat
    if (source === undefined) continue
    const seen = [pair.start?.at, pair.beat?.at].filter((t): t is number => t !== undefined)
    const lastSeenAt = seen.length > 0 ? Math.max(...seen) : null
    const open: DispatchState = lastSeenAt !== null && now - lastSeenAt <= STALLED_AFTER_MS ? 'running' : 'stalled'
    rows.push({
      runtime: runtimeOf(cfg, pair.start?.payload ?? source.payload),
      id: id.slice(0, 8),
      startedAt: pair.start?.at ?? null,
      endedAt: pair.end?.at ?? null,
      lastSeenAt,
      state: pair.end ? (END_STATE[pair.end.type] ?? 'done') : open,
      summary: summaryOf(pair.start?.payload ?? source.payload),
    })
  }
  const byStart = (a: DispatchRow, b: DispatchRow): number =>
    (b.startedAt ?? b.lastSeenAt ?? 0) - (a.startedAt ?? a.lastSeenAt ?? 0)
  const running = rows.filter(r => r.state === 'running').sort(byStart)
  const stalled = rows.filter(r => r.state === 'stalled').sort(byStart)
  const ended = rows
    .filter(r => r.state !== 'running' && r.state !== 'stalled')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, ENDED_LIMIT)
  return [...running, ...stalled, ...ended]
}

/** What one run of the dispatch command gives: the paired rows, or the one-line reason it gave none. */
export const dispatchFromRun = (
  cfg: Config,
  ran: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean },
  now: number,
): DispatchView => {
  if (ran.exitCode !== 0) return { rows: [], error: `exit code ${ran.exitCode}: ${oneLine(ran.stderr || ran.stdout)}`, fetchedAt: now }
  if (ran.isStdoutTruncated) return { rows: [], error: 'output too large, cut off', fetchedAt: now }
  const parsed = parseJsonl(ran.stdout)
  if (parsed.error !== null) return { rows: [], error: parsed.error, fetchedAt: now }
  return { rows: pairDispatches(cfg, parsed.events, now), error: null, fetchedAt: now }
}

/** First non-empty line of an error, kept short. */
export const oneLine = (s: string): string =>
  cut(
    (s.split('\n').find(l => l.trim() !== '')?.trim() ?? 'unknown error').replace(/^(?:[\w-]+: )?\$\.[\w.]+: /, ''),
    60,
  )
