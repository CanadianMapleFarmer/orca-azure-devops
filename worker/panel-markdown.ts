import { decode, escapeText } from './ado/html-text'
import { IMAGE_ALT, imageLink, MARKDOWN_CUT_NOTE, UNKNOWN_AUTHOR } from './messages'

export interface MarkdownTarget {
  maxBytes: number
  resolve: (href: string) => string
  people?: ReadonlyMap<string, string>
}

interface Context {
  resolve: (href: string) => string
  people: ReadonlyMap<string, string>
}

type Unit = { code: true; line: string; fence: string } | { code: false; lines: string[] }

interface Opener {
  at: number
  source: number
  image: boolean
}

interface ConvertedImage {
  at: number
  label: string
  end: number
}

interface Destination {
  start: number
  end: number
  raw: string
}

const CUT_SUFFIX = `\n\n*${MARKDOWN_CUT_NOTE}*`
const CUT_SUFFIX_BYTES = Buffer.byteLength(CUT_SUFFIX)
const NO_JOIN = '​'
const MAX_OPENERS = 32
const MAX_LABEL = 999
const INPUT_PER_BYTE = 16

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const TOC = /^ {0,3}\[\[_(?:TOC|TOSP)_\]\][ \t]*$/
const QUOTE_MARKS = /^(?: {0,3}>[ \t]?)*/
const INTERRUPTS = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d{1,9}[.)][ \t]|(?:[-*_][ \t]*){3,}$)/
const ONE_LINE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/
const BLOCK_TAGS = [
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup',
  'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame',
  'frameset', 'h[1-6]', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul'
].join('|')
const ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`
const TAG = String.raw`<([A-Za-z][A-Za-z0-9-]*)(?:${ATTRIBUTE})*\s*\/?>|<\/([A-Za-z][A-Za-z0-9-]*)\s*>`
const TAG_AT = new RegExp(TAG, 'y')
const TAG_LINE = new RegExp(String.raw`^ {0,3}(?:${TAG})[ \t]*$`)
const LOOSE_TAG = /<(a|img)(?:\s[^<>]*)?>/iy
const HTML_BLOCKS: [RegExp, RegExp | null][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp(String.raw`^ {0,3}<\/?(?:${BLOCK_TAGS})(?:[ \t>]|\/>|$)`, 'i'), null]
]
const ATTRIBUTE_VALUE = /\s([A-Za-z_:][\w.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f\x7f]*)>/y
const MENTION = /@<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/iy
const DEFINITION = /[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t][ \t>]*)*\[/y
const SPECIAL = /[\\`<@!\[\]\n]/g
const ESCAPABLE = /^[!-\/:-@\[-`{-~\n]$/
const HREF_ESCAPE = /\\([!-\/:-@\[-`{-~])|&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi
const HREF_UNSAFE = /[\s\x00-\x1f\x7f()<>[\]\\`]/g
const KEEP_LINK = /^(?:https?|mailto):/i
const KEEP_IMAGE = /^https?:/i
const IMAGE_SIZE = /[ \t]+=\d*x\d*/y
const SECURE = /^https:\/\//i
const FILE_NAME = /^[^:\x00-\x1f]+\.[A-Za-z0-9]{1,8}$/
const GLUES = /[\]<\\`&!]/
const LETTER = /\p{L}/u

export function panelMarkdown(text: string, target: MarkdownTarget): string {
  const ctx: Context = { resolve: target.resolve, people: lowerKeys(target.people) }
  const pieces: string[] = []
  let used = -1
  let kept = { count: 0, fence: '' }
  for (const unit of toUnits(text)) {
    const piece = unit.code ? unit.line : renderInline(unit.lines.join('\n'), ctx)
    const size = used + 1 + Buffer.byteLength(piece)
    if (size > target.maxBytes) {
      const room = target.maxBytes - CUT_SUFFIX_BYTES - used - 1
      const partial = !unit.code && kept.count === pieces.length ? partialProse(unit.lines, room, ctx, pieces.length === 0) : null
      const head = partial === null ? [...pieces.slice(0, kept.count), ...(kept.fence ? [kept.fence] : [])] : [...pieces, partial]
      return head.join('\n') + CUT_SUFFIX
    }
    pieces.push(piece)
    used = size
    const fence = unit.code ? unit.fence : ''
    if (size + (fence ? fence.length + 1 : 0) + CUT_SUFFIX_BYTES <= target.maxBytes) kept = { count: pieces.length, fence }
  }
  return pieces.join('\n')
}

function lowerKeys(people: ReadonlyMap<string, string> | undefined): Map<string, string> {
  return new Map([...(people ?? [])].map(([id, name]) => [id.toLowerCase(), name]))
}

function partialProse(lines: string[], room: number, ctx: Context, midLine: boolean): string | null {
  if (room <= 0) return null
  const fitting = (source: string) => {
    const rendered = renderInline(source, ctx)
    return rendered && Buffer.byteLength(rendered) <= room ? rendered : null
  }
  const limit = room * INPUT_PER_BYTE
  let count = 0
  for (let length = -1; count < lines.length - 1 && length + 1 + lines[count].length <= limit; count++)
    length += 1 + lines[count].length
  const whole = longest(count, n => fitting(lines.slice(0, n).join('\n')))
  if (whole !== null || !midLine) return whole
  const line = lines[0].slice(0, limit)
  return longest(line.length, n => fitting(line.slice(0, codePointEnd(line, n))))
}

function longest(max: number, attempt: (n: number) => string | null): string | null {
  let best: string | null = null
  for (let low = 1, high = max; low <= high;) {
    const middle = (low + high) >>> 1
    const value = attempt(middle)
    if (value === null) high = middle - 1
    else {
      best = value
      low = middle + 1
    }
  }
  return best
}

function codePointEnd(text: string, end: number): number {
  const unit = text.charCodeAt(end - 1)
  return unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end
}

function toUnits(text: string): Unit[] {
  const units: Unit[] = []
  let fence = ''
  let html: RegExp | null | undefined
  let chunk: string[] | null = null
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = ''
      units.push({ code: true, line, fence })
      continue
    }
    const opened = html === undefined ? fenceOf(line) : ''
    if (opened) {
      fence = opened
      chunk = null
      units.push({ code: true, line, fence })
      continue
    }
    if (TOC.test(line)) continue
    if (!line.trim()) {
      if (html === null) html = undefined
      prose(units, line)
      chunk = null
      continue
    }
    if (html === undefined) {
      html = htmlBlock(line, chunk !== null)
      if (html !== undefined || chunk === null || interrupts(line, chunk[chunk.length - 1])) chunk = prose(units, line)
      else chunk.push(line)
    } else if (chunk) chunk.push(line)
    else chunk = prose(units, line)
    if (html instanceof RegExp && html.test(line)) {
      html = undefined
      chunk = null
    } else if (html === undefined && ONE_LINE.test(unquoted(line))) chunk = null
  }
  return units
}

function prose(units: Unit[], line: string): string[] {
  const lines = [line]
  units.push({ code: false, lines })
  return lines
}

function fenceOf(line: string): string {
  const found = FENCE.exec(line)
  return found && !(found[1][0] === '`' && found[2].includes('`')) ? found[1] : ''
}

function closesFence(line: string, fence: string): boolean {
  const found = FENCE_END.exec(line)
  return found !== null && found[1][0] === fence[0] && found[1].length >= fence.length
}

function htmlBlock(line: string, inParagraph: boolean): RegExp | null | undefined {
  for (const [start, end] of HTML_BLOCKS) if (start.test(line)) return end
  if (inParagraph) return undefined
  const tag = TAG_LINE.exec(line)
  const name = (tag?.[1] ?? tag?.[2])?.toLowerCase()
  return name && name !== 'a' && name !== 'img' ? null : undefined
}

function interrupts(line: string, previous: string): boolean {
  return quoteDepth(line) > quoteDepth(previous) || INTERRUPTS.test(unquoted(line))
}

function quoteMarks(line: string): string {
  return QUOTE_MARKS.exec(line)?.[0] ?? ''
}

function quoteDepth(line: string): number {
  return quoteMarks(line).split('>').length - 1
}

function unquoted(line: string): string {
  return line.slice(quoteMarks(line).length)
}

function renderInline(s: string, ctx: Context): string {
  const out: string[] = []
  const openers: Opener[] = []
  const runs = backtickRuns(s)
  let commentsLeft = true
  let plain = 0
  let i = 0
  let image: ConvertedImage | null = null

  const flush = (to: number) => {
    if (to > plain) out.push(s.slice(plain, to))
    plain = to
  }
  const replace = (from: number, to: number, text: string) => {
    flush(from)
    out.push(text)
    plain = to
  }

  const definition = () => {
    const found = definitionAt(s, i)
    if (!found) return
    flush(found.open + 1)
    out.push(renderInline(s.slice(found.open + 1, found.close), ctx))
    plain = found.close
    if (!KEEP_LINK.test(found.dest.raw)) replace(found.dest.start, found.dest.end, resolved(unescapeHref(found.dest.raw), ctx))
    i = found.end
  }

  const mention = () => {
    MENTION.lastIndex = i
    const found = MENTION.exec(s)
    if (!found) {
      i += 1
      return
    }
    const end = MENTION.lastIndex
    replace(i, end, `@${escapeText(ctx.people.get(found[1].toLowerCase()) ?? UNKNOWN_AUTHOR)}`)
    i = end
  }

  const angle = () => {
    AUTOLINK.lastIndex = i
    const autolink = AUTOLINK.exec(s)
    if (autolink) {
      const end = AUTOLINK.lastIndex
      if (!KEEP_LINK.test(autolink[1])) {
        const href = resolved(autolink[1], ctx)
        replace(i, end, href ? `<${href}>` : `\\<${escapeText(autolink[1])}>`)
      }
      i = end
      return
    }
    if (s.startsWith('<!--', i)) {
      const end = commentsLeft ? s.indexOf('-->', i + 2) : -1
      commentsLeft = end >= 0
      i = end >= 0 ? end + 3 : i + 1
      return
    }
    TAG_AT.lastIndex = i
    const strict = TAG_AT.exec(s)
    LOOSE_TAG.lastIndex = i
    const tag = strict ?? LOOSE_TAG.exec(s)
    if (!tag) {
      i += 1
      return
    }
    const end = i + tag[0].length
    const name = (tag[1] ?? tag[2]).toLowerCase()
    if (name === 'a') replace(i, end, removedTag(s, i, end))
    else if (name === 'img' && tag[2] === undefined) {
      const { label, target } = tagImage(tag[0], ctx)
      flush(i)
      emitImage(joinGuard(s, i), label, target, end)
    }
    i = end
  }

  const emitImage = (guard: string, label: string, target: string, end: number) => {
    out.push(`${guard}[${label}](${target})`)
    image = { at: out.length - 1, label, end }
    plain = end
  }

  const open = (isImage: boolean) => {
    flush(i)
    if (openers.length === MAX_OPENERS) openers.shift()
    openers.push({ at: out.length, source: i, image: isImage })
    out.push(isImage ? '![' : '[')
    i += isImage ? 2 : 1
    plain = i
  }

  const close = () => {
    const opener = openers.pop()
    const bracket = i
    i += 1
    if (s[i] !== '(') {
      if (opener?.image) out[opener.at] = `${joinGuard(s, opener.source)}[`
      return
    }
    const tail = linkTail(s, i + 1, opener?.image === true)
    if (!tail) return
    const { dest } = tail
    const href = unescapeHref(dest.raw)
    if (opener?.image && tail.end >= 0) {
      flush(bracket)
      const alt = out.splice(opener.at).slice(1).join('')
      const target = KEEP_IMAGE.test(dest.raw) ? s.slice(dest.start, dest.end) : resolved(href, ctx)
      emitImage(joinGuard(s, opener.source), imageLabel(alt, href), target, tail.end)
      i = tail.end
      return
    }
    if (opener && tail.end >= 0 && image && image.at === opener.at + 1 && image.end === bracket && out.length === opener.at + 2) {
      out.splice(opener.at)
      out.push(`[${image.label}`)
    }
    if (!KEEP_LINK.test(dest.raw)) replace(dest.start, dest.end, resolved(href, ctx))
    if (!opener || tail.end < 0) {
      i = dest.end
      return
    }
    i = tail.end
    for (let k = openers.length - 1; k >= 0; k--) if (!openers[k].image) openers.splice(k, 1)
  }

  definition()
  while (i < s.length) {
    SPECIAL.lastIndex = i
    const next = SPECIAL.exec(s)
    if (!next) break
    i = next.index
    switch (s[i]) {
      case '\\':
        i += ESCAPABLE.test(s[i + 1] ?? '') ? 2 : 1
        break
      case '`':
        i = codeSpanEnd(s, i, runs)
        break
      case '\n':
        i += 1
        definition()
        break
      case '@':
        mention()
        break
      case '<':
        angle()
        break
      case '!':
        if (s[i + 1] === '[') open(true)
        else i += 1
        break
      case '[':
        open(false)
        break
      default:
        close()
    }
  }
  flush(s.length)
  return out.join('')
}

function backtickRuns(s: string): Map<number, number[]> {
  const runs = new Map<number, number[]>()
  for (const run of s.matchAll(/`+/g)) {
    const starts = runs.get(run[0].length)
    if (starts) starts.push(run.index)
    else runs.set(run[0].length, [run.index])
  }
  return runs
}

function codeSpanEnd(s: string, at: number, runs: Map<number, number[]>): number {
  let end = at
  while (s[end] === '`') end++
  const starts = runs.get(end - at) ?? []
  let low = 0
  for (let high = starts.length; low < high;) {
    const middle = (low + high) >>> 1
    if (starts[middle] < end) low = middle + 1
    else high = middle
  }
  return low < starts.length ? starts[low] + (end - at) : end
}

function definitionAt(s: string, at: number): { open: number; close: number; dest: Destination; end: number } | null {
  DEFINITION.lastIndex = at
  if (!DEFINITION.test(s)) return null
  const open = DEFINITION.lastIndex - 1
  let close = open + 1
  let named = false
  for (; close < s.length && close - open <= MAX_LABEL; close++) {
    const c = s[close]
    if (c === '[') return null
    if (c === ']') break
    if (c === '\\') close++
    if (c.trim()) named = true
  }
  if (s[close] !== ']' || s[close + 1] !== ':' || !named) return null
  const dest = destinationAt(s, skipSpace(s, close + 2))
  if (!dest) return null
  let k = dest.end
  while (s[k] === ' ' || s[k] === '\t') k++
  if (k === s.length || s[k] === '\n') return { open, close, dest, end: dest.end }
  if (k === dest.end || !`"'(`.includes(s[k])) return null
  let end = titleEnd(s, k)
  while (s[end] === ' ' || s[end] === '\t') end++
  return { open, close, dest, end: end > k && (end === s.length || s[end] === '\n') ? end : dest.end }
}

function linkTail(s: string, from: number, image: boolean): { dest: Destination; end: number } | null {
  const dest = destinationAt(s, skipSpace(s, from))
  if (!dest) return null
  IMAGE_SIZE.lastIndex = dest.end
  const sized = image && IMAGE_SIZE.test(s) ? IMAGE_SIZE.lastIndex : dest.end
  let k = skipSpace(s, sized)
  if (k > sized) k = skipSpace(s, titleEnd(s, k))
  return { dest, end: s[k] === ')' ? k + 1 : -1 }
}

function skipSpace(s: string, from: number): number {
  let k = from
  while (s[k] === ' ' || s[k] === '\t') k++
  if (s[k] !== '\n') return k
  k++
  while (s[k] === ' ' || s[k] === '\t') k++
  return k
}

function destinationAt(s: string, at: number): Destination | null {
  if (s[at] === '<') {
    let k = at + 1
    while (k < s.length && s[k] !== '>' && s[k] !== '<' && s[k] !== '\n') k += s[k] === '\\' ? 2 : 1
    if (s[k] === '>') return { start: at, end: k + 1, raw: s.slice(at + 1, k) }
  }
  let k = at
  for (let depth = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    if (c <= 0x20 || c === 0x7f) break
    if (c === 0x5c && ESCAPABLE.test(s[k + 1] ?? '') && s[k + 1] !== '\n') k++
    else if (c === 0x28) depth++
    else if (c === 0x29 && depth-- === 0) break
  }
  return k > at ? { start: at, end: k, raw: s.slice(at, k) } : null
}

function titleEnd(s: string, at: number): number {
  const opener = s[at] ?? ''
  if (!opener || !`"'(`.includes(opener)) return at
  const closer = opener === '(' ? ')' : opener
  for (let k = at + 1; k < s.length; k++) {
    if (s[k] === '\\') k++
    else if (s[k] === closer) return k + 1
    else if (opener === '(' && s[k] === '(') return at
  }
  return at
}

function unescapeHref(raw: string): string {
  return raw.replace(HREF_ESCAPE, (entity, punctuation: string | undefined) => punctuation ?? decode(entity))
}

function encodeHref(url: string): string {
  return url.replace(HREF_UNSAFE, c => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))
}

function resolved(href: string, ctx: Context): string {
  const url = ctx.resolve(href)
  return SECURE.test(url) ? encodeHref(url) : ''
}

function joinGuard(s: string, start: number): string {
  return GLUES.test(s[start - 1] ?? '') ? NO_JOIN : ''
}

function removedTag(s: string, start: number, end: number): string {
  if (joinGuard(s, start)) return NO_JOIN
  const lineStart = s.lastIndexOf('\n', start - 1) + 1
  const atLineStart = !s.slice(lineStart, start).trim()
  return atLineStart && !LETTER.test(s[end] ?? '') ? NO_JOIN : ''
}

function tagImage(tag: string, ctx: Context): { label: string; target: string } {
  const attributes = new Map<string, string>()
  for (const found of tag.matchAll(ATTRIBUTE_VALUE)) {
    const name = found[1].toLowerCase()
    if (!attributes.has(name)) attributes.set(name, decode(found[2] ?? found[3] ?? found[4] ?? ''))
  }
  const src = (attributes.get('src') ?? '').trim()
  const alt = escapeText((attributes.get('alt') ?? '').replace(/\s+/g, ' ').trim())
  const target = KEEP_IMAGE.test(src) ? encodeHref(src) : resolved(src, ctx)
  return { label: imageLabel(alt, src), target }
}

function imageLabel(alt: string, src: string): string {
  return imageLink(alt.trim() ? alt : escapeText(fileName(src)))
}

function fileName(src: string): string {
  const name = decodedOrRaw(src.split(/[?#]/)[0].split('/').pop() ?? '')
  return FILE_NAME.test(name) ? name : IMAGE_ALT
}

function decodedOrRaw(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
