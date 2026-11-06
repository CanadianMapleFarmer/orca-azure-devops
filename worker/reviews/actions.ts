import { BAD_LINE, messageOf } from '../../src/shared/messages'
import { isResolved, MAX_REVIEW_COMMENT, VOTE_VALUE, votePhrase, type ReviewKey, type ReviewResult, type VoteChoice } from '../../src/shared/reviews'
import type { AdoHttp } from '../ado/http'
import { setVote } from '../ado/pr-actions'
import { createThread, getThread, replyTo, setThreadStatus } from '../ado/pr-review'
import { toPrSummary } from '../ado/pullrequests'
import {
  alreadyVoted,
  ALREADY_ACTIVE,
  ALREADY_RESOLVED,
  badRequest,
  BINARY_NO_LINES,
  COMMENTED,
  commentedOn,
  EMPTY_COMMENT,
  FILE_NOT_IN_PR,
  LINE_UNCHECKED,
  lineOutOfRange,
  NO_LINES,
  REACTIVATED,
  REPLIED,
  RESOLVED,
  REVIEW_COMMENT_TOO_LONG,
  REVIEW_DRAFT_NO_VOTES,
  REVIEW_PR_CLOSED,
  THREAD_GONE,
  VOTED,
  votedAs
} from '../messages'
import { sameId } from '../prs/release-sets'
import type { Reviews } from './service'
import { statusOf } from './threads'

export interface ReviewActions {
  vote(input: ReviewKey & { vote: VoteChoice }): Promise<ReviewResult>
  reply(input: ReviewKey & { threadId: number; text: string }): Promise<ReviewResult>
  setStatus(input: ReviewKey & { threadId: number; status: 'fixed' | 'active' }): Promise<ReviewResult>
  comment(input: ReviewKey & { text: string; path?: string; line?: number }): Promise<ReviewResult>
}

export interface ReviewActionsDeps {
  http: AdoHttp
  reviews: Pick<Reviews, 'pullRequest' | 'fileFacts'>
  me: (org: string) => Promise<string>
  after: (org: string) => void
}

type Facts = NonNullable<Awaited<ReturnType<Reviews['fileFacts']>>>

export function createReviewActions({ http, reviews, me, after }: ReviewActionsDeps): ReviewActions {
  async function vote({ vote: choice, ...key }: ReviewKey & { vote: VoteChoice }): Promise<ReviewResult> {
    const account = await me(key.org)
    const pr = toPrSummary(await reviews.pullRequest(key), key.org)
    if (pr.status !== 'active') return refused(REVIEW_PR_CLOSED)
    if (pr.isDraft) return refused(REVIEW_DRAFT_NO_VOTES)
    const mine = pr.reviewers.find(reviewer => sameId(reviewer.id, account))
    const wanted = VOTE_VALUE[choice]
    if (mine?.vote === wanted) return ok(alreadyVoted(votePhrase(wanted)))
    try {
      const answer = await setVote(http, key.org, key, account, mine?.isRequired ?? false, wanted)
      const recorded = typeof answer?.vote === 'number' ? answer.vote : 0
      return recorded === wanted ? ok(VOTED[choice]) : { ...ok(votedAs(votePhrase(recorded))), warn: true }
    } finally {
      after(key.org)
    }
  }

  async function reply({ threadId, text, ...key }: ReviewKey & { threadId: number; text: string }): Promise<ReviewResult> {
    const content = checkedText(text)
    const thread = await getThread(http, key.org, key, threadId)
    const first = thread === null || thread.isDeleted === true ? undefined : thread.comments?.[0]
    if (!first) return refused(THREAD_GONE)
    await replyTo(http, key.org, key, threadId, first.id, content)
    return ok(REPLIED)
  }

  async function setStatus({ threadId, status, ...key }: ReviewKey & { threadId: number; status: 'fixed' | 'active' }): Promise<ReviewResult> {
    const thread = await getThread(http, key.org, key, threadId)
    if (thread === null || thread.isDeleted === true) return refused(THREAD_GONE)
    const current = statusOf(thread.status)
    if (status === 'fixed' && isResolved(current)) return ok(ALREADY_RESOLVED)
    if (status === 'active' && (current === 'active' || current === 'pending')) return ok(ALREADY_ACTIVE)
    await setThreadStatus(http, key.org, key, threadId, status)
    return ok(status === 'fixed' ? RESOLVED : REACTIVATED)
  }

  async function comment({ text, path, line, ...key }: ReviewKey & { text: string; path?: string; line?: number }): Promise<ReviewResult> {
    const content = checkedText(text)
    const spot = checkedLine(path, line)
    if (path === undefined) {
      await createThread(http, key.org, key, { content })
      return ok(COMMENTED)
    }
    const facts = await reviews.fileFacts({ ...key, path })
    if (facts === null) return refused(FILE_NOT_IN_PR)
    const side = facts.file.kind === 'deleted' ? 'old' : 'new'
    const problem = spot === null ? null : lineProblem(facts, side, spot)
    if (problem !== null) return refused(problem)
    const { changeTrackingId } = facts.file
    await createThread(http, key.org, key, { content, file: { path, line: spot, side, changeTrackingId, iterationId: facts.iterationId } })
    return ok(commentedOn(path, spot))
  }

  return {
    vote: input => attempt(() => vote(input)),
    reply: input => attempt(() => reply(input)),
    setStatus: input => attempt(() => setStatus(input)),
    comment: input => attempt(() => comment(input))
  }
}

async function attempt(work: () => Promise<ReviewResult>): Promise<ReviewResult> {
  try {
    return await work()
  } catch (error) {
    return refused(messageOf(error))
  }
}

function checkedText(text: string): string {
  const content = text.trim()
  if (content === '') throw badRequest(EMPTY_COMMENT)
  if (content.length > MAX_REVIEW_COMMENT) throw badRequest(REVIEW_COMMENT_TOO_LONG)
  return content
}

function checkedLine(path: string | undefined, line: number | undefined): number | null {
  if (line === undefined) return null
  if (path === undefined || !Number.isSafeInteger(line) || line < 1) throw badRequest(BAD_LINE)
  return line
}

function lineProblem(facts: Facts, side: 'new' | 'old', line: number): string | null {
  if (facts.binary) return BINARY_NO_LINES
  const lines = facts.lines[side]
  if (lines === 'unknown') return LINE_UNCHECKED
  if (lines === null || lines === 0) return NO_LINES
  return line > lines ? lineOutOfRange(lines) : null
}

function ok(message: string): ReviewResult {
  return { ok: true, message }
}

function refused(message: string): ReviewResult {
  return { ok: false, message }
}
