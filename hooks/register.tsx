// agent-monitor: a band above the prompt and a /monitor pane, both drawn from one model.
// Every hook only observes: it passes its event on with next(e) unchanged and keeps its own
// errors to itself (a debug log line), so the session's tools and prompts never feel it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Action, AgentRun, ContextMark, CustomView, DispatchView, Pending, Placement, QuotaView, RecentRun, SessionInfo, StatusInfo } from '../types'
import { parseConfig, resolveCards } from './config'
import type { Config } from './config'
import { dispatchArgv, dispatchFromRun, oneLine } from './dispatch'
import {
  addPending,
  appendChannelText,
  clearByReply,
  contextTransition,
  dueAlerts,
  isTrackedInSubagent,
  labelFor,
  launchOf,
  mergeAgentStatus,
  parseChannelMessages,
  replyTarget,
  waitingToast,
} from './logic'
import type { ChannelMessage } from './logic'
import { buildModel } from './model'
import type { ModelInput } from './model'
import { cardIds, cardOfKey, monitorHint, movedOrder, parseMonitorArgs, rowsAfter, storedIds, storedPlacement } from './arrange'
import { customFromRun, emptyCustom } from './custom'
import { RECENT_MIN_MS, RECORDED_TOOLS, addRecent, endedAgents, storedRecent } from './recent'
import { arrangedOrder, cardInner, cardTitle, layoutPane, paneDoc } from './pane'
import type { PaneOptions } from './pane'
import { claudeRows, quotaFromRun } from './quota'
import { TOGGLE, bandExtras, bandLine, bandSegments, statusLineText, textProps } from './view'
import type { Line } from './view'

const PANE = 'agent-monitor'
const TICK_MS = 30_000
const PANE_REFRESH_MS = 60_000
const COMMAND_TIMEOUT_MS = 20_000

const pendingA = atom({ plugin: 'agent-monitor', key: 'pending' } as const, [] as Pending[])
const seenA = atom({ plugin: 'agent-monitor', key: 'seen' } as const, [] as string[])
const lastReplyA = atom({ plugin: 'agent-monitor', key: 'lastReplyAt' } as const, null as number | null)
const actionsA = atom({ plugin: 'agent-monitor', key: 'actions' } as const, [] as Action[])
const tickA = atom({ plugin: 'agent-monitor', key: 'tick' } as const, 0)
const contextA = atom({ plugin: 'agent-monitor', key: 'context' } as const, { percent: null, isAlerted: false } as ContextMark)
const dispatchA = atom({ plugin: 'agent-monitor', key: 'dispatch' } as const, { rows: [], error: null, fetchedAt: null } as DispatchView)
const agentsA = atom({ plugin: 'agent-monitor', key: 'agents' } as const, [] as AgentRun[])
const customA = atom({ plugin: 'agent-monitor', key: 'custom' } as const, [] as CustomView[])
const sessionA = atom({ plugin: 'agent-monitor', key: 'session' } as const, {
  startedAt: null,
  wakeAt: null,
  wakeText: '',
  compactCount: 0,
  compactAt: null,
} as SessionInfo)
const expandedA = atom({ plugin: 'agent-monitor', key: 'expanded' } as const, {} as Record<string, boolean>)
const STORE_EXPANDED = 'expanded'
const STORE_HIDDEN = 'hidden'
const STORE_ROWS = 'rows'
const hiddenA = atom({ plugin: 'agent-monitor', key: 'hidden' } as const, [] as string[])
const rowsA = atom({ plugin: 'agent-monitor', key: 'rows' } as const, {} as Record<string, number>)
const quotaA = atom({ plugin: 'agent-monitor', key: 'quota' } as const, { claude: [], external: [], error: null, fetchedAt: null } as QuotaView)
const recentA = atom({ plugin: 'agent-monitor', key: 'recent' } as const, [] as RecentRun[])
const orderA = atom({ plugin: 'agent-monitor', key: 'order' } as const, [] as string[])
const placementA = atom({ plugin: 'agent-monitor', key: 'placement' } as const, {} as Record<string, Placement>)
const arrangingA = atom({ plugin: 'agent-monitor', key: 'arranging' } as const, false)
const selectedA = atom({ plugin: 'agent-monitor', key: 'selected' } as const, null as string | null)
const revealA = atom({ plugin: 'agent-monitor', key: 'revealHidden' } as const, false)
const statusA = atom({ plugin: 'agent-monitor', key: 'status' } as const, { model: null, permissionMode: null } as StatusInfo)
const STORE_RECENT = 'recent'
const STORE_ORDER = 'order'
const STORE_PLACEMENT = 'placement'
const QUOTA_TIMEOUT_MS = 10_000
const CUSTOM_TIMEOUT_MS = 10_000
/** How long after a dispatch command starts before its DispatchStarted event is read. */
const DISPATCH_SETTLE_MS = 5_000
const storeSessionKey = (startedAt: number): string => `session:${startedAt}`

type $ = EngineInterface

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const logError = ($: $, where: string, err: unknown): void => {
  try {
    $.ui.log(`agent-monitor ${where}: ${oneLine(errText(err))}`, { to: 'debug' })
  } catch {
    // Not even the debug log: give up quietly.
  }
}

// ---------- the inbox ----------

const recordMessages = async ($: $, messages: readonly ChannelMessage[]): Promise<void> => {
  if (messages.length === 0) return
  const now = await $.clock.now()
  let added: Pending[] = []
  await update($, seenA, seen => {
    const ledger = addPending({ pending: [], seen }, messages, now)
    added = ledger.pending
    return ledger.seen
  })
  if (added.length > 0) await update($, pendingA, list => [...list, ...added])
}

const onTick = async ($: $, cfg: Config): Promise<void> => {
  try {
    const now = await $.clock.now()
    await update($, tickA, () => now)
    let due: Pending[] = []
    await update($, pendingA, list => {
      const result = dueAlerts(list, now, cfg.waitingAlertMs)
      due = result.due
      return result.pending
    })
    for (const p of due) $.ui.toast(waitingToast(cfg, p), { timeoutMs: 10_000 })
  } catch (err) {
    logError($, 'tick', err)
  }
}

// ---------- dispatches and subagents (pane refresh) ----------

/**
 * When the running refresh started. A refresh whose `$` call never settles (its timer dispatch
 * abandoned) must not block every later one, so a flag older than REFRESH_STALE_MS is ignored.
 */
let refreshingSince: number | null = null
const REFRESH_STALE_MS = 45_000

const readDispatches = async ($: $, cfg: Config, now: number): Promise<DispatchView> => {
  try {
    return dispatchFromRun(cfg, await $.process.run(dispatchArgv(cfg, now), { timeoutMs: COMMAND_TIMEOUT_MS }), now)
  } catch (err) {
    return { rows: [], error: oneLine(errText(err)), fetchedAt: now }
  }
}

const readCustom = async ($: $, card: Config['customCards'][number], now: number): Promise<CustomView> => {
  const base = { ...emptyCustom(card), fetchedAt: now }
  try {
    return customFromRun(base, await $.process.run(card.argv, { timeoutMs: CUSTOM_TIMEOUT_MS }))
  } catch (err) {
    return { ...base, error: oneLine(errText(err)) }
  }
}

const hasQuota = async ($: $, cfg: Config): Promise<boolean> => cfg.quotaArgv.length > 0 || (await read($, quotaA)).claude.length > 0

/** The card ids drawn now (QUOTA appears once Claude reports its windows). */
const liveCardIds = async ($: $, cfg: Config): Promise<string[]> => cardIds(cfg, await hasQuota($, cfg))

/** Expands or collapses cards (`all` for every one), kept in $.state and $.store. */
const setExpanded = async ($: $, cfg: Config, which: string, isExpanded: boolean): Promise<string[]> => {
  const match = resolveCards(await liveCardIds($, cfg), which)
  if ('error' in match) return []
  const target = match.ids
  const next: Record<string, boolean> = { ...(await read($, expandedA)), ...Object.fromEntries(target.map(id => [id, isExpanded])) }
  await update($, expandedA, () => next)
  await $.store.set(STORE_EXPANDED, next)
  return target
}

/** /monitor hide|show|rows: the answer line for the person. */
const arrangeCards = async ($: $, cfg: Config, verb: string, which: string, value: string | undefined): Promise<string> => {
  const match = resolveCards(await liveCardIds($, cfg), which)
  if ('error' in match) return match.error
  const target = match.ids
  if (verb === 'hide' || verb === 'show') {
    if (verb === 'hide' && which === 'all') return 'Hide cards one at a time; the header card always stays.'
    await saveHidden($, list => (verb === 'hide' ? [...new Set([...list, ...target])] : list.filter(id => !target.includes(id))))
    return `${verb === 'hide' ? 'Hidden' : 'Shown'}: ${target.join(', ')}.`
  }
  const rows = rowsAfter(await read($, rowsA), target, value)
  if ('error' in rows) return rows.error
  await update($, rowsA, () => rows.next)
  await $.store.set(STORE_ROWS, rows.next)
  return rows.text
}

// ---------- quota ----------

/** Like refreshingSince, for the quota command alone: one hung read never blocks the next. */
let quotaSince: number | null = null

const readQuota = async ($: $, cfg: Config): Promise<Pick<QuotaView, 'external' | 'error'> | { error: string }> => {
  try {
    return quotaFromRun(await $.process.run(cfg.quotaArgv, { timeoutMs: QUOTA_TIMEOUT_MS }))
  } catch (err) {
    return { error: oneLine(errText(err)) }
  }
}

/**
 * Claude's windows from $.session.usage(), then the quotaCommand when one is set. A failing command
 * keeps its last rows (they turn stale on their own) and only the QUOTA card shows why.
 */
const readClaudeQuota = async ($: $): Promise<void> => {
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const rows = claudeRows(usage.rateLimits ?? [], now)
    await update($, quotaA, q => ({ ...q, claude: rows }))
  } catch (err) {
    logError($, 'session.usage', err)
  }
}

const refreshQuota = async ($: $, cfg: Config): Promise<void> => {
  try {
    await readClaudeQuota($)
    const now = await $.clock.now()
    if (cfg.quotaArgv.length > 0 && (quotaSince === null || now - quotaSince >= REFRESH_STALE_MS)) {
      quotaSince = now
      try {
        const read = await readQuota($, cfg)
        await update($, quotaA, q => ({ ...q, ...read, fetchedAt: now }))
      } finally {
        if (quotaSince === now) quotaSince = null
      }
    }
    if (cfg.statusLine) await readStatusSources($, cfg).then(() => pushStatus($, cfg))
  } catch (err) {
    logError($, 'quota', err)
  }
}

// ---------- the status line ($.ui.status) ----------

/** The model's name and, until a measurement comes, context use; the Subinfo card's command while the pane is closed. */
const readStatusSources = async ($: $, cfg: Config): Promise<void> => {
  const model = await $.session.model()
  if ((await read($, statusA)).model !== model) await update($, statusA, s => ({ ...s, model }))
  const { percent } = (await $.session.usage()).context
  if (typeof percent === 'number') await update($, contextA, c => (c.percent === null ? { percent, isAlerted: percent >= cfg.contextWarn } : c))
  const card = cfg.customCards.find(one => one.id === cfg.statusLineSubinfo)
  if (card === undefined || (await isPaneOpen($))) return // the pane's own refresh reads it then
  const view = await readCustom($, card, await $.clock.now())
  await update($, customA, list => list.map(one => (one.id === card.id ? view : one)))
}

/** Pins the status line, or clears it when it is off or knows nothing yet. */
const pushStatus = async ($: $, cfg: Config): Promise<void> => {
  try {
    if (!cfg.statusLine) return $.ui.status(undefined)
    const model = await readModel($, cfg)
    const sub = paneDoc(model, 200, cfg.timeZone, await paneOptions($, cfg)).all.find(c => c.id === cfg.statusLineSubinfo) ?? null
    $.ui.status(statusLineText(model, cfg.statusLineState, await read($, statusA), sub))
  } catch (err) {
    logError($, 'status line', err)
  }
}

/** The permission mode a classic hook event carries (main conversation only); unknown until one does. */
const notePermissionMode = async ($: $, cfg: Config, e: { agent_id?: string; permission_mode?: string }): Promise<void> => {
  const mode = e.permission_mode
  if (e.agent_id !== undefined || typeof mode !== 'string' || (await read($, statusA)).permissionMode === mode) return
  await update($, statusA, s => ({ ...s, permissionMode: mode }))
  await pushStatus($, cfg)
}

// ---------- recently ended runs ----------

const saveRecent = async ($: $, run: RecentRun): Promise<void> => {
  let next: RecentRun[] = []
  await update($, recentA, list => {
    next = addRecent(list, run)
    return next
  })
  await $.store.set(STORE_RECENT, next)
}

/** Background subagents end after their call does: once $.agent.list() says so, they join recent. */
const recordEndedAgents = async ($: $, cfg: Config, now: number): Promise<void> => {
  let ended: RecentRun[] = []
  await update($, agentsA, runs => {
    const result = endedAgents(runs, now, run => labelFor(cfg, 'Agent', { description: run.description }))
    ended = result.ended
    return result.runs
  })
  for (const run of ended) await saveRecent($, run)
}

/** Reads what the pane shows; `isOpening` also runs the quotaCommand, which otherwise keeps its own 60 s timer. */
const refreshPane = async ($: $, cfg: Config, isOpening = false): Promise<void> => {
  const now = await $.clock.now()
  if (refreshingSince !== null && now - refreshingSince < REFRESH_STALE_MS) return
  refreshingSince = now
  try {
    await update($, tickA, () => now)
    if (cfg.dispatchArgv.length > 0) {
      const view = await readDispatches($, cfg, now)
      await update($, dispatchA, () => view)
    }
    for (const card of cfg.customCards) {
      const view = await readCustom($, card, now)
      await update($, customA, list => list.map(one => (one.id === card.id ? view : one)))
    }
    await (isOpening ? refreshQuota($, cfg) : readClaudeQuota($))
    if (cfg.statusLine && !isOpening) await pushStatus($, cfg) // the cards it read may feed the Subinfo
    try {
      const infos = await $.agent.list()
      await update($, agentsA, runs => mergeAgentStatus(runs, infos))
      await recordEndedAgents($, cfg, now)
    } catch (err) {
      logError($, 'agent.list', err)
    }
  } catch (err) {
    logError($, 'refresh', err)
  } finally {
    if (refreshingSince === now) refreshingSince = null
  }
}

const isPaneOpen = async ($: $): Promise<boolean> => (await $.ui.panes()).some(pane => pane.id === PANE)

const onPaneTimer = async ($: $, cfg: Config): Promise<void> => {
  try {
    if (await isPaneOpen($)) await refreshPane($, cfg)
  } catch (err) {
    logError($, 'pane timer', err)
  }
}

// ---------- arranging cards ----------

/** The pane options both views lay the cards out with: what the person set, by command or button. */
const paneOptions = async ($: $, cfg: Config): Promise<PaneOptions> => ({
  customMaxItems: cfg.customCardMaxItems,
  rows: await read($, rowsA),
  hidden: await read($, hiddenA),
  order: await read($, orderA),
  placement: await read($, placementA),
  recentRows: cfg.recentRows,
  isArranging: await read($, arrangingA),
  selected: await read($, selectedA),
  isHiddenRevealed: await read($, revealA),
})

// Person-driven changes (a press, a command) come one at a time, so read-then-write is safe here.
const saveHidden = async ($: $, change: (list: string[]) => string[]): Promise<void> => {
  const next = change(await read($, hiddenA))
  await update($, hiddenA, () => next)
  await $.store.set(STORE_HIDDEN, next)
}

/** Moves a card one place up or down among the cards not hidden, kept in $.store. */
const moveCard = async ($: $, cfg: Config, id: string, by: -1 | 1): Promise<void> => {
  const full = arrangedOrder(await liveCardIds($, cfg), await read($, orderA))
  const next = movedOrder(full, await read($, hiddenA), id, by)
  if (next === null) return
  await update($, orderA, () => next)
  await $.store.set(STORE_ORDER, next)
}

const togglePlacement = async ($: $, id: string): Promise<void> => {
  const map = await read($, placementA)
  const next: Record<string, Placement> = { ...map, [id]: map[id] === 'band' ? 'pane' : 'band' }
  await update($, placementA, () => next)
  await $.store.set(STORE_PLACEMENT, next)
}

/** What a pane Button does, by its key: Arrange/Done, the four arrange buttons, and the hidden-card buttons. */
const press = async ($: $, cfg: Config, key: string): Promise<void> => {
  try {
    const [verb = '', id = ''] = key.split(/:(.*)/s)
    if (key === 'arrange') {
      const isArranging = await read($, arrangingA)
      await update($, arrangingA, () => !isArranging)
      await update($, selectedA, () => null)
    } else if (key === 'reveal-hidden') {
      await update($, revealA, is => !is)
    } else if (verb === 'up' || verb === 'down') {
      await moveCard($, cfg, id, verb === 'up' ? -1 : 1)
      await update($, selectedA, () => id)
    } else if (verb === 'place') {
      await togglePlacement($, id)
      await update($, selectedA, () => id)
    } else if (verb === 'hide') {
      await saveHidden($, list => [...new Set([...list, id])])
      await update($, selectedA, () => null)
    } else if (verb === 'show') {
      await saveHidden($, list => list.filter(one => one !== id))
      if ((await read($, hiddenA)).length === 0) await update($, revealA, () => false)
    }
  } catch (err) {
    logError($, `press ${key}`, err)
  }
}

// ---------- the session card ----------

/**
 * The session's start comes from the engine ($.session.usage().startedAt: its launch, or its first
 * launch when resumed), so a hot reload never resets it; wake and compaction figures are kept in
 * $.store under that start too, and restored when the module's state comes back empty.
 */
const restoreSession = async ($: $): Promise<void> => {
  const { startedAt } = await $.session.usage()
  const saved = (await $.store.get(storeSessionKey(startedAt))) as Partial<SessionInfo> | undefined
  await update($, sessionA, info => {
    const isSameSession = info.startedAt === startedAt
    const kept = isSameSession ? info : { ...info, wakeAt: null, wakeText: '', compactCount: 0, compactAt: null }
    return { ...kept, ...(isSameSession ? {} : (saved ?? {})), startedAt }
  })
  for (const key of await $.store.keys()) {
    if (key.startsWith('session:') && key !== storeSessionKey(startedAt)) await $.store.delete(key)
  }
}

const saveSession = async ($: $, change: (info: SessionInfo) => SessionInfo): Promise<void> => {
  let next: SessionInfo | null = null
  await update($, sessionA, info => {
    next = change(info)
    return next
  })
  const done = next as SessionInfo | null
  if (done !== null && done.startedAt !== null) await $.store.set(storeSessionKey(done.startedAt), done)
}

// ---------- tool calls ----------

type Tracked = { action: Action | null; agentRun: AgentRun | null; startedAt: number }

const beginCall = async (
  $: $,
  cfg: Config,
  tool: string,
  input: Record<string, unknown>,
  loop: string | undefined,
  id: string | undefined,
): Promise<Tracked> => {
  const startedAt = await $.clock.now()
  const label = labelFor(cfg, tool, input)
  const callId = id ?? `${tool}-${startedAt}-${Math.random().toString(36).slice(2)}`
  let action: Action | null = null
  if (loop === undefined || isTrackedInSubagent(label)) {
    const one: Action = { id: callId, tool, label, startedAt }
    action = one
    await update($, actionsA, list => [...list, one].slice(-50))
  }
  let agentRun: AgentRun | null = null
  if ((tool === 'Agent' || tool === 'Task') && loop === undefined) {
    const description = typeof input['description'] === 'string' ? input['description'] : 'task'
    const run: AgentRun = { id: callId, description, startedAt, endedAt: null, isBackground: false, agentId: null, status: null }
    agentRun = run
    await update($, agentsA, list => [...list, run].slice(-30))
  }
  return { action, agentRun, startedAt }
}

const endCall = async ($: $, tracked: Tracked, hasFailed: boolean, result: unknown): Promise<void> => {
  const { action, agentRun } = tracked
  if (action !== null) await update($, actionsA, list => list.filter(one => one.id !== action.id))
  const launch = launchOf(result)
  if (action !== null && RECORDED_TOOLS.has(action.tool) && !(agentRun !== null && launch.isBackground)) {
    const endedAt = await $.clock.now()
    if (endedAt - action.startedAt >= RECENT_MIN_MS) {
      await saveRecent($, { id: action.id, label: action.label, startedAt: action.startedAt, endedAt, status: hasFailed ? 'failed' : 'done' })
    }
  }
  if (agentRun === null) return
  const endedAt = await $.clock.now()
  await update($, agentsA, list =>
    list.map(one =>
      one.id !== agentRun.id
        ? one
        : {
            ...one,
            endedAt,
            isBackground: launch.isBackground,
            agentId: launch.agentId,
            status: hasFailed ? 'failed' : launch.isBackground ? launch.status : 'completed',
          },
    ),
  )
}

const noteReply = async ($: $, cfg: Config, tool: string, input: Record<string, unknown>, startedAt: number) => {
  const target = replyTarget(cfg, tool, input)
  if (target === null) return
  await update($, pendingA, list => clearByReply(list, target, startedAt))
  const now = await $.clock.now()
  await update($, lastReplyA, () => now)
}

const readModel = async ($: $, cfg: Config) => {
  await read($, tickA)
  const now = await $.clock.now()
  const input: ModelInput = {
    pending: await read($, pendingA),
    lastReplyAt: await read($, lastReplyA),
    actions: await read($, actionsA),
    context: await read($, contextA),
    agents: await read($, agentsA),
    dispatch: await read($, dispatchA),
    custom: await read($, customA),
    session: await read($, sessionA),
    quota: await read($, quotaA),
    recent: await read($, recentA),
  }
  return buildModel(input, now, cfg)
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, actionsA, () => [])
      await update($, tickA, () => now)
      await restoreSession($)
      await update($, customA, list => cfg.customCards.map(card => list.find(one => one.id === card.id) ?? emptyCustom(card)))
      const savedHidden = await $.store.get(STORE_HIDDEN)
      if (Array.isArray(savedHidden)) await update($, hiddenA, () => savedHidden.filter((x): x is string => typeof x === 'string'))
      const savedRows = await $.store.get(STORE_ROWS)
      if (typeof savedRows === 'object' && savedRows !== null) await update($, rowsA, () => savedRows as Record<string, number>)
      const saved = await $.store.get(STORE_EXPANDED)
      if (typeof saved === 'object' && saved !== null) await update($, expandedA, () => saved as Record<string, boolean>)
      const savedOrder = storedIds(await $.store.get(STORE_ORDER))
      if (savedOrder !== null) await update($, orderA, () => savedOrder)
      const savedPlacement = storedPlacement(await $.store.get(STORE_PLACEMENT))
      if (savedPlacement !== null) await update($, placementA, () => savedPlacement)
      // Ended runs survive a reload: restored from the store, never cleared at start.
      const savedRecent = storedRecent(await $.store.get(STORE_RECENT))
      if (savedRecent !== null) await update($, recentA, () => savedRecent)
    } catch (err) {
      logError($, 'session.start', err)
    }
    try {
      await $.command.register({
        name: 'monitor',
        description: 'Toggle the agent monitor pane; expand or collapse its cards',
        argumentHint: monitorHint(cfg),
      })
    } catch (err) {
      logError($, 'command.register', err)
    }
    try {
      $.clock.every(TICK_MS, () => void onTick($, cfg))
      $.clock.every(PANE_REFRESH_MS, () => void onPaneTimer($, cfg))
      // The quota feeds the band too, so it is read whether the pane is open or not.
      $.clock.every(PANE_REFRESH_MS, () => void refreshQuota($, cfg))
      // Claude's own windows are read before the first draw; the command runs in the background.
      await readClaudeQuota($)
      if (cfg.statusLine) await readStatusSources($, cfg)
      await pushStatus($, cfg) // off: clears a line a previous load may have left
      void refreshQuota($, cfg)
      if (cfg.openOnStart && !(await isPaneOpen($))) {
        await $.ui.open({ id: PANE, title: 'Agent monitor' })
        void refreshPane($, cfg, true)
      }
    } catch (err) {
      logError($, 'timers', err)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin.kind === 'channel') await recordMessages($, parseChannelMessages(e.text, e.origin.server))
      const isWake = cfg.wakePattern !== null ? cfg.wakePattern.test(e.text) : e.origin.kind === 'scheduled-trigger'
      if (isWake) {
        const now = await $.clock.now()
        const wakeText = e.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        await saveSession($, info => ({ ...info, wakeAt: now, wakeText }))
      }
    } catch (err) {
      logError($, 'prompt.submit', err)
    }
    return next(e)
  })

  // Channel messages delivered into a running turn arrive here; ones prompt.submit saw too are deduplicated.
  on('session.append', async ($, e, next) => {
    try {
      const found = appendChannelText(e)
      if (found !== null) await recordMessages($, parseChannelMessages(found.text, found.server))
    } catch (err) {
      logError($, 'session.append', err)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    let tracked: Tracked = { action: null, agentRun: null, startedAt: 0 }
    try {
      tracked = await beginCall($, cfg, tool, input, e.agentId, e.tool_use_id)
      if (tracked.action?.label.startsWith('dispatch')) $.clock.after(DISPATCH_SETTLE_MS, () => void onPaneTimer($, cfg))
    } catch (err) {
      logError($, 'tool.call begin', err)
    }
    let ran: Awaited<ReturnType<typeof next>> | undefined
    let hasThrown = true
    try {
      ran = await next(e)
      hasThrown = false
    } finally {
      try {
        await endCall($, tracked, hasThrown || ran?.isError === true || ran?.deny !== undefined, ran?.result)
      } catch (err) {
        logError($, 'tool.call end', err)
      }
    }
    try {
      if (tracked.action?.label.startsWith('dispatch') && (await isPaneOpen($))) void refreshPane($, cfg)
      if (ran.deny === undefined && ran.isError !== true && tracked.startedAt > 0) {
        await noteReply($, cfg, tool, input, tracked.startedAt)
      }
    } catch (err) {
      logError($, 'tool.call reply', err)
    }
    return ran
  })

  // The permission mode reaches mods only on classic hook events: kept from each prompt, tool call and stop.
  if (cfg.statusLine) {
    on('classic.UserPromptSubmit', async ($, e, next) => (await notePermissionMode($, cfg, e).catch(err => logError($, 'mode', err)), next(e)))
    on('classic.PostToolUse', async ($, e, next) => (await notePermissionMode($, cfg, e).catch(err => logError($, 'mode', err)), next(e)))
    on('classic.Stop', async ($, e, next) => (await notePermissionMode($, cfg, e).catch(err => logError($, 'mode', err)), next(e)))
  }

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
        const now = await $.clock.now()
        await saveSession($, info => ({ ...info, compactCount: info.compactCount + 1, compactAt: now }))
      }
    } catch (err) {
      logError($, 'session.compact', err)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    try {
      const percent = typeof e.context.percent === 'number' ? e.context.percent : null
      let shouldAlert = false
      await update($, contextA, prev => {
        const t = contextTransition(prev, percent, cfg.contextWarn)
        shouldAlert = t.shouldAlert
        return t.mark
      })
      if (shouldAlert) {
        $.ui.toast(`Context usage passed ${cfg.contextWarn}% - consider restarting the session soon`, { timeoutMs: 10_000 })
      }
      if (e.changed.includes('rateLimits')) {
        const now = await $.clock.now()
        const rows = claudeRows(e.rateLimits, now)
        await update($, quotaA, q => ({ ...q, claude: rows }))
      }
      if (cfg.statusLine) await pushStatus($, cfg)
    } catch (err) {
      logError($, 'session.measure', err)
    }
    return next(e)
  })

  on('command.run', { command: 'monitor' }, async ($, e) => {
    try {
      const { verb, which, value } = parseMonitorArgs(e.args)
      if (verb === 'hide' || verb === 'show' || verb === 'rows') return { text: await arrangeCards($, cfg, verb, which, value) }
      if (verb === 'expand' || verb === 'collapse') {
        const match = resolveCards(await liveCardIds($, cfg), which)
        if ('error' in match) return { text: match.error }
        const ids = await setExpanded($, cfg, which, verb === 'expand')
        return { text: `${verb === 'expand' ? 'Expanded' : 'Collapsed'}: ${ids.join(', ')}.` }
      }
      if (await isPaneOpen($)) {
        await $.ui.close({ id: PANE })
        return { text: 'Agent monitor closed.' }
      }
      const opened = await $.ui.open({ id: PANE, title: 'Agent monitor' })
      await refreshPane($, cfg, true)
      return { text: opened.isPlaced ? 'Agent monitor opened.' : `Agent monitor opened, not shown yet: ${oneLine(opened.reason)}` }
    } catch (err) {
      logError($, 'monitor', err)
      return { text: `Agent monitor could not toggle: ${oneLine(errText(err))}` }
    }
  })

  // The band depends on whether the pane is open: redraw it when the pane closes, however it closes.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    try {
      const now = await $.clock.now()
      if (e.id === PANE) await update($, tickA, () => now)
    } catch (err) {
      logError($, 'ui.close', err)
    }
    return closed
  })

  // The arrange buttons' hotkeys follow the focus ring: the card it lands on takes u/d/b/h.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    try {
      const id = cardOfKey(e.element)
      if (id !== null) await update($, selectedA, () => id)
    } catch (err) {
      logError($, 'ui.focus', err)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const model = await readModel($, cfg)
      const opts = await paneOptions($, cfg)
      const doc = paneDoc(model, e.props.bodyColumns, cfg.timeZone, { ...opts, isArranging: false })
      const segments = bandSegments(model, await isPaneOpen($), bandExtras(model, opts, doc.band, cfg.timeZone))
      if (segments.length === 0) return next(e)
      const line = bandLine(segments, e.props.bodyColumns)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row">
          {line.map(run => (
            <Text {...textProps(run)}>{run.text}</Text>
          ))}
        </Box>
      )
    } catch (err) {
      logError($, 'render band', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    try {
      const model = await readModel($, cfg)
      const expanded = await read($, expandedA)
      const doc = paneDoc(model, e.props.bodyColumns, cfg.timeZone, await paneOptions($, cfg))
      const rows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : cfg.paneMaxRows
      const layout = layoutPane(doc, id => expanded[id] ?? !cfg.collapsedCards.has(id), rows)
      const inner = cardInner(e.props.bodyColumns)
      const row = (line: Line) => (
        <Box flexDirection="row">
          {line.map(run =>
            run.button === undefined ? (
              <Text wrap="truncate" {...textProps(run)}>
                {run.text}
              </Text>
            ) : (
              <Button
                key={run.button.key}
                plain
                label={run.button.label}
                {...(run.button.hotkey === undefined ? {} : { hotkey: run.button.hotkey })}
                onPress={() => press($, cfg, run.button?.key ?? '')}
              />
            ),
          )}
        </Box>
      )
      const card = (key: string, body: RenderChildren) => (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {body}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {card('head', layout.head.map(row))}
          {doc.arrange !== null && card('arrange', doc.arrange.map(row))}
          {layout.cards.map(({ card: one, isOpen, body }) => {
            const title = (
              <Box flexDirection="row">
                <Button
                  key={`toggle-${one.id}`}
                  plain
                  label={isOpen ? TOGGLE.expanded : TOGGLE.collapsed}
                  onPress={() => void setExpanded($, cfg, one.id, !isOpen)}
                />
                {row(cardTitle(one, inner))}
              </Box>
            )
            return card(one.id, [title, ...body.map(row)])
          })}
          {layout.showFooter && <Box flexDirection="column" paddingX={1}>{doc.footer.map(row)}</Box>}
        </Box>
      )
    } catch (err) {
      logError($, 'render pane', err)
      return (
        <Box>
          <Text color="yellow">Agent monitor could not draw: {oneLine(errText(err))}</Text>
        </Box>
      )
    }
  })
}
