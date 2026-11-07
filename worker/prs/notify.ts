import type { PrKey, PrSummary } from '../../src/shared/prs'
import type { RawThread } from '../ado/pr-review'
import { textOr, timestamp } from '../ado/workitems'
import {
  MORE_PR_UPDATES_BODY,
  morePrUpdates,
  newCommentBody,
  newCommentsTitle,
  reviewRequestedBody,
  reviewRequestedTitle,
  UNKNOWN_AUTHOR
} from '../messages'
import { createDelivery, cutNote, type DesktopNotification, type Shown } from '../pipelines/notify'
import { isLiveComment, peopleOf } from '../reviews/threads'
import { commentPreview } from './comment-preview'
import { sameId, toReviewOf } from './release-sets'
import type { PrNotifyPrefs } from './settings'

export const MAX_WATCHED_PRS = 20

type RawComment = NonNullable<RawThread['comments']>[number]

export interface PrThreads {
  pr: PrSummary
  threads: readonly RawThread[]
}

export interface PrUpdate {
  me: string
  review: PrSummary[]
  threads: readonly PrThreads[] | null
}

interface PrBaseline {
  toReview: ReadonlySet<string> | null
  comments: ReadonlyMap<string, number>
}

export interface PrNotifier {
  readsThreads(): boolean
  observe(org: string, update: PrUpdate): void
  forget(org: string): void
}

const FIRST_LOAD: PrBaseline = { toReview: null, comments: new Map() }

export function watchedPrs(mine: readonly PrSummary[]): PrSummary[] {
  return mine
    .filter(pr => pr.status === 'active')
    .sort((a, b) => b.createdAt - a.createdAt || b.prId - a.prId)
    .slice(0, MAX_WATCHED_PRS)
}

function prNotificationsFor(input: {
  org: string
  update: PrUpdate
  prefs: PrNotifyPrefs
  baseline: PrBaseline
  notified: ReadonlySet<string>
}): DesktopNotification[] {
  const { org, update, prefs, baseline, notified } = input
  const found = new Map<string, DesktopNotification>()
  const add = (note: DesktopNotification | null) => {
    if (note && !notified.has(note.key)) found.set(note.key, cutNote(note))
  }
  const waiting = baseline.toReview
  if (prefs.reviews && waiting) {
    for (const pr of toReviewOf(update.review, update.me)) if (!waiting.has(keyOf(pr))) add(reviewNote(org, update.me, pr))
  }
  if (prefs.comments) {
    for (const { pr, threads } of update.threads ?? []) {
      const since = baseline.comments.get(keyOf(pr))
      if (since === undefined) continue
      const people = peopleIn(pr, threads)
      for (const thread of threads) add(commentNote(org, update.me, pr, thread, since, people))
    }
  }
  return [...found.values()]
}

function nextBaseline(update: PrUpdate, previous: PrBaseline, prefs: PrNotifyPrefs): PrBaseline {
  return { toReview: new Set(toReviewOf(update.review, update.me).map(keyOf)), comments: nextComments(update.threads, previous.comments, prefs.comments) }
}

function nextComments(read: readonly PrThreads[] | null, previous: ReadonlyMap<string, number>, reading: boolean): ReadonlyMap<string, number> {
  if (!reading) return new Map()
  return read === null ? previous : newestSeen(read, previous)
}

export function createPrNotifier(deps: {
  show: (n: Shown) => Promise<unknown>
  prefs: () => PrNotifyPrefs
  log: (message: string) => void
}): PrNotifier {
  const delivery = createDelivery(deps)
  const baselines = new Map<string, PrBaseline>()
  return {
    readsThreads: () => deps.prefs().comments,

    observe(org, update) {
      const prefs = deps.prefs()
      const baseline = baselines.get(org) ?? FIRST_LOAD
      const found = prNotificationsFor({ org, update, prefs, baseline, notified: delivery.notified })
      baselines.set(org, nextBaseline(update, baseline, prefs))
      delivery.send(found, extra => ({ title: morePrUpdates(extra), body: MORE_PR_UPDATES_BODY }))
    },

    forget(org) {
      baselines.delete(org)
    }
  }
}

function reviewNote(org: string, me: string, pr: PrSummary): DesktopNotification {
  return {
    key: `review:${org}:${me.toLowerCase()}:${keyOf(pr)}`,
    title: reviewRequestedTitle(pr.prId),
    body: reviewRequestedBody(pr.title, pr.createdBy.name, pr.repoName)
  }
}

function commentNote(org: string, me: string, pr: PrSummary, thread: RawThread, since: number, people: ReadonlyMap<string, string>): DesktopNotification | null {
  if (thread?.isDeleted === true) return null
  const fresh = commentsOf(thread).filter(
    comment => isLiveComment(comment) && !sameId(textOr(comment.author?.id, ''), me) && timestamp(comment.publishedDate) > since
  )
  const latest = fresh.reduce<RawComment | null>((best, comment) => (best === null || isLater(comment, best) ? comment : best), null)
  if (latest === null) return null
  return {
    key: `comment:${org}:${keyOf(pr)}:${thread.id}:${latest.id}`,
    title: newCommentsTitle(pr.prId, fresh.length),
    body: newCommentBody(textOr(latest.author?.displayName, UNKNOWN_AUTHOR), commentPreview(textOr(latest.content, ''), people))
  }
}

function newestSeen(read: readonly PrThreads[], previous: ReadonlyMap<string, number>): Map<string, number> {
  return new Map(
    read.map(({ pr, threads }) => {
      const newest = threads.flatMap(commentsOf).reduce((max, comment) => Math.max(max, timestamp(comment.publishedDate)), 0)
      return [keyOf(pr), Math.max(previous.get(keyOf(pr)) ?? 0, newest)]
    })
  )
}

function commentsOf(thread: RawThread): RawComment[] {
  return Array.isArray(thread?.comments) ? thread.comments.filter(comment => typeof comment === 'object' && comment !== null) : []
}

function isLater(a: RawComment, b: RawComment): boolean {
  const order = timestamp(a.publishedDate) - timestamp(b.publishedDate)
  return order > 0 || (order === 0 && a.id > b.id)
}

function peopleIn(pr: PrSummary, threads: readonly RawThread[]): Map<string, string> {
  const createdBy = { id: pr.createdBy.id, displayName: pr.createdBy.name }
  return peopleOf({ createdBy, reviewers: pr.reviewers.map(reviewer => ({ id: reviewer.id, displayName: reviewer.name })) }, threads)
}

function keyOf({ projectId, repoId, prId }: PrKey): string {
  return `${projectId}/${repoId}/${prId}`
}
