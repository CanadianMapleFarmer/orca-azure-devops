import { assert, test } from 'orca/testing'
import { MAX_BUFFER_LINES, MAX_LOG_LINES, type LogChunk } from '../shared/pipelines'
import {
  appendChunk,
  earlierStart,
  errorLines,
  isErrorText,
  lastLine,
  nextHit,
  nextRead,
  parseLine,
  searchHits,
  visibleIndexes,
  type LogBuffer
} from './log-model'

function chunk(logId: number, first: number, count: number, total: number, text = (n: number) => `line ${n}`): LogChunk {
  return { logId, first, lines: Array.from({ length: count }, (_, index) => text(first + index)), total }
}

function numbers(buffer: LogBuffer): number[] {
  return buffer.lines.map(line => line.n)
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

function bufferOf(lines: string[], first = 1): LogBuffer {
  return appendChunk(null, { logId: 9, first, lines, total: first + lines.length - 1 })
}

test('parseLine reads timestamps and ADO markers', () => {
  assert.deepEqual(parseLine(1, '2026-11-05T08:06:30.1010000Z ##[section]Starting: Build and push image'), {
    n: 1,
    text: 'Starting: Build and push image',
    kind: 'section',
    time: '2026-11-05T08:06:30.1010000Z'
  })
  assert.deepEqual(parseLine(12, "##[error]Bash exited with code '1'."), { n: 12, text: "Bash exited with code '1'.", kind: 'error', time: null })
  const markers = ['error', 'warning', 'section', 'command', 'group', 'endgroup', 'debug'] as const
  for (const kind of markers) {
    assert.deepEqual(parseLine(3, `2026-11-05T08:06:30Z ##[${kind}]text`), { n: 3, text: 'text', kind, time: '2026-11-05T08:06:30Z' })
  }
  assert.deepEqual(parseLine(5, '2026-11-05T08:06:30.2150000Z Generating script.'), {
    n: 5,
    text: 'Generating script.',
    kind: 'plain',
    time: '2026-11-05T08:06:30.2150000Z'
  })
  assert.deepEqual(parseLine(6, '2026-11-05T08:06:30+02:00    at Api.Program.Main()'), {
    n: 6,
    text: '   at Api.Program.Main()',
    kind: 'plain',
    time: '2026-11-05T08:06:30+02:00'
  })
  assert.equal(parseLine(10, '2026-11-05T08:09:38.8120000Z ERROR: failed to solve: process').kind, 'error')
  assert.equal(parseLine(11, '2026-11-05T08:09:39Z fatal: repository not found').kind, 'error')
  assert.equal(parseLine(11, '2026-11-05T08:09:39Z ##[warning]error: kept as a warning').kind, 'warning')
  assert.deepEqual(parseLine(2, '2026-11-05 not a timestamp'), { n: 2, text: '2026-11-05 not a timestamp', kind: 'plain', time: null })
  assert.deepEqual(parseLine(4, '##[info]unknown marker'), { n: 4, text: '##[info]unknown marker', kind: 'plain', time: null })
  assert.deepEqual(parseLine(7, '\x1b[31mERROR:\x1b[0m failed'), { n: 7, text: '\x1b[31mERROR:\x1b[0m failed', kind: 'error', time: null })
  assert.deepEqual(parseLine(8, ''), { n: 8, text: '', kind: 'plain', time: null })
})

test('isErrorText finds Docker, Helm, MSBuild and generic errors but not error counts or file names', () => {
  const errors = [
    'ERROR: failed to solve: process "/bin/sh -c dotnet publish -c Release -o /app" did not complete successfully: exit code: 1',
    '#9 ERROR: process "/bin/sh -c dotnet publish" did not complete successfully: exit code: 1',
    'Error: UPGRADE FAILED: release web-app failed, and has been rolled back due to atomic being set',
    'Error: template: chart/templates/deployment.yaml:23:20: executing "chart/templates/deployment.yaml" at <.Values.image.tag>: nil pointer',
    '/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002: ; expected [/home/vsts/work/1/s/src/Api/Api.csproj]',
    "src/app.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "##[error]Bash exited with code '1'.",
    'error: failed to push some refs to the remote',
    'Tests FAILED',
    'fatal: repository not found'
  ]
  for (const text of errors) assert.ok(isErrorText(text), text)
  const quiet = [
    '    0 Error(s)',
    '    0 Warning(s)',
    'compiling errors.go',
    'errors.go:12: undefined: x',
    'Build succeeded.',
    'no-error: true',
    'terror: the movie',
    'FAILEDX',
    'Failed: 0, Passed: 12',
    "warning CS8618: Non-nullable property 'Name' must contain a non-null value",
    'the fatal: flag is set'
  ]
  for (const text of quiet) assert.ok(!isErrorText(text), text)
})

test('appendChunk tails, prepends, resets on a gap and caps the buffer', () => {
  const first = appendChunk(null, chunk(9, 1, 3, 3))
  assert.deepEqual({ logId: first.logId, first: first.first, total: first.total }, { logId: 9, first: 1, total: 3 })
  assert.deepEqual(numbers(first), [1, 2, 3])
  assert.equal(first.lines[0].text, 'line 1')

  const tailed = appendChunk(first, chunk(9, 4, 2, 5))
  assert.deepEqual(numbers(tailed), [1, 2, 3, 4, 5])
  assert.equal(tailed.total, 5)
  assert.deepEqual(numbers(first), [1, 2, 3])

  const overlapped = appendChunk(tailed, chunk(9, 4, 4, 7, n => `fresh ${n}`))
  assert.deepEqual(numbers(overlapped), range(1, 7))
  assert.deepEqual(overlapped.lines.slice(2).map(line => line.text), ['line 3', 'fresh 4', 'fresh 5', 'fresh 6', 'fresh 7'])

  const unchanged = appendChunk(tailed, chunk(9, 6, 0, 5))
  assert.deepEqual(numbers(unchanged), [1, 2, 3, 4, 5])

  const tail = appendChunk(null, chunk(9, 1001, 1000, 2000))
  const prepended = appendChunk(tail, chunk(9, 1, 1000, 2000))
  assert.equal(prepended.first, 1)
  assert.deepEqual(numbers(prepended), range(1, 2000))

  const gap = appendChunk(tailed, chunk(9, 10, 3, 12))
  assert.equal(gap.first, 10)
  assert.deepEqual(numbers(gap), [10, 11, 12])
  assert.deepEqual(numbers(appendChunk(tail, chunk(9, 1, 10, 2000))), range(1, 10))

  const otherLog = appendChunk(tailed, chunk(10, 4, 2, 5))
  assert.equal(otherLog.logId, 10)
  assert.deepEqual(numbers(otherLog), [4, 5])

  const capped = appendChunk(null, chunk(9, 1, 10, 10), 4)
  assert.deepEqual(numbers(capped), [7, 8, 9, 10])
  assert.equal(capped.first, 7)
  const cappedTail = appendChunk(capped, chunk(9, 11, 3, 13), 4)
  assert.deepEqual(numbers(cappedTail), [10, 11, 12, 13])
  assert.equal(cappedTail.total, 13)
  assert.deepEqual(numbers(appendChunk(capped, chunk(9, 3, 4, 10), 4)), [7, 8, 9, 10])

  const empty = appendChunk(null, { logId: 9, first: 1, lines: [], total: 0 })
  assert.deepEqual({ first: empty.first, lines: empty.lines, total: empty.total }, { first: 1, lines: [], total: 0 })
  assert.deepEqual(numbers(appendChunk(empty, chunk(9, 1, 2, 2))), [1, 2])

  const full = appendChunk(null, chunk(9, 1, MAX_BUFFER_LINES, MAX_BUFFER_LINES))
  const beyond = appendChunk(full, chunk(9, MAX_BUFFER_LINES + 1, MAX_LOG_LINES, MAX_BUFFER_LINES + MAX_LOG_LINES))
  assert.equal(beyond.lines.length, MAX_BUFFER_LINES)
  assert.equal(beyond.first, MAX_LOG_LINES + 1)
  assert.equal(lastLine(beyond), MAX_BUFFER_LINES + MAX_LOG_LINES)
})

test('appendChunk parses each line it keeps', () => {
  const buffer = appendChunk(null, {
    logId: 9,
    first: 41,
    lines: ['2026-11-05T08:09:39.9000000Z src/Api/Program.cs(42,17): error CS1002: ; expected', '2026-11-05T08:09:40Z ##[endgroup]'],
    total: 42
  })
  assert.deepEqual(buffer.lines, [
    { n: 41, text: 'src/Api/Program.cs(42,17): error CS1002: ; expected', kind: 'error', time: '2026-11-05T08:09:39.9000000Z' },
    { n: 42, text: '', kind: 'endgroup', time: '2026-11-05T08:09:40Z' }
  ])
})

test('visibleIndexes keeps only error lines when asked', () => {
  const buffer = bufferOf(['Starting', 'ERROR: failed to solve', '##[warning]careful', '##[error]Bash exited', 'done'])
  assert.deepEqual(visibleIndexes(buffer, false), [0, 1, 2, 3, 4])
  assert.deepEqual(visibleIndexes(buffer, true), [1, 3])
  assert.deepEqual(visibleIndexes(bufferOf([]), true), [])
})

test('searchHits is smart-case and literal', () => {
  const buffer = bufferOf([
    'Error: first',
    'error: second',
    'a.b+c',
    'abc',
    '\x1b[31mRED\x1b[0m alert',
    '2026-11-05T08:06:30.1010000Z hello'
  ])
  assert.deepEqual(searchHits(buffer, 'error'), [0, 1])
  assert.deepEqual(searchHits(buffer, 'Error'), [0])
  assert.deepEqual(searchHits(buffer, 'a.b+c'), [2])
  assert.deepEqual(searchHits(buffer, '(['), [])
  assert.deepEqual(searchHits(buffer, 'red alert'), [4])
  assert.deepEqual(searchHits(buffer, 'RED alert'), [4])
  assert.deepEqual(searchHits(buffer, 'Red alert'), [])
  assert.deepEqual(searchHits(buffer, '[31m'), [])
  assert.deepEqual(searchHits(buffer, '08:06'), [])
  assert.deepEqual(searchHits(buffer, ''), [])
})

test('errorLines returns the first error lines', () => {
  const lines = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? `ERROR: failure ${index + 1}` : `fine ${index + 1}`))
  const buffer = bufferOf(lines, 101)
  const found = errorLines(buffer)
  assert.equal(found.length, 15)
  assert.deepEqual(found.slice(0, 2), [
    { n: 101, text: 'ERROR: failure 1', kind: 'error', time: null },
    { n: 103, text: 'ERROR: failure 3', kind: 'error', time: null }
  ])
  assert.deepEqual(errorLines(buffer, 2).map(line => line.n), [101, 103])
  const many = bufferOf(Array.from({ length: 25 }, (_, index) => `##[error]step ${index}`))
  assert.equal(errorLines(many).length, 20)
  assert.deepEqual(errorLines(bufferOf(['fine'])), [])
})

test('nextRead asks for the lines after the buffer, or the tail when far behind', () => {
  const buffer = appendChunk(null, chunk(9, 1, 100, 100))
  assert.equal(lastLine(buffer), 100)
  assert.equal(nextRead(buffer, 100, true), null)
  assert.equal(nextRead(buffer, null, true), null)
  assert.equal(nextRead(buffer, 90, true), null)
  assert.deepEqual(nextRead(buffer, 150, true), { first: 101 })
  assert.deepEqual(nextRead(buffer, 100 + MAX_LOG_LINES, true), { first: 101 })
  assert.deepEqual(nextRead(buffer, 101 + MAX_LOG_LINES, true), {})
  assert.deepEqual(nextRead(buffer, 101 + MAX_LOG_LINES, false), { first: 101 })
  assert.deepEqual(nextRead(buffer, 101 + MAX_BUFFER_LINES, false), {})
  assert.equal(lastLine(appendChunk(null, { logId: 9, first: 1, lines: [], total: 0 })), 0)
  assert.deepEqual(nextRead(appendChunk(null, { logId: 9, first: 1, lines: [], total: 0 }), 3, true), { first: 1 })
})

test('earlierStart pages back until the first line or a full buffer', () => {
  assert.equal(earlierStart(appendChunk(null, chunk(9, 1, 10, 10))), null)
  assert.equal(earlierStart(appendChunk(null, chunk(9, 2001, 1000, 3000))), 1001)
  assert.equal(earlierStart(appendChunk(null, chunk(9, 401, 1000, 1400))), 1)
  assert.equal(earlierStart(appendChunk(null, chunk(9, 11, 5, 15), 5), 5), null)
  assert.equal(earlierStart(appendChunk(null, chunk(9, 11, 4, 15), 5), 5), 1)
})

test('nextHit walks the hits both ways and wraps', () => {
  const hits = [3, 8, 20]
  assert.equal(nextHit(hits, null, 1), 3)
  assert.equal(nextHit(hits, null, -1), 20)
  assert.equal(nextHit(hits, 3, 1), 8)
  assert.equal(nextHit(hits, 20, 1), 3)
  assert.equal(nextHit(hits, 3, -1), 20)
  assert.equal(nextHit(hits, 8, -1), 3)
  assert.equal(nextHit(hits, 10, 1), 20)
  assert.equal(nextHit(hits, 10, -1), 8)
  assert.equal(nextHit([], 3, 1), null)
})
