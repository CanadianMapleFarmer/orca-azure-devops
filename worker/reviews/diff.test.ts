import { assert, test } from 'orca/testing'
import { MAX_DIFF_BYTES } from '../../src/shared/diff'
import { byteLength } from '../budget'
import { DIFF_NO_TEXT_CHANGES, DIFF_TOO_LARGE, DIFF_TOO_MANY, diffCut } from '../messages'
import { CONTEXT_LINES, MAX_DIFF_LINE_CHARS, MAX_SIDE_LINES, diffLines, diffText, formatHunks, splitLines, type Hunk } from './diff'

function numbered(count: number, name = 'line'): string[] {
  return Array.from({ length: count }, (_, i) => `${name} ${i + 1}`)
}

function fileOf(lines: readonly string[]): string {
  return lines.map(line => `${line}\n`).join('')
}

function hunksOf(result: Hunk[] | 'tooMany'): Hunk[] {
  assert.notEqual(result, 'tooMany')
  return result as Hunk[]
}

function edits(hunks: readonly Hunk[]): number {
  return hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== ' ').length
}

function sides(hunk: Hunk): { old: string[]; new: string[] } {
  return {
    old: hunk.lines.filter(line => line.kind !== '+').map(line => line.text),
    new: hunk.lines.filter(line => line.kind !== '-').map(line => line.text)
  }
}

function rangeOf({ oldStart, oldLines, newStart, newLines }: Hunk) {
  return { oldStart, oldLines, newStart, newLines }
}

test('splitLines handles LF, CRLF and a missing final newline', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('\n'), [''])
  assert.deepEqual(splitLines('a\n\nb\n\n'), ['a', '', 'b', ''])
  assert.deepEqual(splitLines('a\rb\n'), ['a\rb'])
})

test('diffLines finds the smallest edit with three lines of context and merges close hunks', () => {
  const before = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
  const after = ['c', 'b', 'a', 'b', 'a', 'c']
  const whole = hunksOf(diffLines(before, after))
  assert.equal(whole.length, 1)
  assert.equal(edits(whole), 5)
  assert.deepEqual(sides(whole[0]), { old: before, new: after })

  assert.equal(CONTEXT_LINES, 3)
  const old = numbered(30)
  const changed = old.map((line, i) => ([4, 11, 19].includes(i) ? `${line} changed` : line))
  const hunks = hunksOf(diffLines(old, changed))
  assert.deepEqual(hunks.map(rangeOf), [
    { oldStart: 2, oldLines: 14, newStart: 2, newLines: 14 },
    { oldStart: 17, oldLines: 7, newStart: 17, newLines: 7 }
  ])
  assert.equal(edits(hunks), 6)
  assert.deepEqual(hunks[0].lines.slice(2, 6), [
    { kind: ' ', old: 4, new: 4, text: 'line 4' },
    { kind: '-', old: 5, new: null, text: 'line 5' },
    { kind: '+', old: null, new: 5, text: 'line 5 changed' },
    { kind: ' ', old: 6, new: 6, text: 'line 6' }
  ])
  assert.deepEqual(sides(hunks[0]), { old: old.slice(1, 15), new: changed.slice(1, 15) })
  assert.deepEqual(sides(hunks[1]), { old: old.slice(16, 23), new: changed.slice(16, 23) })
  assert.deepEqual(diffLines(old, [...old]), [])
})

test('an added or deleted file is one hunk with no edit limit', () => {
  const lines = numbered(30_000)
  const added = hunksOf(diffLines([], lines, { edits: 1 }))
  assert.deepEqual(added.map(rangeOf), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 30_000 }])
  assert.equal(added[0].lines.length, 30_000)
  assert(added[0].lines.every((line, i) => line.kind === '+' && line.old === null && line.new === i + 1 && line.text === lines[i]))

  const deleted = hunksOf(diffLines(lines, [], { edits: 1 }))
  assert.deepEqual(deleted.map(rangeOf), [{ oldStart: 1, oldLines: 30_000, newStart: 0, newLines: 0 }])
  assert(deleted[0].lines.every((line, i) => line.kind === '-' && line.old === i + 1 && line.new === null))

  const inserted = hunksOf(diffLines(['top', 'bottom'], ['top', ...lines, 'bottom'], { edits: 1 }))
  assert.deepEqual(inserted.map(rangeOf), [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 30_002 }])

  assert.deepEqual(diffText(null, 'a\nb\n'), { text: '@@ -0,0 +1,2 @@\n+  1 │ a\n+  2 │ b', lines: { old: null, new: 2 } })
  assert.deepEqual(diffText('a\n', null), { text: '@@ -1,1 +0,0 @@\n-1   │ a', lines: { old: 1, new: null } })
})

test('diffLines gives up past the edit limit or the work limit', () => {
  assert.equal(diffLines(numbered(3_000, 'old'), numbered(3_000, 'new')), 'tooMany')

  const before = numbered(100_000)
  const after = before.map((line, i) => (i % 111 === 50 && i < 900 * 111 ? `${line} replaced` : line))
  const hunks = hunksOf(diffLines(before, after))
  assert.equal(hunks.length, 900)
  assert.equal(edits(hunks), 1_800)
  assert.equal(diffLines(before, after, { work: 100_000 }), 'tooMany')

  const ends = before.map((line, i) => (i === 0 || i === 99_999 ? `${line} replaced` : line))
  assert.equal(edits(hunksOf(diffLines(before, ends, { work: 200_000 }))), 4)
  assert.equal(diffLines(before, ends, { work: 50_000 }), 'tooMany')

  assert.equal(edits(hunksOf(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'], { edits: 2 }))), 2)
  assert.equal(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'], { edits: 1 }), 'tooMany')
})

test('formatHunks numbers old and new lines and keeps the marker first', () => {
  const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`)
  const after = [...before.slice(0, 8), 'nine', 'ten', 'ten and a half', 'l11', 'l12']
  const hunks = hunksOf(diffLines(before, after))
  const expected = [
    '@@ -6,7 +6,8 @@',
    '  6  6 │ l6',
    '  7  7 │ l7',
    '  8  8 │ l8',
    '- 9    │ l9',
    '-10    │ l10',
    '+    9 │ nine',
    '+   10 │ ten',
    '+   11 │ ten and a half',
    ' 11 12 │ l11',
    ' 12 13 │ l12'
  ]
  assert.deepEqual(formatHunks(hunks), { text: expected.join('\n'), shownLines: 10, cut: false })

  const firstFive = expected.slice(0, 5).join('\n')
  assert.deepEqual(formatHunks(hunks, byteLength(firstFive)), { text: firstFive, shownLines: 4, cut: true })
  assert.deepEqual(formatHunks(hunks, byteLength(firstFive) - 1), { text: expected.slice(0, 4).join('\n'), shownLines: 3, cut: true })

  const old = numbered(30)
  const two = hunksOf(diffLines(old, old.map((line, i) => (i === 4 || i === 19 ? `${line} changed` : line))))
  const rows = formatHunks(two).text.split('\n')
  const second = rows.findIndex((row, i) => i > 0 && row.startsWith('@@'))
  const first = rows.slice(0, second).join('\n')
  assert.deepEqual(formatHunks(two, byteLength(`${first}\n${rows[second]}`)), { text: first, shownLines: second - 1, cut: true })
})

test('diffText degrades for oversized, too-many-change and long-line files and caps the bytes', () => {
  assert.equal(MAX_SIDE_LINES, 50_000)
  const huge = fileOf(numbered(MAX_SIDE_LINES + 1))
  assert.deepEqual(diffText(null, huge), { text: null, message: DIFF_TOO_LARGE, lines: { old: null, new: 50_001 } })
  assert.deepEqual(diffText(huge, 'x\n'), { text: null, message: DIFF_TOO_LARGE, lines: { old: 50_001, new: 1 } })
  const largest = diffText(null, fileOf(numbered(MAX_SIDE_LINES)))
  assert.equal(typeof largest.text, 'string')
  assert.deepEqual(largest.lines, { old: null, new: 50_000 })

  const long = diffText('head\n', `head\n${'x'.repeat(300 * 1024)}\n`)
  const row = (long.text ?? '').split('\n')[2]
  assert(row.startsWith('+  2 │ x'), row.slice(0, 20))
  assert.equal(row.slice('+  2 │ '.length).length, MAX_DIFF_LINE_CHARS)
  assert(row.endsWith('x…'))
  assert.deepEqual({ message: long.message, lines: long.lines }, { message: undefined, lines: { old: 1, new: 2 } })

  const base = numbered(100)
  const appended = diffText(fileOf(base), fileOf([...base, ...numbered(5_000, 'appended line with enough text to pass the byte cap')]))
  const text = appended.text ?? ''
  assert(byteLength(text) <= MAX_DIFF_BYTES, `${byteLength(text)}`)
  assert(byteLength(text) > MAX_DIFF_BYTES - 200, `${byteLength(text)}`)
  const shown = text.split('\n').filter(line => !line.startsWith('@@'))
  assert(shown.length > 3 && shown.length < 5_003, `${shown.length}`)
  assert.equal(appended.message, diffCut(shown.length))
  assert.match(shown[shown.length - 1], /^\+ {5}[ \d]{3}\d │ appended line with enough text to pass the byte cap \d+$/)
  assert.deepEqual(appended.lines, { old: 100, new: 5_100 })
  assert.equal(diffCut(1234), 'Showing the first 1,234 lines of this diff. Check out the branch in Orca for the rest.')

  const changed = diffText(fileOf(numbered(10_000, 'before')), fileOf(numbered(10_000, 'after')))
  assert.deepEqual(changed, { text: null, message: DIFF_TOO_MANY, lines: { old: 10_000, new: 10_000 } })
})

test('identical texts say there are no text changes', () => {
  const none = { text: null, message: DIFF_NO_TEXT_CHANGES, lines: { old: 2, new: 2 } }
  assert.deepEqual(diffText('a\nb\n', 'a\nb\n'), none)
  assert.deepEqual(diffText('a\r\nb', 'a\nb\n'), none)
  assert.deepEqual(diffText(null, ''), { text: null, message: DIFF_NO_TEXT_CHANGES, lines: { old: null, new: 0 } })
  assert.deepEqual(diffText('a\n', 'b\n'), { text: '@@ -1,1 +1,1 @@\n-1   │ a\n+  1 │ b', lines: { old: 1, new: 1 } })
})
