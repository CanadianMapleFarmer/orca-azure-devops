import type { Segment } from './types'

export const PR_TEMPLATE = '[Pull Request {id}]({url}): {title}'
export const PR_VARS = ['id', 'title', 'url', 'repo', 'project', 'source', 'target', 'author'] as const

export const TEMPLATE_EMPTY = 'The share template is empty.'
export const TEMPLATE_TWO_LINKS = 'The share template can have only one link.'
export const TEMPLATE_EMPTY_LINK = 'The link in the share template needs text, like [text]({url}).'
export const unknownPlaceholder = (name: string): string => `Unknown placeholder {${name}} in the share template.`

type Piece = { readonly text: string } | { readonly variable: string }

export type TemplatePart =
  | { readonly kind: 'text'; readonly pieces: readonly Piece[] }
  | { readonly kind: 'link'; readonly text: readonly Piece[]; readonly target: readonly Piece[] }

export type ParsedTemplate = { readonly kind: 'parsed'; readonly parts: readonly TemplatePart[] }

const LINK_SPAN = /\[([^\]]*)\]\(([^)]*)\)/g
const PLACEHOLDER = /\{([^{}]*)\}/g
const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g
const WEB_URL = /^https?:\/\/[^\s\u0000-\u001f\u007f/?#][^\s\u0000-\u001f\u007f]*$/i

export function isWebUrl(url: string): boolean {
  return WEB_URL.test(url)
}

function piecesOf(source: string, vars: readonly string[]): Piece[] | { error: string } {
  const pieces: Piece[] = []
  let last = 0
  for (const match of source.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (!vars.includes(name)) return { error: unknownPlaceholder(name) }
    if (match.index > last) pieces.push({ text: source.slice(last, match.index) })
    pieces.push({ variable: name })
    last = match.index + match[0].length
  }
  if (last < source.length) pieces.push({ text: source.slice(last) })
  return pieces
}

export function parseTemplate(template: string, vars: readonly string[]): ParsedTemplate | { error: string } {
  if (template.trim() === '') return { error: TEMPLATE_EMPTY }
  const spans = [...template.matchAll(LINK_SPAN)]
  if (spans.length > 1) return { error: TEMPLATE_TWO_LINKS }
  const span = spans[0]
  if (span && span[1].trim() === '') return { error: TEMPLATE_EMPTY_LINK }
  const sources = span
    ? [template.slice(0, span.index), span[1], span[2], template.slice(span.index + span[0].length)]
    : [template]
  const pieces: Piece[][] = []
  for (const source of sources) {
    const result = piecesOf(source, vars)
    if ('error' in result) return result
    pieces.push(result)
  }
  if (!span) return { kind: 'parsed', parts: [{ kind: 'text', pieces: pieces[0] }] }
  return {
    kind: 'parsed',
    parts: [
      { kind: 'text', pieces: pieces[0] },
      { kind: 'link', text: pieces[1], target: pieces[2] },
      { kind: 'text', pieces: pieces[3] }
    ]
  }
}

function fill(pieces: readonly Piece[], values: Record<string, string>): string {
  return pieces
    .map(piece => ('text' in piece ? piece.text : (values[piece.variable] ?? '').replace(LINE_BREAKS, ' ')))
    .join('')
}

export function fillLine(template: ParsedTemplate, values: Record<string, string>): Segment[] {
  const segments: Segment[] = []
  for (const part of template.parts) {
    if (part.kind === 'text') {
      const text = fill(part.pieces, values)
      if (text !== '') segments.push({ text })
      continue
    }
    const text = fill(part.text, values)
    const href = fill(part.target, values).trim()
    segments.push(isWebUrl(href) ? { text, href } : { text })
  }
  return segments
}
