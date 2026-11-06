import {
  isResolved,
  type PrReview,
  type ReviewComment,
  type ReviewThread,
  type ThreadAnchor,
  type ThreadStatus
} from '../../src/shared/reviews'
import type { RawThread } from '../ado/pr-review'
import type { RawPullRequest } from '../ado/pullrequests'
import { expectId, expectList, shaped } from '../ado/shape'
import { textOr, timestamp } from '../ado/workitems'
import { byteLength, itemBytes } from '../budget'
import { joinMessages, MALFORMED, REVIEW_TRIMMED, UNKNOWN_AUTHOR } from '../messages'
import { panelMarkdown } from '../panel-markdown'

export const MAX_THREADS = 100
export const MAX_COMMENTS_PER_THREAD = 20
export const MAX_COMMENT_BYTES = 8_000

type RawComment = NonNullable<RawThread['comments']>[number]
type RawContext = RawThread['threadContext']

interface Live {
  raw: RawThread
  status: ThreadStatus
  comments: { raw: RawComment; at: number }[]
  newest: number
}

interface Target {
  people: ReadonlyMap<string, string>
  prUrl: string
}

const SYSTEM_COMMENT = 'system'
const STATUSES: ReadonlySet<string> = new Set<ThreadStatus>(['active', 'pending', 'fixed', 'wontFix', 'closed', 'byDesign'])

export function peopleOf(pr: RawPullRequest, threads: readonly RawThread[]): Map<string, string> {
  const people = new Map<string, string>()
  const add = (identity: unknown) => {
    if (typeof identity !== 'object' || identity === null) return
    const { id, displayName } = identity as { id?: unknown; displayName?: unknown }
    if (typeof id === 'string' && typeof displayName === 'string') people.set(id, displayName)
  }
  add(pr.createdBy)
  for (const reviewer of pr.reviewers ?? []) add(reviewer)
  for (const thread of threads) {
    for (const identity of Object.values(thread?.identities ?? {})) add(identity)
    for (const comment of Array.isArray(thread?.comments) ? thread.comments : []) add(comment?.author)
  }
  return people
}

export function toReviewThreads(raw: readonly RawThread[], context: Target): { threads: ReviewThread[]; total: number } {
  return shaped(() => {
    const live = raw.filter(thread => thread.isDeleted !== true).map(liveThread).filter(thread => thread.comments.length > 0)
    live.sort(reviewOrder)
    return { threads: live.slice(0, MAX_THREADS).map(thread => toReviewThread(thread, context)), total: live.length }
  }, MALFORMED.review)
}

export function fitReview(review: PrReview, budget: number): PrReview {
  const trimmed = joinMessages(review.message, REVIEW_TRIMMED)
  const sizes = review.threads.map(itemBytes)
  let bytes = byteLength({ ...review, message: trimmed })
  let kept = review.threads.length
  while (kept > 0 && bytes > budget) {
    kept -= 1
    bytes -= sizes[kept]
  }
  if (kept === review.threads.length && kept >= review.threadCount) return review
  return { ...review, threads: review.threads.slice(0, kept), message: trimmed }
}

function liveThread(raw: RawThread): Live {
  expectId(raw.id)
  const comments = expectList<RawComment>(raw.comments ?? [])
    .filter(comment => comment.isDeleted !== true && comment.commentType !== SYSTEM_COMMENT)
    .map(comment => ({ raw: comment, at: timestamp(comment.publishedDate) }))
    .sort((a, b) => a.at - b.at || expectId(a.raw.id) - expectId(b.raw.id))
  return { raw, status: statusOf(raw.status), comments, newest: comments.at(-1)?.at ?? -Infinity }
}

function reviewOrder(a: Live, b: Live): number {
  return Number(isResolved(a.status)) - Number(isResolved(b.status)) || b.newest - a.newest || b.raw.id - a.raw.id
}

function toReviewThread(thread: Live, { people, prUrl }: Target): ReviewThread {
  const { comments } = thread
  const shown = comments.length > MAX_COMMENTS_PER_THREAD ? [comments[0], ...comments.slice(1 - MAX_COMMENTS_PER_THREAD)] : comments
  return {
    id: thread.raw.id,
    status: thread.status,
    anchor: anchorOf(thread.raw.threadContext),
    comments: shown.map(({ raw, at }): ReviewComment => ({
      id: expectId(raw.id),
      author: textOr(raw.author?.displayName, UNKNOWN_AUTHOR),
      at,
      content: panelMarkdown(textOr(raw.content, ''), { maxBytes: MAX_COMMENT_BYTES, resolve: () => prUrl, people })
    })),
    hidden: comments.length - shown.length
  }
}

function anchorOf(context: RawContext): ThreadAnchor | null {
  const path = textOr(context?.filePath, '')
  if (!path) return null
  const right = lineOf(context?.rightFileStart)
  if (right !== null) return { path, line: right, side: 'new' }
  const left = lineOf(context?.leftFileStart)
  return left !== null ? { path, line: left, side: 'old' } : { path, line: null, side: 'new' }
}

function lineOf(position: { line: number } | null | undefined): number | null {
  const line = position?.line
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : null
}

function statusOf(status: string | undefined): ThreadStatus {
  return status !== undefined && STATUSES.has(status) ? (status as ThreadStatus) : 'unknown'
}
