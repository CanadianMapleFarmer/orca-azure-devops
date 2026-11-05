import { LOG_FIRST_LINE, MAX_BUFFER_LINES, MAX_LOG_LINES, type LogChunk } from '../shared/pipelines'
import { plainText } from './ansi'

export type LineKind = 'error' | 'warning' | 'section' | 'command' | 'group' | 'endgroup' | 'debug' | 'plain'

export interface LogLine {
  n: number
  text: string
  kind: LineKind
  time: string | null
}

export interface LogBuffer {
  logId: number
  first: number
  lines: LogLine[]
  total: number
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)(?: |$)/
const MARKER = /^##\[(error|warning|section|command|group|endgroup|debug)\]/
const ERROR_PATTERNS = [/##\[error\]/, /(?:^|\s)(?:error|ERROR|Error)(?:\s+[A-Za-z]*\d+)?\s*:/, /\bFAILED\b/, /^fatal:/]
const ERROR_LINES = 20
const CAPITAL = /\p{Lu}/u

export function parseLine(n: number, raw: string): LogLine {
  const stamped = TIMESTAMP.exec(raw)
  const time = stamped ? stamped[1] : null
  const rest = stamped ? raw.slice(stamped[0].length) : raw
  const marked = MARKER.exec(rest)
  if (marked) return { n, text: rest.slice(marked[0].length), kind: marked[1] as LineKind, time }
  return { n, text: rest, kind: isErrorText(plainText(rest)) ? 'error' : 'plain', time }
}

export function isErrorText(text: string): boolean {
  return ERROR_PATTERNS.some(pattern => pattern.test(text))
}

export function lastLine(buffer: LogBuffer): number {
  return buffer.first + buffer.lines.length - 1
}

export function appendChunk(buffer: LogBuffer | null, chunk: LogChunk, cap = MAX_BUFFER_LINES): LogBuffer {
  const incoming = chunk.lines.map((raw, index) => parseLine(chunk.first + index, raw))
  const chunkEnd = chunk.first + incoming.length - 1
  const touches = buffer !== null && buffer.logId === chunk.logId && chunk.first <= lastLine(buffer) + 1 && chunkEnd >= buffer.first - 1
  if (!buffer || !touches) return capped({ logId: chunk.logId, first: chunk.first, lines: incoming, total: chunk.total }, cap)
  const lines = [...buffer.lines.filter(line => line.n < chunk.first), ...incoming, ...buffer.lines.filter(line => line.n > chunkEnd)]
  return capped({ logId: chunk.logId, first: lines[0]?.n ?? chunk.first, lines, total: Math.max(buffer.total, chunk.total) }, cap)
}

function capped(buffer: LogBuffer, cap: number): LogBuffer {
  if (buffer.lines.length <= cap) return buffer
  const lines = buffer.lines.slice(buffer.lines.length - cap)
  return { ...buffer, first: lines[0]?.n ?? buffer.first, lines }
}

export function visibleIndexes(buffer: LogBuffer, errorsOnly: boolean): number[] {
  const indexes: number[] = []
  buffer.lines.forEach((line, index) => {
    if (!errorsOnly || line.kind === 'error') indexes.push(index)
  })
  return indexes
}

export function searchHits(buffer: LogBuffer, query: string): number[] {
  if (!query) return []
  const exact = CAPITAL.test(query)
  const wanted = exact ? query : query.toLowerCase()
  const hits: number[] = []
  buffer.lines.forEach((line, index) => {
    const text = plainText(line.text)
    if ((exact ? text : text.toLowerCase()).includes(wanted)) hits.push(index)
  })
  return hits
}

export function errorLines(buffer: LogBuffer, max = ERROR_LINES): LogLine[] {
  const found: LogLine[] = []
  for (const line of buffer.lines) {
    if (found.length === max) break
    if (line.kind === 'error') found.push(line)
  }
  return found
}

export function nextRead(buffer: LogBuffer, logLines: number | null, follow: boolean, cap = MAX_BUFFER_LINES): { first?: number } | null {
  const end = lastLine(buffer)
  if (logLines === null || logLines <= end) return null
  const behind = logLines - end
  return (follow && behind > MAX_LOG_LINES) || behind > cap ? {} : { first: end + 1 }
}

export function earlierStart(buffer: LogBuffer, cap = MAX_BUFFER_LINES): number | null {
  if (buffer.first <= LOG_FIRST_LINE || buffer.lines.length >= cap) return null
  return Math.max(LOG_FIRST_LINE, buffer.first - MAX_LOG_LINES)
}

export function nextHit(hits: readonly number[], current: number | null, direction: 1 | -1): number | null {
  if (hits.length === 0) return null
  if (direction === 1) return hits.find(line => current === null || line > current) ?? hits[0]
  return [...hits].reverse().find(line => current === null || line < current) ?? hits[hits.length - 1]
}
