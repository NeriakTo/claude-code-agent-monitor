// Custom cards: the JSON a configured command prints, checked before it is drawn.
import type { CustomMark, CustomView } from '../types'
import { cut } from './logic'

const MARKS: readonly CustomMark[] = ['running', 'stalled', 'done', 'failed', 'idle', 'waiting', 'warn']
export const CUSTOM_ITEM_LIMIT = 30

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, n: number): string => (typeof v === 'string' ? cut(v.replace(/\s+/g, ' ').trim(), n) : '')

/** The card a command's stdout describes, or the one-line reason it does not describe one. */
export const parseCustomOutput = (stdout: string): Pick<CustomView, 'summary' | 'items' | 'empty'> | string => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return 'output is not JSON'
  }
  if (!isRecord(raw)) return 'output is not a JSON object'
  if (raw['items'] !== undefined && !Array.isArray(raw['items'])) return 'items is not a list'
  const items = (Array.isArray(raw['items']) ? raw['items'] : []).filter(isRecord).slice(0, CUSTOM_ITEM_LIMIT)
  return {
    summary: text(raw['summary'], 80),
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

export const emptyCustom = (card: { id: string; title: string }): CustomView => ({
  ...card,
  summary: '',
  items: [],
  empty: '',
  error: null,
  fetchedAt: null,
})
