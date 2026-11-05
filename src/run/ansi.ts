export interface Span {
  text: string
  classes: string[]
}

interface Style {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  fg: number | null
  bg: number | null
}

const SEQUENCE =
  /(?:\x1b\[|\u009b)([0-?]*)([ -/]*)([@-~]?)|(?:\x1b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\x07|\x1b\\|\u009c|$)|\x1b[ -/]*[0-~]?|[\x00-\x08\x0a-\x1f\x7f-\u009f]/g
const NOISE = /[\x00-\x08\x0a-\x1f\x7f-\u009f]/
const SGR_PARAMS = /^[\d;:]*$/
const SGR_FINAL = 'm'
const EXTENDED_COLOURS = new Set([38, 48, 58])
const PALETTE_COLOUR = 5
const RGB_COLOUR = 2

const PLAIN: Style = { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null }

export function plainText(line: string): string {
  return NOISE.test(line) ? line.replace(SEQUENCE, '') : line
}

export function ansiSpans(line: string): Span[] {
  if (!NOISE.test(line)) return line ? [{ text: line, classes: [] }] : []
  const spans: Span[] = []
  let style = PLAIN
  let at = 0
  for (const match of line.matchAll(SEQUENCE)) {
    push(spans, line.slice(at, match.index), style)
    at = match.index + match[0].length
    if (match[3] === SGR_FINAL && match[2] === '' && SGR_PARAMS.test(match[1])) style = applySgr(style, match[1])
  }
  push(spans, line.slice(at), style)
  return spans
}

function push(spans: Span[], text: string, style: Style): void {
  if (!text) return
  const classes = classesOf(style)
  const last = spans[spans.length - 1]
  if (last && last.classes.join(' ') === classes.join(' ')) last.text += text
  else spans.push({ text, classes })
}

function classesOf(style: Style): string[] {
  const classes: string[] = []
  if (style.bold) classes.push('b')
  if (style.dim) classes.push('dim')
  if (style.italic) classes.push('i')
  if (style.underline) classes.push('u')
  if (style.fg !== null) classes.push(`fg-${style.fg}`)
  if (style.bg !== null) classes.push(`bg-${style.bg}`)
  return classes
}

function applySgr(current: Style, params: string): Style {
  const style = { ...current }
  const codes = params.split(';')
  for (let index = 0; index < codes.length; index += 1) {
    const token = codes[index]
    if (token.includes(':')) continue
    const code = token === '' ? 0 : Number(token)
    if (EXTENDED_COLOURS.has(code)) {
      const kind = Number(codes[index + 1])
      index += kind === PALETTE_COLOUR ? 2 : kind === RGB_COLOUR ? 4 : 0
      continue
    }
    applyCode(style, code)
  }
  return style
}

function applyCode(style: Style, code: number): void {
  if (code === 0) Object.assign(style, PLAIN)
  else if (code === 1) style.bold = true
  else if (code === 2) style.dim = true
  else if (code === 3) style.italic = true
  else if (code === 4) style.underline = true
  else if (code === 22) style.bold = style.dim = false
  else if (code === 23) style.italic = false
  else if (code === 24) style.underline = false
  else if (code >= 30 && code <= 37) style.fg = code - 30
  else if (code === 39) style.fg = null
  else if (code >= 40 && code <= 47) style.bg = code - 40
  else if (code === 49) style.bg = null
  else if (code >= 90 && code <= 97) style.fg = code - 90 + 8
  else if (code >= 100 && code <= 107) style.bg = code - 100 + 8
}
