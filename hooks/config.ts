// The plugin's options (manifest userConfig), parsed once per load into one Config.
// Defaults work out of the box: no channel names, no dispatch command, nothing personal.

export type Config = {
  channelNames: ReadonlyMap<string, string>
  replyTools: ReadonlySet<string>
  waitingAlertMs: number
  longActionMs: number
  contextWarn: number
  contextCritical: number
  /** The dispatch command split into argv, `{since24h}` still in place; empty when not set. */
  dispatchArgv: readonly string[]
  dispatchPattern: RegExp | null
  runtimeNames: ReadonlyMap<string, string>
  timeZone: string
  customCards: readonly { id: string; title: string; argv: readonly string[] }[]
  openOnStart: boolean
  wakePattern: RegExp | null
  collapsedCards: ReadonlySet<string>
  customCardMaxItems: number
  paneMaxRows: number
  /** The quota command split into argv; empty when not set. */
  quotaArgv: readonly string[]
  quotaWarn: number
  quotaCritical: number
  /** How many ended runs the RUNNING card lists under recent. */
  recentRows: number
  /** Whether the mod pins its own status line under the prompt. */
  statusLine: boolean
  /** What the status line's left side shows, in order: model, context, quota, mode. */
  statusLineState: readonly StatePart[]
  /** The card whose summary the status line's right side shows; '' for none. */
  statusLineSubinfo: string
}

export const STATE_PARTS = ['model', 'context', 'quota', 'mode'] as const
export type StatePart = (typeof STATE_PARTS)[number]

const stateParts = (v: unknown): StatePart[] =>
  typeof v !== 'string'
    ? [...STATE_PARTS]
    : v
        .split(/[,\s]+/)
        .map(p => p.trim().toLowerCase())
        .filter((p): p is StatePart => (STATE_PARTS as readonly string[]).includes(p))

/** A card's id: its title in lower case, runs of other characters as one dash. */
export const cardId = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** `TITLE=command;;TITLE=command`; a pair with no title or no command is skipped. */
export const parseCustomCards = (raw: string): { id: string; title: string; argv: string[] }[] =>
  raw
    .split(';;')
    .map(part => {
      const at = part.indexOf('=')
      const title = at > 0 ? part.slice(0, at).trim() : ''
      return { id: cardId(title), title, argv: at > 0 ? splitArgv(part.slice(at + 1)) : [] }
    })
    .filter(card => card.title !== '' && card.id !== '' && card.argv.length > 0)

export type RawOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>

const MINUTE = 60_000

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

/** `id=name,id=name` (commas, semicolons or newlines between pairs). */
export const parsePairs = (raw: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const part of raw.split(/[,;\n]/)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key && value) out.set(key, value)
  }
  return out
}

/** Splits a command line into argv the way a shell would for plain words and quotes; no expansion. */
export const splitArgv = (line: string): string[] => {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasWord = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (/\s/.test(ch)) {
      if (hasWord) out.push(current)
      current = ''
      hasWord = false
    } else {
      current += ch
      hasWord = true
    }
  }
  if (hasWord) out.push(current)
  return out
}

const toPattern = (raw: string): RegExp | null => {
  if (!raw) return null
  try {
    return new RegExp(raw)
  } catch {
    return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
}

export const parseConfig = (options: RawOptions | undefined): Config => {
  const o = options ?? {}
  const warn = num(o['contextWarnPercent'], 70, 1, 100)
  const quotaWarn = num(o['quotaWarnPercent'], 70, 1, 100)
  return {
    channelNames: parsePairs(str(o['channelNames'])),
    replyTools: new Set(
      str(o['replyTools'])
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
    waitingAlertMs: num(o['waitingAlertMinutes'], 5, 0, 24 * 60) * MINUTE,
    longActionMs: num(o['longActionMinutes'], 10, 0, 24 * 60) * MINUTE,
    contextWarn: warn,
    contextCritical: Math.max(warn, num(o['contextCriticalPercent'], 85, 1, 100)),
    dispatchArgv: splitArgv(str(o['dispatchCommand'])),
    dispatchPattern: toPattern(str(o['dispatchCommandPattern'])),
    runtimeNames: parsePairs(str(o['runtimeNames'])),
    timeZone: str(o['timeZone']),
    customCards: parseCustomCards(str(o['customCards'])),
    openOnStart: o['openOnStart'] === true,
    wakePattern: toPattern(str(o['wakePattern'])),
    collapsedCards: new Set(
      (typeof o['collapsedCards'] === 'string' ? o['collapsedCards'] : 'session')
        .split(/[,\s]+/)
        .map(cardId)
        .filter(Boolean),
    ),
    customCardMaxItems: Math.round(num(o['customCardMaxItems'], 5, 1, 100)),
    paneMaxRows: Math.round(num(o['paneMaxRows'], 44, 10, 500)),
    quotaArgv: splitArgv(str(o['quotaCommand'])),
    quotaWarn,
    quotaCritical: Math.max(quotaWarn, num(o['quotaCriticalPercent'], 90, 1, 100)),
    recentRows: Math.round(num(o['recentRows'], 5, 0, 30)),
    statusLine: o['statusLine'] === true,
    statusLineState: stateParts(o['statusLineState']),
    statusLineSubinfo: cardId(typeof o['statusLineSubinfo'] === 'string' ? o['statusLineSubinfo'] : 'schedule'),
  }
}

export const DEFAULT_CONFIG: Config = parseConfig({})

/** Levenshtein distance. */
const distance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

export type CardMatch = { ids: string[] } | { error: string }

/**
 * Finds the cards a typed name means: `all`; the name with case ignored and spaces as dashes; or a
 * unique prefix of one. Several matches list the candidates; none lists every card and suggests the
 * nearest by edit distance (to the whole id or its head of the same length).
 */
export const resolveCards = (ids: readonly string[], typed: string): CardMatch => {
  const name = cardId(typed)
  if (name === 'all') return { ids: [...ids] }
  if (ids.includes(name)) return { ids: [name] }
  const prefixed = name === '' ? [] : ids.filter(id => id.startsWith(name))
  if (prefixed.length === 1) return { ids: prefixed }
  if (prefixed.length > 1) return { error: `"${typed}" matches ${prefixed.join(', ')}; type more of the name.` }
  const score = (id: string): number => Math.min(distance(name, id), distance(name, id.slice(0, name.length)))
  const nearest = [...ids].sort((a, b) => score(a) - score(b))[0]
  return { error: `No card named "${typed}".${nearest === undefined ? '' : ` Did you mean ${nearest}?`} Cards: ${ids.join(', ')}.` }
}
