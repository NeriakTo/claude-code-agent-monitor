// The SVG pictures in docs/renders/: styled runs read back from a drawn tree, placed cell by cell.
import { describe, expect, test } from 'claude-code/testing'

import { textProps } from '../hooks/view'
import type { Run } from '../hooks/view'
import { renderRuns, renderText } from './kit'
import type { Seg } from './kit'
import { CELL, COLORS, cellX, escapeXml, lineY, num, renderSvg, svgProblems } from './svg'

/** A drawn tree shaped like the pane's: a gray rounded card of rows, each row a run of Texts. */
const text = (run: Run) => ({ type: 'Text', props: textProps(run), children: [run.text] })
const row = (runs: Run[]) => ({ type: 'Box', props: { flexDirection: 'row' }, children: runs.map(text) })
const card = (rows: Run[][]) => ({
  type: 'Box',
  props: { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
  children: rows.map(row),
})

const SAMPLE = card([
  [{ text: 'AGENT MONITOR', tone: 'accent', bold: true }],
  [{ text: '●', tone: 'ok' }, { text: ' Bash "a<b> & c\'d"', tone: 'plain' }],
  [{ text: '待回覆', tone: 'warn' }, { text: '  ', tone: 'plain' }, { text: '!!', tone: 'critical', bold: true }, { text: ' old', tone: 'muted' }],
])

const pieces = (svg: string): { attrs: string; body: string }[] =>
  [...svg.matchAll(/<text(\s[^>]*textLength[^>]*)>([^<]*)<\/text>/g)].map(m => ({ attrs: m[1] ?? '', body: m[2] ?? '' }))

describe('styled runs', () => {
  test('each piece keeps the tone and weight its Text was drawn with; borders are muted', () => {
    const rows = renderRuns(SAMPLE, 30)
    const styled = (r: readonly Seg[]) => r.filter(s => s.text.trim() !== '').map(s => [s.text.trim(), s.tone, s.bold])
    expect(styled(rows[1] ?? [])).toEqual([['│', 'muted', false], ['AGENT MONITOR', 'accent', true], ['│', 'muted', false]])
    expect(styled(rows[3] ?? [])).toEqual([['│', 'muted', false], ['待回覆', 'warn', false], ['!!', 'critical', true], ['old', 'muted', false], ['│', 'muted', false]])
    expect(rows[0]?.[0]).toEqual({ text: `╭${'─'.repeat(28)}╮`, tone: 'muted', bold: false })
  })

  test('the plain text is the styled runs with the styling dropped', () => {
    expect(renderText(SAMPLE, 30)).toEqual(renderRuns(SAMPLE, 30).map(r => r.map(s => s.text).join('')))
    expect(renderText(SAMPLE, 30)[3]).toBe('│ 待回覆  !! old             │')
  })
})

describe('SVG', () => {
  const rows = renderRuns(SAMPLE, 30)
  const svg = renderSvg(rows, 30, 'sample <one> & "two"')

  test('is well formed, references nothing outside, and rebuilds the plain text cell by cell', () => {
    expect(svgProblems(svg, renderText(SAMPLE, 30))).toEqual([])
    for (const bad of ['<script', 'href="http', '@import', 'url(']) expect(svg.includes(bad), bad).toBe(false)
  })

  test('special characters are escaped in text and title', () => {
    expect(svg).toContain('Bash &quot;a&lt;b&gt; &amp; c&#39;d&quot;')
    expect(svg).toContain('<title>sample &lt;one&gt; &amp; &quot;two&quot;</title>')
    expect(svg).not.toContain('"a<b>')
    expect(escapeXml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  test('colors and weight come from each piece’s tone', () => {
    expect(svg).toContain(`fill="${COLORS.accent}" font-weight="600">AGENT MONITOR</text>`)
    expect(svg).toContain(`fill="${COLORS.ok}">●</text>`)
    expect(svg).toContain(`fill="${COLORS.warn}">待回覆</text>`)
    expect(svg).toContain(`fill="${COLORS.critical}" font-weight="600">!!</text>`)
    expect(svg).toContain(`fill="${COLORS.muted}">old</text>`)
    expect(svg).toContain(`fill="${COLORS.plain}">Bash &quot;`)
  })

  test('each piece starts at its cell, is locked to cells × 8.4, and lines go down the page in order', () => {
    const all = pieces(svg)
    const wide = all.find(p => p.body === '待回覆')
    expect(wide?.attrs).toContain(`x="${num(cellX(2))}"`)
    expect(wide?.attrs).toContain(`textLength="${num(6 * CELL)}"`)
    const bang = all.find(p => p.body === '!!')
    expect(bang?.attrs).toContain(`x="${num(cellX(10))}"`)
    expect(bang?.attrs).toContain(`textLength="${num(2 * CELL)}"`)
    const ys = all.map(p => Number(/\sy="([^"]*)"/.exec(p.attrs)?.[1]))
    expect(ys.every((y, i) => i === 0 || y >= (ys[i - 1] ?? 0))).toBe(true)
    // The top and bottom rows are border strokes only; the three rows between carry text.
    expect([...new Set(ys)]).toEqual([1, 2, 3].map(i => Number(num(lineY(i)))))
    for (const p of all) expect(p.attrs).toContain('lengthAdjust="spacingAndGlyphs"')
  })

  test('card borders are strokes on the cell grid, one per run, in the border tone', () => {
    const strokes = [...svg.matchAll(/<path d="([^"]*)" stroke="([^"]*)" fill="none" data-col="(\d+)" data-row="(\d+)" data-text="([^"]*)"\/>/g)]
    const top = strokes.find(m => m[4] === '0')
    expect(top?.[5]).toBe(`╭${'─'.repeat(28)}╮`)
    expect(top?.[2]).toBe(COLORS.muted)
    // The ─ run is one horizontal stroke: the corner, one H across 28 cells, the other corner.
    expect(top?.[1]).toContain(`H${num(cellX(29))}`)
    expect(top?.[1]?.match(/H/g)?.length).toBe(1)
    const sides = strokes.filter(m => m[5] === '│' && m[4] === '1').map(m => m[3])
    expect(sides).toEqual(['0', '29'])
    expect(svg).not.toMatch(/>[─│╭╮╰╯]/)
  })

  test('the same rows draw the same bytes, with no time or randomness in them', () => {
    expect(renderSvg(renderRuns(SAMPLE, 30), 30, 'sample <one> & "two"')).toBe(svg)
  })

  test('the checks catch a broken picture', () => {
    const lines = renderText(SAMPLE, 30)
    expect(svgProblems(svg.replace('</g>', ''), lines).join()).toContain('left open')
    expect(svgProblems(svg.replace('&amp;', '&'), lines).join()).toContain('unescaped &')
    expect(svgProblems(svg.replace('<title>', '<script>x</script><title>'), lines).join()).toContain('contains <script')
    expect(svgProblems(svg.replace(`textLength="${num(6 * CELL)}"`, 'textLength="40.0"'), lines).join()).toContain('textLength')
    expect(svgProblems(svg.replace(`x="${num(cellX(10))}"`, `x="${num(cellX(11))}"`), lines).join()).toContain('rebuilds as')
    expect(svgProblems(svg.replace('data-col="29" data-row="1"', 'data-col="28" data-row="1"'), lines).join()).toContain('starts outside its cell')
  })
})
