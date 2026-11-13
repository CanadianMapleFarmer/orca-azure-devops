import { linkTo, safeHref } from './links'

export { safeHref }

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Block[][] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: Inline[][] | null; rows: Inline[][][] }

type Wrapped = Extract<Inline, { children: Inline[] }>
type BlockOf<K extends Block['kind']> = Extract<Block, { kind: K }>

interface Frame { link: boolean; count: number; children: Inline[]; links: number }

const PLAIN = /[^\\`*[\]\n]+/y
const PUNCTUATION = /^[!-\/:-@[-`{-~]$/
const SPACE = /\s/
const MARKER = /^(-|\d{1,9}\.)(?: +|$)/
const HEADING = /^(#{1,4}) (.*)$/
const FENCE = /^(`{3,})[^`]*$/
const DELIMITER = /^:?-+:?$/
const MAX_NESTING = 16

export function parseInline(text: string): Inline[] {
  const root: Inline[] = []
  const frames: Frame[] = []
  const linkFrames: number[] = []
  const missingCode = new Set<number>()
  let ends: Int32Array | null = null
  let links = 0
  let buffer = ''

  const target = () => frames[frames.length - 1]?.children ?? root
  const flush = () => {
    if (buffer) add(target(), { kind: 'text', text: buffer })
    buffer = ''
  }
  const push = (run: Inline) => {
    flush()
    add(target(), run)
  }
  const unwind = (into: Inline[], from: number) => {
    for (const frame of frames.splice(from)) {
      add(into, { kind: 'text', text: frame.link ? '[' : '*'.repeat(frame.count) })
      for (const run of frame.children) add(into, run)
    }
  }

  const codeSpan = (start: number): number => {
    const length = runLength(text, start, '`')
    const close = missingCode.has(length) ? -1 : closingRun(text, start + length, length)
    if (close === -1) {
      missingCode.add(length)
      buffer += '`'.repeat(length)
      return start + length
    }
    push({ kind: 'code', text: codeText(text.slice(start + length, close)) })
    return close + length
  }

  const emphasis = (start: number): number => {
    const end = start + runLength(text, start, '*')
    let count = end - start
    const canOpen = end < text.length && !SPACE.test(text[end])
    const canClose = start > 0 && !SPACE.test(text[start - 1])
    while (canClose && count > 0) {
      const top = frames[frames.length - 1]
      const opensBold = canOpen && count === 2 && top?.count === 1 && runLength(text, text.indexOf('*', end), '*') >= 2
      const take = top && !top.link && !opensBold ? closes(top.count, count) : 0
      if (!take) break
      flush()
      const run: Inline = { kind: take === 2 ? 'strong' : 'em', children: top.children }
      top.count -= take
      count -= take
      if (top.count > 0) top.children = [run]
      else {
        frames.pop()
        add(target(), run)
      }
    }
    if (count > 0 && canOpen) {
      flush()
      frames.push({ link: false, count, children: [], links })
    } else buffer += '*'.repeat(count)
    return end
  }

  const openLink = (start: number): number => {
    flush()
    frames.push({ link: true, count: 0, children: [], links })
    linkFrames.push(frames.length - 1)
    return start + 1
  }

  const closeLink = (start: number): number => {
    const index = linkFrames[linkFrames.length - 1]
    const end = index !== undefined && text[start + 1] === '(' ? (ends ??= destinations(text))[start + 1] : -1
    if (index === undefined || end === -1 || frames[index].links !== links) {
      buffer += ']'
      return start + 1
    }
    flush()
    const frame = frames[index]
    unwind(frame.children, index + 1)
    frames.pop()
    linkFrames.pop()
    links++
    add(target(), { kind: 'link', href: text.slice(start + 2, end), children: frame.children })
    return end + 1
  }

  let i = 0
  while (i < text.length) {
    PLAIN.lastIndex = i
    const plain = PLAIN.exec(text)
    if (plain) {
      buffer += plain[0]
      i = PLAIN.lastIndex
      continue
    }
    const char = text[i]
    if (char === '\\') {
      const escaped = PUNCTUATION.test(text[i + 1] ?? '')
      buffer += escaped ? text[i + 1] : char
      i += escaped ? 2 : 1
    } else if (char === '\n') {
      push({ kind: 'break' })
      i++
    } else if (char === '`') i = codeSpan(i)
    else if (char === '*') i = emphasis(i)
    else if (char === '[') i = openLink(i)
    else i = closeLink(i)
  }
  flush()
  unwind(root, 0)
  return root
}

function closes(open: number, close: number): number {
  if (open === 1) return 1
  if (close >= 2) return 2
  return open === 2 ? 0 : 1
}

function add(runs: Inline[], run: Inline): void {
  const last = runs[runs.length - 1]
  if (run.kind === 'text' && last?.kind === 'text') last.text += run.text
  else runs.push(run)
}

function runLength(text: string, start: number, char: string): number {
  let end = start
  while (text[end] === char) end++
  return end - start
}

function closingRun(text: string, from: number, length: number): number {
  for (let at = text.indexOf('`', from); at !== -1; ) {
    const run = runLength(text, at, '`')
    if (run === length) return at
    at = text.indexOf('`', at + run)
  }
  return -1
}

function codeText(raw: string): string {
  const code = raw.replace(/\n/g, ' ')
  return code.startsWith(' ') && code.endsWith(' ') && code.trim() ? code.slice(1, -1) : code
}

function destinations(text: string): Int32Array {
  const ends = new Int32Array(text.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) i++
    else if (char === '(') open.push(i)
    else if (char === ')') {
      const at = open.pop()
      if (at !== undefined) ends[at] = i
    } else if (SPACE.test(char)) open.length = 0
  }
  return ends
}

interface ListFrame { block: BlockOf<'list'>; marker: number; content: number }
interface OpenFence { block: BlockOf<'code'>; indent: number; length: number; lines: string[] }

class BlockReader {
  readonly root: Block[] = []
  private lists: ListFrame[] = []
  private paragraph: { block: BlockOf<'paragraph'>; lines: string[] } | null = null
  private table: { block: BlockOf<'table'>; lines: string[] } | null = null
  private fence: OpenFence | null = null

  read(line: string): void {
    if (this.fence) return this.readCode(line, this.fence)
    const rest = line.trimStart()
    if (!rest) return this.closeText()
    if (this.paragraph && !this.interrupts(rest)) return void this.paragraph.lines.push(rest)
    if (this.table && rest.startsWith('|')) return void this.table.lines.push(rest)
    this.closeText()
    const indent = line.length - rest.length
    while (this.lists.length > 0) {
      const top = this.lists[this.lists.length - 1]
      if (indent >= top.content || (indent >= top.marker && MARKER.test(rest))) break
      this.lists.pop()
    }
    this.start(rest, indent)
  }

  end(): Block[] {
    this.closeText()
    if (this.fence) this.fence.block.text = this.fence.lines.join('\n')
    return this.root
  }

  private interrupts(rest: string): boolean {
    return FENCE.test(rest) || (this.lists.length > 0 && MARKER.test(rest))
  }

  private readCode(line: string, fence: OpenFence): void {
    const trimmed = line.trim()
    if (trimmed.length < fence.length || /[^`]/.test(trimmed)) return void fence.lines.push(dedent(line, fence.indent))
    fence.block.text = fence.lines.join('\n')
    this.fence = null
  }

  private closeText(): void {
    if (this.paragraph) this.paragraph.block.children = parseInline(this.paragraph.lines.join('\n'))
    if (this.table) Object.assign(this.table.block, tableOf(this.table.lines))
    this.paragraph = null
    this.table = null
  }

  private container(): Block[] {
    const top = this.lists[this.lists.length - 1]
    return top ? top.block.items[top.block.items.length - 1] : this.root
  }

  private start(content: string, column: number): void {
    for (let marker = MARKER.exec(content); marker && this.item(marker[1], column); marker = MARKER.exec(content)) {
      column += marker[0].length
      content = content.slice(marker[0].length)
    }
    if (!content) return
    const fence = FENCE.exec(content)
    const heading = HEADING.exec(content)
    if (fence) {
      const block: BlockOf<'code'> = { kind: 'code', text: '' }
      this.fence = { block, indent: column, length: fence[1].length, lines: [] }
      this.container().push(block)
    } else if (heading) {
      this.container().push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, children: parseInline(heading[2]) })
    } else if (content.startsWith('|')) {
      const block: BlockOf<'table'> = { kind: 'table', header: null, rows: [] }
      this.table = { block, lines: [content] }
      this.container().push(block)
    } else {
      const block: BlockOf<'paragraph'> = { kind: 'paragraph', children: [] }
      this.paragraph = { block, lines: [content] }
      this.container().push(block)
    }
  }

  private item(marker: string, column: number): boolean {
    const ordered = marker !== '-'
    const top = this.lists[this.lists.length - 1]
    const sibling = top !== undefined && column < top.content
    if (sibling && top.block.ordered === ordered) {
      top.block.items.push([])
      return true
    }
    if (!sibling && this.lists.length >= MAX_NESTING) return false
    if (sibling) this.lists.pop()
    const block: BlockOf<'list'> = { kind: 'list', ordered, items: [[]] }
    this.container().push(block)
    this.lists.push({ block, marker: column, content: column + marker.length + 1 })
    return true
  }
}

function dedent(line: string, indent: number): string {
  let cut = 0
  while (cut < indent && line[cut] === ' ') cut++
  return line.slice(cut)
}

function splitCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (let i = 1; i < line.length; i++) {
    const char = line[i]
    if (char === '\\' && i + 1 < line.length) {
      const next = line[++i]
      cell += next === '|' ? '|' : char + next
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  if (cell.trim()) cells.push(cell.trim())
  return cells
}

function tableOf(lines: string[]): Pick<BlockOf<'table'>, 'header' | 'rows'> {
  const cells = lines.map(splitCells)
  const hasHeader = cells.length > 1 && cells[1].length > 0 && cells[1].every(cell => DELIMITER.test(cell))
  const inline = (row: string[]) => row.map(cell => parseInline(cell))
  return { header: hasHeader ? inline(cells[0]) : null, rows: (hasHeader ? cells.slice(2) : cells).map(inline) }
}

export function parseBlocks(markdown: string): Block[] {
  const reader = new BlockReader()
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) reader.read(line)
  return reader.end()
}

export function renderRich(markdown: string, open: (url: string) => void): DocumentFragment {
  const fragment = document.createDocumentFragment()
  appendBlocks(fragment, parseBlocks(markdown), open)
  return fragment
}

interface BlockRun { parent: ParentNode; blocks: Block[]; next: number; tight: boolean }

function appendBlocks(parent: ParentNode, blocks: Block[], open: (url: string) => void): void {
  const pending: BlockRun[] = [{ parent, blocks, next: 0, tight: false }]
  while (pending.length > 0) {
    const top = pending[pending.length - 1]
    const index = top.next++
    const block = top.blocks[index]
    if (!block) pending.pop()
    else if (top.tight && index === 0 && block.kind === 'paragraph') appendInline(top.parent, block.children, open)
    else if (block.kind === 'list') pending.push(...listItems(top.parent, block).reverse())
    else top.parent.append(blockNode(block, open))
  }
}

function listItems(parent: ParentNode, block: BlockOf<'list'>): BlockRun[] {
  const list = document.createElement(block.ordered ? 'ol' : 'ul')
  const items = block.items.map(() => document.createElement('li'))
  list.append(...items)
  parent.append(list)
  return block.items.map((blocks, index) => ({ parent: items[index], blocks, next: 0, tight: true }))
}

function blockNode(block: Exclude<Block, { kind: 'list' }>, open: (url: string) => void): HTMLElement {
  if (block.kind === 'heading') return withInline(block.level <= 2 ? 'h4' : 'h5', block.children, open)
  if (block.kind === 'paragraph') return withInline('p', block.children, open)
  if (block.kind === 'code') {
    const pre = document.createElement('pre')
    pre.append(codeNode(block.text))
    return pre
  }
  const table = document.createElement('table')
  if (block.header) table.append(tableRow('th', block.header, open))
  for (const cells of block.rows) table.append(tableRow('td', cells, open))
  return table
}

function tableRow(tag: 'th' | 'td', cells: Inline[][], open: (url: string) => void): HTMLElement {
  const row = document.createElement('tr')
  for (const runs of cells) row.append(withInline(tag, runs, open))
  return row
}

function withInline(tag: 'h4' | 'h5' | 'p' | 'th' | 'td', runs: Inline[], open: (url: string) => void): HTMLElement {
  const node = document.createElement(tag)
  appendInline(node, runs, open)
  return node
}

function codeNode(text: string): HTMLElement {
  const code = document.createElement('code')
  code.append(document.createTextNode(text))
  return code
}

function appendInline(parent: ParentNode, runs: Inline[], open: (url: string) => void): void {
  const pending = [{ parent, runs, next: 0, depth: 0 }]
  while (pending.length > 0) {
    const top = pending[pending.length - 1]
    const run = top.runs[top.next++]
    if (!run) pending.pop()
    else if (run.kind === 'text') top.parent.append(document.createTextNode(run.text))
    else if (run.kind === 'break') top.parent.append(document.createElement('br'))
    else if (run.kind === 'code') top.parent.append(codeNode(run.text))
    else {
      const node = wrapper(run, top.depth, open)
      if (node) top.parent.append(node)
      pending.push({ parent: node ?? top.parent, runs: run.children, next: 0, depth: top.depth + 1 })
    }
  }
}

function wrapper(run: Wrapped, depth: number, open: (url: string) => void): HTMLElement | null {
  if (run.kind === 'link') return safeHref(run.href) ? linkTo(run.href, [], open) : null
  return depth < MAX_NESTING ? document.createElement(run.kind) : null
}
