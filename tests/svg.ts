// Draws styled runs (tests/kit.ts renderRuns) as a dark, terminal-like SVG for the README.
// Alignment does not depend on the font: every piece is placed by its cell index and locked to
// cells x CELL with textLength, and the card borders (─ │ ╭ ╮ ╰ ╯) are strokes on the same cell
// grid, so they line up and join in whatever monospace font the viewer has.
import { cells } from './kit'
import type { Seg, Tone } from './kit'

export const CELL = 8.4
export const LINE = 20
export const FONT_SIZE = 14
export const PAD = 16
export const BAR = 28
/** Baseline offset of a text line inside its LINE-high row. */
export const BASELINE = 15
export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

export const COLORS: Record<Tone, string> = {
  plain: '#d7dae0',
  muted: '#7f8794',
  accent: '#61afef',
  ok: '#4ec98a',
  warn: '#e5c07b',
  critical: '#ef6b73',
}

const BACKGROUND = '#16181d'
const BAR_FILL = '#1d2026'
const EDGE = '#2b2f36'

/** Fixed one-decimal coordinates, so the same input always prints the same bytes. */
export const num = (n: number): string => n.toFixed(1)

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Where line `row` (0-based) puts its baseline. */
export const lineY = (row: number): number => BAR + PAD + row * LINE + BASELINE

/** Where cell `col` (0-based) starts. */
export const cellX = (col: number): number => PAD + col * CELL

/** Line-drawing characters drawn as strokes, so card borders join up whatever the font. */
export const BOX = /[─│╭╮╰╯]/

/** The stroke of one line-drawing character in the cell at (`x`, `top`). */
const boxStroke = (ch: string, x: number, top: number): string => {
  const cx = x + CELL / 2
  const cy = top + LINE / 2
  const r = CELL / 2
  const bottom = top + LINE
  const right = x + CELL
  switch (ch) {
    case '─':
      return `M${num(x)} ${num(cy)}H${num(right)}`
    case '│':
      return `M${num(cx)} ${num(top)}V${num(bottom)}`
    case '╭':
      return `M${num(cx)} ${num(bottom)}V${num(cy + r)}A${num(r)} ${num(r)} 0 0 1 ${num(right)} ${num(cy)}`
    case '╮':
      return `M${num(x)} ${num(cy)}A${num(r)} ${num(r)} 0 0 1 ${num(cx)} ${num(cy + r)}V${num(bottom)}`
    case '╰':
      return `M${num(cx)} ${num(top)}V${num(cy - r)}A${num(r)} ${num(r)} 0 0 0 ${num(right)} ${num(cy)}`
    default:
      return `M${num(x)} ${num(cy)}A${num(r)} ${num(r)} 0 0 0 ${num(cx)} ${num(cy - r)}V${num(top)}`
  }
}

/** Splits a piece into runs that are all line-drawing characters or none. */
const runsOf = (text: string): string[] => text.match(/[─│╭╮╰╯]+|[^─│╭╮╰╯]+/g) ?? []

const textLine = (row: readonly Seg[], index: number): string[] => {
  const out: string[] = []
  const top = BAR + PAD + index * LINE
  let col = 0
  for (const seg of row) {
    for (const run of runsOf(seg.text)) {
      if (BOX.test(run)) {
        // One path per run; a run of ─ is one stroke across its cells.
        const d = [...run].map((ch, i) => boxStroke(ch, cellX(col + i), top)).join('').replace(/H[\d.]+M[\d.]+ [\d.]+(?=H)/g, '')
        out.push(`<path d="${d}" stroke="${COLORS[seg.tone]}" fill="none" data-col="${col}" data-row="${index}" data-text="${escapeXml(run)}"/>`)
      } else {
        const body = run.trim()
        if (body !== '') {
          const lead = cells(run) - cells(run.trimStart())
          const weight = seg.bold ? ' font-weight="600"' : ''
          out.push(
            `<text x="${num(cellX(col + lead))}" y="${num(lineY(index))}" textLength="${num(cells(body) * CELL)}" lengthAdjust="spacingAndGlyphs" fill="${COLORS[seg.tone]}"${weight}>${escapeXml(body)}</text>`,
          )
        }
      }
      col += cells(run)
    }
  }
  return out
}

/** One SVG for `rows` drawn at `columns` cells, under a title bar reading `title`. */
export const renderSvg = (rows: readonly (readonly Seg[])[], columns: number, title: string): string => {
  const w = 2 * PAD + columns * CELL
  const h = BAR + 2 * PAD + rows.length * LINE
  const r = 10
  const t = escapeXml(title)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}" role="img" aria-label="${t}" xml:space="preserve">`,
    `<title>${t}</title>`,
    `<rect x="0.5" y="0.5" width="${num(w - 1)}" height="${num(h - 1)}" rx="${r}" fill="${BACKGROUND}"/>`,
    `<path d="M0.5 ${BAR} V${num(r + 0.5)} A${r} ${r} 0 0 1 ${num(r + 0.5)} 0.5 H${num(w - r - 0.5)} A${r} ${r} 0 0 1 ${num(w - 0.5)} ${num(r + 0.5)} V${BAR} Z" fill="${BAR_FILL}"/>`,
    `<line x1="0.5" y1="${num(BAR + 0.5)}" x2="${num(w - 0.5)}" y2="${num(BAR + 0.5)}" stroke="${EDGE}"/>`,
    `<rect x="0.5" y="0.5" width="${num(w - 1)}" height="${num(h - 1)}" rx="${r}" fill="none" stroke="${EDGE}"/>`,
    `<text x="${num(PAD)}" y="18.0" font-family="${escapeXml(FONT)}" font-size="12" fill="${COLORS.muted}">${t}</text>`,
    `<g font-family="${escapeXml(FONT)}" font-size="${FONT_SIZE}">`,
    ...rows.flatMap(textLine),
    '</g>',
    '</svg>',
  ].join('\n')
}

// ---------- checks the tests run on every SVG ----------

const FORBIDDEN = ['<script', 'href="http', '@import', 'url(', '<image', '<style', '<foreignObject']

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

const attr = (attrs: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1]

/**
 * What is wrong with `svg` as a drawing of `lines` (the plain text of the same rows), or [] when
 * nothing is: tags pair up, nothing external is referenced, every & starts an entity, each line's
 * pieces sit on that line's baseline in order, each piece is locked to its cells, each border stroke
 * starts in its own cell, and putting every piece and stroke back at its cell rebuilds `lines` exactly.
 */
export const svgProblems = (svg: string, lines: readonly string[]): string[] => {
  const problems: string[] = []
  for (const bad of FORBIDDEN) if (svg.includes(bad)) problems.push(`contains ${bad}`)
  const stray = svg.match(/&(?!(?:amp|lt|gt|quot|#39);)/g)
  if (stray !== null) problems.push(`${stray.length} unescaped &`)
  const stack: string[] = []
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g
  let last = 0
  for (let m = tag.exec(svg); m !== null; m = tag.exec(svg)) {
    if (/[<>]/.test(svg.slice(last, m.index))) problems.push(`stray < or > before offset ${m.index}`)
    last = tag.lastIndex
    const [, close, name = '', , self] = m
    if (close === '/') {
      if (stack.pop() !== name) problems.push(`</${name}> closes nothing open`)
    } else if (self !== '/') stack.push(name)
  }
  if (/[<>]/.test(svg.slice(last))) problems.push('stray < or > at the end')
  if (stack.length > 0) problems.push(`left open: ${stack.join(', ')}`)
  if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>')) problems.push('not one <svg> element')

  const rebuilt: { col: number; text: string }[][] = lines.map(() => [])
  let prevY = -Infinity
  const piece = /<text(\s[^>]*textLength="[^"]*"[^>]*)>([^<]*)<\/text>/g
  for (let m = piece.exec(svg); m !== null; m = piece.exec(svg)) {
    const attrs = m[1] ?? ''
    const text = unescapeXml(m[2] ?? '')
    const x = Number(attr(attrs, 'x'))
    const y = Number(attr(attrs, 'y'))
    const at = (y - BAR - PAD - BASELINE) / LINE
    const row = Math.round(at)
    const col = Math.round((x - PAD) / CELL)
    if (y < prevY) problems.push(`y goes back up at "${text}"`)
    prevY = y
    if (Math.abs(at - row) > 1e-6 || row < 0 || row >= lines.length) {
      problems.push(`"${text}" is off the line grid (y ${y})`)
      continue
    }
    if (Math.abs((x - PAD) / CELL - col) > 1e-3) problems.push(`"${text}" is off the cell grid (x ${x})`)
    if (attr(attrs, 'textLength') !== num(cells(text) * CELL)) problems.push(`"${text}" textLength ${attr(attrs, 'textLength')} is not ${num(cells(text) * CELL)}`)
    if (attr(attrs, 'lengthAdjust') !== 'spacingAndGlyphs') problems.push(`"${text}" lacks lengthAdjust`)
    rebuilt[row]?.push({ col, text })
  }
  const stroke = /<path d="M([\d.]+) ([\d.]+)[^"]*"[^>]*\sdata-col="(\d+)" data-row="(\d+)" data-text="([^"]*)"\/>/g
  for (let m = stroke.exec(svg); m !== null; m = stroke.exec(svg)) {
    const [x, y, col, row] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number]
    const text = unescapeXml(m[5] ?? '')
    const left = cellX(col)
    const top = BAR + PAD + row * LINE
    if (!BOX.test(text) || [...text].some(ch => !BOX.test(ch))) problems.push(`stroke "${text}" is not all line drawing`)
    if (x < left - 1e-6 || x > left + CELL + 1e-6 || y < top - 1e-6 || y > top + LINE + 1e-6) problems.push(`stroke "${text}" starts outside its cell (${col}, ${row})`)
    if (row >= lines.length) problems.push(`stroke "${text}" is below the last line`)
    else rebuilt[row]?.push({ col, text })
  }
  rebuilt.forEach((pieces, i) => {
    let out = ''
    for (const p of [...pieces].sort((a, b) => a.col - b.col)) {
      if (cells(out) > p.col) problems.push(`line ${i}: "${p.text}" overlaps what comes before it`)
      out += ' '.repeat(Math.max(0, p.col - cells(out))) + p.text
    }
    if (out !== (lines[i] ?? '').trimEnd()) problems.push(`line ${i} rebuilds as "${out}", not "${lines[i]}"`)
  })
  return problems
}
