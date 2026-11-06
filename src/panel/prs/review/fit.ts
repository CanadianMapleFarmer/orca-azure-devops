import type { ChangedFile, ReviewThread, ThreadAnchor } from '../../../shared/reviews'
import { cutLabel, utf8Length } from '../../label'

export const MAX_THREAD_CARDS = 30
export const MAX_COMMENTS_SHOWN = 10
export const THREADS_BYTES = 300 * 1024
export const FILE_THREADS_BYTES = 100 * 1024
export const MAX_FILE_ROWS = 1000
export const FILE_ROWS_BYTES = 192 * 1024

const FILE_ROW_OVERHEAD_BYTES = 64

const WHOLE_NUMBER = /^\d+$/

export function fitThreads(threads: readonly ReviewThread[], budget = THREADS_BYTES): { shown: ReviewThread[]; hidden: number } {
  const shown: ReviewThread[] = []
  let used = 0
  for (const thread of threads) {
    if (shown.length === MAX_THREAD_CARDS) break
    const trimmed = firstAndNewest(thread)
    used += contentBytes(trimmed)
    if (used > budget) break
    shown.push(trimmed)
  }
  return { shown, hidden: threads.length - shown.length }
}

function firstAndNewest(thread: ReviewThread): ReviewThread {
  const { comments } = thread
  if (comments.length <= MAX_COMMENTS_SHOWN) return thread
  const kept = [comments[0], ...comments.slice(1 - MAX_COMMENTS_SHOWN)]
  return { ...thread, comments: kept, hidden: thread.hidden + comments.length - kept.length }
}

function contentBytes(thread: ReviewThread): number {
  return thread.comments.reduce(
    (total, comment) => total + utf8Length(comment.author) + utf8Length(comment.content),
    utf8Length(thread.anchor?.path ?? '')
  )
}

export function matchingFiles(files: readonly ChangedFile[], filter: string): ChangedFile[] {
  const needle = filter.trim().toLowerCase()
  return needle === '' ? [...files] : files.filter(file => file.path.toLowerCase().includes(needle))
}

const rowBytes = (file: ChangedFile): number => 2 * utf8Length(cutLabel(file.path)) + FILE_ROW_OVERHEAD_BYTES

export function fileRows(files: readonly ChangedFile[], filter: string): ChangedFile[] {
  const rows: ChangedFile[] = []
  let used = 0
  for (const file of matchingFiles(files, filter)) {
    used += rowBytes(file)
    if (rows.length === MAX_FILE_ROWS || used > FILE_ROWS_BYTES) break
    rows.push(file)
  }
  return rows
}

export function anchorTitle(anchor: ThreadAnchor | null): string {
  if (anchor === null) return 'General'
  if (anchor.line === null) return anchor.path
  return `${anchor.path}, ${anchor.side === 'old' ? 'old line' : 'line'} ${anchor.line}`
}

export function parseLine(text: string): number | null | 'bad' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const line = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : NaN
  return Number.isSafeInteger(line) && line >= 1 ? line : 'bad'
}
