import { fillLine, isWebUrl, parseTemplate } from './template'
import type { Segment, ShareItem, ShareMessage } from './types'

export const MAX_SHARE_ITEMS = 50
export const MAX_INTRO = 2000

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const MARKDOWN_SPECIALS = /[\\`*_[\]()<>#|~&@]/g
const MARKDOWN_TARGET_SPECIALS = /[\\`()<>&]/g

function cutIntro(intro: string): string {
  const trimmed = intro.replace(/\r\n?/g, '\n').trim()
  if (trimmed.length <= MAX_INTRO) return trimmed
  const cut = trimmed.slice(0, MAX_INTRO)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export function buildMessage(input: {
  template: string
  fallback: string
  vars: readonly string[]
  intro: string
  items: ShareItem[]
}): { message: ShareMessage; warning?: string } {
  const requested = parseTemplate(input.template, input.vars)
  const parsed = 'error' in requested ? parseTemplate(input.fallback, input.vars) : requested
  if ('error' in parsed) throw new Error(parsed.error)
  const message: ShareMessage = {
    intro: cutIntro(input.intro),
    lines: input.items.slice(0, MAX_SHARE_ITEMS).map(item => fillLine(parsed, item.vars))
  }
  return 'error' in requested ? { message, warning: requested.error } : { message }
}

function linkOf(segment: Segment): string | undefined {
  return segment.href !== undefined && isWebUrl(segment.href) ? segment.href : undefined
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => HTML_ENTITIES[char])
}

function htmlSegment(segment: Segment): string {
  const text = escapeHtml(segment.text)
  const href = linkOf(segment)
  return href === undefined ? text : `<a href="${escapeHtml(href)}">${text}</a>`
}

export function toHtml(message: ShareMessage): string {
  const intro = message.intro === '' ? [] : message.intro.split('\n')
  return [
    ...intro.map(line => `<div>${line.trim() === '' ? '<br>' : escapeHtml(line)}</div>`),
    ...message.lines.map(line => `<div>${line.map(htmlSegment).join('')}</div>`)
  ].join('')
}

function plainLine(line: Segment[]): string {
  const text = line.map(segment => segment.text).join('')
  const href = line.map(linkOf).find(url => url !== undefined)
  return href === undefined ? text : `${text} ${href}`
}

export function toPlain(message: ShareMessage): string {
  return [message.intro, message.lines.map(plainLine).join('\n')].filter(block => block !== '').join('\n\n')
}

function escapeMarkdown(text: string): string {
  return text
    .replace(MARKDOWN_SPECIALS, '\\$&')
    .replace(/:(?=\/\/)/g, '\\:')
    .replace(/(www)\./gi, '$1\\.')
}

function escapeLineStart(line: string): string {
  return line
    .replace(/^[ \t]+/, '')
    .replace(/^[-+=]/, '\\$&')
    .replace(/^(\d+)\./, '$1\\.')
}

function markdownSegment(segment: Segment): string {
  const text = escapeMarkdown(segment.text)
  const href = linkOf(segment)
  return href === undefined ? text : `[${text}](${href.replace(MARKDOWN_TARGET_SPECIALS, '\\$&')})`
}

export function toMarkdown(message: ShareMessage): string {
  const intro = message.intro === '' ? [] : [message.intro.split('\n').map(line => escapeLineStart(escapeMarkdown(line))).join('  \n')]
  return [...intro, ...message.lines.map(line => escapeLineStart(line.map(markdownSegment).join('')))].join('\n\n')
}
