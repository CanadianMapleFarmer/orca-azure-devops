import { diagramKind, fenceAfter, isWideTable, mermaidBlocks, tableAt, withoutCr, type MermaidBlock } from '../../shared/wiki-blocks'

export type PageSegment =
  | { kind: 'markdown'; first: number; last: number; text: string; refs: string }
  | { kind: 'diagram'; key: string; first: number; last: number; diagram: string }
  | { kind: 'table'; key: string; first: number; last: number; columns: string[] }

type Card = Exclude<PageSegment, { kind: 'markdown' }>

interface Range {
  first: number
  last: number
}

interface Definition {
  first: number
  text: string
}

const ALL_PAGES = 'All pages'
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:/
const LINK_DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*\S/
const CONTINUATION = /^[ \t]+\S/
const BRACKETED = /\[([^[\]]+)\]/g
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g

export function pageSegments(markdown: string): PageSegment[] {
  const lines = markdown.split('\n')
  const diagrams = new Map(mermaidBlocks(lines).map(block => [block.first, block]))
  const fenced = fencedLines(lines, diagrams)
  const parts = withGaps(lines.length, cardsOf(lines, diagrams, fenced))
  const definitions = definitionsIn(
    lines,
    fenced,
    parts.filter((part): part is Range => !('kind' in part))
  )
  return parts.map(part => ('kind' in part ? part : markdownSegment(lines, fenced, part, definitions)))
}

export function backLabel(path: string): string {
  const parents = path.split('/').filter(part => part !== '').slice(0, -1)
  return `‹ ${parents.length === 0 ? ALL_PAGES : parents.join(' / ')}`
}

function fencedLines(lines: readonly string[], diagrams: ReadonlyMap<number, MermaidBlock>): boolean[] {
  const fenced: boolean[] = []
  let open = ''
  let at = 0
  while (at < lines.length) {
    const diagram = diagrams.get(at)
    if (diagram) {
      for (; at <= diagram.last; at += 1) fenced.push(false)
      continue
    }
    const after = fenceAfter(withoutCr(lines[at]), open)
    fenced.push(open !== '' || after !== '')
    open = after
    at += 1
  }
  return fenced
}

function cardsOf(lines: readonly string[], diagrams: ReadonlyMap<number, MermaidBlock>, fenced: readonly boolean[]): Card[] {
  const cards: Card[] = []
  let at = 0
  while (at < lines.length) {
    const diagram = diagrams.get(at)
    if (diagram) {
      cards.push({ kind: 'diagram', key: `diagram:${at}`, first: at, last: diagram.last, diagram: diagramKind(diagram.body) })
      at = diagram.last + 1
      continue
    }
    const table = fenced[at] ? null : tableAt(lines, at)
    if (table && isWideTable(table.columns, table.rows)) cards.push({ kind: 'table', key: `table:${at}`, first: at, last: table.last, columns: table.columns })
    at = table ? table.last + 1 : at + 1
  }
  return cards
}

function withGaps(count: number, cards: readonly Card[]): (Card | Range)[] {
  const parts: (Card | Range)[] = []
  let next = 0
  for (const card of cards) {
    if (card.first > next) parts.push({ first: next, last: card.first - 1 })
    parts.push(card)
    next = card.last + 1
  }
  if (next < count) parts.push({ first: next, last: count - 1 })
  return parts
}

function markdownSegment(lines: readonly string[], fenced: readonly boolean[], range: Range, definitions: ReadonlyMap<string, Definition>): PageSegment {
  const used = labelsIn(proseOf(lines, fenced, range))
  const copied = [...definitions].filter(([label, found]) => used.has(label) && (found.first < range.first || found.first > range.last))
  return {
    kind: 'markdown',
    first: range.first,
    last: range.last,
    text: lines.slice(range.first, range.last + 1).join('\n'),
    refs: copied.map(([, found]) => found.text).join('\n\n')
  }
}

function definitionsIn(lines: readonly string[], fenced: readonly boolean[], ranges: readonly Range[]): Map<string, Definition> {
  const found = new Map<string, Definition>()
  for (const { first, last } of ranges) {
    for (let at = first; at <= last; at += 1) {
      const label = fenced[at] ? null : labelOf(withoutCr(lines[at]))
      if (label === null) continue
      let end = at
      while (end < last && !fenced[end + 1] && CONTINUATION.test(withoutCr(lines[end + 1]))) end += 1
      if (!found.has(label)) found.set(label, { first: at, text: lines.slice(at, end + 1).map(withoutCr).join('\n') })
      at = end
    }
  }
  return found
}

function labelOf(line: string): string | null {
  const footnote = FOOTNOTE_DEFINITION.exec(line)
  if (footnote) return normalized(`^${footnote[1]}`)
  const link = LINK_DEFINITION.exec(line)
  return link ? normalized(link[1]) : null
}

function proseOf(lines: readonly string[], fenced: readonly boolean[], { first, last }: Range): string {
  return lines
    .slice(first, last + 1)
    .filter((_, index) => !fenced[first + index])
    .join('\n')
    .replace(CODE_SPAN, '')
}

function labelsIn(prose: string): Set<string> {
  return new Set(Array.from(prose.matchAll(BRACKETED), found => normalized(found[1])))
}

function normalized(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}
