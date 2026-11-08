import type { PrReviewer, PrSummary, ReleaseSet } from '../../shared/prs'
import type { Chip } from '../chips'
import type { Place } from '../grouping'

export const MERGED_SHOWN = 2
export const MIN_BRANCH_PREFIX = 4

const APPROVED_VOTE = 10
const WAITING_FOR_AUTHOR_VOTE = -5
const REJECTED_VOTE = -10

export function prPlace(pr: PrSummary): Place {
  return { projectId: pr.projectId, projectName: pr.projectName, repoId: pr.repoId, repoName: pr.repoName }
}

export function setPlaces(set: ReleaseSet): Place[] {
  return set.prs.map(prPlace)
}

export function myVoteOn(pr: PrSummary, me: string | null): number {
  return pr.reviewers.find(reviewer => me !== null && reviewer.id.toLowerCase() === me.toLowerCase())?.vote ?? 0
}

const isActive = (pr: PrSummary): boolean => pr.status === 'active'

const hasVote = (pr: PrSummary, vote: number): boolean => pr.reviewers.some(reviewer => reviewer.vote === vote)

function worstCheck(pr: PrSummary): Chip | null {
  if (pr.mergeStatus === 'conflicts') return { tone: 'danger', text: 'conflicts' }
  if (pr.checks?.build === 'failed') return { tone: 'danger', text: '✗ build' }
  if (pr.checks?.policies === 'rejected') return { tone: 'danger', text: '✗ policies' }
  if (hasVote(pr, REJECTED_VOTE)) return { tone: 'danger', text: 'rejected' }
  if (hasVote(pr, WAITING_FOR_AUTHOR_VOTE)) return { tone: 'warning', text: 'waiting for author' }
  if (pr.checks?.build === 'running') return { tone: 'warning', text: '● build' }
  if (pr.checks?.policies === 'pending') return { tone: 'neutral', text: '· policies' }
  if (pr.checks?.build === 'succeeded' || pr.checks?.policies === 'approved') return { tone: 'success', text: '✓ build' }
  return null
}

function statusChip(pr: PrSummary): Chip | null {
  if (pr.status === 'completed') return { tone: 'success', text: 'merged' }
  if (pr.status === 'abandoned') return { tone: 'neutral', text: 'abandoned' }
  const check = worstCheck(pr)
  const parts = [pr.isDraft ? 'draft' : null, check?.text ?? null, pr.autoComplete ? 'auto-complete' : null].filter(part => part !== null)
  if (parts.length === 0) return null
  return { tone: check?.tone ?? (pr.autoComplete ? 'accent' : 'neutral'), text: parts.join(' · ') }
}

function placeChip(pr: PrSummary, place: 'repo' | 'project' | null): Chip | null {
  if (place === 'repo') return { tone: 'neutral', text: pr.repoName }
  if (place === 'project') return { tone: 'neutral', text: `${pr.projectName} / ${pr.repoName}` }
  return null
}

export function prChips(pr: PrSummary, place: 'repo' | 'project' | null): Chip[] {
  return [placeChip(pr, place), statusChip(pr)].filter(chip => chip !== null)
}

const isWaitedFor = (reviewer: PrReviewer): boolean => reviewer.isRequired && !reviewer.hasDeclined && reviewer.vote === 0

export function waitingOn(pr: PrSummary): string | null {
  if (!isActive(pr)) return null
  const waiting = pr.reviewers.filter(isWaitedFor).map(reviewer => reviewer.name)
  return waiting.length > 0 ? `waiting for ${waiting.join(', ')}` : null
}

function commonPrefix(sources: readonly string[]): string[] {
  const [first, ...rest] = sources.map(source => Array.from(source))
  let length = first.length
  for (const other of rest) {
    let same = 0
    while (same < length && same < other.length && other[same] === first[same]) same += 1
    length = same
  }
  return first.slice(0, length)
}

export function branchPattern(sources: readonly string[]): string {
  const distinct = [...new Set(sources)]
  if (distinct.length <= 1) return distinct[0] ?? ''
  const prefix = commonPrefix(distinct)
  return prefix.length >= MIN_BRANCH_PREFIX ? `${prefix.join('')}*` : `${distinct.length} branches`
}

export function needsApprove(pr: PrSummary, me: string | null): boolean {
  return isActive(pr) && !pr.isDraft && myVoteOn(pr, me) !== APPROVED_VOTE
}

export function needsAutoComplete(pr: PrSummary): boolean {
  return isActive(pr) && !pr.isDraft && !pr.autoComplete
}

const isStuck = (pr: PrSummary): boolean =>
  pr.mergeStatus === 'conflicts' ||
  pr.checks?.build === 'failed' ||
  pr.checks?.policies === 'rejected' ||
  hasVote(pr, REJECTED_VOTE) ||
  hasVote(pr, WAITING_FOR_AUTHOR_VOTE)

export function needsYou(set: ReleaseSet): boolean {
  return set.prs.some(pr => isActive(pr) && isStuck(pr))
}
