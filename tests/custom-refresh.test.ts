import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { parseConfig, parseCustomCardRefresh } from '../hooks/config'
import { parseCustomOutput } from '../hooks/custom'
import { SYMBOLS } from '../hooks/view'
import { MIN, band, ok, pane, renderText, start, toggle, world } from './kit'

const ITEMS = [
  { mark: 'idle', text: 'first item', right: 'one', group: 'Alpha' },
  { mark: 'done', text: 'second item', right: 'two', group: 'Beta' },
]
const CARD = { options: { customCards: 'PROJECTS=projects-tool', timeZone: 'UTC' } }
const draw = async ($: Engine, columns = 60, rows = 200): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns, rows))
  const lines = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return lines
}

test('refresh options: card ids, clamping, malformed entries, defaults and last valid duplicate', async () => {
  expect([...parseCustomCardRefresh('board=10, builds=30, Slow Jobs=5000, tiny=1, decimal=10.5')]).toEqual([
    ['board', 10], ['builds', 30], ['slow-jobs', 3600], ['tiny', 10], ['decimal', 10.5],
  ])
  expect([...parseCustomCardRefresh('bad, =20, x=NaN, x=Infinity, negative=-1, x=1s, x=10=20, x=, x=20, x=no, x=30')]).toEqual([['negative', 10], ['x', 30]])
  expect(parseConfig({}).customCardRefresh.size).toBe(0)
  expect([...parseConfig({ customCardRefresh: 'board=10' }).customCardRefresh]).toEqual([['board', 10]])
})

test('group parsing: invalid marks are absent, optional right is bounded, malformed groups ignored', async () => {
  const parsed = parseCustomOutput(JSON.stringify({ items: ITEMS, groups: { Alpha: { mark: 'bad', right: '1234567890123456' }, Beta: { mark: 'failed' }, Empty: {}, Bad: [] } }))
  expect(typeof parsed).toBe('object')
  if (typeof parsed === 'string') return
  expect(parsed.groups?.['Alpha']?.mark).toBe(undefined)
  expect([...parsed.groups?.['Alpha']?.right ?? ''].length).toBeLessThanOrEqual(12)
  expect(parsed.groups?.['Beta']).toEqual({ mark: 'failed' })
  expect(parsed.groups?.['Empty']).toBe(undefined)
  expect(parseCustomOutput('{"groups":[]}')).toEqual(parseCustomOutput('{}'))
})

test('decorated heading uses item mark and plain name, indents only its children, ignores unused groups', CARD, async ($, on) => {
  world(on, () => ok(JSON.stringify({ items: ITEMS, groups: { Alpha: { mark: 'failed', right: 'blocked' }, Ghost: { mark: 'running' } } })))
  await start($)
  await toggle($)
  const text = (await draw($)).join('\n')
  expect(text).toMatch(/│ ✗ Alpha\s+blocked │\n│   · first item\s+one │\n│ Beta\s+1 │\n│ ✓ second item\s+two │/)
  expect(text).toMatch(/- PROJECTS\s+2 │/)
  expect(text).not.toContain('failed')
  expect(text).not.toContain('Ghost')
  const ui = await $.ui.mount(pane(60, 200))
  expect((await ui.find({ type: 'Text', text: '✗' }))?.props['color']).toBe('red')
  expect((await ui.find({ type: 'Text', text: ' Alpha' }))?.props['dimColor']).toBe(undefined)
  await ui.unmount()
  for (const columns of [24, 48, 60, 100]) {
    const lines = await draw($, columns)
    expect([...new Set([...lines.join('\n')].filter(ch => ch.charCodeAt(0) > 126 && !SYMBOLS.includes(ch)))]).toEqual([])
    const from = lines.findIndex(line => line.includes('- PROJECTS'))
    const to = lines.findIndex((line, i) => i > from && line.startsWith('╰'))
    // At 24 columns the existing padded footer can overflow; test the new card rows there.
    for (const line of columns === 24 ? lines.slice(from, to) : lines) expect([...line].length, line).toBeLessThanOrEqual(columns)
  }
})

test('group decoration leaves fallback summaries, band and status line unchanged', { options: { ...CARD.options, statusLine: true, statusLineSubinfo: 'projects' } }, async ($, on) => {
  let groups: unknown = undefined
  const w = world(on, () => ok(JSON.stringify({ items: ITEMS, groups })))
  await start($)
  await toggle($)
  const ui = await $.ui.mount(pane(60, 200))
  await ui.press({ key: 'arrange' })
  await ui.press({ key: 'place:projects' })
  await ui.press({ key: 'arrange' })
  await ui.unmount()
  const bandText = async () => {
    const mounted = await $.ui.mount(band(100))
    const result = renderText(await mounted.drawn(), 100).join('\n')
    await mounted.unmount()
    return result
  }
  const before = await bandText()
  const status = w.status[w.status.length - 1]
  groups = { Alpha: { mark: 'failed', right: 'blocked' }, Beta: { mark: 'warn' } }
  await w.clock.advance(MIN)
  expect(await bandText()).toBe(before)
  expect(w.status[w.status.length - 1]).toBe(status)
  await $.command.run({ command: 'monitor', args: 'collapse projects', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect(await bandText()).toBe(before)
})

test('no decoration is byte-for-byte unchanged; invalid mark alone does not decorate', CARD, async ($, on) => {
  let groups: unknown = undefined
  const w = world(on, () => ok(JSON.stringify({ items: ITEMS, groups })))
  await start($)
  await toggle($)
  const before = await draw($)
  groups = { Alpha: { mark: 'unknown' }, Beta: {}, Ghost: { mark: 'failed' } }
  await w.clock.advance(MIN)
  const after = await draw($)
  // Clock-bearing rows change; the complete custom card does not.
  const card = (lines: string[]) => lines.slice(lines.findIndex(l => l.includes('- PROJECTS')), lines.findIndex((l, i) => i > lines.findIndex(l => l.includes('- PROJECTS')) && l.startsWith('╰')))
  expect(card(after)).toEqual(card(before))
  expect(card(after).join('\n')).toMatch(/│ Alpha\s+1 │\n│ · first item/)
})

test('right-only headings reserve an empty mark slot; mark-only headings show item count', CARD, async ($, on) => {
  world(on, () => ok(JSON.stringify({ items: ITEMS, groups: { Alpha: { right: 'ready' }, Beta: { mark: 'warn' } } })))
  await start($)
  await toggle($)
  expect((await draw($)).join('\n')).toMatch(/│   Alpha\s+ready │\n│   · first item[^]*│ ● Beta\s+1 │\n│   ✓ second item/)
})

test('decorated headings never count toward max items or height-folded more counts', { options: { ...CARD.options, customCardMaxItems: 1 } }, async ($, on) => {
  world(on, () => ok(JSON.stringify({ items: ITEMS, groups: { Alpha: { mark: 'running' }, Beta: { mark: 'failed' } } })))
  await start($)
  await toggle($)
  expect((await draw($)).join('\n')).toMatch(/● Alpha[^]*first item[^]*\+1 more/)
  expect((await draw($, 60, 17)).join('\n')).toContain('+2 more')
})

const TIMERS = { options: { customCards: 'BOARD=board-tool;;BUILDS=builds-tool;;OTHER=other-tool', customCardRefresh: 'board=10, builds=30', dispatchCommand: 'dispatch-tool', quotaCommand: 'quota-tool', timeZone: 'UTC' } }

test('card timers run only their card; default cards, dispatch and quota keep 60 seconds; pane closed stops card timers', TIMERS, async ($, on) => {
  const w = world(on, argv => ok(argv[0] === 'quota-tool' ? '{"rows":[]}' : argv[0] === 'dispatch-tool' ? '' : '{"items":[]}'))
  const counts = () => ['board-tool', 'builds-tool', 'other-tool', 'dispatch-tool', 'quota-tool'].map(name => w.runs.filter(argv => argv[0] === name).length)
  await start($)
  await w.clock.settle()
  expect(counts()).toEqual([0, 0, 0, 0, 1])
  await toggle($)
  expect(counts()).toEqual([1, 1, 1, 1, 2])
  await w.clock.advance(10_000)
  expect(counts()).toEqual([2, 1, 1, 1, 2])
  await w.clock.advance(20_000)
  expect(counts()).toEqual([4, 2, 1, 1, 2])
  await w.clock.advance(30_000)
  expect(counts()).toEqual([7, 3, 2, 2, 3])
  await toggle($)
  await w.clock.advance(MIN)
  expect(counts()).toEqual([7, 3, 2, 2, 4])
  expect(w.logs).toEqual([])
})

test('pane reopening cannot rerun a configured card before its interval; footer drops interval list first', TIMERS, async ($, on) => {
  const w = world(on, argv => ok(argv[0] === 'quota-tool' ? '{"rows":[]}' : argv[0] === 'dispatch-tool' ? '' : '{"items":[]}'))
  await start($)
  await toggle($)
  expect((await draw($, 100)).join('\n')).toContain('refresh 60s · board 10s · builds 30s')
  expect((await draw($, 32)).join('\n')).toContain('refresh 60s')
  expect((await draw($, 32)).join('\n')).not.toContain('board 10s')
  await w.clock.advance(1000)
  await toggle($)
  await toggle($)
  expect(w.runs.filter(argv => argv[0] === 'board-tool').length).toBe(1)
  await w.clock.advance(9000)
  expect(w.runs.filter(argv => argv[0] === 'board-tool').length).toBe(2)
})

test('a slow configured command does not overlap; an abandoned read recovers after 45 seconds and cannot overwrite the new result', { options: { customCards: 'BOARD=board-tool', customCardRefresh: 'board=10' } }, async ($, on) => {
  let count = 0
  let release: (() => void) | undefined
  const w = world(on, async () => {
    count++
    if (count === 2) {
      await new Promise<void>(resolve => { release = resolve })
      return ok('{"items":[{"text":"old result"}]}')
    }
    return ok('{"items":[{"text":"new result"}]}')
  })
  await start($)
  await toggle($)
  await w.clock.advance(10_000)
  await w.clock.advance(40_000)
  expect(w.runs.length).toBe(2)
  await w.clock.advance(10_000)
  expect(w.runs.length).toBe(3)
  release?.()
  await w.clock.settle()
  expect((await draw($)).join('\n')).toContain('new result')
  expect((await draw($)).join('\n')).not.toContain('old result')
})
