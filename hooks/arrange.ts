// Arranging cards, the pure part: which cards exist, how a move reorders them, which card an
// arrange button belongs to, and reading saved values back from the store. Nothing here touches $.
import type { Placement } from '../types'
import type { Config } from './config'

/** Every card id this configuration draws, in default pane order; QUOTA only when there is quota data. */
export const cardIds = (cfg: Config, hasQuota = cfg.quotaArgv.length > 0): string[] => [
  ...(hasQuota ? ['quota'] : []),
  'inbox',
  'running',
  ...(cfg.dispatchArgv.length > 0 ? ['dispatches'] : []),
  ...cfg.customCards.map(c => c.id),
  'session',
]

/** The full order after moving `id` one place up (-1) or down (1) among the cards not hidden; null when it cannot move. */
export const movedOrder = (full: readonly string[], hidden: readonly string[], id: string, by: -1 | 1): string[] | null => {
  const visible = full.filter(one => !hidden.includes(one))
  const at = visible.indexOf(id)
  const other = visible[at + by]
  if (at === -1 || other === undefined) return null
  return full.map(one => (one === id ? other : one === other ? id : one))
}

/** The card an arrange button belongs to, from its key (`up:quota`); null for any other element. */
export const cardOfKey = (key: string | undefined): string | null => /^(?:up|down|place|hide):(.+)$/s.exec(key ?? '')?.[1] ?? null

/** A stored list of ids, or null when the store holds something else. */
export const storedIds = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)

/** A stored placement map, keeping only pane and band entries; null when the store holds something else. */
export const storedPlacement = (v: unknown): Record<string, Placement> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter((kv): kv is [string, Placement] => kv[1] === 'band' || kv[1] === 'pane'))
    : null

/** /monitor's argument hint: every subcommand and every card id this configuration has. */
export const monitorHint = (cfg: Config): string =>
  `[expand|collapse <card|all> · hide <card> · show <card|all> · rows <card> <1-30|default>] cards: ${cardIds(cfg).join(', ')}${
    cfg.quotaArgv.length > 0 ? '' : ' (quota once Claude reports its limits)'
  }`

/** /monitor's words: the verb, the card name (it may hold spaces) and, for rows, the number (the last word). */
export const parseMonitorArgs = (args: string): { verb: string; which: string; value: string | undefined } => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const value = verb === 'rows' && rest.length > 1 ? rest.pop() : undefined
  return { verb, which: rest.join(' ') || 'all', value }
}

/** /monitor rows: the new per-card limits and the answer line, or why the value is refused. */
export const rowsAfter = (
  map: Readonly<Record<string, number>>,
  target: readonly string[],
  value: string | undefined,
): { next: Record<string, number>; text: string } | { error: string } => {
  const n = Number(value)
  if (value !== 'default' && !(Number.isInteger(n) && n >= 1 && n <= 30)) return { error: 'Rows takes a whole number from 1 to 30, or default.' }
  const merged = { ...map, ...Object.fromEntries(target.map(id => [id, n])) }
  const next = Object.fromEntries(Object.entries(merged).filter(([id]) => !(value === 'default' && target.includes(id))))
  return { next, text: value === 'default' ? `Rows back to default: ${target.join(', ')}.` : `Rows set to ${n}: ${target.join(', ')}.` }
}
