import { MAX_DIFF_BYTES, type DiffText } from '../../src/shared/diff'
import { cutText } from '../ado/cut-text'
import { byteLength } from '../budget'
import { DIFF_NO_TEXT_CHANGES, DIFF_TOO_LARGE, DIFF_TOO_MANY, diffCut } from '../messages'

export const CONTEXT_LINES = 3
export const MAX_EDITS = 2_000
export const MAX_SIDE_LINES = 50_000
export const MAX_DIFF_LINE_CHARS = 1_000
export const MAX_DIFF_WORK = 20_000_000

export interface DiffLine {
  kind: ' ' | '-' | '+'
  old: number | null
  new: number | null
  text: string
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface Change {
  old: number
  new: number
  deleted: number
  inserted: number
}

const JSON_QUOTE_BYTES = byteLength('')

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

export function diffLines(
  before: readonly string[],
  after: readonly string[],
  limits: { edits?: number; work?: number } = {}
): Hunk[] | 'tooMany' {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  const deleted = oldEnd - start
  const inserted = newEnd - start
  if (deleted === 0 && inserted === 0) return []
  const changes =
    deleted === 0 || inserted === 0
      ? [{ old: start, new: start, deleted, inserted }]
      : shortestEdit(before, after, start, oldEnd, newEnd, limits.edits ?? MAX_EDITS, limits.work ?? MAX_DIFF_WORK)
  return changes === 'tooMany' ? changes : hunksOf(before, after, changes)
}

function shortestEdit(
  before: readonly string[],
  after: readonly string[],
  start: number,
  oldEnd: number,
  newEnd: number,
  maxEdits: number,
  maxWork: number
): Change[] | 'tooMany' {
  const ids = new Map<string, number>()
  const encode = (lines: readonly string[], end: number) => {
    const encoded = new Int32Array(end - start)
    for (let i = start; i < end; i += 1) {
      let id = ids.get(lines[i])
      if (id === undefined) ids.set(lines[i], (id = ids.size))
      encoded[i - start] = id
    }
    return encoded
  }
  const a = encode(before, oldEnd)
  const b = encode(after, newEnd)
  const trace: Int32Array[] = []
  let work = 0
  for (let d = 0; d <= maxEdits; d += 1) {
    const prev = trace[d - 1]
    const v = new Int32Array(2 * d + 1)
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : isDown(prev, d, k) ? prev[k + d] : prev[k + d - 2] + 1
      let y = x - k
      work += 1
      while (x < a.length && y < b.length) {
        work += 1
        if (a[x] !== b[y]) break
        x += 1
        y += 1
      }
      v[k + d] = x
      if (work > maxWork) return 'tooMany'
      if (x >= a.length && y >= b.length) {
        trace.push(v)
        return changesOf(trace, a.length, b.length, start)
      }
    }
    trace.push(v)
  }
  return 'tooMany'
}

function isDown(prev: Int32Array, d: number, k: number): boolean {
  return k === -d || (k !== d && prev[k + d - 2] < prev[k + d])
}

function changesOf(trace: readonly Int32Array[], n: number, m: number, offset: number): Change[] {
  const moves: { x: number; y: number; down: boolean }[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1]
    const k = x - y
    const down = isDown(prev, d, k)
    const from = down ? k + 1 : k - 1
    x = prev[from + d - 1]
    y = x - from
    moves.push({ x, y, down })
  }
  const changes: Change[] = []
  for (const { x, y, down } of moves.reverse()) {
    const last = changes[changes.length - 1]
    if (last && last.old + last.deleted === x + offset && last.new + last.inserted === y + offset) {
      if (down) last.inserted += 1
      else last.deleted += 1
    } else {
      changes.push({ old: x + offset, new: y + offset, deleted: down ? 0 : 1, inserted: down ? 1 : 0 })
    }
  }
  return changes
}

function hunksOf(before: readonly string[], after: readonly string[], changes: readonly Change[]): Hunk[] {
  const hunks: Hunk[] = []
  for (let first = 0; first < changes.length; ) {
    let last = first
    while (last + 1 < changes.length && changes[last + 1].old - (changes[last].old + changes[last].deleted) <= 2 * CONTEXT_LINES) last += 1
    hunks.push(hunkOf(before, after, changes.slice(first, last + 1)))
    first = last + 1
  }
  return hunks
}

function hunkOf(before: readonly string[], after: readonly string[], group: readonly Change[]): Hunk {
  const lead = Math.min(CONTEXT_LINES, group[0].old)
  const tail = group[group.length - 1]
  const trail = Math.min(CONTEXT_LINES, before.length - (tail.old + tail.deleted))
  const oldFrom = group[0].old - lead
  const newFrom = group[0].new - lead
  const lines: DiffLine[] = []
  let o = oldFrom
  let n = newFrom
  const same = (until: number) => {
    for (; o < until; o += 1, n += 1) lines.push({ kind: ' ', old: o + 1, new: n + 1, text: before[o] })
  }
  for (const change of group) {
    same(change.old)
    for (const end = o + change.deleted; o < end; o += 1) lines.push({ kind: '-', old: o + 1, new: null, text: before[o] })
    for (const end = n + change.inserted; n < end; n += 1) lines.push({ kind: '+', old: null, new: n + 1, text: after[n] })
  }
  same(o + trail)
  const oldLines = o - oldFrom
  const newLines = n - newFrom
  return { oldStart: oldLines ? oldFrom + 1 : oldFrom, oldLines, newStart: newLines ? newFrom + 1 : newFrom, newLines, lines }
}

export function formatHunks(hunks: readonly Hunk[], maxBytes = MAX_DIFF_BYTES): { text: string; shownLines: number; cut: boolean } {
  const widest = hunks.reduce((max, hunk) => Math.max(max, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1), 1)
  const width = String(widest).length
  const rows: string[] = []
  let used = JSON_QUOTE_BYTES
  let shownLines = 0
  for (const hunk of hunks) {
    let header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`
    for (const line of hunk.lines) {
      const row = `${header}${rowOf(line, width)}`
      const cost = byteLength(rows.length ? `\n${row}` : row) - JSON_QUOTE_BYTES
      if (used + cost > maxBytes) return { text: rows.join('\n'), shownLines, cut: true }
      rows.push(row)
      used += cost
      shownLines += 1
      header = ''
    }
  }
  return { text: rows.join('\n'), shownLines, cut: false }
}

function rowOf(line: DiffLine, width: number): string {
  const number = (value: number | null) => (value === null ? '' : String(value)).padStart(width)
  return `${line.kind}${number(line.old)} ${number(line.new)} │ ${cutText(line.text, MAX_DIFF_LINE_CHARS)}`
}

export function diffText(before: string | null, after: string | null): DiffText & { lines: { old: number | null; new: number | null } } {
  const beforeLines = before === null ? null : splitLines(before)
  const afterLines = after === null ? null : splitLines(after)
  const lines = { old: beforeLines?.length ?? null, new: afterLines?.length ?? null }
  if ((lines.old ?? 0) > MAX_SIDE_LINES || (lines.new ?? 0) > MAX_SIDE_LINES) return { text: null, message: DIFF_TOO_LARGE, lines }
  const hunks = diffLines(beforeLines ?? [], afterLines ?? [])
  if (hunks === 'tooMany') return { text: null, message: DIFF_TOO_MANY, lines }
  if (hunks.length === 0) return { text: null, message: DIFF_NO_TEXT_CHANGES, lines }
  const { text, shownLines, cut } = formatHunks(hunks)
  return cut ? { text, message: diffCut(shownLines), lines } : { text, lines }
}
