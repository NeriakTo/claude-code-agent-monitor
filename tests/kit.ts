// Shared test world: the engine stand-ins beneath the plugin, and a plain-text renderer for drawn trees.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

export const PLUGIN = 'agent-monitor'
export const T0 = Date.parse('2026-10-05T04:00:00Z')
export const MIN = 60_000
export const DISCORD = 'plugin:discord:discord'
export const CHAT_A = '555000001112'
export const CHAT_B = '555000003093'

export const band = (bodyColumns = 160) => ({
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns, scroll: { offset: 0, bodyRows: 5 }, view: {} },
})

export const pane = (bodyColumns = 60, bodyRows = 60) => ({
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'agent-monitor',
  props: {
    title: 'Agent monitor',
    isFocused: false,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

export type World = {
  clock: ReturnType<typeof mock.clock>
  toasts: string[]
  logs: string[]
  runs: (readonly string[])[]
  timeouts: (number | undefined)[]
  /** What the plugin keeps in $.store. */
  store: Map<string, unknown>
  /** What $.session.usage() reports as the session's start. */
  sessionStartedAt: number
  /** What $.session.usage() reports as Claude's rate-limit windows. */
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  /** The argumentHint /monitor registered with. */
  hint: string
  open: Set<string>
  opens: string[]
}

/** The engine beneath the plugin. `answer` stands for the dispatch command; `agents` for $.agent.list(). */
export const world = (
  on: On,
  answer: (argv: readonly string[]) => ProcessRunResult | string | Promise<ProcessRunResult | string> = () => 'not configured',
  agents: { id: string; description: string; type: string; status: 'running' | 'completed' }[] = [],
): World => {
  const clock = mock.clock(on, { now: T0 })
  const w: World = { clock, toasts: [], logs: [], runs: [], timeouts: [], store: new Map(), sessionStartedAt: T0, rateLimits: [], hint: '', open: new Set(), opens: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: w.sessionStartedAt, context: { window: 200_000 }, rateLimits: w.rateLimits } }))
  on('ui.focus', () => ({}))
  on('store.set', ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    w.hint = e.argumentHint ?? ''
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: agents }))
  on('ui.panes', () => ({
    value: [...w.open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true, plugin: PLUGIN })),
  }))
  on('ui.open', ($, e) => {
    w.open.add(e.id)
    w.opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.open.delete(e.id)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    w.runs.push(e.argv)
    w.timeouts.push(e.init?.timeoutMs)
    const out = await answer(e.argv)
    return typeof out === 'string' ? { deny: out } : { value: out }
  })
  return w
}

export const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

export const toggle = ($: Engine) =>
  $.command.run({ command: 'monitor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })

export const tag = (chatId: string, messageId: string, server = DISCORD): string =>
  `<channel source="${server}" chat_id="${chatId}" message_id="${messageId}" user="someone" ts="t">hello</channel>`

export const fromChannel = (server = DISCORD) => ({ kind: 'channel' as const, server })

export const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// ---------- plain-text rendering of a drawn tree ----------

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && 'type' in v

const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : isNode(n) ? n.children.map(textOf).join('') : ''

const cells = (s: string): number => [...s].reduce((w, ch) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0)

const padEnd = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - cells(s)))

/** Draws a tree as the terminal would lay it out, borders and margins included, at `width` cells. */
export const renderText = (n: unknown, width: number): string[] => {
  if (!isNode(n)) return typeof n === 'string' ? [n] : []
  if (n.type === 'Text') return [textOf(n)]
  // A plain Button with a hotkey is drawn `h: Hide` by the terminal; without one, its label alone.
  if (n.type === 'Button') return [`${typeof n.props['hotkey'] === 'string' ? `${n.props['hotkey']}: ` : ''}${String(n.props['label'] ?? '')}`]
  const p = n.props
  const isColumn = p['flexDirection'] === 'column'
  const border = typeof p['borderStyle'] === 'string'
  const padX = typeof p['paddingX'] === 'number' ? p['paddingX'] : 0
  const inner = width - (border ? 2 : 0) - 2 * padX
  let lines = isColumn ? n.children.flatMap(c => renderText(c, inner)) : [n.children.map(c => renderText(c, inner).join('')).join('')]
  lines = lines.map(l => ' '.repeat(padX) + padEnd(l, inner) + ' '.repeat(padX))
  if (border) {
    lines = [`╭${'─'.repeat(width - 2)}╮`, ...lines.map(l => `│${l}│`), `╰${'─'.repeat(width - 2)}╯`]
  }
  const top = typeof p['marginTop'] === 'number' ? p['marginTop'] : 0
  return [...Array.from({ length: top }, () => ''), ...lines].map(l => l.trimEnd())
}

export const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
