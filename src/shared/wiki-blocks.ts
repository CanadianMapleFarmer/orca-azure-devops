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

function fenceOf(line: string): { fence: string; info: string } | null {
  const found = FENCE.exec(line)
  if (!found || (found[1][0] === '`' && found[2].includes('`'))) return null
  return { fence: found[1], info: found[2].trim() }
}

function closesFence(line: string, fence: string): boolean {
  const found = FENCE_END.exec(line)
  return found !== null && found[1][0] === fence[0] && found[1].length >= fence.length
}

function longestTicks(body: string): number {
  return body.split('\n').reduce((longest, line) => Math.max(longest, LEADING_TICKS.exec(line)?.[1].length ?? 0), 0)
}

function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function crOf(line: string): string {
  return line.endsWith('\r') ? '\r' : ''
}
