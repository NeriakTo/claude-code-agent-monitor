// Custom cards: the JSON a configured command prints, checked before it is drawn.
import type { CustomMark, CustomView } from '../types'
import { oneLine } from './dispatch'
import { cut } from './logic'

const MARKS: readonly CustomMark[] = ['running', 'stalled', 'done', 'failed', 'idle', 'waiting', 'warn']
export const CUSTOM_ITEM_LIMIT = 30

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, n: number): string => (typeof v === 'string' ? cut(v.replace(/\s+/g, ' ').trim(), n) : '')

/** The card a command's stdout describes, or the one-line reason it does not describe one. */
export const parseCustomOutput = (stdout: string): Pick<CustomView, 'summary' | 'badge' | 'items' | 'empty' | 'groups'> | string => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return 'output is not JSON'
  }
  if (!isRecord(raw)) return 'output is not a JSON object'
  if (raw['items'] !== undefined && !Array.isArray(raw['items'])) return 'items is not a list'
  const items = (Array.isArray(raw['items']) ? raw['items'] : []).filter(isRecord).slice(0, CUSTOM_ITEM_LIMIT)
  const groups: NonNullable<CustomView['groups']> = Object.create(null)
  if (isRecord(raw['groups'])) {
    for (const [name, decoration] of Object.entries(raw['groups'])) {
      const group = text(name, 40)
      if (group === '' || !isRecord(decoration)) continue
      const mark = MARKS.includes(decoration['mark'] as CustomMark) ? decoration['mark'] as CustomMark : undefined
      const right = typeof decoration['right'] === 'string' ? [...decoration['right'].replace(/\s+/g, ' ').trim()].slice(0, 12).join('') : undefined
      if (mark !== undefined || right !== undefined) groups[group] = { ...(mark === undefined ? {} : { mark }), ...(right === undefined ? {} : { right }) }
    }
  }
  return {
    ...(Object.keys(groups).length === 0 ? {} : { groups }),
    summary: text(raw['summary'], 80),
    badge: text(raw['badge'], 30),
    empty: text(raw['empty'], 60) || 'nothing to show',
    items: items.map(item => {
      const group = text(item['group'], 40)
      return {
        mark: MARKS.includes(item['mark'] as CustomMark) ? (item['mark'] as CustomMark) : 'idle',
        text: text(item['text'], 80),
        right: text(item['right'], 12),
        // Optional: items that name a group are listed under a heading per group.
        ...(group === '' ? {} : { group }),
      }
    }),
  }
}

/** A custom card after one run of its command: its JSON, or the one-line reason it gave none. */
export const customFromRun = (base: CustomView, ran: { exitCode: number; stdout: string; stderr: string }): CustomView => {
  if (ran.exitCode !== 0) return { ...base, error: `exit code ${ran.exitCode}: ${oneLine(ran.stderr || ran.stdout)}` }
  const parsed = parseCustomOutput(ran.stdout)
  return typeof parsed === 'string' ? { ...base, error: parsed } : { ...base, ...parsed }
}

export const emptyCustom = (card: { id: string; title: string }): CustomView => ({
  ...card,
  summary: '',
  badge: '',
  items: [],
  empty: '',
  error: null,
  fetchedAt: null,
})
