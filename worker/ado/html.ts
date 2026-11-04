const SUFFIX = '\n\n… open in Azure DevOps for the rest'
const DROPPED = new Set(['script', 'style', 'head'])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }
const MAX_TAG = 2048
const MAX_INDENT = 8
const TAG = /<(?:(\/?)([a-z][a-z0-9]*)|[!?])/iy
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

interface Span { tag: string; open: string; close: string; block: boolean }

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|nbsp));/gi, (_, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()]
    const code = dec ? Number(dec) : parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
  })
}

function tagEnd(html: string, from: number): number {
  const limit = Math.min(html.length, from + MAX_TAG)
  let quote = ''
  for (let i = from + 1; i < limit; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

function skipElement(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\b`, 'gi')
  close.lastIndex = from
  const found = close.exec(html)
  if (!found) return html.length
  const end = tagEnd(html, found.index)
  return end === -1 ? html.length : end + 1
}

function linkTarget(attrs: string): string | null {
  const found = HREF.exec(attrs)
  const href = decode(found?.[1] ?? found?.[2] ?? found?.[3] ?? '').trim()
  if (!/^(https?:|mailto:)/i.test(href)) return null
  return href.replace(/[\s()<>]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))
}

function cap(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown
  let cut = markdown.lastIndexOf('\n', maxChars - 1)
  if (cut <= 0) {
    cut = maxChars
    const before = markdown.charCodeAt(cut - 1)
    if (before >= 0xd800 && before <= 0xdbff) cut--
  }
  return markdown.slice(0, cut).trimEnd() + SUFFIX
}

export function htmlToMarkdown(html: string | null | undefined, opts: { maxChars: number; itemUrl: string }): string {
  if (typeof html !== 'string' || !html) return ''
  const source = html.replace(/\r\n?/g, '\n')
  const parts: string[] = []
  const spans: Span[] = []
  const lists: { ordered: boolean; n: number }[] = []
  let flushed = 0
  let last = ''
  let trailingNewlines = 2
  let atMarker = false
  let pre: string | null = null

  const push = (text: string) => {
    if (!text) return
    parts.push(text)
    atMarker = false
    last = text[text.length - 1]
    let k = text.length
    while (k > 0 && text[k - 1] === '\n') k--
    trailingNewlines = Math.min(2, k === 0 ? trailingNewlines + text.length : text.length - k)
  }
  const breakTo = (n: 1 | 2) => {
    if (atMarker || trailingNewlines >= n) return
    push('\n'.repeat(n - trailingNewlines))
  }
  const openSpans = () => {
    for (; flushed < spans.length; flushed++) {
      if (spans[flushed].block) breakTo(2)
      push(spans[flushed].open)
    }
  }
  const text = (raw: string) => {
    if (pre !== null) {
      pre += decode(raw)
      return
    }
    const decoded = decode(raw.replace(/\s+/g, ' '))
    if (decoded.trim() === '') {
      if (!atMarker && trailingNewlines === 0 && last !== ' ') push(' ')
      return
    }
    openSpans()
    push(atMarker || trailingNewlines > 0 ? decoded.trimStart() : decoded)
  }
  const closeSpansTo = (index: number) => {
    for (let k = spans.length - 1; k >= index; k--) {
      if (k >= flushed) continue
      push(spans[k].close)
      if (spans[k].block) breakTo(2)
    }
    spans.length = Math.min(spans.length, index)
    flushed = Math.min(flushed, index)
  }
  const endPre = () => {
    const code = (pre ?? '').replace(/^\n+/, '').trimEnd()
    pre = null
    if (!code) return
    let fence = '```'
    while (code.includes(fence)) fence += '`'
    breakTo(2)
    push(`${fence}\n${code}\n${fence}`)
    breakTo(2)
  }
  const openTag = (name: string, attrs: string) => {
    if (pre !== null) {
      if (name === 'br') pre += '\n'
      return
    }
    const gap = lists.length > 0 ? 1 : 2
    if (name === 'p' || name === 'div') breakTo(gap)
    else if (name === 'br') push('\n')
    else if (name === 'b' || name === 'strong') spans.push({ tag: name, open: '**', close: '**', block: false })
    else if (name === 'i' || name === 'em') spans.push({ tag: name, open: '*', close: '*', block: false })
    else if (name === 'code') spans.push({ tag: name, open: '`', close: '`', block: false })
    else if (/^h[1-4]$/.test(name)) spans.push({ tag: name, open: '#'.repeat(Number(name[1])) + ' ', close: '', block: true })
    else if (name === 'a') {
      const href = linkTarget(attrs)
      spans.push({ tag: name, open: href ? '[' : '', close: href ? `](${href})` : '', block: false })
    } else if (name === 'ul' || name === 'ol') {
      breakTo(gap)
      lists.push({ ordered: name === 'ol', n: 0 })
    } else if (name === 'li') {
      breakTo(1)
      const list = lists[lists.length - 1]
      const bullet = list?.ordered ? `${++list.n}.` : '-'
      push(`${'  '.repeat(Math.min(Math.max(lists.length - 1, 0), MAX_INDENT))}${bullet} `)
      atMarker = true
    } else if (name === 'pre') pre = ''
    else if (name === 'img') {
      openSpans()
      push(`[image](${opts.itemUrl})`)
    }
  }
  const closeTag = (name: string) => {
    if (pre !== null) {
      if (name === 'pre') endPre()
      return
    }
    if (name === 'p' || name === 'div') breakTo(lists.length > 0 ? 1 : 2)
    else if (name === 'ul' || name === 'ol') {
      lists.pop()
      breakTo(lists.length > 0 ? 1 : 2)
    } else if (name === 'li') breakTo(1)
    else {
      for (let k = spans.length - 1; k >= 0; k--) {
        if (spans[k].tag !== name) continue
        closeSpansTo(k)
        break
      }
    }
  }

  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      text(source.slice(i))
      break
    }
    if (lt > i) text(source.slice(i, lt))
    i = lt
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end === -1 ? source.length : end + 3
      continue
    }
    TAG.lastIndex = i
    const tag = TAG.exec(source)
    const end = tag ? tagEnd(source, i) : -1
    if (!tag || end === -1) {
      text('<')
      i++
      continue
    }
    const name = tag[2]?.toLowerCase()
    i = end + 1
    if (!name) continue
    if (tag[1]) closeTag(name)
    else if (DROPPED.has(name)) i = skipElement(source, name, i)
    else openTag(name, source.slice(tag.index + tag[0].length, end))
  }
  if (pre !== null) endPre()
  closeSpansTo(0)

  const markdown = parts.join('').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return cap(markdown, opts.maxChars)
}
