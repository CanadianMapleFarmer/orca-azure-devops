import { decode } from '../ado/html-text'
import { UNKNOWN_AUTHOR } from '../messages'

const MENTION = /@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi
const LINE_BREAK = /<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi
const MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g
const FENCE = /^\s*(?:`{3,}|~{3,})/
const ESCAPED = /\\([!-\/:-@\[-`{-~])/g
const HIDDEN = /[-]/g
const HIDE_OFFSET = 0xe000
const LINE_MARKS = /^(?:\s*(?:>|#{1,6}(?=\s|$)|[-+*](?=\s)|\d{1,9}[.)](?=\s)))+/
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const STRONG = /(?<![\p{L}\p{N}_])(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu
const EMPHASIS = /(?<![\p{L}\p{N}_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu
const CODE = /(`+)(.+?)\1/g

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
    const plain = line
      .replace(ESCAPED, (_, char: string) => String.fromCharCode(HIDE_OFFSET + char.charCodeAt(0)))
      .replace(LINE_MARKS, '')
      .replace(LINK, '$1')
      .replace(STRONG, '$2')
      .replace(EMPHASIS, '$2')
      .replace(CODE, '$2')
      .replace(HIDDEN, char => String.fromCharCode(char.charCodeAt(0) - HIDE_OFFSET))
      .replace(/\s+/g, ' ')
      .trim()
    if (plain) return plain
  }
  return ''
}
