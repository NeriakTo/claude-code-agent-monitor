import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MIN, T0, pane, renderText, start, toggle, world } from './kit'
import type { World } from './kit'

const OPTIONS = { options: { timeZone: 'Asia/Singapore' } }

const draw = async ($: Engine, columns = 60): Promise<string> => {
  const ui = await $.ui.mount(pane(columns, 200))
  const out = renderText(await ui.drawn(), columns).join('\n')
  await ui.unmount()
  return out
}

/** Tool calls that take as long as their description says: `3m`, `12m`, `2s`. */
const timedCalls = (on: Parameters<typeof world>[0], w: World) =>
  on('tool.call', async ($, e) => {
    const said = 'description' in e && typeof e.description === 'string' ? e.description : ''
    const m = / (\d+)([ms])$/.exec(said)
    if (m !== null) await w.clock.sleep(Number(m[1]) * (m[2] === 'm' ? MIN : 1000))
    if (said.startsWith('fail')) return { result: 'failed', isError: true as const }
    return { result: 'ok' }
  })

const runFor = async ($: Engine, w: World, call: Parameters<Engine['tool']['call']>[0], ms: number): Promise<void> => {
  const pending = $.tool.call(call)
  await w.clock.advance(ms)
  await pending
}

const RECENT = /─── recent ─+ │\n│ ✗ agent fail screenshot 12m\s+12m · 12:15 │\n│ ✓ Bash "build web 3m"\s+3m · 12:03 │/

test('RUNNING keeps the last ended Bash and agent runs under recent, newest first, with time taken and end time; short calls and other tools are left out', OPTIONS, async ($, on) => {
  const w = world(on)
  timedCalls(on, w)
  await start($)
  await runFor($, w, { tool: 'Bash', command: 'make', description: 'build web 3m' }, 3 * MIN)
  await runFor($, w, { tool: 'Bash', command: 'ls', description: 'quick 2s' }, 2000)
  await runFor($, w, { tool: 'Agent', description: 'fail screenshot 12m', prompt: 'p' }, 12 * MIN)
  await toggle($)
  const text = await draw($)
  expect(text).toMatch(/- RUNNING\s+2 recent │\n│ idle\s+│/)
  expect(text).toMatch(RECENT)
  expect(text).not.toContain('quick')
  expect((w.store.get('recent') as unknown[]).length).toBe(2)
})

test('recent survives a hot reload and a new session, restored from the store', OPTIONS, async ($, on) => {
  const w = world(on)
  timedCalls(on, w)
  await start($)
  await runFor($, w, { tool: 'Bash', command: 'make', description: 'build web 3m' }, 3 * MIN)
  await runFor($, w, { tool: 'Agent', description: 'fail screenshot 12m', prompt: 'p' }, 12 * MIN)
  await start($) // a hot reload fires session.start again; the in-flight list is cleared, recent is not
  await toggle($)
  expect(await draw($)).toMatch(RECENT)
})

test('a new session restores recent from the store and ignores rows that are not recent runs', OPTIONS, async ($, on) => {
  const w = world(on)
  w.store.set('recent', [
    { id: 'a', label: 'agent old review', startedAt: T0 - 30 * MIN, endedAt: T0 - 10 * MIN, status: 'done' },
    { id: 'b', label: 'broken', startedAt: 'x' },
    { id: 'c', label: 'Bash "deploy check"', startedAt: T0 - 9 * MIN, endedAt: T0 - 8 * MIN, status: 'cancelled' },
  ])
  await start($)
  await toggle($)
  const text = await draw($)
  expect(text).toMatch(/✓ agent old review\s+20m · 11:50/)
  expect(text).toMatch(/– Bash "deploy check"\s+1m · 11:52/)
  expect(text).not.toContain('broken')
})

test('recentRows sets how many are listed; /monitor rows running changes it for this card', { options: { ...OPTIONS.options, recentRows: 1 } }, async ($, on) => {
  const w = world(on)
  timedCalls(on, w)
  await start($)
  for (const n of [1, 2, 3]) await runFor($, w, { tool: 'Bash', command: 'make', description: `step ${n} 1m` }, MIN)
  await toggle($)
  let text = await draw($)
  expect(text).toContain('step 3 1m')
  expect(text).not.toContain('step 2 1m')
  expect(text).toMatch(/RUNNING\s+1 recent/)
  await $.command.run({ command: 'monitor', args: 'rows running 3', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  text = await draw($)
  expect(text.match(/✓ Bash "step \d 1m"/g)?.length).toBe(3)
})

test('a background agent joins recent once Claude Code lists it as completed, and only once', OPTIONS, async ($, on) => {
  const agents: { id: string; description: string; type: string; status: 'running' | 'completed' }[] = [
    { id: 'bg1', description: 'scan the logs', type: 'general-purpose', status: 'running' },
  ]
  const w = world(on, () => 'not configured', agents)
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'bg1', description: 'scan the logs', prompt: 'p', outputFile: '/tmp/o' } }))
  await start($)
  await $.tool.call({ tool: 'Agent', description: 'scan the logs', prompt: 'p' })
  await toggle($)
  expect(await draw($)).not.toContain('recent')
  await w.clock.advance(20 * MIN)
  const first = agents[0]
  if (first !== undefined) first.status = 'completed'
  await w.clock.advance(MIN)
  await w.clock.advance(MIN)
  const text = await draw($)
  expect(text.match(/✓ agent scan the logs/g)?.length).toBe(1)
  expect((w.store.get('recent') as unknown[]).length).toBe(1)
})
