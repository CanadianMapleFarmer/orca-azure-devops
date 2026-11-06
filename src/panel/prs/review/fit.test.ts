import { assert, test } from 'orca/testing'
import type { ChangedFile, ReviewThread } from '../../../shared/reviews'
import { NOW } from '../fixtures'
import { utf8Length } from '../../label'
import {
  anchorTitle,
  FILE_ROWS_BYTES,
  FILE_THREADS_BYTES,
  fileRows,
  fitThreads,
  matchingFiles,
  MAX_COMMENTS_SHOWN,
  MAX_FILE_ROWS,
  MAX_THREAD_CARDS,
  parseLine,
  THREADS_BYTES
} from './fit'
import { threadOf } from './fixtures'

const commentsOf = (count: number, bytes: number) =>
  Array.from({ length: count }, (_, index) => ({ id: index + 1, author: 'Grace Hopper', at: NOW + index, content: 'x'.repeat(bytes) }))

test('the review limits are the ones the plan names', () => {
  assert.deepEqual(
    [MAX_THREAD_CARDS, MAX_COMMENTS_SHOWN, THREADS_BYTES, FILE_THREADS_BYTES, MAX_FILE_ROWS],
    [30, 10, 300 * 1024, 100 * 1024, 1000]
  )
})

test('fitThreads keeps whole threads within the byte budget and counts the rest', () => {
  const long = threadOf(7, { comments: commentsOf(20, 10), hidden: 0 })
  const { shown: [trimmed], hidden: none } = fitThreads([long])
  assert.equal(none, 0)
  assert.equal(trimmed.hidden, 10)
  assert.deepEqual(
    trimmed.comments.map(comment => comment.id),
    [1, 12, 13, 14, 15, 16, 17, 18, 19, 20]
  )
  assert.equal(long.comments.length, 20, 'the input is left alone')
  assert.equal(long.hidden, 0)

  const already = fitThreads([threadOf(8, { comments: commentsOf(12, 10), hidden: 5 })]).shown[0]
  assert.equal(already.hidden, 7)

  const small = threadOf(9, { comments: commentsOf(3, 10), hidden: 2 })
  assert.deepEqual(fitThreads([small]).shown, [small])

  const big = (id: number) => threadOf(id, { comments: commentsOf(10, 8_000) })
  const threads = [1, 2, 3, 4, 5].map(big)
  const fitted = fitThreads(threads)
  assert.deepEqual(
    fitted.shown.map(thread => thread.id),
    [1, 2, 3]
  )
  assert.equal(fitted.hidden, 2)
  const onFile = fitThreads(threads, FILE_THREADS_BYTES)
  assert.deepEqual(
    [onFile.shown.map(thread => thread.id), onFile.hidden],
    [[1], 4]
  )
  const tight = fitThreads([threadOf(1, { comments: commentsOf(1, 50) }), threadOf(2, { comments: commentsOf(1, 50) })], 120)
  assert.deepEqual([tight.shown.map(thread => thread.id), tight.hidden], [[1], 1])
  assert.deepEqual(fitThreads([threadOf(1, { comments: commentsOf(1, 500) })], 100), { shown: [], hidden: 1 })
})

test('fitThreads counts the bytes of wide characters, not their length', () => {
  const wide = (id: number) => threadOf(id, { anchor: null, comments: [{ id: 1, author: 'A', at: NOW, content: '界'.repeat(30) }] })
  assert.equal(fitThreads([wide(1), wide(2)], 190).shown.length, 2)
  assert.equal(fitThreads([wide(1), wide(2)], 150).shown.length, 1)
})

test('fitThreads stops at the card limit', () => {
  const threads = Array.from({ length: 150 }, (_, index) => threadOf(index + 1, { comments: commentsOf(1, 20) }))
  const { shown, hidden } = fitThreads(threads)
  assert.equal(shown.length, MAX_THREAD_CARDS)
  assert.deepEqual(shown, threads.slice(0, MAX_THREAD_CARDS))
  assert.equal(hidden, 120)
  assert.deepEqual(fitThreads([]), { shown: [], hidden: 0 })
})

test('fileRows filters by path text, case-insensitively, and caps the rows', () => {
  const files: ChangedFile[] = [
    { path: '/src/Auth/Redirect.ts', originalPath: null, kind: 'edited' },
    { path: '/src/auth/redirect.test.ts', originalPath: null, kind: 'added' },
    { path: '/docs/auth.md', originalPath: '/docs/login.md', kind: 'renamed' }
  ]
  assert.deepEqual(fileRows(files, ''), files)
  assert.deepEqual(fileRows(files, '   '), files)
  assert.deepEqual(
    fileRows(files, 'REDIRECT').map(file => file.path),
    ['/src/Auth/Redirect.ts', '/src/auth/redirect.test.ts']
  )
  assert.deepEqual(
    fileRows(files, ' auth/ ').map(file => file.path),
    ['/src/Auth/Redirect.ts', '/src/auth/redirect.test.ts']
  )
  assert.deepEqual(fileRows(files, 'login'), [], 'only the path is searched')
  assert.deepEqual(fileRows(files, 'nothing'), [])

  const many: ChangedFile[] = Array.from({ length: 1_500 }, (_, index) => ({ path: `/gen/file-${index}.ts`, originalPath: null, kind: 'added' }))
  assert.equal(fileRows(many, '').length, MAX_FILE_ROWS)
  assert.deepEqual(fileRows(many, '').at(-1), many[MAX_FILE_ROWS - 1])
  assert.deepEqual(
    fileRows(many, 'file-149').map(file => file.path),
    ['/gen/file-149.ts', ...Array.from({ length: 10 }, (_, index) => `/gen/file-149${index}.ts`)]
  )
})

const pathsOf = (count: number, size: number): ChangedFile[] =>
  Array.from({ length: count }, (_, index) => ({ path: `/${'d'.repeat(size)}/${String(index).padStart(4, '0')}.ts`, originalPath: null, kind: 'edited' }))

const rowBytes = (files: readonly ChangedFile[]) => files.reduce((total, file) => total + 2 * utf8Length(file.path), 0)

test('fileRows stops before the rows pass the byte budget and keeps the order', () => {
  const files = pathsOf(1_000, 250)
  const rows = fileRows(files, '')
  assert.ok(rows.length > 100 && rows.length < MAX_FILE_ROWS, `${rows.length} rows`)
  assert.deepEqual(rows, files.slice(0, rows.length))
  assert.ok(rowBytes(rows) < FILE_ROWS_BYTES)
  assert.ok(rowBytes(files.slice(0, rows.length + 1)) > FILE_ROWS_BYTES - 64 * (rows.length + 1), 'it stops only when the next row no longer fits')
  assert.deepEqual(
    fileRows(files, '0999').map(file => file.path),
    [files[999].path],
    'the filter reaches the rows the budget left out'
  )
  assert.equal(fileRows(pathsOf(1_000, 40), '').length, MAX_FILE_ROWS, 'ordinary paths are only capped by count')
})

test('fileRows counts the bytes of wide characters and cuts a path past the label limit', () => {
  const wide: ChangedFile[] = Array.from({ length: 1_000 }, (_, index) => ({ path: `/${'界'.repeat(60)}/${index}.ts`, originalPath: null, kind: 'edited' }))
  assert.ok(fileRows(wide, '').length < 600, 'a character is up to four bytes, not one')
  const huge = pathsOf(400, 5_000)
  const rows = fileRows(huge, '')
  assert.ok(rows.length > 50 && rows.length < 400, `${rows.length} rows`)
})

test('matchingFiles returns every match, uncapped', () => {
  const many = pathsOf(1_500, 250)
  assert.equal(matchingFiles(many, '').length, 1_500)
  assert.deepEqual(
    matchingFiles(many, ' 0149 ').map(file => file.path),
    [many[149].path]
  )
  assert.deepEqual(matchingFiles(many, 'nothing'), [])
})

test('anchorTitle names general, file, line and old-line threads', () => {
  assert.equal(anchorTitle(null), 'General')
  assert.equal(anchorTitle({ path: '/src/auth/legacy-return.ts', line: null, side: 'new' }), '/src/auth/legacy-return.ts')
  assert.equal(anchorTitle({ path: '/src/auth/redirect.ts', line: 12, side: 'new' }), '/src/auth/redirect.ts, line 12')
  assert.equal(anchorTitle({ path: '/src/auth/legacy-return.ts', line: 7, side: 'old' }), '/src/auth/legacy-return.ts, old line 7')
})

test('parseLine accepts whole numbers only', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('   '), null)
  assert.equal(parseLine('42'), 42)
  assert.equal(parseLine(' 7 '), 7)
  assert.equal(parseLine('007'), 7)
  assert.equal(parseLine('1'), 1)
  assert.equal(parseLine('9999999'), 9_999_999)
  for (const bad of ['0', '-3', '+3', '4.2', '1e3', '0x10', 'twelve', '12a', '1 2', '١٢', '１２', 'Infinity', 'NaN', '99999999999999999999'])
    assert.equal(parseLine(bad), 'bad', bad)
})

test('fitThreads leaves a thread on its first comment when that is all it has', () => {
  const thread: ReviewThread = threadOf(3, { comments: commentsOf(1, 5) })
  assert.deepEqual(fitThreads([thread]).shown, [thread])
})
