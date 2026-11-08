export interface MermaidBlock {
  first: number
  last: number
  colon: boolean
  body: string
}

interface Opened {
  first: number
  colon: boolean
  fence: string
}

const MERMAID = 'mermaid'
const COLON_OPENER = /^ {0,3}:::[ \t]*mermaid[ \t]*$/i
const COLON_CLOSER = ':::'
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const LEADING_TICKS = /^[ \t]*(`*)/
const FRONT_MATTER = '---'
const COMMENT = '%%'
const KIND_WORD = /[\s:;]/
const KINDS = new Map([
  ['graph', 'flowchart'],
  ['flowchart', 'flowchart'],
  ['sequenceDiagram', 'sequence diagram'],
  ['erDiagram', 'entity relationship diagram'],
  ['journey', 'user journey'],
  ['gantt', 'Gantt chart'],
  ['pie', 'pie chart'],
  ['gitGraph', 'git graph'],
  ['mindmap', 'mind map'],
  ['timeline', 'timeline'],
  ['quadrantChart', 'quadrant chart'],
  ['requirementDiagram', 'requirement diagram']
])
const KIND_PREFIXES: [string, string][] = [
  ['classDiagram', 'class diagram'],
  ['stateDiagram', 'state diagram']
]
const ANY_DIAGRAM = 'diagram'
const DELIMITER_CELL = /^:?-+:?$/

export const WIDE_TABLE_COLUMNS = 4
export const WIDE_TABLE_CHARS = 48

export function isColonOpener(line: string): boolean {
  return COLON_OPENER.test(withoutCr(line))
}

export function isColonCloser(line: string): boolean {
  return line.trim() === COLON_CLOSER
}

export function fenceAfter(line: string, open: string): string {
  if (open) return closesFence(line, open) ? '' : open
  return fenceOf(line)?.fence ?? ''
}

export function mermaidBlocks(lines: readonly string[]): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  let block: Opened | null = null
  let other = ''
  const close = (opened: Opened, last: number, bodyEnd: number) => {
    blocks.push({ first: opened.first, last, colon: opened.colon, body: lines.slice(opened.first + 1, bodyEnd).map(withoutCr).join('\n') })
  }
  for (const [index, raw] of lines.entries()) {
    const line = withoutCr(raw)
    if (other) {
      other = fenceAfter(line, other)
    } else if (block) {
      if (block.colon ? isColonCloser(line) : closesFence(line, block.fence)) {
        close(block, index, index)
        block = null
      }
    } else if (isColonOpener(line)) {
      block = { first: index, colon: true, fence: '' }
    } else {
      const fenced = fenceOf(line)
      if (fenced?.info === MERMAID) block = { first: index, colon: false, fence: fenced.fence }
      else if (fenced) other = fenced.fence
    }
  }
  if (block) close(block, lines.length - 1, lines.length)
  return blocks
}

export function toFencedMermaid(markdown: string): string {
  const lines = markdown.split('\n')
  for (const block of mermaidBlocks(lines)) {
    if (!block.colon) continue
    const fence = '`'.repeat(Math.max(3, longestTicks(block.body) + 1))
    lines[block.first] = `${fence}${MERMAID}${crOf(lines[block.first])}`
    if (block.last > block.first && isColonCloser(lines[block.last])) lines[block.last] = `${fence}${crOf(lines[block.last])}`
  }
  return lines.join('\n')
}

export function diagramKind(body: string): string {
  const word = firstLine(body).split(KIND_WORD)[0]
  return KINDS.get(word) ?? KIND_PREFIXES.find(([prefix]) => word.startsWith(prefix))?.[1] ?? ANY_DIAGRAM
}

export function tableAt(lines: readonly string[], index: number): { columns: string[]; rows: string[][]; last: number } | null {
  const columns = splitRow(lines[index] ?? '')
  const delimiter = splitRow(lines[index + 1] ?? '')
  if (columns === null || columns.length === 0 || delimiter?.length !== columns.length || !delimiter.every(cell => DELIMITER_CELL.test(cell))) return null
  const rows: string[][] = []
  let last = index + 1
  for (let at = index + 2; at < lines.length; at += 1) {
    const cells = fenceOf(withoutCr(lines[at])) ? null : splitRow(lines[at])
    if (cells === null) break
    rows.push(Array.from(columns, (_, column) => cells[column] ?? ''))
    last = at
  }
  return { columns, rows, last }
}

export function isWideTable(columns: readonly string[], rows: readonly string[][]): boolean {
  if (columns.length >= WIDE_TABLE_COLUMNS) return true
  const widest = columns.map((header, column) => rows.reduce((longest, row) => Math.max(longest, row[column]?.length ?? 0), header.length))
  return widest.reduce((total, width) => total + width, 0) > WIDE_TABLE_CHARS
}

function splitRow(line: string): string[] | null {
  const text = line.trim()
  const cells: string[] = []
  let cell = ''
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (char === '\\' && at + 1 < text.length) {
      cell += text[at + 1] === '|' ? '|' : text.slice(at, at + 2)
      at += 2
    } else if (char === '`') {
      const end = codeSpanEnd(text, at)
      cell += text.slice(at, end)
      at = end
    } else if (char === '|') {
      cells.push(cell)
      cell = ''
      at += 1
    } else {
      cell += char
      at += 1
    }
  }
  cells.push(cell)
  if (cells.length === 1) return null
  if (text.startsWith('|')) cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells.map(cell => cell.trim())
}

function codeSpanEnd(text: string, start: number): number {
  let opened = start
  while (text[opened] === '`') opened += 1
  const run = opened - start
  let from = text.indexOf('`', opened)
  while (from !== -1) {
    let end = from
    while (text[end] === '`') end += 1
    if (end - from === run) return end
    from = text.indexOf('`', end)
  }
  return opened
}

function firstLine(body: string): string {
  const lines = body.split('\n').map(line => line.trim())
  let start = Math.max(0, lines.findIndex(line => line !== ''))
  if (lines[start] === FRONT_MATTER) {
    const end = lines.indexOf(FRONT_MATTER, start + 1)
    if (end === -1) return ''
    start = end + 1
  }
  return lines.slice(start).find(line => line !== '' && !line.startsWith(COMMENT)) ?? ''
}

export function fenceOf(line: string): { fence: string; info: string } | null {
  const found = FENCE.exec(line)
  if (!found || (found[1][0] === '`' && found[2].includes('`'))) return null
  return { fence: found[1], info: found[2].trim() }
}

export function closesFence(line: string, fence: string): boolean {
  const found = FENCE_END.exec(line)
  return found !== null && found[1][0] === fence[0] && found[1].length >= fence.length
}

function longestTicks(body: string): number {
  return body.split('\n').reduce((longest, line) => Math.max(longest, LEADING_TICKS.exec(line)?.[1].length ?? 0), 0)
}

export function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function crOf(line: string): string {
  return line.endsWith('\r') ? '\r' : ''
}
