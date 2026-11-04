const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
}
const ENTITY = new RegExp(`&(?:#(\\d+)|#x([0-9a-f]+)|(${Object.keys(NAMED).join('|')}));`, 'gi')
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const MAX_QUOTED_TAG = 2048

export function decode(text: string): string {
  return text.replace(ENTITY, (_, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()]
    const code = dec ? Number(dec) : parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
  })
}

export function escapeText(text: string): string {
  return text.replace(/[\\<[\]`]/g, '\\$&')
}

export function tagEnd(html: string, from: number): number {
  const limit = Math.min(html.length, from + MAX_QUOTED_TAG)
  let quote = ''
  for (let i = from + 1; i < limit; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return html.indexOf('>', from)
}

export function skipElement(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\b`, 'gi')
  close.lastIndex = from
  const found = close.exec(html)
  if (!found) return html.length
  const end = tagEnd(html, found.index)
  return end === -1 ? html.length : end + 1
}

export function linkTarget(attrs: string): string | null {
  const found = HREF.exec(attrs)
  const href = decode(found?.[1] ?? found?.[2] ?? found?.[3] ?? '').trim()
  if (!/^(https?:|mailto:)/i.test(href)) return null
  return href.replace(/[\s()<>]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))
}
