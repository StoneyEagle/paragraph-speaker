/**
 * Finding the spoken words inside a reply's own markdown, and marking one.
 *
 * The voice reads the selection as the person saw it (rendered text, markdown
 * gone); the transcript row holds markdown. Both are cut into word cores (runs
 * of letters and digits) and lined up, so spoken word i maps to a range of the
 * markdown. Marking wraps that range in inline code (a shaded box) or bold.
 */

/** Where one spoken word sits in the markdown. */
export type Span = {
  start: number
  end: number
  /** Inside code, a link's address or a web address: a mark there would break it. */
  isUnmarkable: boolean
  /** Inside **bold**: a bold mark would end that bold, so a code mark is used. */
  isInBold: boolean
}

/**
 * orange: the word bold in Claude's orange; color: orange alone, so the line
 * never moves (bold is wider). For both the mod draws the blocks being read.
 * code, bold: markdown marks on the app's own drawing.
 */
export type MarkStyle = 'orange' | 'color' | 'code' | 'bold'

/** No word spoken yet: blocks drawn with nothing marked. */
export const NO_SPAN: Span = { start: -1, end: -1, isUnmarkable: false, isInBold: false }

/** Plain text (a person's own message) as lines, the spoken word split out. */
export function plainLines(text: string, spoken: Span): Line[] {
  let at = 0
  return text.split('\n').map(line => {
    const from = at
    at += line.length + 1
    const s = Math.max(spoken.start - from, 0)
    const e = Math.min(spoken.end - from, line.length)
    const split: Piece[] = [{ text: line.slice(0, s) }, { text: line.slice(s, e), isSpoken: true }, { text: line.slice(e) }]
    const pieces: Piece[] = e <= s ? [{ text: line }] : split.filter(p => p.text !== '')
    return { prefix: '', pieces, isHeading: false, isQuote: false }
  })
}

type Token = Span & { core: string }

const CORE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
/** How far ahead in the markdown a spoken word is looked for. */
const LOOKAHEAD = 12

/** Ranges no mark may go in: fenced and inline code, link addresses, web addresses. */
function unmarkableRanges(md: string): [number, number][] {
  const ranges: [number, number][] = []
  const add = (re: RegExp) => {
    for (const m of md.matchAll(re)) ranges.push([m.index, m.index + m[0].length])
  }
  add(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm)
  add(/(`+)(?!`)(?:[^\n]|\n(?!\s*\n))*?[^`]\1(?!`)/g)
  add(/\]\([^)]*\)/g)
  add(/<[a-z][a-z0-9+.-]*:[^>\s]*>|https?:\/\/[^\s<>()\]]+/gi)
  return ranges
}

function isInside(ranges: [number, number][], start: number, end: number): boolean {
  return ranges.some(([a, b]) => start < b && end > a)
}

/** True when an odd number of ** or __ open before `at` in its paragraph. */
function isInBoldAt(md: string, at: number, unmarkable: [number, number][]): boolean {
  const from = md.lastIndexOf('\n\n', at) + 1
  let open = false
  for (const m of md.slice(from, at).matchAll(/\*\*|__/g)) {
    const p = from + m.index
    if (!isInside(unmarkable, p, p + 2)) open = !open
  }
  return open
}

function tokens(md: string): Token[] {
  const unmarkable = unmarkableRanges(md)
  return [...md.matchAll(CORE)].map(m => {
    const start = m.index
    const end = start + m[0].length
    return {
      core: m[0].toLowerCase(),
      start,
      end,
      isUnmarkable: isInside(unmarkable, start, end),
      isInBold: isInBoldAt(md, start, unmarkable),
    }
  })
}

/**
 * Lines the spoken words up with the markdown: entry i is where word i sits,
 * undefined for a word not found there. Null when the words are not in this
 * markdown at all (three in a row must match to start), so another row's.
 */
export function align(
  md: string,
  words: readonly string[],
  /** Words that are not on screen (a table's spoken explanation): never matched. */
  skip: ReadonlySet<number> = new Set(),
): (Span | undefined)[] | null {
  const marks = tokens(md)
  const spoken: { core: string; word: number }[] = []
  words.forEach((word, i) => {
    if (skip.has(i)) return
    for (const m of word.matchAll(CORE)) spoken.push({ core: m[0].toLowerCase(), word: i })
  })
  if (spoken.length === 0 || marks.length === 0) return null

  // Where the selection starts: the first spoken core whose next ones follow it in the markdown.
  const need = Math.min(3, spoken.length)
  const where = new Map<string, number[]>()
  marks.forEach((t, j) => where.set(t.core, [...(where.get(t.core) ?? []), j]))
  let k0 = -1
  let j0 = -1
  search: for (let k = 0; k + need <= spoken.length; k++) {
    for (const j of where.get(spoken[k]!.core) ?? []) {
      let d = 1
      while (d < need && j + d < marks.length && marks[j + d]!.core === spoken[k + d]!.core) d++
      if (d === need) {
        k0 = k
        j0 = j
        break search
      }
    }
  }
  if (k0 < 0) return null

  // From there, each spoken core is looked for a little way ahead; one not found is skipped.
  const spans: (Span | undefined)[] = words.map(() => undefined)
  let j = j0
  for (let k = k0; k < spoken.length && j < marks.length; k++) {
    let found = -1
    for (let d = 0; d < LOOKAHEAD && j + d < marks.length; d++) {
      if (marks[j + d]!.core === spoken[k]!.core) {
        found = j + d
        break
      }
    }
    // Lost the place (a table read as an explanation, text the copy left out):
    // find it again further on, where the next few spoken words follow in a row.
    if (found < 0) found = resync(marks, spoken, k, j + LOOKAHEAD)
    if (found < 0) continue
    const t = marks[found]!
    const w = spoken[k]!.word
    const prev = spans[w]
    if (prev === undefined) {
      spans[w] = { start: t.start, end: t.end, isUnmarkable: t.isUnmarkable, isInBold: t.isInBold }
    } else if (/^[.'’-]*$/.test(md.slice(prev.end, t.start))) {
      // A word of several cores ("e.g.", "x-ray") is marked whole when only plain marks part them.
      spans[w] = { ...prev, end: t.end, isUnmarkable: prev.isUnmarkable || t.isUnmarkable }
    }
    j = found + 1
  }
  return spans
}

/** Where spoken[k] and the next two cores follow in a row in the markdown, from `from` on; -1 if nowhere near. */
function resync(marks: Token[], spoken: { core: string }[], k: number, from: number): number {
  const need = Math.min(3, spoken.length - k)
  if (need < 2) return -1 // one word alone is too weak to jump on
  for (let p = from; p < Math.min(marks.length, from + 3000); p++) {
    let d = 0
    while (d < need && p + d < marks.length && marks[p + d]!.core === spoken[k + d]!.core) d++
    if (d === need) return p
  }
  return -1
}

// ── Tables ──

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** The markdown tables: blocks whose second line is a |---|---| rule. */
export function tablesOf(md: string): Block[] {
  return blocksOf(md).filter(b => {
    const [head, rule] = md.slice(b.start, b.end).split('\n')
    return head !== undefined && head.includes('|') && rule !== undefined && TABLE_RULE.test(rule)
  })
}

/** One table line's cells, its outer pipes left out. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim())
}

/** A table's rows of cells, the header row first, the rule left out. */
export function tableCells(table: string): string[][] {
  return table
    .split('\n')
    .filter((line, i) => i !== 1 && line.trim() !== '')
    .map(splitRow)
}

/** A cell's markdown as the plain text it shows: links, bold, italic, code marks and escapes gone. */
export function plainCell(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(?<![\p{L}\p{N}*])\*(\S(?:[^*]*\S)?)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(\S(?:[^_]*\S)?)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\\([|\\`*_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One cell of a table the mod draws: its runs (marked ones `isSpoken`), and whether the part spoken is about it. */
export type GridCell = { pieces: Piece[]; isMarked: boolean }

/**
 * A table as the mod draws it in the app's own table's place: its rows (the
 * header first, left out when all its cells are empty, as the app leaves it
 * out), each column's share of the width and its alignment.
 */
export type GridTable = {
  header: GridCell[] | null
  rows: GridCell[][]
  widths: string[]
  aligns: ('left' | 'center' | 'right')[]
}

/** The app's reply text: 15px; a table cell's padding, 8px a side. */
const FONT_PX = 15
const CELL_PAD_PX = 16

/** About how wide a run draws in the app's sans font, in ems; code in its monospace, with its 4px padding a side. */
function emsOf(text: string, isBold: boolean, isCode: boolean): number {
  let ems = 0
  for (const ch of text) {
    if (isCode) ems += 0.54
    else if (ch === ' ') ems += 0.27
    else if (/[iljtfrI.,:;!'|()[\]]/.test(ch)) ems += 0.3
    else if (/[mwMW@%]/.test(ch)) ems += 0.85
    else if (/[A-Z]/.test(ch)) ems += 0.66
    else if (/[0-9]/.test(ch)) ems += 0.56
    else if (/[a-z]/.test(ch)) ems += 0.52
    else if (/[\p{Extended_Pictographic}　-鿿가-힯]/u.test(ch)) ems += 1
    else ems += 0.6
  }
  if (isCode && text !== '') ems += 0.55
  return isBold ? ems * 1.06 : ems
}

/** A cell's widest unbreakable word and its whole run, in pixels, its padding in. */
function cellWidths(pieces: Piece[], isHeader: boolean): { min: number; max: number } {
  let max = 0
  let min = 0
  let word = 0
  for (const p of pieces) {
    const isBold = isHeader || p.isBold === true
    for (const part of p.text.split(/( )/)) {
      if (part === ' ') {
        min = Math.max(min, word)
        word = 0
        max += emsOf(' ', isBold, p.isCode === true)
        continue
      }
      const w = emsOf(part, isBold, p.isCode === true)
      word += w
      max += w
    }
  }
  min = Math.max(min, word)
  return { min: min * FONT_PX + CELL_PAD_PX, max: max * FONT_PX + CELL_PAD_PX }
}

/**
 * Each column's share of a table `available` pixels wide, as the browser lays
 * out the app's full-width table: with room for every cell on one line, in
 * proportion to the columns' widest cells; with less, each column's widest
 * word first and what is left in proportion to what each still lacks.
 */
function columnShares(min: number[], max: number[], available: number | undefined): number[] {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  if (available === undefined || sum(max) <= available) return max
  if (sum(min) >= available) return min
  const lacking = max.map((m, c) => m - min[c]!)
  const room = available - sum(min)
  return min.map((m, c) => m + (sum(lacking) > 0 ? (room * lacking[c]!) / sum(lacking) : 0))
}

/**
 * A table to draw in the app's table's place, the same size: its cells' runs,
 * the cells `refs` name marked, each column as wide as the app makes it
 * (estimated from its text), so a mark that colors a cell moves nothing.
 * `available` is the width the reply has, in pixels, when known.
 */
export function gridTable(table: string, refs: readonly CellRef[], available?: number): GridTable {
  const isRef = (row: number, col: number) =>
    refs.some(r => (r.row === undefined || r.row === row) && (r.col === undefined || r.col === col))
  const cells = tableCells(table)
  const cols = Math.max(0, ...cells.map(row => row.length))
  const rule = splitRow(table.split('\n')[1] ?? '')
  const aligns = Array.from({ length: cols }, (_, c) => {
    const r = rule[c] ?? ''
    return /^:-+:$/.test(r) ? ('center' as const) : /-:$/.test(r) ? ('right' as const) : ('left' as const)
  })
  const grid = cells.map((row, r) =>
    Array.from({ length: cols }, (_, c): GridCell => {
      const isMarked = isRef(r, c + 1)
      const pieces = inlinePieces(row[c] ?? '', 0, NO_SPAN).map(p => ({
        ...p,
        ...(r === 0 ? { isBold: true as const } : {}),
        ...(isMarked ? { isSpoken: true as const } : {}),
      }))
      return { pieces, isMarked }
    }),
  )
  const [head = [], ...rows] = grid
  const isHeaderShown = head.some(cell => cell.pieces.some(p => p.text.trim() !== ''))
  const shown = isHeaderShown ? [head, ...rows] : rows
  const sizes = shown.map((row, r) => row.map(cell => cellWidths(cell.pieces, isHeaderShown && r === 0)))
  const min = Array.from({ length: cols }, (_, c) => Math.max(0, ...sizes.map(row => row[c]!.min)))
  const max = Array.from({ length: cols }, (_, c) => Math.max(0, ...sizes.map(row => row[c]!.max)))
  const shares = columnShares(min, max, available === undefined ? undefined : available - 2 * (cols + 1))
  return { header: isHeaderShown ? head : null, rows, widths: wholePercents(shares).map(p => `${p}%`), aligns }
}

/** Shares as whole percents (a Box takes no fraction of one) that add up to 100, each at least 1. */
function wholePercents(shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0) || 1
  const exact = shares.map(s => (100 * s) / total)
  const whole = exact.map(x => Math.max(1, Math.floor(x)))
  // The percents left over go to the columns that lost the most to rounding down.
  const order = exact.map((x, c) => [x - Math.floor(x), c] as const).sort((a, b) => b[0] - a[0])
  for (let i = 0, left = 100 - whole.reduce((a, b) => a + b, 0); left > 0 && order.length > 0; i++, left--) {
    whole[order[i % order.length]![1]]! += 1
  }
  return whole
}

/**
 * What part of a table a spoken part is about: one cell (row and col), a whole
 * row (row alone) or a whole column (col alone). Row 0 is the header, the
 * first row under it is 1; the first column is 1.
 */
export type CellRef = { row?: number; col?: number }

/** One part of a table's spoken explanation and the cells it talks about. */
export type ExplanationPart = { say: string; refs: CellRef[] }

/** A table read row by row, each cell with its column's name, each row marked as it is read. */
export function readTableParts(table: string, plain: (md: string) => string): ExplanationPart[] {
  const [head = [], ...rows] = tableCells(table)
  const names = head.map((h, i) => plain(h).replace(/[.]$/, '') || `column ${i + 1}`)
  const list = (items: string[]) =>
    items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  const said: ExplanationPart[] = [
    { say: `A table with ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} and the columns ${list(names)}.`, refs: [{ row: 0 }] },
  ]
  rows.forEach((row, r) => {
    const cells = row
      .map((cell, c) => [names[c] ?? `column ${c + 1}`, plain(cell).replace(/[.]$/, '')] as const)
      .filter(([, value]) => value !== '')
      .map(([name, value]) => `${name}: ${value}`)
    said.push({ say: `Row ${r + 1}. ${cells.join(', ')}.`, refs: [{ row: r + 1 }] })
  })
  return said
}

/** A table read row by row, as one text. */
export function readTable(table: string, plain: (md: string) => string): string {
  return readTableParts(table, plain)
    .map(p => p.say)
    .join(' ')
}

/** The table with its rows and columns numbered, as the model is shown it. */
export function numberedTable(table: string): string {
  return tableCells(table)
    .map((row, r) => `Row ${r}${r === 0 ? ' (header)' : ''}: ${row.map((cell, c) => `col ${c + 1}: ${cell}`).join(' | ')}`)
    .join('\n')
}

/**
 * The model's answer as explanation parts: JSON `{"parts":[{"say","refs"}]}`,
 * fenced or not. Refs outside the table are dropped. Null when it is not that
 * JSON (the caller then speaks plain text, or reads the table row by row).
 */
export function parseExplanation(answer: string, table: string): ExplanationPart[] | null {
  const from = answer.indexOf('{')
  const to = answer.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  let data: unknown
  try {
    data = JSON.parse(answer.slice(from, to + 1))
  } catch {
    return null
  }
  const parts = (data as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null
  const cells = tableCells(table)
  const rows = cells.length
  const cols = Math.max(0, ...cells.map(row => row.length))
  const isIn = (n: unknown, min: number, max: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max
  const out: ExplanationPart[] = []
  for (const part of parts as unknown[]) {
    const say = (part as { say?: unknown }).say
    if (typeof say !== 'string' || say.trim() === '') continue
    const refs = (part as { refs?: unknown }).refs
    const kept: CellRef[] = []
    for (const ref of Array.isArray(refs) ? (refs as unknown[]) : []) {
      const { row, col } = (ref ?? {}) as { row?: unknown; col?: unknown }
      const hasRow = isIn(row, 0, rows - 1)
      const hasCol = isIn(col, 1, cols)
      if (hasRow || hasCol) kept.push({ ...(hasRow ? { row } : {}), ...(hasCol ? { col } : {}) })
    }
    out.push({ say: say.trim(), refs: kept })
  }
  return out.length > 0 ? out : null
}

/** The markdown with one word marked; unchanged where no mark fits. */
export function markWord(md: string, span: Span, style: 'code' | 'bold'): string {
  if (span.isUnmarkable) return md
  const word = md.slice(span.start, span.end)
  const marked = style === 'bold' && !span.isInBold ? `**${word}**` : `\`${word}\``
  return md.slice(0, span.start) + marked + md.slice(span.end)
}

// ── Drawing one block by hand, for a mark markdown has no way to say (a color) ──

/** A block of the markdown: a paragraph, a list, a heading, a code block. */
export type Block = { start: number; end: number }

/** One run of a line's text and its look. */
export type Piece = {
  text: string
  isBold?: true
  isItalic?: true
  isCode?: true
  isStrike?: true
  isLink?: true
  /** The word being spoken. */
  isSpoken?: true
}

/**
 * One line of a block as it reads: what opens it (a bullet, a number), its
 * runs. A heading's `level` (1 for #) and a list item's `item` (how deep it
 * sits, its bullet or number) say how to lay it out as the app does.
 */
export type Line = {
  prefix: string
  pieces: Piece[]
  isHeading: boolean
  isQuote: boolean
  level?: number
  item?: { depth: number; marker: string }
}

/** The markdown cut into blocks at blank lines; a fenced code block stays one block. */
export function blocksOf(md: string): Block[] {
  const out: Block[] = []
  let start = -1
  let fence: string | null = null
  let pos = 0
  for (const line of md.split('\n')) {
    const lineStart = pos
    pos += line.length + 1
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      if (start < 0) start = lineStart
      continue
    }
    if (line.trim() === '') {
      if (start >= 0) out.push({ start, end: lineStart - 1 })
      start = -1
      continue
    }
    if (start < 0) start = lineStart
  }
  if (start >= 0) out.push({ start, end: md.length })
  return out
}

/**
 * A block's lines as styled runs, the spoken word split out as its own run;
 * null for a block only markdown draws well (code, a table, html, a rule).
 */
export function blockLines(md: string, block: Block, spoken: Span): Line[] | null {
  const lines: Line[] = []
  let offset = block.start
  for (const raw of md.slice(block.start, block.end).split('\n')) {
    const at = offset
    offset += raw.length + 1
    if (/^[ \t]*(`{3,}|~{3,})|^\s*\||^\s*<|^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return null
    let body = raw
    let bodyAt = at
    const cut = (n: number) => {
      body = body.slice(n)
      bodyAt += n
    }
    let prefix = ''
    const quote = /^\s*>\s?/.exec(body)
    if (quote) {
      prefix = '│ '
      cut(quote[0].length)
    }
    const heading = /^\s{0,3}(#{1,6})\s+/.exec(body)
    if (heading) cut(heading[0].length)
    const item = /^(\s*)([-*+]|\d+[.)])\s+/.exec(body)
    let listItem: Line['item']
    if (item) {
      const depth = Math.floor(item[1]!.length / 2)
      const marker = /\d/.test(item[2]!) ? item[2]! : '•'
      prefix += '  '.repeat(depth) + `${marker} `
      listItem = { depth, marker }
      cut(item[0].length)
    } else if (!heading && lines.length > 0) {
      // A line that goes on from the one before (a soft break) reads as one line.
      cut(body.length - body.trimStart().length)
      lines[lines.length - 1]!.pieces.push({ text: ' ' }, ...inlinePieces(body, bodyAt, spoken))
      continue
    }
    lines.push({
      prefix,
      pieces: inlinePieces(body, bodyAt, spoken),
      isHeading: heading !== null,
      isQuote: quote !== null,
      ...(heading ? { level: heading[1]!.length } : {}),
      ...(listItem ? { item: listItem } : {}),
    })
  }
  return lines
}

/** A line's inline markdown (bold, italic, code, links, strike) as runs; `at` is where it sits in the whole markdown. */
function inlinePieces(body: string, at: number, spoken: Span): Piece[] {
  const pieces: Piece[] = []
  const look: Omit<Piece, 'text'> = {}
  const push = (text: string, from: number, extra: Omit<Piece, 'text'> = {}) => {
    if (text === '') return
    const base = { ...look, ...extra }
    const s = Math.max(spoken.start - from, 0)
    const e = Math.min(spoken.end - from, text.length)
    if (e <= s) {
      pieces.push({ text, ...base })
      return
    }
    if (s > 0) pieces.push({ text: text.slice(0, s), ...base })
    pieces.push({ text: text.slice(s, e), ...base, isSpoken: true })
    if (e < text.length) pieces.push({ text: text.slice(e), ...base })
  }
  const toggle = (key: 'isBold' | 'isItalic' | 'isStrike') => {
    if (look[key]) delete look[key]
    else look[key] = true
  }
  let run = ''
  let runAt = at
  const flush = () => {
    push(run, runAt)
    run = ''
  }
  let i = 0
  while (i < body.length) {
    const rest = body.slice(i)
    const prev = body[i - 1] ?? ' '
    let m: RegExpExecArray | null
    if ((m = /^\\([!-/:-@[-`{-~])/.exec(rest))) {
      flush()
      push(m[1]!, at + i + 1)
    } else if ((m = /^(`+)(.*?[^`])\1(?!`)/.exec(rest)) || (m = /^(`)([^`])\1/.exec(rest))) {
      flush()
      push(m[2]!, at + i + m[1]!.length, { isCode: true })
    } else if ((m = /^!?\[([^\]]*)\]\([^)]*\)/.exec(rest))) {
      flush()
      push(m[1]!, at + i + rest.indexOf('[') + 1, { isLink: true })
    } else if ((m = /^<(https?:[^>\s]+)>/.exec(rest))) {
      flush()
      push(m[1]!, at + i + 1, { isLink: true })
    } else if ((m = /^(\*\*|__|~~)/.exec(rest)) && (look[m[1] === '~~' ? 'isStrike' : 'isBold'] || body.indexOf(m[1]!, i + 2) > i + 2)) {
      if (m[1] === '__' && /[\p{L}\p{N}]/u.test(prev) && !look.isBold) {
        if (run === '') runAt = at + i
        run += m[1]
      } else {
        flush()
        toggle(m[1] === '~~' ? 'isStrike' : 'isBold')
      }
    } else if (
      (m = /^[*_]/.exec(rest)) &&
      (look.isItalic ? prev !== ' ' : /\S/.test(body[i + 1] ?? ' ') && body.indexOf(m[0], i + 1) > i + 1) &&
      !(m[0] === '_' && /[\p{L}\p{N}]/u.test(look.isItalic ? (body[i + 1] ?? ' ') : prev))
    ) {
      flush()
      toggle('isItalic')
    } else {
      if (run === '') runAt = at + i
      run += body[i]
      i += 1
      continue
    }
    i += m[0].length
  }
  flush()
  return pieces
}
