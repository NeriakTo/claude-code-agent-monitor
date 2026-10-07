// Pure helpers: channel tags, the reply ledger, action labels, reply-tool matching,
// subagent results, the context line and terminal width. Nothing here touches $.
import type { AgentRun, ContextMark, Pending } from '../types'
import type { Config } from './config'

export const MINUTE = 60_000
export const SEEN_LIMIT = 500

// ---------- channel messages ----------

export type ChannelMessage = { server: string; chatId: string; key: string }

const TAG = /<channel\s+([^>]*)>/g
const ATTR = /([a-z_]+)="([^"]*)"/g

const attrsOf = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2]
  }
  return out
}

/** FNV-1a, for messages that carry no id of their own. */
export const hashText = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

const usable = (v: string | undefined): string => (v === undefined || v === '...' ? '' : v)

/**
 * Every `<channel source=... chat_id=... message_id=...>` tag in a delivery's text, any server.
 * A tag with no message id is keyed by a hash of its body. No tag at all: the whole delivery
 * is one message of `fallbackServer` (when given).
 */
export const parseChannelMessages = (text: string, fallbackServer: string | null): ChannelMessage[] => {
  const out: ChannelMessage[] = []
  for (const m of text.matchAll(TAG)) {
    const attrs = attrsOf(m[1] ?? '')
    const server = usable(attrs['source']) || fallbackServer || ''
    if (!server || attrs['source'] === '...') continue
    const chatId = usable(attrs['chat_id'])
    let messageId = usable(attrs['message_id'])
    if (!messageId) {
      const start = (m.index ?? 0) + m[0].length
      const end = text.indexOf('</channel>', start)
      messageId = `h${hashText(text.slice(start, end === -1 ? start + 400 : end))}`
    }
    out.push({ server, chatId, key: `${server}|${chatId}|${messageId}` })
  }
  if (out.length === 0 && fallbackServer) {
    out.push({ server: fallbackServer, chatId: '', key: `${fallbackServer}||h${hashText(text)}` })
  }
  return out
}

export type AppendLike = {
  agentId?: string
  door: string
  origin: object
  message: { type: string; content: readonly unknown[] }
}

const originOf = (origin: object): { kind: unknown; server: unknown } => origin as { kind: unknown; server: unknown }

/**
 * A session.append row that may hold channel messages: the main conversation's user row,
 * from a channel, or a delivery folded into a running turn that carries channel tags.
 * Tool results and rows typed at the terminal are never read.
 */
export const appendChannelText = (e: AppendLike): { text: string; server: string | null } | null => {
  if (e.agentId !== undefined || e.message.type !== 'user') return null
  if (e.door !== 'delivery' && e.door !== 'prompt') return null
  const origin = originOf(e.origin)
  if (origin.kind === 'composer') return null
  const text = e.message.content
    .map(b => {
      if (typeof b !== 'object' || b === null) return ''
      const block = b as { type?: unknown; text?: unknown }
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .join('\n')
  if (origin.kind === 'channel' && typeof origin.server === 'string') return { text, server: origin.server }
  return text.includes('<channel') ? { text, server: null } : null
}

// ---------- the reply ledger ----------

export type Ledger = { pending: Pending[]; seen: string[] }

/** New messages become pending; one seen before (even replied to) is never added again. */
export const addPending = (ledger: Ledger, messages: readonly ChannelMessage[], now: number): Ledger => {
  const seen = new Set(ledger.seen)
  const added: Pending[] = []
  for (const msg of messages) {
    if (seen.has(msg.key)) continue
    seen.add(msg.key)
    added.push({ ...msg, at: now, isAlerted: false })
  }
  if (added.length === 0) return ledger
  return { pending: [...ledger.pending, ...added], seen: [...seen].slice(-SEEN_LIMIT) }
}

/** A reply clears its server's messages that arrived by `before`: one chat's, or the whole server's. */
export const clearByReply = (pending: readonly Pending[], target: ReplyTarget, before: number): Pending[] =>
  pending.filter(
    p => !(sameServer(p.server, target.server) && (target.chatId === null || p.chatId === target.chatId) && p.at <= before),
  )

/** Messages that just passed the alert line and were not announced yet, marked announced. */
export const dueAlerts = (
  pending: readonly Pending[],
  now: number,
  alertMs: number,
): { pending: Pending[]; due: Pending[] } => {
  const due: Pending[] = []
  const next = pending.map(p => {
    if (p.isAlerted || now - p.at < alertMs) return p
    due.push(p)
    return { ...p, isAlerted: true }
  })
  return { pending: due.length === 0 ? [...pending] : next, due }
}

/** The one toast a message gets when it has waited past the alert line. */
export const waitingToast = (cfg: Config, p: Pending): string =>
  `Inbox: a message has waited ${Math.round(cfg.waitingAlertMs / MINUTE)}m without a reply (${channelLabel(cfg, p.server, p.chatId)})`

// ---------- servers, channel names and reply tools ----------

/** How an MCP tool name spells a server name: anything but letters, digits, _ and - becomes _. */
export const serverKey = (server: string): string => server.replace(/[^A-Za-z0-9_-]/g, '_')

const sameServer = (a: string, b: string): boolean => serverKey(a) === serverKey(b)

/** The server's short name: its last `:` part (plugin:discord:discord -> discord). */
export const serverShort = (server: string): string => server.split(':').filter(Boolean).pop() ?? server

export const channelLabel = (cfg: Config, server: string, chatId: string): string => {
  const short = serverShort(server)
  if (!chatId) return short
  return `${short} #${cfg.channelNames.get(chatId) ?? chatId.slice(-4)}`
}

export type ReplyTarget = { server: string; chatId: string | null }

/**
 * Whether a tool call replies to a channel, and to which: an MCP tool ending in __reply or
 * __voice_reply (or one listed in replyTools) clears its own server's messages, one chat's
 * when the input names a chat_id.
 */
export const replyTarget = (cfg: Config, tool: string, input: Readonly<Record<string, unknown>>): ReplyTarget | null => {
  if (!tool.startsWith('mcp__')) return null
  const isListed = cfg.replyTools.size > 0 ? cfg.replyTools.has(tool) : /__(voice_)?reply$/.test(tool)
  if (!isListed) return null
  const server = tool.slice('mcp__'.length, tool.lastIndexOf('__'))
  if (!server) return null
  const chatId = typeof input['chat_id'] === 'string' && input['chat_id'] ? input['chat_id'] : null
  return { server, chatId }
}

// ---------- action labels ----------

const RUNTIME = /--runtime[\s=]+["']?([A-Za-z0-9_.-]+)/

export const runtimeLabel = (cfg: Config, runtime: string): string => cfg.runtimeNames.get(runtime) ?? runtime

/** The label a tool call shows under Now. */
export const labelFor = (cfg: Config, tool: string, input: Readonly<Record<string, unknown>>): string => {
  const description = typeof input['description'] === 'string' ? input['description'].trim() : ''
  if (tool === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : ''
    if (cfg.dispatchPattern !== null && cfg.dispatchPattern.test(command)) {
      const runtime = RUNTIME.exec(command)?.[1]
      return runtime ? `dispatch -> ${runtimeLabel(cfg, runtime)}` : 'dispatch'
    }
    return `Bash "${cut(description || command.trim() || 'command', 24)}"`
  }
  if (tool === 'Agent' || tool === 'Task') return `agent ${cut(description || 'task', 24)}`
  if (tool.startsWith('mcp__')) return tool.split('__').pop() || tool
  return tool
}

/** Inside a subagent only dispatches are tracked; the rest is covered by its Agent row. */
export const isTrackedInSubagent = (label: string): boolean => label.startsWith('dispatch')

// ---------- subagents ----------

/** The Agent tool's result: async_launched (with agentId) runs in the background, remote_launched in the cloud. */
export const launchOf = (result: unknown): { isBackground: boolean; agentId: string | null; status: string | null } => {
  if (typeof result !== 'object' || result === null) return { isBackground: false, agentId: null, status: null }
  const r = result as { status?: unknown; agentId?: unknown }
  if (r.status === 'async_launched') {
    return { isBackground: true, agentId: typeof r.agentId === 'string' ? r.agentId : null, status: 'running' }
  }
  if (r.status === 'remote_launched') return { isBackground: true, agentId: null, status: 'remote' }
  return { isBackground: false, agentId: null, status: null }
}

/** Background agents take their status from $.agent.list(): by agentId, else the newest of the same description. */
export const mergeAgentStatus = (
  runs: readonly AgentRun[],
  infos: readonly { id: string; description: string; status: string }[],
): AgentRun[] =>
  runs.map(run => {
    if (!run.isBackground || run.status === 'remote') return run
    const info =
      infos.find(one => run.agentId !== null && one.id === run.agentId) ??
      [...infos].reverse().find(one => one.description === run.description)
    return info === undefined ? run : { ...run, status: info.status }
  })

// ---------- context ----------

/** The next mark for a new reading, and whether this reading crossed the warning line. */
export const contextTransition = (
  prev: ContextMark,
  percent: number | null,
  warn: number,
): { mark: ContextMark; shouldAlert: boolean } => {
  if (percent === null) return { mark: { ...prev, percent: null }, shouldAlert: false }
  if (percent < warn) return { mark: { percent, isAlerted: false }, shouldAlert: false }
  return { mark: { percent, isAlerted: true }, shouldAlert: !prev.isAlerted }
}

// ---------- text and width ----------

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0x303e) ||
  (cp >= 0x3041 && cp <= 0x33ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xa000 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** Terminal cells: wide (CJK, full-width, emoji) characters take two. */
export const displayWidth = (s: string): number => {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

/** Cut to `width` cells, ending in `~` when cut (ASCII, so every terminal font has it). */
export const truncateWidth = (s: string, width: number): string => {
  if (width <= 0) return ''
  if (displayWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out.trimEnd()}~`
}

/** Cut to `n` characters, ending in `~` when cut. */
export const cut = (s: string, n: number): string => {
  const chars = [...s]
  return chars.length <= n ? s : `${chars.slice(0, n).join('')}~`
}

/** 0m -> "<1m", 12m -> "12m", 125m -> "2h05m". */
export const duration = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / MINUTE)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** HH:MM in the configured time zone (UTC when none, or when the zone is unknown). */
export const clockTime = (ms: number | null, timeZone: string): string => {
  if (ms === null) return '--:--'
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone || 'UTC',
    }).format(new Date(ms))
  } catch {
    const d = new Date(ms)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  }
}
