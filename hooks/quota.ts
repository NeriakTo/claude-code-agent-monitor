// Quota rows: Claude's own rate-limit windows ($.session.usage) and the quotaCommand's JSON,
// checked before they are drawn. Nothing here touches $.
import type { QuotaRow, QuotaView } from '../types'
import { oneLine } from './dispatch'
import { cut } from './logic'

/** The windows Claude Code reports, by kind; any other kind is shown as `Claude <kind>`. */
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  five_hour: 'Claude 5h',
  seven_day: 'Claude week',
}

export type RateLimitLike = { kind: string; percentUsed: number; resetsAt?: string }

/** Claude's rows from `$.session.usage().rateLimits` (or a session.measure), read at `now`. */
export const claudeRows = (limits: readonly RateLimitLike[], now: number): QuotaRow[] =>
  limits
    .filter(l => typeof l.kind === 'string' && typeof l.percentUsed === 'number' && Number.isFinite(l.percentUsed))
    .map(l => {
      const reset = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
      return {
        name: CLAUDE_NAMES[l.kind] ?? cut(`Claude ${l.kind.replace(/_/g, ' ')}`, 20),
        usedPercent: l.percentUsed,
        resetsAt: Number.isNaN(reset) ? null : reset,
        fetchedAt: now,
        // Pushed by the engine whenever a window moves, so never called stale.
        maxAgeMs: null,
      }
    })

export const QUOTA_ROW_LIMIT = 12

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const time = (v: unknown): number | null | 'bad' => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return 'bad'
  const t = Date.parse(v)
  return Number.isNaN(t) ? 'bad' : t
}

/**
 * The rows a quotaCommand prints: a JSON object `{ "rows": [...] }` or a bare list. Each row needs a
 * `name`; `usedPercent` is a number or null (no reading); `resetsAt` and `fetchedAt` are ISO times or
 * empty; `maxAgeSeconds` is optional. One bad row fails the read with its reason, rather than
 * showing half of what the command meant.
 */
export const parseQuotaOutput = (stdout: string): QuotaRow[] | string => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return 'output is not JSON'
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw['rows'] : undefined
  if (!Array.isArray(list)) return 'output has no rows list'
  const rows: QuotaRow[] = []
  for (const [i, row] of list.slice(0, QUOTA_ROW_LIMIT).entries()) {
    if (!isRecord(row) || typeof row['name'] !== 'string' || row['name'].trim() === '') return `row ${i + 1} has no name`
    const used = row['usedPercent']
    if (used !== null && used !== undefined && (typeof used !== 'number' || !Number.isFinite(used))) {
      return `row ${i + 1} usedPercent is not a number`
    }
    const resetsAt = time(row['resetsAt'])
    const fetchedAt = time(row['fetchedAt'])
    if (resetsAt === 'bad') return `row ${i + 1} resetsAt is not an ISO time`
    if (fetchedAt === 'bad') return `row ${i + 1} fetchedAt is not an ISO time`
    const maxAge = row['maxAgeSeconds']
    rows.push({
      name: cut(row['name'].replace(/\s+/g, ' ').trim(), 20),
      usedPercent: typeof used === 'number' ? Math.max(0, used) : null,
      resetsAt,
      fetchedAt,
      maxAgeMs: typeof maxAge === 'number' && Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : null,
    })
  }
  return rows
}

export type CommandRun = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }

/** What one run of the quotaCommand gives: its rows, or the one-line reason it gave none. */
export const quotaFromRun = (ran: CommandRun): Pick<QuotaView, 'external' | 'error'> | { error: string } => {
  if (ran.exitCode !== 0) return { error: `exit code ${ran.exitCode}: ${oneLine(ran.stderr || ran.stdout)}` }
  if (ran.isStdoutTruncated) return { error: 'output too large, cut off' }
  const parsed = parseQuotaOutput(ran.stdout)
  return typeof parsed === 'string' ? { error: parsed } : { external: parsed, error: null }
}

/** A 10-cell gauge: filled cells rounded to the nearest tenth, clamped to the gauge. */
export const GAUGE_CELLS = 10
export const gauge = (percent: number): { filled: string; empty: string } => {
  const n = Math.min(GAUGE_CELLS, Math.max(0, Math.round(percent / 10)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(GAUGE_CELLS - n) }
}

const DAY = 24 * 60 * 60_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const parts = (ms: number, timeZone: string): { hm: string; md: string; weekday: string } => {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      timeZone: timeZone || 'UTC',
    }).formatToParts(new Date(ms))
    const get = (type: string): string => f.find(p => p.type === type)?.value ?? ''
    const hour = get('hour') === '24' ? '00' : get('hour')
    return { hm: `${hour}:${get('minute')}`, md: `${get('month')}/${get('day')}`, weekday: get('weekday') }
  } catch {
    const d = new Date(ms)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return {
      hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
      md: `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`,
      weekday: WEEKDAYS[d.getUTCDay()] ?? '',
    }
  }
}

/** When a window resets: `17:10` within a day, `Thu 16:00` within a week, `10/14` after that. */
export const resetText = (resetsAt: number | null, now: number, timeZone: string): string => {
  if (resetsAt === null) return ''
  const p = parts(resetsAt, timeZone)
  const ahead = resetsAt - now
  if (ahead < DAY) return p.hm
  if (ahead < 7 * DAY) return `${p.weekday} ${p.hm}`
  return p.md
}
