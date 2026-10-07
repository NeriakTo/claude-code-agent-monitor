// Plain-text renders for review without loading the mod: each is printed between marker lines,
// and scripts/write-renders.sh copies them to docs/renders/. Neutral sample data only.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYMBOLS } from '../hooks/view'
import { CHAT_A, MIN, T0, band, fromChannel, ok, pane, renderText, start, tag, world } from './kit'
import type { World } from './kit'

/** The test runner prints console output; the hooks environment's typings do not declare it. */
declare const console: { log: (text: string) => void }

const iso = (ms: number): string => new Date(ms).toISOString()

/** Alpha read 3 minutes before `now` (fresh); Beta 70 minutes before with a 30 minute period (stale). */
export const sampleQuota = (now: number): string =>
  JSON.stringify({
    rows: [
      { name: 'Alpha', usedPercent: 2, resetsAt: iso(T0 + 9 * 24 * 60 * MIN), fetchedAt: iso(now - 3 * MIN), maxAgeSeconds: 300 },
      { name: 'Beta', usedPercent: 1, resetsAt: iso(T0 + 9 * 24 * 60 * MIN), fetchedAt: iso(now - 70 * MIN), maxAgeSeconds: 1800 },
    ],
  })

export const SAMPLE_PROJECTS = JSON.stringify({
  summary: '5 open · 1 on you',
  badge: '5 open · 1 on you',
  items: [
    { mark: 'warn', text: '#301 monitor arrange mode', right: 'you', group: 'Alpha' },
    { mark: 'idle', text: '#208 parser second pass', right: 'me', group: 'Alpha' },
    { mark: 'waiting', text: '#298 release outline', right: 'ext', group: 'Alpha' },
    { mark: 'idle', text: '#150 nightly report cleanup', right: 'me', group: 'Beta' },
    { mark: 'idle', text: '#151 export settings page', right: 'me', group: 'Beta' },
  ],
  empty: 'no open tasks',
})

export const SAMPLE = {
  options: {
    quotaCommand: 'quota-tool --json',
    customCards: 'PROJECTS=projects-tool --json',
    timeZone: 'Asia/Singapore',
  },
}

/**
 * A sample session at T0 + 41m: a background-free agent running for 41 minutes, a build that took
 * 3 minutes and an agent run that failed after 12, one channel message, Claude at 58% and 61%.
 */
export const sampleSession = async ($: Engine, on: Parameters<typeof world>[0]): Promise<{ w: World; done: () => Promise<void> }> => {
  const w: World = world(on, argv => ok(argv[0] === 'quota-tool' ? sampleQuota(w.clock.now()) : SAMPLE_PROJECTS))
  w.rateLimits = [
    { kind: 'five_hour', percentUsed: 58, resetsAt: iso(T0 + 111 * MIN) },
    { kind: 'seven_day', percentUsed: 61, resetsAt: iso(T0 + 3 * 24 * 60 * MIN) },
  ]
  on('tool.call', async ($, e) => {
    if (e.tool === 'Agent' && e.description === 'review batch 2 fixes') await w.clock.sleep(120 * MIN)
    if (e.tool === 'Agent' && e.description === 'screenshot run') {
      await w.clock.sleep(12 * MIN)
      return { result: 'failed', isError: true as const }
    }
    if (e.tool === 'Bash') await w.clock.sleep(3 * MIN)
    return { result: 'ok' }
  })
  await start($)
  const failing = $.tool.call({ tool: 'Agent', description: 'screenshot run', prompt: 'p' })
  await w.clock.advance(12 * MIN)
  await failing
  const running = $.tool.call({ tool: 'Agent', description: 'review batch 2 fixes', prompt: 'p' })
  await w.clock.advance(MIN)
  const build = $.tool.call({ tool: 'Bash', command: 'make web', description: 'build web' })
  await w.clock.advance(3 * MIN)
  await build
  await w.clock.advance(25 * MIN)
  await $.prompt.submit({ text: tag(CHAT_A, '1'), origin: fromChannel(), wait: false })
  await w.clock.advance(6 * MIN)
  return {
    w,
    done: async () => {
      await w.clock.advance(120 * MIN)
      await running
    },
  }
}

const offList = (text: string): string[] => [...new Set([...text].filter(ch => ch.charCodeAt(0) > 0x7e && !SYMBOLS.includes(ch)))]

const print = (name: string, lines: readonly string[]): void => console.log(`\n----- render:${name} -----\n${lines.join('\n')}\n----- end:${name} -----`)

const monitor = ($: Engine, args: string) =>
  $.command.run({ command: 'monitor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })

test('renders: band and pane at 60 and 100 columns, normal and arrange mode', SAMPLE, async ($, on) => {
  const { done } = await sampleSession($, on)
  const shots: [string, string[]][] = []
  for (const columns of [60, 100]) {
    const ui = await $.ui.mount(band(columns))
    shots.push([`band-${columns}`, renderText(await ui.drawn(), columns)])
    await ui.unmount()
  }
  await monitor($, '')
  await monitor($, 'hide inbox')
  await monitor($, 'hide session')
  for (const columns of [60, 100]) {
    const ui = await $.ui.mount(pane(columns, 200))
    shots.push([`pane-normal-${columns}`, renderText(await ui.drawn(), columns)])
    await ui.unmount()
  }
  for (const columns of [60, 100]) {
    const ui = await $.ui.mount(pane(columns, 200))
    await ui.press({ key: 'arrange' })
    shots.push([`pane-arrange-${columns}`, renderText(await ui.drawn(), columns)])
    await ui.press({ key: 'arrange' })
    await ui.unmount()
  }
  for (const [name, lines] of shots) {
    const columns = Number(name.split('-').pop())
    for (const l of lines) expect([...l].length, `${name}: ${l}`).toBeLessThanOrEqual(columns)
    expect(offList(lines.join('\n')), name).toEqual([])
    print(name, lines)
  }
  await done()
})

test('renders: the hidden list shown, a card moved from the band back to the pane, and the focus on another card', SAMPLE, async ($, on) => {
  const { done } = await sampleSession($, on)
  const shots: [string, string[]][] = []
  await monitor($, '')
  await monitor($, 'hide inbox')
  await monitor($, 'hide session')
  const ui = await $.ui.mount(pane(60, 200))
  await ui.press({ key: 'reveal-hidden' })
  shots.push(['pane-hidden-60', renderText(await ui.drawn(), 60)])
  await ui.press({ key: 'reveal-hidden' })
  await ui.press({ key: 'arrange' })
  await ui.press({ key: 'place:projects' })
  const onBand = renderText(await ui.drawn(), 60)
  await ui.press({ key: 'place:projects' })
  const backInPane = renderText(await ui.drawn(), 60)
  shots.push(['pane-arrange-band-to-pane-60', ['PROJECTS on the band (its button reads P):', ...onBand, '', 'After pressing P, back in the pane (B again):', ...backInPane]])
  await $.ui.focus({ component: 'Pane', requestId: 'agent-monitor', plugin: 'agent-monitor', element: 'hide:running', origin: { kind: 'person' } })
  shots.push(['pane-arrange-focus-60', renderText(await ui.drawn(), 60)])
  await ui.unmount()
  const [hiddenShot, bandShot, focusShot] = shots.map(([, lines]) => lines.join('\n'))
  expect(hiddenShot).toMatch(/2 hidden\s+Close\n {3}INBOX\s+Show\n {3}SESSION\s+Show$/)
  expect(bandShot).toMatch(/PROJECTS \(band\)\s+u: ↑ {6}b: P h: H │/)
  expect(bandShot).toMatch(/After pressing P[^]*│ {2}PROJECTS\s+u: ↑ {6}b: B h: H │/)
  expect(focusShot).toMatch(/│ {2}RUNNING\s+u: ↑ d: ↓ b: B h: H │/)
  expect(focusShot).toMatch(/│ {2}QUOTA\s+↓ B H │/)
  for (const [name, lines] of shots) {
    for (const l of lines) expect([...l].length, `${name}: ${l}`).toBeLessThanOrEqual(60)
    expect(offList(lines.join('\n')), name).toEqual([])
    print(name, lines)
  }
  await done()
})

test('render: a short pane (30 rows) crowded with cards keeps every QUOTA row while the other cards fold', { options: { ...SAMPLE.options, customCards: 'PROJECTS=projects-tool --json;;BACKLOG=backlog-tool', customCardMaxItems: 20 } }, async ($, on) => {
  const w: World = world(on, argv =>
    ok(
      argv[0] === 'quota-tool'
        ? sampleQuota(w.clock.now())
        : argv[0] === 'backlog-tool'
          ? JSON.stringify({ summary: '20 items', items: Array.from({ length: 20 }, (_, i) => ({ mark: 'idle', text: `backlog item ${i + 1}`, right: '' })) })
          : SAMPLE_PROJECTS,
    ),
  )
  w.rateLimits = [
    { kind: 'five_hour', percentUsed: 58, resetsAt: iso(T0 + 111 * MIN) },
    { kind: 'seven_day', percentUsed: 61, resetsAt: iso(T0 + 3 * 24 * 60 * MIN) },
  ]
  await start($)
  await monitor($, '')
  const ui = await $.ui.mount(pane(60, 30))
  const out = renderText(await ui.drawn(), 60)
  await ui.unmount()
  const text = out.join('\n')
  expect(text).toMatch(/- QUOTA[^\n]*\n│ Claude 5h[^\n]*\n│ Claude week[^\n]*\n│ Alpha[^\n]*\n│ Beta[^\n]*\n╰/)
  expect(text).toMatch(/BACKLOG[^]*\+\d+ more/)
  // Folded by the height fit, a grouped card counts its items, not its group headings.
  expect(text).toMatch(/- PROJECTS[^\n]*\n│ \+5 more/)
  for (const l of out) expect([...l].length).toBeLessThanOrEqual(60)
  expect(offList(text)).toEqual([])
  print('pane-quota-crowded-60', out)
})

test('renders: once a context reading comes, the QUOTA badge shows context use (ctx N%) at 60 and 100 columns', SAMPLE, async ($, on) => {
  const { done } = await sampleSession($, on)
  await $.session.measure({ context: { window: 200_000, tokens: 88_000, percent: 44 }, rateLimits: [], changed: ['context'] })
  await monitor($, '')
  await monitor($, 'hide inbox')
  await monitor($, 'hide session')
  for (const columns of [60, 100]) {
    const ui = await $.ui.mount(pane(columns, 200))
    const lines = renderText(await ui.drawn(), columns)
    await ui.unmount()
    const text = lines.join('\n')
    expect(text).toMatch(/- QUOTA\s+ctx 44% │/)
    expect(text).toMatch(/│ Claude week\s+■■■■■■····\s+61%/)
    for (const l of lines) expect([...l].length, `${columns}: ${l}`).toBeLessThanOrEqual(columns)
    expect(offList(text)).toEqual([])
    print(`pane-quota-ctx-${columns}`, lines)
  }
  await done()
})
