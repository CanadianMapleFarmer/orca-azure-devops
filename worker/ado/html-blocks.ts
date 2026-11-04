import { REST_IN_ADO } from '../messages'

const SUFFIX = `\n\n${REST_IN_ADO}`

function openFence(markdown: string): string {
  let open = ''
  for (const line of markdown.split('\n')) {
    const fence = line.trim()
    if (!/^`{3,}$/.test(fence)) continue
    if (!open) open = fence
    else if (fence.length >= open.length) open = ''
  }
  return open
}

export function capMarkdown(markdown: string, maxChars: number, inputCut = false): string {
  if (markdown.length <= maxChars) return inputCut ? withRestNote(markdown) : markdown
  let cut = markdown.lastIndexOf('\n', maxChars - 1)
  if (cut <= 0) {
    cut = maxChars
    const before = markdown.charCodeAt(cut - 1)
    if (before >= 0xd800 && before <= 0xdbff) cut--
  }
  return withRestNote(markdown.slice(0, cut).trimEnd())
}

function withRestNote(head: string): string {
  const fence = openFence(head)
  return head + (fence ? `\n${fence}` : '') + SUFFIX
}

export function fenceFor(content: string, min: number): string {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(min, longest + 1))
}

export function inlineCode(raw: string): string {
  const content = raw.replace(/\s+/g, ' ').trim()
  if (!content) return ''
  const fence = fenceFor(content, 1)
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${content}${pad}${fence}`
}

export function collapseSpace(space: string): string {
  if (!space) return ''
  let newlines = 0
  for (let i = space.indexOf('\n'); i !== -1 && newlines < 2; i = space.indexOf('\n', i + 1)) newlines++
  return newlines ? '\n'.repeat(newlines) : ' '
}

export function cellText(raw: string): string {
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).join(' ').replace(/\|/g, '\\|')
}

export function tableRow(cells: string[], header: boolean): string {
  const row = `| ${cells.join(' | ')} |`
  return header ? `${row}\n| ${cells.map(() => '---').join(' | ')} |` : row
}
