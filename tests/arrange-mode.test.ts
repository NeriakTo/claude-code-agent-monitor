import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SYMBOLS } from '../hooks/view'
import { MIN, T0, band, ok, pane, renderText, start, toggle, world } from './kit'

const iso = (ms: number): string => new Date(ms).toISOString()

const LONG = 'A VERY LONG CUSTOM CARD TITLE THAT DOES NOT FIT A NARROW PANE'

const GROUPED = JSON.stringify({
  summary: '7 open · 2 on you',
  items: [
    { mark: 'warn', text: '#11 first on you', right: 'you', group: 'Alpha' },
    { mark: 'idle', text: '#12 mine', right: 'me', group: 'Alpha' },
    { mark: 'waiting', text: '#13 theirs', right: 'ext', group: 'Alpha' },
    { mark: 'warn', text: '#21 second on you', right: 'you', group: 'Beta' },
    { mark: 'idle', text: '#22 mine', right: 'me', group: 'Beta' },
    { mark: 'idle', text: '#23 mine too', right: 'me', group: 'Beta' },
    { mark: 'idle', text: '#24 last one', right: 'me', group: 'Beta' },
  ],
  empty: 'no open tasks',
})

const CARDS = {
  options: {
    customCards: `PROJECTS=projects-tool;;${LONG}=long-tool`,
    timeZone: 'Asia/Singapore',
  },
}

const answer = (argv: readonly string[]) =>
  ok(argv[0] === 'projects-tool' ? GROUPED : JSON.stringify({ summary: 'long card', items: [{ mark: 'idle', text: 'one', right: '' }] }))

const draw = async ($: Engine, columns: number): Promise<string[]> => {
  const ui = await $.ui.mount(pane(columns, 200))
  const out = renderText(await ui.drawn(), columns)
  await ui.unmount()
  return out
}

const pressIn = async ($: Engine, key: string, columns = 100): Promise<void> => {
  const ui = await $.ui.mount(pane(columns, 200))
  await ui.press({ key })
  await ui.unmount()
}

const bandText = async ($: Engine, columns: number): Promise<string> => {
  const ui = await $.ui.mount(band(columns))
  const out = renderText(await ui.drawn(), columns).join('')
  await ui.unmount()
  return out
}

/** The arrange rows: the lines between the header card and the footer that hold a card title. */
const arrangeRows = (out: readonly string[], titles: readonly string[]): string[] =>
  out.filter(l => titles.some(t => l.startsWith(`│  ${t.slice(0, 6)}`)))

const offList = (text: string): string[] => [...new Set([...text].filter(ch => ch.charCodeAt(0) > 0x7e && !SYMBOLS.includes(ch)))]

test('Arrange mode: Done replaces Arrange, only title rows with up, down, Band and Hide; no up on the first card, no down on the last', CARDS, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  let out = await draw($, 100)
  expect(out[1]).toMatch(/AGENT MONITOR\s+Arrange {2}12:00 │$/)
  await pressIn($, 'arrange')
  out = await draw($, 100)
  const text = out.join('\n')
  expect(out[1]).toMatch(/AGENT MONITOR\s+Done {2}12:00 │$/)
  expect(text).toContain('Arrange: move, place or hide cards. Changes are kept.')
  expect(text).not.toContain('#11 first on you')
  const rows = arrangeRows(out, ['INBOX', 'RUNNING', 'PROJECTS', LONG, 'SESSION'])
  expect(rows.length).toBe(5)
  expect(rows[0]).toMatch(/INBOX\s+d: ↓ {2}b: Band {2}h: Hide │$/)
  expect(rows[0]).not.toContain('↑')
  expect(rows[1]).toMatch(/RUNNING\s+↑ {2}↓ {2}Band {2}Hide │$/)
  expect(rows[4]).toMatch(/SESSION\s+↑ {5}Band {2}Hide │$/)
  expect(rows[4]).not.toContain('↓')
  await pressIn($, 'arrange')
  expect((await draw($, 100)).join('\n')).toContain('#11 first on you')
})

test('60 columns: buttons shrink to ↑ ↓ B H and are never cut; a long title is cut instead; 100 columns fit too, all in whitelisted symbols', CARDS, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  await pressIn($, 'arrange', 60)
  for (const columns of [60, 100]) {
    const out = await draw($, columns)
    for (const l of out) expect([...l].length, l).toBeLessThanOrEqual(columns)
    expect(offList(out.join('\n'))).toEqual([])
    const long = out.find(l => l.includes('A VERY')) ?? ''
    if (columns === 60) {
      expect(long).toMatch(/│  A VERY LONG CUSTOM CARD TITLE THAT DOES NOT FI~ ↑ ↓ B H │$/)
      expect(out.find(l => l.includes('RUNNING'))).toMatch(/RUNNING\s+↑ ↓ B H │$/)
    } else {
      expect(long).toMatch(/A VERY LONG CUSTOM CARD TITLE THAT DOES NOT FIT A NARROW PANE\s+↑ {2}↓ {2}Band {2}Hide │$/)
    }
  }
})

test('up and down reorder the cards, the order is kept in the store and comes back at the next session', CARDS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  await pressIn($, 'arrange')
  await pressIn($, 'down:inbox')
  await pressIn($, 'up:session')
  await pressIn($, 'arrange')
  const order = (out: readonly string[]): string[] =>
    out.map(l => /^│ [-+] (INBOX|RUNNING|PROJECTS|A VERY|SESSION)/.exec(l)?.[1]).filter((t): t is string => t !== undefined)
  expect(order(await draw($, 100))).toEqual(['RUNNING', 'INBOX', 'PROJECTS', 'SESSION', 'A VERY'])
  expect(w.store.get('order')).toEqual(['running', 'inbox', 'projects', 'session', 'a-very-long-custom-card-title-that-does-not-fit-a-narrow-pane'])
  await start($) // a reload
  expect(order(await draw($, 100))).toEqual(['RUNNING', 'INBOX', 'PROJECTS', 'SESSION', 'A VERY'])
})

test('a card set to Band leaves the pane and becomes a band segment, even with the pane open; Pane brings it back', CARDS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  await pressIn($, 'arrange')
  await pressIn($, 'place:projects')
  let out = await draw($, 100)
  expect(arrangeRows(out, ['PROJECTS'])[0]).toMatch(/PROJECTS \(band\)\s+u: ↑ {2}d: ↓ {2}b: Pane {2}h: Hide │$/)
  await pressIn($, 'arrange')
  out = await draw($, 100)
  expect(out.join('\n')).not.toMatch(/[-+] PROJECTS/)
  expect(w.store.get('placement')).toEqual({ projects: 'band' })
  expect(await bandText($, 200)).toBe(' PROJECTS 7 open · 2 on you')
  await toggle($)
  expect(await bandText($, 200)).toBe(' · INBOX 0  │  · NOW idle  │  PROJECTS 7 open · 2 on you  │  no reply yet')
  await toggle($)
  await pressIn($, 'arrange')
  await pressIn($, 'place:projects')
  await pressIn($, 'arrange')
  expect((await draw($, 100)).join('\n')).toMatch(/- PROJECTS/)
  expect(w.store.get('placement')).toEqual({ projects: 'pane' })
})

test('Hide moves a card to the footer: N hidden with a Show button that lists each hidden card with its own Show', CARDS, async ($, on) => {
  const w = world(on, answer)
  await start($)
  await toggle($)
  await pressIn($, 'arrange')
  await pressIn($, 'hide:session')
  await pressIn($, 'hide:inbox')
  await pressIn($, 'arrange')
  let text = (await draw($, 60)).join('\n')
  expect(text).not.toMatch(/[-+] SESSION/)
  expect(text).toMatch(/updated 12:00 · refresh 60s · 2 hidden\s+Show$/)
  expect(w.store.get('hidden')).toEqual(['session', 'inbox'])
  await pressIn($, 'reveal-hidden', 60)
  text = (await draw($, 60)).join('\n')
  expect(text).toMatch(/2 hidden\s+Close\n {3}INBOX\s+Show\n {3}SESSION\s+Show$/)
  await pressIn($, 'show:session', 60)
  text = (await draw($, 60)).join('\n')
  expect(text).toMatch(/\+ SESSION/)
  expect(text).toMatch(/1 hidden\s+Close\n {3}INBOX\s+Show$/)
  await pressIn($, 'show:inbox', 60)
  text = (await draw($, 60)).join('\n')
  expect(text).not.toContain('hidden')
  expect(w.store.get('hidden')).toEqual([])
})

test('keys: the card the focus ring is on carries the u/d/b/h hotkeys; the first card has them until the ring moves', CARDS, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  await pressIn($, 'arrange')
  const hotkeys = async (): Promise<Record<string, string>> => {
    const ui = await $.ui.mount(pane(100, 200))
    const buttons = await ui.findAll({ type: 'Button' })
    await ui.unmount()
    return Object.fromEntries(
      buttons.filter(b => typeof b.props['hotkey'] === 'string').map(b => [String(b.props['hotkey']), String(b.props['key'])]),
    )
  }
  expect(await hotkeys()).toEqual({ d: 'down:inbox', b: 'place:inbox', h: 'hide:inbox' })
  await $.ui.focus({ component: 'Pane', requestId: 'agent-monitor', plugin: 'agent-monitor', element: 'place:running', origin: { kind: 'person' } })
  expect(await hotkeys()).toEqual({ u: 'up:running', d: 'down:running', b: 'place:running', h: 'hide:running' })
  // Moving with u keeps the hotkeys on the moved card.
  await pressIn($, 'up:running')
  expect(await hotkeys()).toEqual({ d: 'down:running', b: 'place:running', h: 'hide:running' })
})

test('grouped custom cards: a gray heading per group with its count; the cap picks warn items first and folds the rest', { options: { ...CARDS.options, customCardMaxItems: 4 } }, async ($, on) => {
  world(on, answer)
  await start($)
  await toggle($)
  const out = await draw($, 60)
  const text = out.join('\n')
  expect(text).toMatch(/│ Alpha\s+3 │\n│ ● #11 first on you\s+you │\n│ · #12 mine\s+me │\n│ · #13 theirs\s+ext │\n│ Beta\s+4 │\n│ ● #21 second on you\s+you │\n│ \+3 more/)
  const ui = await $.ui.mount(pane(60, 200))
  expect((await ui.find({ type: 'Text', text: 'Alpha' }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
  // The summary still stands for the whole card when it is collapsed.
  await $.command.run({ command: 'monitor', args: 'collapse projects', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect((await draw($, 60)).join('\n')).toMatch(/\+ PROJECTS\s+7 │\n│ 7 open · 2 on you/)
})

test('the arrange order covers QUOTA too, once Claude reports its windows', { options: { timeZone: 'Asia/Singapore' } }, async ($, on) => {
  const w = world(on)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(T0 + 60 * MIN) }]
  await start($)
  await toggle($)
  await pressIn($, 'arrange')
  await pressIn($, 'down:quota')
  await pressIn($, 'arrange')
  const out = (await draw($, 100)).join('\n')
  expect(out.indexOf('- INBOX')).toBeLessThan(out.indexOf('- QUOTA'))
  expect(w.store.get('order')).toEqual(['inbox', 'quota', 'running', 'session'])
})
