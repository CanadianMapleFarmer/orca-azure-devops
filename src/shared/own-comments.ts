import type { WorkComment } from './work'

export const OWN_COMMENT_MS = 120_000

export interface OwnComment { comment: WorkComment; at: number }

export type OwnComments = Readonly<Record<string, readonly OwnComment[]>>

export function recordOwn(own: OwnComments, key: string, comment: WorkComment, now: number): OwnComments {
  const kept: Record<string, readonly OwnComment[]> = {}
  for (const [held, entries] of Object.entries(own)) {
    const recent = entries.filter(entry => isRecent(entry, now))
    if (recent.length > 0) kept[held] = recent
  }
  kept[key] = [...(kept[key] ?? []), { comment, at: now }]
  return kept
}

export function withOwn(own: OwnComments, key: string, comments: WorkComment[], now: number): WorkComment[] {
  const read = new Set(comments.map(comment => comment.id))
  const missing = (own[key] ?? []).filter(entry => isRecent(entry, now) && !read.has(entry.comment.id)).map(entry => entry.comment)
  return missing.length === 0 ? comments : [...missing, ...comments].sort((a, b) => b.id - a.id)
}

function isRecent(entry: OwnComment, now: number): boolean {
  return now - entry.at < OWN_COMMENT_MS
}
