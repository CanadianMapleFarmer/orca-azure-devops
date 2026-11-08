import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { badRequest, DRAFT_OUTSIDE, draftPathTaken } from '../messages'
import { TAB_FOLDER, type TabFileFs } from '../tab-files'

export const MAX_SEGMENT = 80
export const MAX_DRAFT_NAME = 200

export type DraftFs = TabFileFs & Pick<typeof import('node:fs/promises'), 'rm' | 'realpath' | 'lstat'>

const WIKI_FOLDER = 'wiki'
const READ_FOLDER = 'wiki-read'
const WIKI_DEPTH = 2
const BASE_FOLDER = '.base'
const THEIRS_FOLDER = '.theirs'
const EXTENSION = '.md'
const CUT_NAME = 188
const HASH_CHARS = 8
const UNSAFE = /[<>:"/\\|?*\p{Cc}\p{Cs}]/gu
const SPACES = /\s+/gu
const ENDS = /^[ .]+|[ .]+$/g
const TRAILING = /[ .]+$/
const NAME_TRAILING = /[ ./]+$/
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

export function fileSegment(text: string): string {
  const cleaned = text.normalize('NFC').replace(UNSAFE, '-').replace(SPACES, ' ').replace(ENDS, '')
  const segment = cutUnits(cleaned, MAX_SEGMENT).replace(TRAILING, '')
  if (segment === '') return '_'
  return DEVICE.test(segment) ? cutUnits(`_${segment}`, MAX_SEGMENT).replace(TRAILING, '') : segment
}

export function pageFileName(folder: string, org: string, wikiName: string, pagePath: string): string {
  const pages = pagePath.split('/')
  if (pages.length > 1 && pages[0] === '') pages.shift()
  const name = `${[folder, ...[org, wikiName, ...pages].map(fileSegment)].join('/')}${EXTENSION}`
  if (name.length <= MAX_DRAFT_NAME) return name
  const hash = createHash('sha256').update(JSON.stringify([org, wikiName, pagePath])).digest('hex').slice(0, HASH_CHARS)
  return `${cutUnits(name, CUT_NAME).replace(NAME_TRAILING, '')}~${hash}${EXTENSION}`
}

export function draftName(org: string, wikiName: string, pagePath: string): string {
  return pageFileName(WIKI_FOLDER, org, wikiName, pagePath)
}

export function readerName(org: string, wikiName: string, pagePath: string): string {
  return pageFileName(READ_FOLDER, org, wikiName, pagePath)
}

export function baseName(draft: string): string {
  return `${WIKI_FOLDER}/${BASE_FOLDER}/${insideWiki(draft)}`
}

export function theirsName(draft: string): string {
  return `${WIKI_FOLDER}/${THEIRS_FOLDER}/${insideWiki(draft)}`
}

export async function assertInside(fs: DraftFs, workspacePath: string, relative: string): Promise<string> {
  const segments = relative.split('/')
  if (path.isAbsolute(relative) || relative.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw badRequest(DRAFT_OUTSIDE)
  }
  const root = await fs.realpath(workspacePath)
  const parts = [TAB_FOLDER, ...segments]
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const target = path.join(root, ...parts.slice(0, depth))
    const stat = await fs.lstat(target).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (!stat) break
    const last = depth === parts.length
    if (last ? stat.isFile() : stat.isDirectory() && sameFile(await fs.realpath(target), target)) continue
    const wrongKind = last ? stat.isDirectory() : stat.isFile()
    if (wrongKind && depth > WIKI_DEPTH && parts[WIKI_DEPTH - 1] === WIKI_FOLDER) {
      throw badRequest(draftPathTaken(parts.slice(WIKI_DEPTH, depth).join('/')))
    }
    throw badRequest(DRAFT_OUTSIDE)
  }
  return path.join(root, TAB_FOLDER, relative)
}

export function sameFile(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()
}

function insideWiki(draft: string): string {
  return draft.startsWith(`${WIKI_FOLDER}/`) ? draft.slice(WIKI_FOLDER.length + 1) : draft
}

function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}
