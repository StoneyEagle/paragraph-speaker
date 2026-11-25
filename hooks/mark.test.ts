import { expect, test } from 'claude-code/testing'

import {
  NO_SPAN,
  align,
  blockLines,
  blocksOf,
  gridTable,
  markWord,
  parseExplanation,
  plainCell,
  plainLines,
  readTable,
  readTableParts,
  tableCells,
  tablesOf,
} from './mark'
import type { GridCell, GridTable, Line, Span } from './mark'

/** A line as plain text, the spoken word in [brackets]. */
const readable = (line: Line) => line.prefix + line.pieces.map(p => (p.isSpoken ? `[${p.text}]` : p.text)).join('')
const spanOf = (md: string, word: string): Span => {
  const start = md.indexOf(word)
  return { start, end: start + word.length, isUnmarkable: false, isInBold: false }
}

const TABLE_REPLY = [
  'Before the table.',
  '',
  '| Plan | Price | Speed |',
  '|:---|---:|---|',
  '| Basic | 5 | slow |',
  '| Pro | 12 | `fast` |',
  '',
  'After the table comes more text here.',
].join('\n')

test('tables are found, their cells read, and read row by row when they cannot be explained', () => {
  const [table] = tablesOf(TABLE_REPLY)
  const text = TABLE_REPLY.slice(table!.start, table!.end)
  expect(tablesOf('a | b\nnot a rule')).toEqual([])
  expect(tableCells(text)).toEqual([
    ['Plan', 'Price', 'Speed'],
    ['Basic', '5', 'slow'],
    ['Pro', '12', '`fast`'],
  ])
  expect(readTable(text, toSpeech)).toBe(
    'A table with 2 rows and the columns Plan, Price and Speed. Row 1. Plan: Basic, Price: 5, Speed: slow. Row 2. Plan: Pro, Price: 12, Speed: fast.',
  )
})

const TABLE = '| Plan | Price | Speed |\n|---|---|---|\n| Basic | 5 | slow |\n| **Pro** | 12 | `fast` |'

test('the model’s parts are read with their cells; refs outside the table are dropped', () => {
  const answer = [
    '```json',
    '{"parts":[',
    '{"say":"Two plans are compared.","refs":[]},',
    '{"say":"Pro costs twelve.","refs":[{"row":2,"col":2},{"row":9},{"col":7},{}]},',
    '{"say":"Speed differs.","refs":[{"col":3}]},',
    '{"say":"  ","refs":[]}',
    ']}',
    '```',
  ].join('\n')
  expect(parseExplanation(answer, TABLE)).toEqual([
    { say: 'Two plans are compared.', refs: [] },
    { say: 'Pro costs twelve.', refs: [{ row: 2, col: 2 }] },
    { say: 'Speed differs.', refs: [{ col: 3 }] },
  ])
  expect(parseExplanation('Just a plain explanation.', TABLE)).toBeNull()
  expect(parseExplanation('{"parts": "nope"}', TABLE)).toBeNull()
})

const cellText = (cell: GridCell) => cell.pieces.map(p => p.text).join('')
const markedCells = (grid: GridTable) => [grid.header ?? [], ...grid.rows].flatMap(row => row.filter(c => c.isMarked).map(cellText))
const shares = (grid: GridTable) => grid.widths.map(w => Number.parseFloat(w))

test('a table drawn in the app table’s place keeps its cells’ looks and marks the cells talked about', () => {
  const grid = gridTable(TABLE, [{ row: 2, col: 2 }])
  expect(grid.header!.map(cellText)).toEqual(['Plan', 'Price', 'Speed'])
  expect(grid.rows.map(row => row.map(cellText))).toEqual([
    ['Basic', '5', 'slow'],
    ['Pro', '12', 'fast'],
  ])
  // The header is bold, as the app draws it; a cell's own bold and code stay.
  expect(grid.header!.every(cell => cell.pieces.every(p => p.isBold))).toBe(true)
  expect(grid.rows[1]![0]!.pieces[0]!.isBold).toBe(true)
  expect(grid.rows[1]![2]!.pieces[0]!.isCode).toBe(true)
  // The cell talked about, its runs marked as spoken
  expect(markedCells(grid)).toEqual(['12'])
  expect(grid.rows[1]![1]!.pieces.every(p => p.isSpoken)).toBe(true)
  // A row, a column (its header too)
  expect(markedCells(gridTable(TABLE, [{ row: 1 }]))).toEqual(['Basic', '5', 'slow'])
  expect(markedCells(gridTable(TABLE, [{ col: 3 }]))).toEqual(['Speed', 'slow', 'fast'])
  // The rule's alignment: ---: is right-aligned, :---: centered
  expect(gridTable('| Name | Price | Mid |\n|---|---:|:---:|\n| a | 5 | x |', []).aligns).toEqual(['left', 'right', 'center'])
  // A header with nothing in it is left out, as the app leaves it out.
  expect(gridTable('| | |\n|---|---|\n| a | b |', []).header).toBeNull()
})

test('a table’s columns are as wide as the app makes them, whatever is marked', () => {
  const grid = gridTable(TABLE, [])
  // Shares of the width that add up to all of it, the same however the cells are marked
  expect(Math.round(shares(grid).reduce((a, b) => a + b, 0))).toBe(100)
  expect(gridTable(TABLE, [{ col: 1 }]).widths).toEqual(grid.widths)
  // With room for every cell on one line: in proportion to each column's widest cell.
  const notes = '| Name | Notes |\n|---|---|\n| A | a long note that goes on and on for many words here |'
  const [name, note] = shares(gridTable(notes, []))
  expect(note! / name!).toBeGreaterThan(5)
  // With less room the note wraps, and the short column keeps the room its text needs.
  const [narrowName] = shares(gridTable(notes, [], 300))
  expect(narrowName!).toBeGreaterThan(name!)
})

test('a cell shows its text without its markdown', () => {
  expect(['**Pro**', '`fast`', '[docs](https://x.y)', '*it*', 'snake_case', 'a \\| b', '__b__ and ~~gone~~'].map(plainCell)).toEqual([
    'Pro',
    'fast',
    'docs',
    'it',
    'snake_case',
    'a | b',
    'b and gone',
  ])
})

test('the row-by-row reading marks each row as it is read', () => {
  expect(readTableParts(TABLE, toSpeech).map(p => p.refs)).toEqual([[{ row: 0 }], [{ row: 1 }], [{ row: 2 }]])
})

test('after a table read as an explanation, the words are found again in the text after it', () => {
  const explanation = 'It compares two plans and the speed they give you.'.split(' ')
  const before = toSpeech('Before the table.').split(' ')
  const after = toSpeech('After the table comes more text here.').split(' ')
  const words = [...before, ...explanation, ...after]
  const skip = new Set(explanation.map((_, i) => before.length + i))
  const spans = align(TABLE_REPLY, words, skip)!
  const at = (i: number) => (spans[i] ? TABLE_REPLY.slice(spans[i]!.start, spans[i]!.end) : undefined)
  expect(at(0)).toBe('Before')
  expect(explanation.map((_, i) => at(before.length + i))).toEqual(explanation.map(() => undefined)) // never marked
  const firstAfter = before.length + explanation.length
  expect(at(firstAfter)).toBe('After')
  expect(spans[firstAfter]!.start).toBe(TABLE_REPLY.indexOf('After'))
  expect(at(words.length - 1)).toBe('here')
})

test('plain text (a person’s message) splits only at the spoken word', () => {
  const text = 'first line\nsecond `not code` line'
  expect(plainLines(text, spanOf(text, 'not')).map(readable)).toEqual(['first line', 'second `[not] code` line'])
  expect(plainLines(text, NO_SPAN).map(readable)).toEqual(['first line', 'second `not code` line'])
})

test('blocks: paragraphs apart at blank lines, a code block whole', () => {
  const md = 'One.\nStill one.\n\n```\na\n\nb\n```\n\nThree.'
  expect(blocksOf(md).map(b => md.slice(b.start, b.end))).toEqual(['One.\nStill one.', '```\na\n\nb\n```', 'Three.'])
})

test('a block drawn by hand keeps its looks, the spoken word split out', () => {
  const md = 'Say **bold *and* more**, `code`, a [link](https://x.y) and\nmore here.'
  const block = blocksOf(md)[0]!
  const lines = blockLines(md, block, spanOf(md, 'more here'.slice(0, 4)))!
  expect(lines.length).toBe(1) // the soft break joins the two lines
  expect(readable(lines[0]!)).toBe('Say bold and [more], code, a link and more here.')
  const pieces = lines[0]!.pieces
  expect(pieces.find(p => p.text === 'and' && p.isItalic)?.isBold).toBe(true)
  expect(pieces.find(p => p.isSpoken)?.isBold).toBe(true)
  expect(pieces.find(p => p.text === 'code')?.isCode).toBe(true)
  expect(pieces.find(p => p.text === 'link')?.isLink).toBe(true)
})

test('lists and headings keep their bullets, numbers and size; code and tables are left to markdown', () => {
  const list = '- first item\n- second word\n  1. inner'
  const lines = blockLines(list, blocksOf(list)[0]!, spanOf(list, 'word'))!
  expect(lines.map(readable)).toEqual(['• first item', '• second [word]', '  1. inner'])
  // How deep each item sits and what opens it, to lay the list out as the app does
  expect(lines.map(l => l.item)).toEqual([
    { depth: 0, marker: '•' },
    { depth: 0, marker: '•' },
    { depth: 1, marker: '1.' },
  ])
  const heading = '## A heading'
  const [headingLine] = blockLines(heading, blocksOf(heading)[0]!, spanOf(heading, 'heading'))!
  expect([headingLine!.isHeading, headingLine!.level]).toEqual([true, 2])
  const table = '| a | b |\n|---|---|'
  expect(blockLines(table, blocksOf(table)[0]!, spanOf(table, 'a'))).toBeNull()
  const snake = 'call snake_case_name now'
  expect(readable(blockLines(snake, blocksOf(snake)[0]!, spanOf(snake, 'now'))![0]!)).toBe('call snake_case_name [now]')
})
import { toSpeech } from './register'

const REPLY = [
  'Intro line that is not selected.',
  '',
  'Hello **there**, this is a [link](https://example.com) and `code` here, e.g. now.',
  '',
  'Last part of the reply.',
].join('\n')

/** What the voice reads for a selection the person made in the rendered reply. */
const spokenWords = (rendered: string) => toSpeech(rendered).split(' ')

test('each spoken word maps to its place in the markdown, from mid-reply', () => {
  const words = spokenWords('Hello there, this is a link and code here, e.g. now.')
  const spans = align(REPLY, words)!
  const at = (i: number) => REPLY.slice(spans[i]!.start, spans[i]!.end)

  expect(words[1]).toBe('there,')
  expect(at(0)).toBe('Hello')
  expect(at(1)).toBe('there')
  expect(spans[1]!.isInBold).toBe(true)
  expect(at(5)).toBe('link')
  expect(spans[5]!.start).toBe(REPLY.indexOf('link')) // the link text, not its address
  expect(at(7)).toBe('code')
  expect(spans[7]!.isUnmarkable).toBe(true)
  expect(at(9)).toBe('e.g') // a word of several parts is marked whole
  expect(at(10)).toBe('now')
})

test('words that are not in a row give null: they belong to another row', () => {
  expect(align(REPLY, spokenWords('Something else entirely is being read here.'))).toBeNull()
})

test('a selection that runs on into later paragraphs keeps lining up', () => {
  const spans = align(REPLY, spokenWords('here, e.g. now. Last part of the reply.'))!
  expect(REPLY.slice(spans[3]!.start, spans[3]!.end)).toBe('Last')
  expect(REPLY.slice(spans[7]!.start, spans[7]!.end)).toBe('reply')
})

test('marks: a shaded code box, or bold; code inside bold; nothing inside code', () => {
  const words = spokenWords('Hello there, this is a link and code here')
  const spans = align(REPLY, words)!

  expect(markWord(REPLY, spans[0]!, 'code')).toContain('`Hello` **there**')
  expect(markWord(REPLY, spans[0]!, 'bold')).toContain('**Hello** **there**')
  // "there" is already bold: another ** would end that bold, so it gets a code box
  expect(markWord(REPLY, spans[1]!, 'bold')).toContain('**`there`**')
  expect(markWord(REPLY, spans[5]!, 'code')).toContain('[`link`](https://example.com)')
  expect(markWord(REPLY, spans[7]!, 'code')).toBe(REPLY)
})

test('code blocks and web addresses are never marked', () => {
  const md = 'Run this:\n\n```\nnpm install thing\n```\n\nSee https://example.com/install for more.'
  const spans = align(md, spokenWords('Run this: npm install thing See https://example.com/install for more.'))!
  const install = spans[3]!
  expect(md.slice(install.start, install.end)).toBe('install')
  expect(install.isUnmarkable).toBe(true)
  const more = spans[spans.length - 1]!
  expect(md.slice(more.start, more.end)).toBe('more')
  expect(more.isUnmarkable).toBe(false)
})
