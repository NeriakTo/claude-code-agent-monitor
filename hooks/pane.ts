// The /monitor pane: a header card and one round card per section, each with a collapsed
// summary and expanded detail. Built from the same Model and symbol table as the band.
import type { CustomMark, Placement } from '../types'
import { clockTime, cut, displayWidth, duration, truncateWidth } from './logic'
import type { Model, QuotaLine } from './model'
import { gauge, resetText } from './quota'
import {
  buttonRun,
  count,
  fitLine,
  levelMark,
  levelTone,
  percentText,
  quotaFlag,
  quotaTone,
  replyText,
  restartRun,
  spread,
  statusMark,
} from './view'
import type { Line, Run, Tone } from './view'

/**
 * `maxLines`: most detail lines shown when expanded; the rest fold into one `+N more` line.
 * `isPinned`: every line is always shown (QUOTA): no `+N more`, and never shortened to fit the height.
 */
export type Card = { id: string; title: string; badge: Line; summary: Line; lines: Line[]; maxLines?: number; isPinned?: boolean }
/**
 * `cards`: the pane's cards in the person's order. `footer`: the hidden-cards line (when some are
 * hidden), the updated line, and the hidden cards one by one when the person asked to see them.
 * `band`: cards placed on the band, as the band shows them. `arrange`: in arrange mode, one title
 * row per card with its move, place and hide buttons (the pane then shows those instead of cards).
 */
export type PaneDoc = {
  head: Line[]
  cards: Card[]
  footer: Line[]
  band: { id: string; title: string; summary: Line }[]
  arrange: Line[] | null
  /** Every card this configuration draws, hidden or placed anywhere (the status line's Subinfo reads one). */
  all: Card[]
}

/**
 * What the person set with /monitor and the arrange buttons: hidden cards, per-card item limits,
 * the card order and placement, and the pane's mode. All but the first three are optional.
 */
export type PaneOptions = {
  customMaxItems: number
  rows: Readonly<Record<string, number>>
  hidden: readonly string[]
  order?: readonly string[]
  placement?: Readonly<Record<string, Placement>>
  recentRows?: number
  isArranging?: boolean
  /** The card whose arrange buttons carry the u/d/b/h hotkeys. */
  selected?: string | null
  isHiddenRevealed?: boolean
}

/** The badge: a gray count, and a red `· N failed` when the card holds failed items. */
export const badgeOf = (n: number, failed: number, tone: Tone = 'muted'): Line =>
  n === 0 && failed === 0
    ? []
    : [
        { text: String(n), tone: n === 0 ? 'muted' : tone, bold: tone !== 'muted' },
        ...(failed > 0 ? [SEP, { text: `${failed} failed`, tone: 'critical' as Tone, bold: true }] : []),
      ]

/** Cells inside a card: the pane body less the round border (2) and padding (2). */
export const cardInner = (bodyColumns: number): number => Math.max(16, bodyColumns - 4)

const muted = (text: string): Line => [{ text, tone: 'muted' }]

const DISPATCH_COLS = { runtime: 11, id: 8, start: 5, age: 5 } as const
const RECENT_DEFAULT = 3
/** Stalled dispatches silent longer than this fold into one line. */
const STALE_FOLD_MS = 60 * 60_000

/** Fits the 5-cell AGE column: 1h43m, then whole hours (10h), then days (2d). */
export const ageText = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 600) return duration(ms)
  return m < 24 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / (24 * 60))}d`
}

const padTo = (s: string, n: number): string => {
  const t = truncateWidth(s, n)
  return t + ' '.repeat(Math.max(0, n - displayWidth(t)))
}

const SEP: Run = { text: ' · ', tone: 'muted' }

/** A custom item's mark: the status table, plus waiting (gray middle dot, like idle) and warn (yellow dot). */
export const customMark = (mark: CustomMark): Run =>
  mark === 'waiting' ? { text: '·', tone: 'muted' } : mark === 'warn' ? { text: '●', tone: 'warn' } : statusMark(mark)

/** The header card: title, the Arrange (or Done) button and clock, the overview, and the restart warning when there is one. */
/**
 * Arrange mode's help under the header: how changes are kept, how to pick a card, and, where the
 * buttons are shrunk to letters, what the letters mean.
 */
export const ARRANGE_HELP = {
  intro: 'Arrange: move, place or hide cards. Changes are kept.',
  saving: 'Each change is saved at once; Done only leaves.',
  picking: 'Pick a card: Tab or arrow keys, or click. Keys u d b h.',
  legend: '↑ ↓ move · B/P band or pane · H hide',
} as const

const headLines = (m: Model, inner: number, timeZone: string, isArranging: boolean, isCompact = false): Line[] => {
  const title = spread(
    [{ text: 'AGENT MONITOR', tone: 'accent', bold: true }],
    [buttonRun('arrange', isArranging ? 'Done' : 'Arrange'), { text: '  ', tone: 'plain' }, { text: clockTime(m.now, timeZone), tone: 'muted' }],
    inner,
  )
  if (isArranging) {
    const help = [ARRANGE_HELP.intro, ARRANGE_HELP.saving, ARRANGE_HELP.picking, ...(isCompact ? [ARRANGE_HELP.legend] : [])]
    return [title, ...help.map(text => fitLine(muted(text), inner))]
  }
  const runningAgents = m.subagents.filter(s => s.status === 'running').length
  const overview: Line = [
    { text: 'inbox ', tone: 'plain' },
    count(m.inbox.total, levelTone(m.inbox.level)),
    SEP,
    { text: 'now ', tone: 'plain' },
    count(m.actions.length, m.actions.some(a => a.level !== 'normal') ? 'warn' : 'ok'),
    SEP,
    { text: 'agents ', tone: 'plain' },
    count(runningAgents, 'ok'),
    SEP,
    { text: replyText(m.lastReplyAgoMs), tone: 'muted' },
  ]
  const restart = restartRun(m)
  return [
    title,
    fitLine(overview, inner),
    ...(restart === null ? [] : [[restart]]),
  ]
}

const timed = (mark: Run, label: string, right: Run, inner: number): Line =>
  spread([mark, { text: ` ${label}`, tone: 'plain' }], [right], inner)

const inboxCard = (m: Model, inner: number): Card => {
  const [oldest] = m.inbox.groups
  return {
    id: 'inbox',
    title: 'INBOX',
    badge: badgeOf(m.inbox.total, 0),
    summary:
      oldest === undefined
        ? muted('no messages waiting')
        : fitLine(
            [
              { text: `${m.inbox.total} waiting, oldest ${oldest.label} `, tone: 'plain' },
              { text: duration(oldest.waitedMs), tone: oldest.level === 'normal' ? 'plain' : levelTone(oldest.level) },
            ],
            inner,
          ),
    lines:
      oldest === undefined
        ? [muted('no messages waiting')]
        : m.inbox.groups.map(g =>
            timed(
              levelMark(g.level, false),
              `${g.label}${g.count > 1 ? ` x${g.count}` : ''}`,
              { text: duration(g.waitedMs), tone: g.level === 'normal' ? 'plain' : levelTone(g.level) },
              inner,
            ),
          ),
  }
}

/** The `─── recent ───` rule the RUNNING and DISPATCHES cards both draw above ended rows. */
const recentRule = (inner: number): Line => muted(`─── recent ${'─'.repeat(Math.max(0, inner - 11))}`)

const runningCard = (m: Model, inner: number, timeZone: string, recentRows: number): Card => {
  const [first] = m.actions
  const recent = m.recent.slice(0, recentRows)
  const active =
    first === undefined
      ? [muted('idle')]
      : m.actions.map(a =>
          timed(levelMark(a.level, false), a.label, { text: duration(a.elapsedMs), tone: a.level === 'normal' ? 'plain' : levelTone(a.level) }, inner),
        )
  const ended = recent.map(r =>
    timed(statusMark(r.status), r.label, { text: `${duration(r.elapsedMs)} · ${clockTime(r.endedAt, timeZone)}`, tone: 'muted' }, inner),
  )
  return {
    id: 'running',
    title: 'RUNNING',
    badge: [
      ...badgeOf(m.actions.length, 0),
      ...(recent.length === 0 ? [] : [...(m.actions.length > 0 ? [SEP] : []), { text: `${recent.length} recent`, tone: 'muted' as Tone }]),
    ],
    summary:
      first === undefined
        ? muted('idle')
        : fitLine(
            [
              { text: `${m.actions.length} running, longest ${first.label} `, tone: 'plain' },
              { text: duration(first.elapsedMs), tone: first.level === 'normal' ? 'plain' : levelTone(first.level) },
            ],
            inner,
          ),
    lines: [...active, ...(ended.length === 0 ? [] : [recentRule(inner), ...ended])],
  }
}

/** One quota row: name, a 10-cell gauge, the percent and its flag, the reset time, and how old a stale reading is. */
const quotaLine = (row: QuotaLine, inner: number, now: number, timeZone: string): Line => {
  // Below 60 cells the name column and the gaps narrow, so a stale row's age still fits.
  const isRoomy = inner >= 60
  const gap = isRoomy ? '  ' : ' '
  const name: Run = { text: `${padTo(row.name, isRoomy ? 14 : 12)} `, tone: row.isStale ? 'muted' : 'plain' }
  const old: Run[] = row.isStale ? [{ text: `${gap}${row.ageMs === null ? 'age unknown' : `${duration(row.ageMs)} old`}`, tone: 'muted' }] : []
  if (row.usedPercent === null) return fitLine([name, { text: 'no data', tone: 'muted' }, ...old], inner)
  const tone = quotaTone(row)
  const g = gauge(row.usedPercent)
  const reset = resetText(row.resetsAt, now, timeZone)
  return fitLine(
    [
      name,
      { text: g.filled, tone },
      { text: g.empty, tone: 'muted' },
      { text: percentText(row).padStart(6), tone, bold: row.level !== 'normal' && !row.isStale },
      { text: quotaFlag(row).padEnd(2), tone, bold: true },
      ...(reset === '' ? [] : [{ text: `${gap}resets ${reset}`, tone: 'muted' as Tone }]),
      ...old,
    ],
    inner,
  )
}

const quotaCard = (m: Model, inner: number, timeZone: string): Card => {
  const q = m.quota
  const top = q.tightest
  const lines: Line[] = [
    ...(q.error === null ? [] : [fitLine([{ text: `could not read quota: ${q.error}`, tone: 'critical' }], inner)]),
    ...q.rows.map(row => quotaLine(row, inner, m.now, timeZone)),
  ]
  if (lines.length === 0) lines.push(muted('no quota readings yet'))
  const topRuns = (row: QuotaLine): Run[] => [{ text: `${percentText(row)}${quotaFlag(row)}`, tone: quotaTone(row), bold: row.level !== 'normal' }]
  // The badge is context use, colored by its level with `!`/`!!` past the context lines; the tightest quota until a context reading comes.
  const c = m.context
  const ctxFlag = c === null ? '' : c.level === 'error' ? '!!' : c.level === 'warning' ? '!' : ''
  const badge: Line =
    c !== null
      ? [{ text: 'ctx ', tone: 'muted' }, { text: `${c.percent}%${ctxFlag}`, tone: levelTone(c.level), bold: c.level !== 'normal' }]
      : top === null
        ? []
        : [{ text: 'tightest ', tone: 'muted' }, ...topRuns(top)]
  return {
    id: 'quota',
    title: 'QUOTA',
    isPinned: true,
    badge,
    summary:
      top === null
        ? (lines[0] ?? [])
        : fitLine([{ text: `tightest ${top.name} `, tone: 'plain' }, ...topRuns(top), ...(q.error === null ? [] : [SEP, { text: '1 source failed', tone: 'critical' as Tone }])], inner),
    lines,
  }
}

const dispatchCard = (m: Model, inner: number, timeZone: string, recent: number): Card => {
  const d = m.dispatches
  const c = DISPATCH_COLS
  const taskWidth = Math.max(0, inner - 2 - c.runtime - c.id - c.start - c.age - 4)
  const running = d.rows.filter(r => r.status === 'running')
  const stalled = d.rows.filter(r => r.status === 'stalled')
  const fresh = stalled.filter(r => r.lastSeenAt !== null && m.now - r.lastSeenAt <= STALE_FOLD_MS)
  const stale = stalled.filter(r => !fresh.includes(r))
  const ended = d.rows.filter(r => r.status !== 'running' && r.status !== 'stalled').slice(0, recent)
  const row = (r: (typeof d.rows)[number]): Line => {
    const isOpen = r.status === 'running' || r.status === 'stalled'
    const tone: Tone = isOpen ? 'plain' : 'muted'
    return fitLine(
      [
        statusMark(r.status),
        { text: ` ${padTo(r.runtime, c.runtime)} ${padTo(r.id, c.id)} ${padTo(clockTime(r.startedAt, timeZone), c.start)} `, tone },
        { text: padTo(ageText(r.ageMs), c.age), tone: r.status === 'stalled' ? 'warn' : tone },
        { text: ` ${truncateWidth(r.summary || (r.status === 'stalled' ? 'no end event' : ''), taskWidth)}`.trimEnd(), tone: 'muted' },
      ],
      inner,
    )
  }
  const lines: Line[] = []
  let summary: Line
  if (d.error !== null) {
    lines.push(fitLine([{ text: `could not read dispatches: ${d.error}`, tone: 'critical' }], inner))
    summary = lines[0] ?? []
  } else if (d.fetchedAt === null) {
    lines.push(muted('loading...'))
    summary = muted('loading...')
  } else {
    if (d.rows.length === 0) lines.push(muted('none in the last 24h'))
    if (running.length + fresh.length > 0) {
      lines.push(muted(`  ${padTo('RUNTIME', c.runtime)} ${padTo('ID', c.id)} ${padTo('START', c.start)} ${padTo('AGE', c.age)} TASK`))
    }
    lines.push(...running.map(row), ...fresh.map(row))
    if (stale.length > 0) {
      const since = Math.min(...stale.map(r => r.startedAt ?? r.lastSeenAt ?? m.now))
      lines.push([statusMark('stalled'), { text: ` ${stale.length} stalled since ${clockTime(since, timeZone)}`, tone: 'muted' }])
    }
    if (ended.length > 0) {
      lines.push(recentRule(inner))
      lines.push(...ended.map(row))
    }
    const okCount = ended.filter(r => r.status === 'done').length
    const badCount = ended.filter(r => r.status === 'failed' || r.status === 'rejected').length
    summary =
      ended.length === 0
        ? muted('nothing ended in the last 24h')
        : [
            { text: 'recent ', tone: 'muted' },
            { text: `✓ ${okCount}`, tone: 'muted' },
            ...(badCount > 0 ? [{ text: '  ', tone: 'plain' as Tone }, { text: `✗ ${badCount}`, tone: 'critical' as Tone }] : []),
          ]
  }
  const badge: Line = [
    { text: `${running.length} running`, tone: running.length === 0 ? 'muted' : 'ok', bold: running.length > 0 },
    ...(stalled.length > 0 ? [SEP, { text: `${stalled.length} stalled`, tone: 'warn' as Tone, bold: true }] : []),
  ]
  return { id: 'dispatches', title: 'DISPATCHES', badge, summary, lines }
}

const URGENT: readonly CustomMark[] = ['failed', 'warn', 'stalled']

/**
 * Orders items so the ones a capped card shows come first: failed, warn and stalled items always
 * make the cut (up to `cap`), the rest of the cut goes to the first other items; each group keeps
 * the command's own order.
 */
export const visibleFirst = <T extends { mark: CustomMark }>(items: readonly T[], cap: number): T[] => {
  if (items.length <= cap) return [...items]
  const urgent = items.filter(i => URGENT.includes(i.mark)).slice(0, cap)
  const rest = items.filter(i => !urgent.includes(i))
  const chosen = new Set<T>([...urgent, ...rest.slice(0, cap - urgent.length)])
  return [...items.filter(i => chosen.has(i)), ...items.filter(i => !chosen.has(i))]
}

type CustomItem = Model['custom'][number]['items'][number]

const itemLine = (i: CustomItem, inner: number): Line =>
  timed(customMark(i.mark), i.text, { text: i.right, tone: i.mark === 'failed' ? 'critical' : 'muted' }, inner)

/**
 * A card whose items carry `group`: a gray heading per group with its item count on the right, the
 * group's items under it in the command's order. The `maxItems` cap picks items as an ungrouped card
 * does (failed, warn and stalled first) and the rest fold into one `+N more` row; headings do not
 * count against the cap.
 */
/**
 * How many items a line stands for when the height fit folds it into `+N more`: a group heading
 * stands for none, a grouped card's own `+N more` for its N; any other line for one.
 */
const ITEM_COUNT = new WeakMap<Line, number>()
const counted = (line: Line, n: number): Line => (ITEM_COUNT.set(line, n), line)

const groupedLines = (items: readonly CustomItem[], inner: number, maxItems: number): Line[] => {
  const chosen = new Set(visibleFirst(items, maxItems).slice(0, maxItems))
  const groups = [...new Set(items.map(i => i.group ?? ''))]
  const lines: Line[] = []
  for (const group of groups) {
    const all = items.filter(i => (i.group ?? '') === group)
    const shownItems = all.filter(i => chosen.has(i))
    if (shownItems.length === 0) continue
    if (group !== '') lines.push(counted(spread([{ text: group, tone: 'muted' }], [{ text: String(all.length), tone: 'muted' }], inner), 0))
    lines.push(...shownItems.map(i => itemLine(i, inner)))
  }
  const rest = items.length - chosen.size
  return rest > 0 ? [...lines, counted(moreLine(rest), rest)] : lines
}

const customCard = (m: Model, view: Model['custom'][number], inner: number, maxItems: number): Card => {
  const loading = view.fetchedAt === null
  const failed = view.items.filter(i => i.mark === 'failed').length
  const waiting = view.items.some(i => i.mark === 'waiting')
  const isGrouped = view.items.some(i => i.group !== undefined)
  const lines: Line[] =
    view.error !== null
      ? [fitLine([{ text: `could not read: ${view.error}`, tone: 'critical' }], inner)]
      : loading
        ? [muted('loading...')]
        : view.items.length === 0
          ? [fitLine(muted(view.empty), inner)]
          : isGrouped
            ? groupedLines(view.items, inner, maxItems)
            : visibleFirst(view.items, maxItems).map(i => itemLine(i, inner))
  return {
    id: view.id,
    title: view.title,
    // The command's own badge text when it gives one (e.g. `14 open · 3 on you`), else the item count.
    badge:
      view.badge !== '' && view.error === null
        ? [
            { text: view.badge, tone: waiting || view.items.some(i => i.mark === 'warn') ? 'warn' : 'muted', bold: true },
            ...(failed > 0 ? [SEP, { text: `${failed} failed`, tone: 'critical' as Tone, bold: true }] : []),
          ]
        : badgeOf(view.items.length, failed, waiting ? 'warn' : 'muted'),
    summary: view.error !== null || loading || view.summary === '' ? (lines[0] ?? []) : fitLine([{ text: view.summary, tone: 'plain' }], inner),
    lines,
    // A grouped card already applied the cap and drew its own +N more row.
    ...(isGrouped && view.error === null && !loading ? {} : { maxLines: maxItems }),
  }
}

const sessionCard = (m: Model, inner: number, timeZone: string): Card => {
  const s = m.session
  const up = s.startedAt === null ? '--' : duration(m.now - s.startedAt)
  const woke = s.wakeAt === null ? 'never' : clockTime(s.wakeAt, timeZone)
  return {
    id: 'session',
    title: 'SESSION',
    badge: [],
    summary: fitLine([{ text: `up ${up} · woke ${woke} · compacted ${s.compactCount}`, tone: 'plain' }], inner),
    lines: [
      fitLine([{ text: 'started ', tone: 'muted' }, { text: `${clockTime(s.startedAt, timeZone)} (up ${up})`, tone: 'plain' }], inner),
      fitLine(
        s.wakeAt === null
          ? muted('no wake yet')
          : [{ text: 'last wake ', tone: 'muted' }, { text: `${woke} ${cut(s.wakeText, 30)}`, tone: 'plain' }],
        inner,
      ),
      fitLine(
        [
          { text: 'compacted ', tone: 'muted' },
          { text: `${s.compactCount}${s.compactAt === null ? '' : `, last ${clockTime(s.compactAt, timeZone)}`}`, tone: 'plain' },
        ],
        inner,
      ),
    ],
  }
}

/** Data older than this is called stale: two refreshes missed. */
const STALE_DATA_MS = 150_000

/** When the cards' data was last read (not when the pane was drawn), flagged once it is stale. */
const footer = (m: Model, timeZone: string): Line => {
  const reads = [m.dispatches.isEnabled ? m.dispatches.fetchedAt : null, ...m.custom.map(c => c.fetchedAt)].filter(
    (t): t is number => t !== null,
  )
  const at = reads.length > 0 ? Math.max(...reads) : null
  const isStale = at !== null && m.now - at > STALE_DATA_MS
  return [
    { text: `updated ${at === null ? clockTime(m.now, timeZone) : clockTime(at, timeZone)}`, tone: isStale ? 'warn' : 'muted' },
    ...(isStale ? [{ text: ` (stale, ${duration(m.now - at)} old)`, tone: 'warn' as Tone }] : []),
    { text: ' · refresh 60s', tone: 'muted' },
  ]
}

/**
 * The person's order over the cards this configuration draws: saved ids first, as saved; an id the
 * saved order lacks goes right after the card that precedes it by default.
 */
export const arrangedOrder = (defaults: readonly string[], saved: readonly string[]): string[] => {
  const out = saved.filter((id, i) => defaults.includes(id) && saved.indexOf(id) === i)
  defaults.forEach((id, i) => {
    if (out.includes(id)) return
    const before = defaults.slice(0, i).reverse().find(prev => out.includes(prev))
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, id)
  })
  return out
}

/** Below this body width the arrange buttons shrink to `↑ ↓ B H`. */
export const WIDE_ARRANGE_COLUMNS = 80

const ARRANGE_KEYS = { up: 'u', down: 'd', place: 'b', hide: 'h' } as const

/**
 * A card's row in arrange mode: its title on the left (cut first), then up, down, place and hide.
 * The first card has no up button and the last no down button: blank, so the columns line up.
 * The selected card's buttons carry the u/d/b/h hotkeys.
 */
const arrangeRow = (
  card: Card,
  i: number,
  n: number,
  placement: Placement,
  inner: number,
  isWide: boolean,
  isSelected: boolean,
): Line => {
  const hot = (k: keyof typeof ARRANGE_KEYS): string | undefined => (isSelected ? ARRANGE_KEYS[k] : undefined)
  const place = placement === 'band' ? 'Pane' : 'Band'
  const label = { up: '↑', down: '↓', place: isWide ? place : place.slice(0, 1), hide: isWide ? 'Hide' : 'H' }
  const gap: Run = { text: isWide ? '  ' : ' ', tone: 'plain' }
  const slot = (k: 'up' | 'down', isShown: boolean): Run => {
    const run = buttonRun(`${k}:${card.id}`, label[k], hot(k))
    return isShown ? run : { text: ' '.repeat(displayWidth(run.text)), tone: 'plain' }
  }
  const right: Run[] = [
    slot('up', i > 0),
    gap,
    slot('down', i < n - 1),
    gap,
    buttonRun(`place:${card.id}`, label.place, hot('place')),
    gap,
    buttonRun(`hide:${card.id}`, label.hide, hot('hide')),
  ]
  return spread([{ text: ` ${card.title}`, tone: 'accent', bold: true }, ...(placement === 'band' ? [{ text: ' (band)', tone: 'muted' as Tone }] : [])], right, inner)
}

/**
 * Every card, in the person's order (by default QUOTA when there is one, INBOX, RUNNING, DISPATCHES
 * when configured, the custom cards, SESSION). Hidden cards are left out; cards placed on the band
 * go to `band` instead of the pane, except in arrange mode, which lists them all.
 */
export const paneDoc = (m: Model, bodyColumns: number, timeZone: string, opts: PaneOptions): PaneDoc => {
  const inner = cardInner(bodyColumns)
  const width = Math.max(20, bodyColumns)
  const footWidth = Math.max(18, bodyColumns - 2)
  const isArranging = opts.isArranging === true
  const limit = (card: Card): Card => (opts.rows[card.id] === undefined ? card : { ...card, maxLines: opts.rows[card.id] })
  const byDefault = [
    ...(m.quota.isEnabled ? [quotaCard(m, inner, timeZone)] : []),
    limit(inboxCard(m, inner)),
    runningCard(m, inner, timeZone, opts.rows['running'] ?? opts.recentRows ?? 5),
    ...(m.dispatches.isEnabled ? [dispatchCard(m, inner, timeZone, opts.rows['dispatches'] ?? RECENT_DEFAULT)] : []),
    ...m.custom.map(view => limit(customCard(m, view, inner, opts.customMaxItems))),
    limit(sessionCard(m, inner, timeZone)),
  ]
  const order = arrangedOrder(
    byDefault.map(card => card.id),
    opts.order ?? [],
  )
  const all = order.map(id => byDefault.find(card => card.id === id)).filter((card): card is Card => card !== undefined)
  const hidden = all.filter(card => opts.hidden.includes(card.id))
  const visible = all.filter(card => !opts.hidden.includes(card.id))
  const placeOf = (id: string): Placement => opts.placement?.[id] ?? 'pane'
  const isWide = bodyColumns >= WIDE_ARRANGE_COLUMNS
  const selected = visible.some(card => card.id === opts.selected) ? opts.selected : visible[0]?.id
  const updated = footer(m, timeZone)
  return {
    all,
    head: headLines(m, inner, timeZone, isArranging, !isWide),
    cards: isArranging ? [] : visible.filter(card => placeOf(card.id) === 'pane'),
    band: visible.filter(card => placeOf(card.id) === 'band').map(card => ({ id: card.id, title: card.title, summary: card.summary })),
    arrange: isArranging
      ? visible.map((card, i) => arrangeRow(card, i, visible.length, placeOf(card.id), inner, isWide, card.id === selected))
      : null,
    footer: [
      ...(hidden.length > 0 ? [fitLine(muted(`hidden: ${hidden.map(card => card.id).join(', ')}`), width)] : []),
      hidden.length === 0
        ? fitLine(updated, width)
        : spread(
            [...updated, { text: ` · ${hidden.length} hidden`, tone: 'muted' }],
            [buttonRun('reveal-hidden', opts.isHiddenRevealed === true ? 'Close' : 'Show')],
            footWidth,
          ),
      ...(opts.isHiddenRevealed === true
        ? hidden.map(card => spread([{ text: `  ${card.title}`, tone: 'plain' }], [buttonRun(`show:${card.id}`, 'Show')], footWidth))
        : []),
    ],
  }
}

/** A card's title row after its toggle: the title on the left, its badge on the right. */
export const cardTitle = (card: Card, inner: number): Line =>
  spread([{ text: ` ${card.title}`, tone: 'accent', bold: true }], card.badge, inner - 1)

// ---------- fitting the pane's height ----------

export type Placed = { card: Card; isOpen: boolean; body: Line[] }
export type Layout = { head: Line[]; cards: Placed[]; showFooter: boolean }

const moreLine = (hidden: number): Line => muted(`+${hidden} more`)

/** The first `keep` rows of `lines`, the last of them a `+N more` line when some are hidden. */
const shown = (lines: readonly Line[], keep: number): Line[] => {
  if (keep >= lines.length) return [...lines]
  const hidden = lines.slice(Math.max(0, keep - 1)).reduce((n, line) => n + (ITEM_COUNT.get(line) ?? 1), 0)
  return [...lines.slice(0, Math.max(0, keep - 1)), moreLine(hidden)]
}

/** Rows a round card takes: its border (2), its title row and its body. */
const CARD_FRAME = 3

/**
 * Lays the cards into `maxRows`: collapsed cards keep their one summary row; expanded ones show up
 * to their maxLines, then the longest is shortened a row at a time (down to one `+N more` row) until
 * everything fits, so every card's title row stays on screen. The footer goes last of all. A pinned
 * card (QUOTA) is never shortened: when nothing else can give way, the pane runs past `maxRows`
 * and scrolls rather than hide a quota row.
 */
export const layoutPane = (doc: PaneDoc, isOpen: (id: string) => boolean, maxRows: number): Layout => {
  const open = doc.cards.map(card => isOpen(card.id))
  const keep = doc.cards.map((card, i) =>
    !open[i]
      ? 1
      : card.isPinned !== true && card.maxLines !== undefined && card.lines.length > card.maxLines
        ? card.maxLines + 1
        : card.lines.length,
  )
  let showFooter = true
  const total = (): number =>
    2 + doc.head.length + keep.reduce((sum, k) => sum + CARD_FRAME + Math.max(1, k), 0) + (showFooter ? doc.footer.length : 0)
  while (total() > maxRows) {
    let longest = -1
    keep.forEach((k, i) => {
      if (open[i] && doc.cards[i]?.isPinned !== true && k > 1 && (longest === -1 || k > (keep[longest] ?? 0))) longest = i
    })
    if (longest === -1) {
      if (!showFooter) break
      showFooter = false
      continue
    }
    keep[longest] = (keep[longest] ?? 1) - 1
  }
  return {
    head: doc.head,
    cards: doc.cards.map((card, i) => ({
      card,
      isOpen: open[i] === true,
      body: open[i] ? shown(card.lines, keep[i] ?? 1) : [card.summary],
    })),
    showFooter,
  }
}
