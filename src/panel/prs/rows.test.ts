import { assert, test } from 'orca/testing'
import type { PrChecks, PrSummary } from '../../shared/prs'
import { NOW, prOf, reviewerOf, setOf } from './fixtures'
import { branchPattern, MERGED_SHOWN, MIN_BRANCH_PREFIX, needsApprove, needsAutoComplete, needsYou, placeChip, prPlace, setPlaces, statusChip, waitingOn } from './rows'

const checks = (build: PrChecks['build'], policies: PrChecks['policies']): PrChecks => ({ build, policies })

const voted = (...votes: number[]) => votes.map((vote, index) => reviewerOf(`Reviewer ${index}`, vote))

const statusOf = (over: Partial<PrSummary>) => statusChip(prOf(1, over))

test('statusChip gives one chip: merged alone, else draft, the worst check and auto-complete in one text with the check\'s tone', () => {
  const everything: Partial<PrSummary> = { isDraft: true, autoComplete: true, mergeStatus: 'conflicts', checks: checks('failed', 'rejected'), reviewers: voted(-10, -5) }
  assert.deepEqual(statusOf({ ...everything, status: 'completed', closedAt: NOW }), { tone: 'success', text: 'merged' })
  assert.deepEqual(statusOf({ ...everything, status: 'abandoned', closedAt: NOW }), { tone: 'neutral', text: 'abandoned' })

  const worst: [Partial<PrSummary>, string, string][] = [
    [{ mergeStatus: 'conflicts', checks: checks('failed', 'rejected'), reviewers: voted(-10, -5) }, 'danger', 'conflicts'],
    [{ checks: checks('failed', 'rejected'), reviewers: voted(-10, -5) }, 'danger', '✗ build'],
    [{ checks: checks('running', 'rejected'), reviewers: voted(-10, -5) }, 'danger', '✗ policies'],
    [{ checks: checks('running', 'pending'), reviewers: voted(-5, -10) }, 'danger', 'rejected'],
    [{ checks: checks('running', 'pending'), reviewers: voted(10, -5) }, 'warning', 'waiting for author'],
    [{ checks: checks('running', 'approved'), reviewers: voted(10, 5) }, 'warning', 'build …'],
    [{ checks: checks('succeeded', 'pending') }, 'neutral', '· policies'],
    [{ checks: checks('succeeded', 'none') }, 'success', '✓ build'],
    [{ checks: checks('none', 'approved') }, 'success', '✓ build']
  ]
  for (const [over, tone, text] of worst) assert.deepEqual(statusOf(over), { tone, text }, text)

  assert.deepEqual(statusOf({ isDraft: true, checks: checks('running', 'pending') }), { tone: 'warning', text: 'draft · build …' })
  assert.deepEqual(statusOf({ autoComplete: true, checks: checks('succeeded', 'approved') }), { tone: 'success', text: '✓ build · auto-complete' })
  assert.deepEqual(statusOf({ isDraft: true, autoComplete: true, mergeStatus: 'conflicts' }), { tone: 'danger', text: 'draft · conflicts · auto-complete' })
  assert.deepEqual(statusOf({ autoComplete: true }), { tone: 'accent', text: 'auto-complete' })
  assert.deepEqual(statusOf({ isDraft: true, autoComplete: true, checks: checks('none', 'none') }), { tone: 'accent', text: 'draft · auto-complete' })
  assert.deepEqual(statusOf({ isDraft: true }), { tone: 'neutral', text: 'draft' })
  assert.equal(statusOf({}), null)
  assert.equal(statusOf({ checks: checks('none', 'none'), reviewers: voted(10, 5, 0) }), null)
})

test('placeChip names the repository in Across repos and the project / repository in Across projects, and nothing elsewhere', () => {
  const api = prOf(2, { repoId: 'repo-api', repoName: 'fabrikam-api', checks: checks('failed', 'none') })
  assert.deepEqual(placeChip(api, 'repo'), { tone: 'neutral', text: 'fabrikam-api' })
  assert.deepEqual(placeChip(api, 'project'), { tone: 'neutral', text: 'Fabrikam Web / fabrikam-api' })
  assert.equal(placeChip(api, null), null)
  assert.deepEqual(placeChip(prOf(3), 'project'), { tone: 'neutral', text: 'Fabrikam Web / web-app' })
  assert.deepEqual(placeChip(prOf(4, { status: 'completed', closedAt: NOW }), 'repo'), { tone: 'neutral', text: 'web-app' })
  assert.deepEqual(statusChip(api), { tone: 'danger', text: '✗ build' })
})

test('waitingOn names required reviewers who have not voted or declined', () => {
  const reviewers = [
    reviewerOf('Ada Optional', 0),
    reviewerOf('Declined Required', 0, { isRequired: true, hasDeclined: true }),
    reviewerOf('Approved Required', 10, { isRequired: true }),
    reviewerOf('Rejected Required', -10, { isRequired: true }),
    reviewerOf('Author Required', -5, { isRequired: true }),
    reviewerOf('Grace Hopper', 0, { isRequired: true }),
    reviewerOf('Release Approvers', 0, { isRequired: true, isGroup: true })
  ]
  assert.equal(waitingOn(prOf(1, { reviewers })), 'waiting for Grace Hopper, Release Approvers')
  assert.equal(waitingOn(prOf(1, { reviewers: reviewers.slice(0, 5) })), null)
  assert.equal(waitingOn(prOf(1)), null)
  assert.equal(waitingOn(prOf(1, { reviewers, status: 'completed', closedAt: NOW })), null, 'a merged pull request waits for nobody')
  assert.equal(waitingOn(prOf(1, { reviewers, status: 'abandoned', closedAt: NOW })), null)
})

test('branchPattern turns a shared prefix into * and counts unrelated branches', () => {
  assert.equal(MIN_BRANCH_PREFIX, 4)
  assert.equal(branchPattern(['feature/login']), 'feature/login')
  assert.equal(branchPattern(['feature/login', 'feature/logout']), 'feature/log*')
  assert.equal(branchPattern(['release/2026.11', 'release/2026.12', 'release/2026.12-hotfix']), 'release/2026.1*')
  assert.equal(branchPattern(['feat/a', 'feat/b']), 'feat/*')
  assert.equal(branchPattern(['abcd1', 'abcd2']), 'abcd*')
  assert.equal(branchPattern(['abc1', 'abc2']), '2 branches')
  assert.equal(branchPattern(['feature/login', 'hotfix/login', 'main']), '3 branches')
  assert.equal(branchPattern(['feature/login', 'feature/login']), 'feature/login')
})

test('needsApprove and needsAutoComplete skip drafts, finished pull requests and ones already done', () => {
  const me = 'u-contoso'
  const mine = (vote: number) => reviewerOf('Ada Lovelace', vote, { id: 'U-Contoso' })
  assert.equal(needsApprove(prOf(1), me), true)
  assert.equal(needsApprove(prOf(1), null), true)
  assert.equal(needsApprove(prOf(1, { reviewers: [mine(5)] }), me), true)
  assert.equal(needsApprove(prOf(1, { reviewers: [reviewerOf('Grace Hopper', 10)] }), me), true)
  assert.equal(needsApprove(prOf(1, { reviewers: [mine(10)] }), me), false)
  assert.equal(needsApprove(prOf(1, { isDraft: true }), me), false)
  assert.equal(needsApprove(prOf(1, { status: 'completed', closedAt: NOW }), me), false)
  assert.equal(needsApprove(prOf(1, { status: 'abandoned', closedAt: NOW }), me), false)

  assert.equal(needsAutoComplete(prOf(1)), true)
  assert.equal(needsAutoComplete(prOf(1, { autoComplete: true })), false)
  assert.equal(needsAutoComplete(prOf(1, { isDraft: true })), false)
  assert.equal(needsAutoComplete(prOf(1, { status: 'completed', closedAt: NOW })), false)
  assert.equal(needsAutoComplete(prOf(1, { status: 'abandoned', closedAt: NOW })), false)
})

test('needsYou looks for conflicts, a failed build, rejected policies or a rejecting or waiting vote on an active pull request', () => {
  const needing: Partial<PrSummary>[] = [
    { mergeStatus: 'conflicts' },
    { checks: checks('failed', 'none') },
    { checks: checks('none', 'rejected') },
    { reviewers: voted(-10) },
    { reviewers: voted(-5) }
  ]
  for (const over of needing) assert.equal(needsYou(setOf([prOf(1), prOf(2, over)])), true, JSON.stringify(over))
  assert.equal(needsYou(setOf([prOf(1, { isDraft: true, checks: checks('running', 'pending'), reviewers: voted(0, 5, 10) })])), false)
  assert.equal(needsYou(setOf([prOf(1, { status: 'completed', closedAt: NOW, mergeStatus: 'conflicts', reviewers: voted(-10) })])), false)
})

test('a pull request\'s place is its project and repository, and a set has one per pull request', () => {
  const api = prOf(2, { projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: 'repo-tools-app', repoName: 'web-app' })
  assert.deepEqual(prPlace(api), { projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: 'repo-tools-app', repoName: 'web-app' })
  assert.deepEqual(setPlaces(setOf([prOf(1), api])), [
    { projectId: 'proj-web', projectName: 'Fabrikam Web', repoId: 'repo-web', repoName: 'web-app' },
    { projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: 'repo-tools-app', repoName: 'web-app' }
  ])
  assert.equal(MERGED_SHOWN, 2)
})
