import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { STATUS_DIVIDER } from '../hooks/view'
import { MIN, T0, band, ok, pane, renderText, start, toggle, world } from './kit'
import type { World } from './kit'

const iso = (ms: number): string => new Date(ms).toISOString()

const SCHEDULE = (next: string) =>
  JSON.stringify({
    summary: `next ${next} nightly-report-run · 1 failed`,
    items: [
      { mark: 'idle', text: 'nightly-report-run', right: next },
      { mark: 'idle', text: 'db-backup', right: '18:00' },
      { mark: 'failed', text: 'disk-usage-check-daily', right: 'last 05:30' },
    ],
    empty: 'no jobs',
  })

const ON = {
  options: {
    statusLine: true,
    customCards: 'WAITING=waiting-tool;;SCHEDULE=schedule-tool',
    timeZone: 'Asia/Singapore',
  },
}

const scheduled = (on: Parameters<typeof world>[0], next = { at: '12:30' }): World => {
  const w = world(on, argv => ok(argv[0] === 'schedule-tool' ? SCHEDULE(next.at) : JSON.stringify({ items: [] })))
  w.rateLimits = [
    { kind: 'five_hour', percentUsed: 58, resetsAt: iso(T0 + 70 * MIN) },
    { kind: 'seven_day', percentUsed: 61, resetsAt: iso(T0 + 3 * 24 * 60 * MIN) },
  ]
  return w
}

const last = (w: World): string | undefined => w.status[w.status.length - 1]

const measure = ($: Engine, percent: number, rate?: number) =>
  $.session.measure({
    context: { window: 200_000, tokens: percent * 2000, percent },
    rateLimits: rate === undefined ? [] : [{ kind: 'five_hour', percentUsed: rate, resetsAt: iso(T0 + 70 * MIN) }],
    changed: rate === undefined ? ['context'] : ['context', 'rateLimits'],
  })

const prompt = ($: Engine, mode: string, agentId?: string) =>
  $.classic.UserPromptSubmit({ prompt: 'p', permission_mode: mode, ...(agentId === undefined ? {} : { agent_id: agentId }) } as Parameters<
    Engine['classic']['UserPromptSubmit']
  >[0])

test('off by default: the mod only clears a line a previous load may have left, and the band and pane are unchanged', { options: { customCards: 'SCHEDULE=schedule-tool' } }, async ($, on) => {
  const w = scheduled(on)
  await start($)
  await measure($, 40)
  expect(w.status).toEqual([undefined])
  expect(w.runs).toEqual([])
  const ui = await $.ui.mount(band(200))
  expect(renderText(await ui.drawn(), 200).join('')).toBe(' · INBOX 0  │  · NOW idle  │  ● QUOTA week 61%  │  no reply yet')
  await ui.unmount()
})

test('on: State is model, context left, tightest quota, permission mode; Subinfo after │ is the SCHEDULE card read with the pane closed', ON, async ($, on) => {
  const w = scheduled(on)
  await start($)
  // The schedule command runs for the status line although the pane is closed; the other card does not.
  expect(w.runs).toEqual([['schedule-tool']])
  await measure($, 42)
  // No hook event has carried the permission mode yet: the part is left out, not guessed.
  expect(last(w)).toBe('Model One · ctx 58% left · quota week 61% │ SCHEDULE 3 · next 12:30 nightly-report-run · 1 failed')
  await prompt($, 'bypassPermissions')
  expect(last(w)).toBe('Model One · ctx 58% left · quota week 61% · bypass permissions │ SCHEDULE 3 · next 12:30 nightly-report-run · 1 failed')
  expect(last(w)?.split(STATUS_DIVIDER).length).toBe(2)
})

test('context and quota follow session.measure, with ! and !! past their lines; a subagent\'s permission mode is ignored; default is not shown', ON, async ($, on) => {
  const w = scheduled(on)
  await start($)
  await prompt($, 'acceptEdits')
  await measure($, 75)
  expect(last(w)).toContain('ctx 25% left ! · quota week 61% · accept edits')
  await measure($, 88, 93)
  expect(last(w)).toContain('ctx 12% left !! · quota 5h 93% !! · accept edits')
  await prompt($, 'plan', 'sub-1')
  expect(last(w)).toContain('accept edits')
  await prompt($, 'default')
  expect(last(w)).toBe('Model One · ctx 12% left !! · quota 5h 93% !! │ SCHEDULE 3 · next 12:30 nightly-report-run · 1 failed')
})

test('a schedule change reaches the status line at the next 60 s refresh, pane closed or open', ON, async ($, on) => {
  const next = { at: '12:30' }
  const w = scheduled(on, next)
  await start($)
  next.at = '13:00'
  await w.clock.advance(MIN)
  expect(last(w)).toContain('SCHEDULE 3 · next 13:00 nightly-report-run')
  await toggle($)
  next.at = '14:00'
  await w.clock.advance(MIN)
  expect(last(w)).toContain('SCHEDULE 3 · next 14:00 nightly-report-run')
  // The pane still shows its cards as before.
  const ui = await $.ui.mount(pane(60, 200))
  expect(renderText(await ui.drawn(), 60).join('\n')).toMatch(/SCHEDULE\s+3 · 1 failed │/)
  await ui.unmount()
})

test('statusLineState picks the State parts and their order; an empty Subinfo drops the divider; nothing to say clears the line', { options: { ...ON.options, statusLineState: 'mode, quota', statusLineSubinfo: '' } }, async ($, on) => {
  const w = scheduled(on)
  await start($)
  expect(last(w)).toBe('quota week 61%')
  await prompt($, 'plan')
  expect(last(w)).toBe('plan mode · quota week 61%')
  expect(last(w)).not.toContain(STATUS_DIVIDER.trim())
})

test('with no State parts and no Subinfo there is nothing to pin, so the line is cleared', { options: { statusLine: true, statusLineState: '', statusLineSubinfo: '' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await measure($, 50)
  expect(w.status.length).toBeGreaterThan(0)
  expect(w.status.every(text => text === undefined)).toBe(true)
})

test('the Subinfo can be any card: running, with its count first', { options: { statusLine: true, statusLineState: 'model', statusLineSubinfo: 'running' } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(last(w)).toBe('Model One │ RUNNING · idle')
})
