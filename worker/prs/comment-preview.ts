import { decode } from '../ado/html-text'
import { UNKNOWN_AUTHOR } from '../messages'

const MENTION = /@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi
const LINE_BREAK = /<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi
const MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g
const FENCE = /^\s*(?:`{3,}|~{3,})/
const DEFINITION = /^\s*\[[^\]]+\]:(?:\s*\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)?\s*$/
const ESCAPED = /\\([!-\/:-@\[-`{-~])/g
const HIDDEN = /[\uE021-\uE07E]/g
const HIDE_OFFSET = 0xe000
const MARKERS = /[*_~]/g
const LINE_MARKS = /^(?:\s*(?:>|#{1,6}(?=\s|$)|[-+*](?=\s)|\d{1,9}[.)](?=\s)))+/
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const URL_RUN = /<?[a-z][a-z0-9+.-]*:\/\/\S*/gi
const STRONG = /(?<![\p{L}\p{N}_])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu
const EMPHASIS = /(?<![\p{L}\p{N}_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu
const CODE = /(`+)(.+?)\1/g

function hide(char: string): string {
  return String.fromCharCode(HIDE_OFFSET + char.charCodeAt(0))
}

export function commentPreview(content: string, people: ReadonlyMap<string, string>): string {
  const named = new Map([...people].map(([id, name]) => [id.toLowerCase(), name]))
  const text = decode(
    content
      .replace(MENTION, (_, id: string) => `@${named.get(id.toLowerCase()) ?? UNKNOWN_AUTHOR}`)
      .replace(LINE_BREAK, '\n')
      .replace(MARKUP, '')
  )
  for (const line of text.split(/\r\n?|\n/)) {
    if (FENCE.test(line)) continue
    const unmarked = line.replace(ESCAPED, (_, char: string) => hide(char)).replace(LINE_MARKS, '')
    if (DEFINITION.test(unmarked)) continue
    const plain = unmarked
      .replace(LINK, '$1')
      .replace(CODE, (_, __, code: string) => code.replace(MARKERS, hide))
      .replace(STRONG, '$2')
      .replace(EMPHASIS, '$2')
      .replace(URL_RUN, '')
      .replace(HIDDEN, char => String.fromCharCode(char.charCodeAt(0) - HIDE_OFFSET))
      .replace(/\s+/g, ' ')
      .trim()
    if (plain) return plain
  }
  return ''
}
