import { MAX_LINE_CHARS, type FileRef } from './pipelines'

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s+/
const MARKER = /^##\[[^\]]*\]/
const URL_TEXT = /https?:\/\/\S*/gi
const COMPILER = /^(\S.*?)\((\d{1,9})(?:,\s*(\d{1,9}))?\)\s*:\s*(?:error|warning)\b/
const PATH_LINE = /((?:[A-Za-z]:[\\/])?[^\s:"'<>|*?()[\]{}=,;]+):(\d{1,9})(?::(\d{1,9}))?(?![\w/\\])/g
const PYTHON_FRAME = /File "([^"]+)", line (\d{1,9})/
const SEPARATOR = /[\\/]/
const EXTENSION = /\.[A-Za-z][\w+-]*$/
const DOCKERFILE = /^Dockerfile/
const BACKSLASH = /\\/g
const DRIVE = /^[A-Za-z]:/
const LEADING_SEPARATORS = /^(?:\.?\/)+/

export const MAX_CANDIDATES = 12

export function fileRefOf(text: string): FileRef | null {
  const line = text
    .slice(0, MAX_LINE_CHARS)
    .replace(TIMESTAMP, '')
    .replace(MARKER, '')
    .replace(URL_TEXT, ' ')
    .trim()
  return compilerRef(line) ?? pathLineRef(line) ?? pythonRef(line)
}

function compilerRef(line: string): FileRef | null {
  const match = COMPILER.exec(line)
  return match ? ref(match[1], match[2], match[3]) : null
}

function pathLineRef(line: string): FileRef | null {
  for (const match of line.matchAll(PATH_LINE)) {
    if (looksLikeFile(match[1])) return ref(match[1], match[2], match[3])
  }
  return null
}

function pythonRef(line: string): FileRef | null {
  const match = PYTHON_FRAME.exec(line)
  return match ? ref(match[1], match[2], undefined) : null
}

function looksLikeFile(path: string): boolean {
  const name = path.split(SEPARATOR).pop() ?? ''
  return DOCKERFILE.test(name) || EXTENSION.test(name)
}

function ref(path: string, line: string, column: string | undefined): FileRef {
  return { path, line: positive(line), column: positive(column) }
}

function positive(digits: string | undefined): number | null {
  const value = Number(digits)
  return value > 0 ? value : null
}

export function pathCandidates(path: string, max = MAX_CANDIDATES): string[] {
  const segments = path.replace(BACKSLASH, '/').replace(DRIVE, '').replace(LEADING_SEPARATORS, '').split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return []
  return Array.from({ length: Math.min(segments.length, max) }, (_, start) => segments.slice(start).join('/'))
}
