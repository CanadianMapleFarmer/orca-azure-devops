import type { DiffText } from './diff'
import type { PrKey, PrSummary } from './prs'

export interface ReviewKey extends PrKey {
  org: string
}

export type VoteChoice = 'approve' | 'suggestions' | 'waitForAuthor' | 'reject'

export const VOTE_VALUE: Record<VoteChoice, number> = {
  approve: 10,
  suggestions: 5,
  waitForAuthor: -5,
  reject: -10
}

export const VOTE_BUTTON: Record<VoteChoice, string> = {
  approve: 'Approve',
  suggestions: 'Approve with suggestions',
  waitForAuthor: 'Wait for author',
  reject: 'Reject'
}

const VOTE_PHRASE: Record<VoteChoice, string> = {
  approve: 'Approved',
  suggestions: 'Approved with suggestions',
  waitForAuthor: 'Waiting for author',
  reject: 'Rejected'
}

export function votePhrase(vote: number): string {
  const choice = (Object.keys(VOTE_VALUE) as VoteChoice[]).find(key => VOTE_VALUE[key] === vote)
  return choice ? VOTE_PHRASE[choice] : 'No vote'
}

export type ChangeKind = 'added' | 'edited' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  originalPath: string | null
  kind: ChangeKind
}

export type ThreadStatus = 'active' | 'pending' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'unknown'

export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  active: 'Active',
  pending: 'Pending',
  fixed: 'Resolved',
  wontFix: "Won't fix",
  closed: 'Closed',
  byDesign: 'By design',
  unknown: 'Unknown'
}

const RESOLVED: ReadonlySet<ThreadStatus> = new Set(['fixed', 'wontFix', 'closed', 'byDesign'])

export function isResolved(status: ThreadStatus): boolean {
  return RESOLVED.has(status)
}

export interface ThreadAnchor {
  path: string
  line: number | null
  side: 'new' | 'old'
}

export const MAX_REVIEW_COMMENT = 10_000

export interface ReviewComment {
  id: number
  author: string
  at: number
  content: string
}

export interface ReviewThread {
  id: number
  status: ThreadStatus
  anchor: ThreadAnchor | null
  comments: ReviewComment[]
  hidden: number
}

export interface PrReview {
  key: ReviewKey
  pr: PrSummary
  description: string
  myVote: number
  files: ChangedFile[]
  moreFiles: boolean
  threads: ReviewThread[]
  threadCount: number
  loadedAt: number
  message?: string
}

export type LineCount = number | null | 'unknown'

export interface FileDiff extends DiffText {
  path: string
  lines: { old: LineCount; new: LineCount }
}

export interface ReviewResult {
  ok: boolean
  message: string
  warn?: true
}

export type CheckoutResult =
  | { status: 'opened' | 'refused'; message: string }
  | { status: 'armed'; message: string; armedUntil: number }
