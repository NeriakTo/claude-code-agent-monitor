// The band above the prompt, and the pieces both views share (see pane.ts for the pane).
// Neither computes a figure or a threshold: both read the Model, and both take their status
// symbols and colors from statusMark/levelMark below, so the two always agree.
import { cut, displayWidth, duration, truncateWidth } from './logic'
import type { Level, Model, QuotaLine, Status } from './model'

/**
 * Every non-ASCII character either view may draw. Terminal fonts (PuTTY's included) have these;
 * anything else risks a box glyph. The round card borders are drawn by the surface, listed too.
 * The gauge blocks and the move arrows (█░↑↓) are in the Windows console's code page 437 as well.
 */
export const SYMBOLS = '●✓✗◌–·│─┊╭╮╰╯█░↑↓'

/** The card toggles: ASCII, so every font has them. */
export const TOGGLE = { expanded: '-', collapsed: '+' } as const

/** Color roles; textProps maps them to named terminal colors only. */
export type Tone = 'accent' | 'ok' | 'warn' | 'critical' | 'muted' | 'plain'
/**
 * One styled piece of a line. With `button`, the piece is drawn as a plain Button whose label is
 * `button.label`; `text` is what the terminal shows for it (`h: Hide` when it has a hotkey), so
 * widths stay right.
 */
export type Run = { text: string; tone: Tone; bold?: boolean; button?: { key: string; label: string; hotkey?: string } }

/** A plain Button as a run: the terminal draws `hotkey: label`, or the label alone. */
export const buttonRun = (key: string, label: string, hotkey?: string): Run => ({
  text: hotkey === undefined ? label : `${hotkey}: ${label}`,
  tone: 'plain',
  button: { key, label, ...(hotkey === undefined ? {} : { hotkey }) },
})
export type Line = Run[]

export const textProps = (run: Run): { color?: string; dimColor?: boolean; bold?: boolean } => {
  const bold = run.bold === true ? { bold: true } : {}
  switch (run.tone) {
    case 'accent':
      return { color: 'cyan', ...bold }
    case 'ok':
      return { color: 'green', ...bold }
    case 'warn':
      return { color: 'yellow', ...bold }
    case 'critical':
      return { color: 'red', ...bold }
    case 'muted':
      return { dimColor: true, ...bold }
    default:
      return bold
  }
}

// ---------- the one symbol and color table ----------

export const statusMark = (status: Status): Run => {
  switch (status) {
    case 'running':
      return { text: '●', tone: 'ok' }
    case 'stalled':
      return { text: '◌', tone: 'warn' }
    case 'done':
      return { text: '✓', tone: 'muted' }
    case 'failed':
    case 'rejected':
      return { text: '✗', tone: 'critical' }
    case 'cancelled':
      return { text: '–', tone: 'muted' }
    default:
      return { text: '·', tone: 'muted' }
  }
}

export const levelTone = (level: Level): Tone => (level === 'error' ? 'critical' : level === 'warning' ? 'warn' : 'ok')

/** A dot colored by severity; a gray middle dot when there is nothing to show. */
export const levelMark = (level: Level, isEmpty: boolean): Run =>
  isEmpty ? { text: '·', tone: 'muted' } : { text: '●', tone: levelTone(level) }

/** A count colored by state: gray at zero. */
export const count = (n: number, tone: Tone): Run => ({ text: String(n), tone: n === 0 ? 'muted' : tone, bold: n > 0 })

export const lineWidth = (line: Line): number => line.reduce((w, r) => w + displayWidth(r.text), 0)

/** Cuts a line to `width` cells, the last run that does not fit ending in `~`. */
export const fitLine = (line: Line, width: number): Line => {
  const out: Line = []
  let left = width
  for (const run of line) {
    const w = displayWidth(run.text)
    if (w <= left) {
      out.push(run)
      left -= w
      continue
    }
    // A button is never cut: it is dropped whole when it does not fit.
    if (left > 0 && run.button === undefined) out.push({ ...run, text: truncateWidth(run.text, left) })
    break
  }
  return out
}

/** `left` then `right` pushed to the far edge; the left side gives way when they do not both fit. */
export const spread = (left: Line, right: Line, width: number): Line => {
  const rw = lineWidth(right)
  const fittedLeft = fitLine(left, Math.max(0, width - rw - 1))
  const gap = Math.max(1, width - lineWidth(fittedLeft) - rw)
  return fitLine([...fittedLeft, { text: ' '.repeat(gap), tone: 'plain' }, ...right], width)
}

export const replyText = (ms: number | null): string =>
  ms === null ? 'no reply yet' : ms < 60_000 ? 'replied just now' : `replied ${duration(ms)} ago`

/** The restart warning shared by the band and the pane's overview; none under the warning line. */
export const restartRun = (m: Model): Run | null =>
  m.context === null || m.context.level === 'normal'
    ? null
    : { text: m.context.level === 'error' ? 'restart now' : 'restart soon', tone: levelTone(m.context.level), bold: true }

// ---------- quota figures, shared by the band and the pane ----------

/** The tone a quota figure takes: neutral below the warning line, gray when stale. */
export const quotaTone = (row: QuotaLine): Tone =>
  row.isStale ? 'muted' : row.level === 'error' ? 'critical' : row.level === 'warning' ? 'warn' : 'plain'

/** `!` past the warning line, `!!` past the critical one, so the state never rests on color alone. */
export const quotaFlag = (row: QuotaLine): string => (row.isStale ? '' : row.level === 'error' ? '!!' : row.level === 'warning' ? '!' : '')

export const percentText = (row: QuotaLine): string => (row.usedPercent === null ? '--' : `${Math.round(row.usedPercent)}%`)

/** The band's short name: `Claude 5h` is `5h`, other sources keep their name. */
export const shortQuotaName = (name: string): string => cut(name.replace(/^Claude /, ''), 12)

// ---------- the band ----------

export type Segment = {
  key: 'inbox' | 'now' | 'context' | 'quota' | 'card' | 'reply'
  runs: Line
  /** A tighter form tried before the segment is dropped (the quota's `Q 61%`). */
  compact?: Line
}

export const SEPARATOR: Run = { text: '  │  ', tone: 'muted' }

/** What else the band shows: the quota (unless hidden), and the cards placed on the band. */
export type BandExtras = {
  isQuotaHidden?: boolean
  isQuotaOnBand?: boolean
  /** The pane's own render of a card placed on the band: its title and collapsed summary. */
  cards?: readonly { title: string; summary: Line }[]
  /** Clock times for the reset, in this zone. */
  resetLabel?: (row: QuotaLine) => string
}

const quotaSegment = (m: Model, extras: BandExtras): Segment | null => {
  const top = m.quota.tightest
  if (top === null || extras.isQuotaHidden === true) return null
  const tone = quotaTone(top)
  const flag = quotaFlag(top)
  const reset = top.level === 'normal' ? '' : (extras.resetLabel?.(top) ?? '')
  return {
    key: 'quota',
    runs: [
      levelMark(top.level, false),
      { text: ' QUOTA ', tone: 'plain', bold: true },
      { text: `${shortQuotaName(top.name)} `, tone: 'plain' },
      { text: percentText(top), tone, bold: top.level !== 'normal' },
      ...(flag === '' ? [] : [{ text: ` ${flag}`, tone, bold: true }]),
      ...(reset === '' ? [] : [{ text: ` resets ${reset}`, tone: 'muted' as Tone }]),
    ],
    compact: [{ text: 'Q ', tone: 'plain', bold: true }, { text: `${percentText(top)}${flag}`, tone, bold: top.level !== 'normal' }],
  }
}

/** A card placed on the band: its title, then its collapsed summary cut to 40 cells. */
const cardSegment = (card: { title: string; summary: Line }): Segment => ({
  key: 'card',
  runs: [{ text: `${cut(card.title, 16)} `, tone: 'plain', bold: true }, ...fitLine(card.summary, 40)],
})

/**
 * The band's segments. With the pane closed: INBOX, NOW, the restart warning (only past the
 * warning line), the tightest quota, cards placed on the band, and the last reply. With the pane
 * open the pane says the rest, so the band keeps only what is past a threshold (and the cards the
 * person put there); nothing left means no band at all (an empty list).
 */
export const bandSegments = (m: Model, isPaneOpen: boolean, extras: BandExtras = {}): Segment[] => {
  const [oldest] = m.inbox.groups
  const inbox: Segment = {
    key: 'inbox',
    runs: [
      levelMark(m.inbox.level, m.inbox.total === 0),
      { text: ' INBOX ', tone: 'plain', bold: true },
      count(m.inbox.total, levelTone(m.inbox.level)),
      ...(oldest === undefined
        ? []
        : [
            { text: `  ${oldest.label} `, tone: 'plain' as Tone },
            { text: duration(oldest.waitedMs), tone: levelTone(oldest.level) },
            ...(m.inbox.groups.length > 1 ? [{ text: ` +${m.inbox.groups.length - 1}ch`, tone: 'muted' as Tone }] : []),
          ]),
    ],
  }
  const [first] = m.actions
  const now: Segment = {
    key: 'now',
    runs:
      first === undefined
        ? [statusMark('idle'), { text: ' NOW ', tone: 'plain', bold: true }, { text: 'idle', tone: 'muted' }]
        : [
            levelMark(first.level, false),
            { text: ' NOW  ', tone: 'plain', bold: true },
            { text: `${cut(first.label, 28)} `, tone: 'plain' },
            { text: duration(first.elapsedMs), tone: levelTone(first.level) },
            ...(m.actions.length > 1 ? [{ text: ` +${m.actions.length - 1}`, tone: 'muted' as Tone }] : []),
          ],
  }
  const restart = restartRun(m)
  const context: Segment | null =
    restart === null ? null : { key: 'context', runs: [{ text: '●', tone: restart.tone }, { text: ' ', tone: 'plain' }, restart] }
  const quota = quotaSegment(m, extras)
  const cards = (extras.cards ?? []).map(cardSegment)
  if (isPaneOpen) {
    const isQuotaUrgent = quota !== null && (m.quota.tightest?.level !== 'normal' || extras.isQuotaOnBand === true)
    return [
      ...(m.inbox.level !== 'normal' ? [inbox] : []),
      ...(first !== undefined && first.level !== 'normal' ? [now] : []),
      ...(context === null ? [] : [context]),
      ...(isQuotaUrgent && quota !== null ? [quota] : []),
      ...cards,
    ]
  }
  return [
    inbox,
    now,
    ...(context === null ? [] : [context]),
    ...(quota === null ? [] : [quota]),
    ...cards,
    { key: 'reply', runs: [{ text: replyText(m.lastReplyAgoMs), tone: 'muted' }] },
  ]
}

/**
 * The band as one line within `width`. When it does not fit: the quota shrinks to `Q 61%`; then the
 * last reply goes, then cards placed on the band (last first), then the restart warning and NOW as
 * before; the quota goes last of all. The first segment always stays.
 */
export const bandLine = (segments: readonly Segment[], width: number): Line => {
  let kept = [...segments]
  const join = (list: readonly Segment[]): Line => [
    { text: ' ', tone: 'plain' },
    ...list.flatMap((s, i) => (i > 0 ? [SEPARATOR, ...s.runs] : s.runs)),
  ]
  const fits = (): boolean => lineWidth(join(kept)) <= width
  const drop = (key: Segment['key']): boolean => {
    const at = kept.map(s => s.key).lastIndexOf(key)
    if (at <= 0) return false
    kept = kept.filter((_, i) => i !== at)
    return true
  }
  if (!fits()) kept = kept.map(s => (s.compact === undefined ? s : { ...s, runs: s.compact }))
  if (!fits()) drop('reply')
  while (!fits() && drop('card')) {
    // one card at a time, from the right
  }
  for (const key of ['context', 'now', 'quota'] as const) if (!fits()) drop(key)
  while (kept.length > 1 && !fits()) kept.pop()
  return fitLine(join(kept), width)
}
