const SUFFIX = '\n\n… open in Azure DevOps for the rest'

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

export function capMarkdown(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown
  let cut = markdown.lastIndexOf('\n', maxChars - 1)
  if (cut <= 0) {
    cut = maxChars
    const before = markdown.charCodeAt(cut - 1)
    if (before >= 0xd800 && before <= 0xdbff) cut--
  }
  const head = markdown.slice(0, cut).trimEnd()
  const fence = openFence(head)
  return head + (fence ? `\n${fence}` : '') + SUFFIX
}

export function cellText(raw: string): string {
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).join(' ').replace(/\|/g, '\\|')
}

export function tableRow(cells: string[], header: boolean): string {
  const row = `| ${cells.join(' | ')} |`
  return header ? `${row}\n| ${cells.map(() => '---').join(' | ')} |` : row
}
