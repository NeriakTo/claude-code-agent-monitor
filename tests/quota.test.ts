import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseQuotaOutput, resetText } from '../hooks/quota'
import { SYMBOLS } from '../hooks/view'
import { MIN, T0, band, ok, pane, renderText, start, toggle, world } from './kit'

const iso = (ms: number): string => new Date(ms).toISOString()

/** Claude's two windows: 58% resetting in 70 minutes, 61% resetting in 3 days. */
const CLAUDE = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: iso(T0 + 70 * MIN) },
  { kind: 'seven_day', percentUsed: 61, resetsAt: iso(T0 + 3 * 24 * 60 * MIN) },
]

const QUOTA = { options: { quotaCommand: 'quota-tool --json', timeZone: 'Asia/Singapore' } }

/** Two outside sources: Alpha fresh at 2%, Beta read 40 minutes ago with a 10 minute period (stale). */
const ROWS = JSON.stringify({
  rows: [
    { name: 'Alpha', usedPercent: 2, resetsAt: iso(T0 + 9 * 24 * 60 * MIN), fetchedAt: iso(T0 - 2 * MIN), maxAgeSeconds: 300 },
    { name: 'Beta', usedPercent: 95, resetsAt: '', fetchedAt: iso(T0 - 40 * MIN), maxAgeSeconds: 600 },
  ],
})

const lines = async ($: Engine, columns: number): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns, 200))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

const bandText = async ($: Engine, columns: number): Promise<string> => {
  const ui = await $.ui.mount(band(columns))
  const out = renderText(await ui.drawn(), columns).join('')
  await ui.unmount()
  return out
}

const offList = (text: string): string[] => [...new Set([...text].filter(ch => ch.charCodeAt(0) > 0x7e && !SYMBOLS.includes(ch)))]

const run = async ($: Engine, args: string): Promise<string | undefined> =>
  (await $.command.run({ command: 'monitor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })).text

test('Claude windows from $.session.usage: a QUOTA card first, gauges, aligned percents, reset times; the band shows the tightest', { options: { timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  w.rateLimits = CLAUDE
  await start($)
  await toggle($)
  const out = await lines($, 100)
  const text = out.join('\n')
  expect(text).toMatch(/- QUOTA\s+tightest 61%/)
  const five = out.find(l => l.includes('Claude 5h')) ?? ''
  const week = out.find(l => l.includes('Claude week')) ?? ''
  expect(five).toMatch(/Claude 5h\s+██████░░░░\s+58%\s+resets 13:10/)
  expect(week).toMatch(/Claude week\s+██████░░░░\s+61%\s+resets Thu 12:00/)
  expect(five.indexOf('%')).toBe(week.indexOf('%'))
  expect(text.indexOf(' QUOTA ')).toBeLessThan(text.indexOf(' INBOX '))
  expect(w.runs).toEqual([])
  await toggle($)
  expect(await bandText($, 200)).toBe(' · INBOX 0  │  · NOW idle  │  ● QUOTA week 61%  │  no reply yet')
  expect(await run($, 'hide nothing')).toMatch(/Cards: quota, inbox, running, session\.$/)
})

test('quota thresholds: ! past 70% in yellow, !! past 90% in red with the reset time; the pane open keeps it on the band', { options: { timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 72, resetsAt: iso(T0 + 70 * MIN) }]
  await start($)
  await toggle($)
  const ui = await $.ui.mount(pane(100, 200))
  expect(renderText(await ui.drawn(), 100).join('\n')).toMatch(/Claude 5h\s+███████░░░\s+72%!/)
  expect((await ui.find({ type: 'Text', text: '72%' }))?.props['color']).toBe('yellow')
  await ui.unmount()
  expect(await bandText($, 200)).toBe(' ● QUOTA 5h 72% ! resets 13:10')
  await $.session.measure({
    context: { window: 1, tokens: 1, percent: 10 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 92.5, resetsAt: iso(T0 + 70 * MIN) }],
    changed: ['rateLimits'],
  })
  expect(await bandText($, 200)).toBe(' ● QUOTA 5h 93% !! resets 13:10')
  const bandUi = await $.ui.mount(band(200))
  expect((await bandUi.find({ type: 'Text', text: '93%' }))?.props['color']).toBe('red')
  expect((await bandUi.find({ type: 'Text', text: ' !!' }))?.props['color']).toBe('red')
  expect((await bandUi.find({ type: 'Text', text: '●' }))?.props['color']).toBe('red')
  await bandUi.unmount()
  await toggle($)
  expect(await bandText($, 200)).toContain('● QUOTA 5h 93% !! resets 13:10  │  no reply yet')
})

test('quotaCommand rows: run without a shell; a reading past twice its period shows how old it is, turns gray and is never the tightest', QUOTA, async ($, on) => {
  const w = world(on, argv => (argv[0] === 'quota-tool' ? ok(ROWS) : 'unexpected'))
  w.rateLimits = CLAUDE
  await start($)
  await toggle($)
  expect(w.runs[0]).toEqual(['quota-tool', '--json'])
  expect(w.timeouts[0]).toBe(10_000)
  const out = await lines($, 100)
  const alpha = out.find(l => l.includes('Alpha')) ?? ''
  const beta = out.find(l => l.includes('Beta')) ?? ''
  expect(alpha).toMatch(/Alpha\s+░░░░░░░░░░\s+2%\s+resets 10\/14\s+│$/)
  expect(beta).toMatch(/Beta\s+██████████\s+95%\s+40m old/)
  expect(beta).not.toContain('!')
  expect(out.join('\n')).toMatch(/QUOTA\s+tightest 61%/)
  const ui = await $.ui.mount(pane(100, 200))
  expect((await ui.find({ type: 'Text', text: /^\s*95%$/ }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test('a failing, timed-out or non-JSON quotaCommand shows why in the QUOTA card only; Claude rows, other cards and the band carry on', QUOTA, async ($, on) => {
  let mode: 'exit' | 'json' | 'deny' = 'exit'
  const w = world(on, () =>
    mode === 'exit'
      ? { exitCode: 1, stdout: '', stderr: 'cache unreadable\nmore', isStdoutTruncated: false, isStderrTruncated: false }
      : mode === 'json'
        ? ok('<html>')
        : 'timed out after 10000ms',
  )
  w.rateLimits = CLAUDE
  await start($)
  await toggle($)
  for (const [next, reason] of [
    ['exit', 'could not read quota: exit code 1: cache unreadable'],
    ['json', 'could not read quota: output is not JSON'],
    ['deny', 'could not read quota: timed out after 10000ms'],
  ] as const) {
    mode = next
    await w.clock.advance(MIN)
    const text = (await lines($, 60)).join('\n')
    expect(text).toContain(reason)
    expect(text).toMatch(/Claude week\s+██████░░░░\s+61%/)
    expect(text).toMatch(/- INBOX\s+│\n│ no messages waiting/)
    expect(text).not.toContain('could not draw')
    await toggle($)
    expect(await bandText($, 200)).toContain('● QUOTA week 61%')
    await toggle($)
  }
  expect(w.logs).toEqual([])
})

test('a narrow band shrinks the quota to Q 61%, then drops the last reply, then NOW, and the quota last; INBOX always stays', { options: { timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  w.rateLimits = CLAUDE
  await start($)
  const states: string[] = []
  for (let columns = 120; columns >= 16; columns--) {
    const line = await bandText($, columns)
    expect(line.length).toBeLessThanOrEqual(columns)
    expect(line).toContain('INBOX')
    const state = line.includes('QUOTA week 61%')
      ? 'full'
      : line.includes('Q 61%')
        ? line.includes('no reply yet')
          ? 'compact + reply'
          : 'compact'
        : 'no quota'
    if (states[states.length - 1] !== state) states.push(state)
  }
  expect(states).toEqual(['full', 'compact + reply', 'compact', 'no quota'])
  // NOW goes before the quota does.
  for (const columns of [30, 22]) expect(await bandText($, columns)).toBe(' · INBOX 0  │  Q 61%')
  expect(await bandText($, 18)).toBe(' · INBOX 0')
})

test('hiding QUOTA also takes it off the band; placing it on the band keeps it there with the pane open', { options: { timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  // The engine's own band, drawn when the mod has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
  w.rateLimits = CLAUDE
  await start($)
  await toggle($)
  expect(await bandText($, 200)).toBe('engine')
  const ui = await $.ui.mount(pane(100, 200))
  await ui.press({ key: 'arrange' })
  await ui.press({ key: 'place:quota' })
  await ui.press({ key: 'arrange' })
  await ui.unmount()
  expect(await bandText($, 200)).toBe(' ● QUOTA week 61%')
  expect((await lines($, 100)).join('\n')).not.toContain('- QUOTA')
  expect(await run($, 'hide quota')).toBe('Hidden: quota.')
  await toggle($)
  expect(await bandText($, 200)).toBe(' · INBOX 0  │  · NOW idle  │  no reply yet')
})

test('the quota JSON contract: rows or a bare list, null percent means no data, bad rows fail the read with a reason', async () => {
  expect(parseQuotaOutput('[{"name":"Alpha","usedPercent":null,"resetsAt":null,"fetchedAt":null}]')).toEqual([
    { name: 'Alpha', usedPercent: null, resetsAt: null, fetchedAt: null, maxAgeMs: null },
  ])
  expect(parseQuotaOutput('{"rows":[{"name":"A","usedPercent":5,"resetsAt":"2026-10-05T05:00:00Z","fetchedAt":"2026-10-05T04:00:00Z","maxAgeSeconds":300}]}')).toEqual([
    { name: 'A', usedPercent: 5, resetsAt: Date.parse('2026-10-05T05:00:00Z'), fetchedAt: T0, maxAgeMs: 300_000 },
  ])
  expect(parseQuotaOutput('nope')).toBe('output is not JSON')
  expect(parseQuotaOutput('{"items":[]}')).toBe('output has no rows list')
  expect(parseQuotaOutput('[{"usedPercent":5}]')).toBe('row 1 has no name')
  expect(parseQuotaOutput('[{"name":"A","usedPercent":"5"}]')).toBe('row 1 usedPercent is not a number')
  expect(parseQuotaOutput('[{"name":"A","usedPercent":5,"fetchedAt":"yesterday"}]')).toBe('row 1 fetchedAt is not an ISO time')
  expect(resetText(T0 + 70 * MIN, T0, 'Asia/Singapore')).toBe('13:10')
  expect(resetText(T0 + 3 * 24 * 60 * MIN, T0, 'Asia/Singapore')).toBe('Thu 12:00')
  expect(resetText(T0 + 9 * 24 * 60 * MIN, T0, 'Asia/Singapore')).toBe('10/14')
  expect(resetText(null, T0, '')).toBe('')
})

test('a source with no reading still gets its row, and every quota line stays within 60 columns in whitelisted symbols', QUOTA, async ($, on) => {
  const w = world(on, () => ok(JSON.stringify({ rows: [{ name: 'Gamma', usedPercent: null, resetsAt: '', fetchedAt: '', maxAgeSeconds: 1800 }] })))
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(T0 + 70 * MIN) }]
  await start($)
  await toggle($)
  const out = await lines($, 60)
  expect(out.join('\n')).toMatch(/Gamma\s+no data\s+age unknown/)
  expect(out.join('\n')).toMatch(/Claude 5h\s+██████████\s+100%!!/)
  for (const l of out) expect([...l].length).toBeLessThanOrEqual(60)
  expect(offList(out.join('\n'))).toEqual([])
})
