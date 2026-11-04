import { capMarkdown, cellText, collapseSpace, fenceFor, inlineCode, tableRow } from './html-blocks'
import { decode, escapeText, linkTarget, skipElement, tagEnd, truncateHtml } from './html-text'

const DROPPED = new Set(['script', 'style', 'head'])
const BLOCK = new Set(['p', 'div', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'pre', 'h1', 'h2', 'h3', 'h4'])
const MAX_INDENT = 24
const MAX_INPUT = 512 * 1024
const TAG = /<(?:(\/?)([a-z][a-z0-9]*)|[!?])/iy

interface Span { tag: string; open: string; close: string; block: boolean }

export function htmlToMarkdown(html: string | null | undefined, opts: { maxChars: number; itemUrl: string }): string {
  if (typeof html !== 'string' || !html) return ''
  const source = truncateHtml(html, MAX_INPUT).replace(/\r\n?/g, '\n')
  const parts: string[] = []
  const spans: Span[] = []
  const lists: { ordered: boolean; n: number; indent: number; width: number }[] = []
  let row: { cells: string[]; header: boolean } | null = null
  let cell: { start: number; spans: number; lists: number; last: string; newlines: number; marker: boolean } | null = null
  let tableDepth = 0
  let tableRows = 0
  let flushed = 0
  let last = ''
  let trailingNewlines = 2
  let atMarker = false
  let pre: string | null = null
  let inCode = false
  const openCount = new Map<string, number>()

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
    const decoded = escapeText(decode(raw.replace(/\s+/g, ' ')))
    const spaceBefore = !atMarker && trailingNewlines === 0 && last !== ' '
    if (decoded.trim() === '') {
      if (spaceBefore) push(' ')
      return
    }
    const body = decoded.trimStart()
    if (spaceBefore && body.length < decoded.length) push(' ')
    openSpans()
    push(body)
  }
  const addSpan = (tag: string, open: string, close: string, block = false) => {
    spans.push({ tag, open, close, block })
    openCount.set(tag, (openCount.get(tag) ?? 0) + 1)
  }
  const takeTrailingSpace = () => {
    const floor = cell?.start ?? 0
    let k = parts.length
    while (k > floor && /^\s*$/.test(parts[k - 1])) k--
    const tail = k > floor ? parts[k - 1] : ''
    const kept = tail.trimEnd()
    if (kept.endsWith('`') && /^\s*`{3,}$/.test(kept.slice(kept.lastIndexOf('\n') + 1))) return ''
    const moved = tail.slice(kept.length) + parts.splice(k).join('')
    if (k > floor) parts[k - 1] = kept
    return collapseSpace(moved)
  }
  const closeSpansTo = (index: number) => {
    for (let k = spans.length - 1; k >= index; k--) {
      const span = spans[k]
      openCount.set(span.tag, (openCount.get(span.tag) ?? 1) - 1)
      if (k >= flushed) continue
      const moved = span.close && !span.block ? takeTrailingSpace() : ''
      push(span.close)
      push(moved)
      if (span.block) breakTo(2)
    }
    spans.length = Math.min(spans.length, index)
    flushed = Math.min(flushed, index)
  }
  const endCell = () => {
    if (!cell || !row) return
    closeSpansTo(cell.spans)
    const raw = parts.splice(cell.start).join('')
    lists.length = Math.min(lists.length, cell.lists)
    ;({ last, newlines: trailingNewlines, marker: atMarker } = cell)
    row.cells.push(cellText(raw))
    cell = null
  }
  const endRow = () => {
    endCell()
    if (row?.cells.length) {
      breakTo(1)
      push(tableRow(row.cells, tableRows === 0 && row.header))
      tableRows++
    }
    row = null
  }
  const endPre = () => {
    const code = (pre ?? '').replace(/^\n+/, '').trimEnd()
    pre = null
    if (!code) return
    const list = lists[lists.length - 1]
    const pad = list ? ' '.repeat(list.indent + list.width) : ''
    const fence = fenceFor(code, 3)
    const first = atMarker ? '' : pad
    breakTo(list ? 1 : 2)
    push(first + [fence, ...code.split('\n'), fence].join(`\n${pad}`))
    breakTo(list ? 1 : 2)
  }
  const endCode = () => {
    const code = inlineCode(pre ?? '')
    pre = null
    inCode = false
    if (!code) return
    openSpans()
    push(last === '`' ? ` ${code}` : code)
  }
  const endsCode = (name: string) => name === 'code' || BLOCK.has(name)
  const openTag = (name: string, attrs: string) => {
    if (inCode && endsCode(name)) endCode()
    if (pre !== null) {
      if (name === 'br') pre += '\n'
      return
    }
    const gap = lists.length > 0 ? 1 : 2
    if (name === 'p' || name === 'div') breakTo(gap)
    else if (name === 'br') push('\n')
    else if (name === 'b' || name === 'strong') addSpan(name, '**', '**')
    else if (name === 'i' || name === 'em') addSpan(name, '*', '*')
    else if (name === 'code') {
      pre = ''
      inCode = true
    } else if (/^h[1-4]$/.test(name)) addSpan(name, '#'.repeat(Number(name[1])) + ' ', '', true)
    else if (name === 'a') {
      const href = linkTarget(attrs)
      addSpan(name, href ? '[' : '', href ? `](${href})` : '')
    } else if (name === 'ul' || name === 'ol') {
      breakTo(gap)
      const parent = lists[lists.length - 1]
      const indent = parent ? Math.min(parent.indent + parent.width, MAX_INDENT) : 0
      lists.push({ ordered: name === 'ol', n: 0, indent, width: 2 })
    } else if (name === 'li') {
      if (atMarker) push('\n')
      else breakTo(1)
      if (lists.length === 0) lists.push({ ordered: false, n: 0, indent: 0, width: 2 })
      const list = lists[lists.length - 1]
      const marker = list.ordered ? `${++list.n}.` : '-'
      list.width = marker.length + 1
      push(`${' '.repeat(list.indent)}${marker} `)
      atMarker = true
    } else if (name === 'table') {
      if (tableDepth++ === 0) tableRows = 0
      breakTo(2)
    } else if (tableDepth === 1 && name === 'tr') {
      endRow()
      row = { cells: [], header: false }
    } else if (tableDepth === 1 && (name === 'td' || name === 'th')) {
      endCell()
      row ??= { cells: [], header: false }
      row.header ||= name === 'th'
      cell = { start: parts.length, spans: spans.length, lists: lists.length, last, newlines: trailingNewlines, marker: atMarker }
      trailingNewlines = 2
      atMarker = false
    } else if (name === 'pre') pre = ''
    else if (name === 'img') {
      openSpans()
      push(`[image](${opts.itemUrl})`)
    }
  }
  const closeTag = (name: string) => {
    if (inCode && endsCode(name)) {
      endCode()
      if (name === 'code') return
    }
    if (pre !== null) {
      if (name === 'pre') endPre()
      return
    }
    if (name === 'p' || name === 'div') breakTo(lists.length > 0 ? 1 : 2)
    else if (name === 'ul' || name === 'ol') {
      lists.pop()
      breakTo(lists.length > 0 ? 1 : 2)
    } else if (name === 'li') breakTo(1)
    else if (name === 'table') {
      if (tableDepth > 0 && --tableDepth === 0) endRow()
      breakTo(2)
    } else if (tableDepth === 1 && name === 'tr') endRow()
    else if (tableDepth === 1 && (name === 'td' || name === 'th')) endCell()
    else if (openCount.get(name)) {
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
    if (!tag) {
      text('<')
      i++
      continue
    }
    const end = tagEnd(source, i)
    if (end === -1) break
    const name = tag[2]?.toLowerCase()
    i = end + 1
    if (!name) continue
    if (tag[1]) closeTag(name)
    else if (DROPPED.has(name)) i = skipElement(source, name, i)
    else openTag(name, source.slice(tag.index + tag[0].length, end))
  }
  if (inCode) endCode()
  else if (pre !== null) endPre()
  endRow()
  closeSpansTo(0)

  const markdown = parts.join('').split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return capMarkdown(markdown, opts.maxChars, html.length > MAX_INPUT)
}
