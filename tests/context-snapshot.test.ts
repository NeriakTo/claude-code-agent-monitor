import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { parseConfig } from '../hooks/config'
import { ok, pane, renderText, T0, world } from './kit'

const SESSION_ID = '測試對話'
const context = (percent: number, window = 200_000) => ({ window, tokens: percent * window / 100, percent })
const measure = ($: Engine, percent: number, window?: number) =>
  $.session.measure({ context: context(percent, window), rateLimits: [], changed: ['context'] })

const snapshot = (used_percent: number, now = T0) =>
  ({ session_id: SESSION_ID, used_percent, measured_at: new Date(now).toISOString() })

// 引擎測試只允許透過 process.run 存取檔案，這裡模擬暫存工作目錄內的快照。
const DIR = '/private/var/tmp/agent-monitor-context-test'
const PATH = DIR + '/board/context.json'
const OPTIONS = { options: { contextSnapshotPath: PATH } }
const start = ($: Engine) => $.session.start({ cwd: DIR, surface: 'terminal', isInteractive: true })

const fixture = (on: On) => {
  let file: string | undefined
  let failure = false
  const w = world(on, argv => {
    const [shell, flag, , , path, payload] = argv
    expect([shell, flag, path]).toEqual(['/bin/sh', '-c', PATH])
    if (failure) return { ...ok(''), exitCode: 1, stderr: '改名失敗\n額外訊息' }
    file = payload || undefined
    return ok('')
  })
  on('session.id', () => ({ value: SESSION_ID }))
  return { w, read: (): unknown => file === undefined ? undefined : JSON.parse(file), fail: () => { failure = true } }
}

test('快照路徑預設為空字串並可從選項讀取', {}, () => {
  expect(parseConfig(undefined)).toHaveProperty('contextSnapshotPath', '')
  expect(parseConfig({ contextSnapshotPath: 'board/context.json' })).toHaveProperty('contextSnapshotPath', 'board/context.json')
})

test('未設定時不寫快照', {}, async ($, on) => {
  const w = world(on)
  let idReads = 0
  on('session.id', () => {
    idReads++
    return { value: SESSION_ID }
  })
  await start($)
  await measure($, 26)
  expect(idReads).toBe(0)
  expect(w.runs).toEqual([])
  expect(w.logs).toEqual([])
})

test('啟動時有讀值便建立快照並寫入已用比例', OPTIONS, async ($, on) => {
  const f = fixture(on)
  f.w.sessionContext = context(26.4)
  await start($)
  expect(f.read()).toEqual(snapshot(26))
})

test('連續量測整檔覆寫並保留真正量到的零', OPTIONS, async ($, on) => {
  const f = fixture(on)
  await start($)
  expect(f.read()).toBeUndefined()
  await measure($, 26)
  expect(f.read()).toEqual(snapshot(26))
  await f.w.clock.advance(1_000)
  await measure($, 0)
  expect(f.read()).toEqual(snapshot(0, T0 + 1_000))
})

test('分母為零或讀值超出範圍時移除舊快照', OPTIONS, async ($, on) => {
  const f = fixture(on)
  await start($)
  await measure($, 26)
  expect(f.read()).toEqual(snapshot(26))
  await measure($, 0, 0)
  expect(f.read()).toBeUndefined()
  await measure($, 26)
  await measure($, 101)
  expect(f.read()).toBeUndefined()
})

test('主對話壓縮成功才更新快照', OPTIONS, async ($, on) => {
  const f = fixture(on)
  const messages = [{ role: 'user' as const, text: '待壓縮訊息', toolUses: [] }]
  f.w.sessionContext = context(76)
  on('session.compact', (_, e) => {
    if (e.trigger === 'manual') return { skip: '略過' }
    return { messages: e.messages, tokensAfter: e.agentId === undefined ? 24_000 : 40_000 }
  })
  await start($)
  expect(f.read()).toEqual(snapshot(76))
  await $.session.compact({ trigger: 'auto', messages, agentId: '子代理' })
  await $.session.compact({ trigger: 'precompute', messages })
  await $.session.compact({ trigger: 'manual', messages })
  expect(f.read()).toEqual(snapshot(76))
  await $.session.compact({ trigger: 'auto', messages })
  expect(f.read()).toEqual(snapshot(12))
})

test('改名失敗只記一行警告並繼續顯示面板', OPTIONS, async ($, on) => {
  const f = fixture(on)
  f.w.rateLimits = [{ kind: 'five_hour', percentUsed: 15 }]
  await start($)
  f.fail()
  await measure($, 26)
  const ui = await $.ui.mount(pane())
  expect(renderText(await ui.drawn(), 60).join('\n')).toContain('ctx 26%')
  expect(f.w.logs).toHaveLength(1)
  expect(f.w.logs[0]).toMatch(/^agent-monitor 警告[^\r\n]*$/)
})
