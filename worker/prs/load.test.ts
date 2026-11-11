import { assert, test } from 'orca/testing'
import { createAdoHttp } from '../ado/http'
import { loadPrChips } from '../ado/pr-links'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { createEntities } from '../data/entities'
import { fakePrs, isEvaluations, isMineActive, isMineCompleted, isPrWorkItems, isReviewList, ME, PLATFORM, projectOf } from './fake-prs'
import { createPrSource } from './load'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const PROJECTS = [
  { id: PROJECT, name: 'Fabrikam Web' },
  { id: PLATFORM, name: 'Fabrikam Platform' }
]

const RUNNING = { count: 1, value: [{ status: 'running', configuration: { type: { displayName: 'Build' }, settings: { buildDefinitionId: 42 } } }] }

function setup() {
  const ado = fakePrs()
  const clock = { now: T0 }
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const tables = createEntities(() => clock.now).of(ORG)
  return { ado, clock, http, tables, source: createPrSource(http, ORG, () => clock.now, tables) }
}

function listed(name: string): RawPullRequest[] {
  return fixture<{ value: RawPullRequest[] }>(name).value
}

function keyOf(raw: RawPullRequest): string {
  return `${raw.repository.project.id}/${raw.repository.id}/${raw.pullRequestId}`
}

function evaluatedPr(call: AdoCall): number {
  return Number(call.query.get('artifactId')?.split('/').at(-1))
}

test('a signal reaches every request of a full load', async () => {
  const { ado, source } = setup()
  const controller = new AbortController()
  const { mine, review } = await source.full(ME, PROJECTS, true, controller.signal)

  assert.deepEqual(mine.map(pr => pr.prId), [4101, 4102, 4103, 4104, 4105, 4090, 4091])
  assert.deepEqual(review.map(pr => pr.prId), [4110, 4111])
  assert.deepEqual(
    [isMineActive, isMineCompleted, isReviewList, isPrWorkItems, isEvaluations].map(match => ado.count(match)),
    [2, 2, 2, 7, 5]
  )
  controller.abort()
  assert.ok(ado.calls.every(call => call.signal?.aborted), 'every request carried the signal')
})

test('a full load enriches my PRs: work items for all, checks for active ones only', async () => {
  const { source } = setup()
  const { mine, review } = await source.full(ME, PROJECTS, true)
  const byId = new Map(mine.map(pr => [pr.prId, pr]))

  assert.deepEqual(byId.get(4101)?.workItemIds, [1204, 1207])
  assert.deepEqual(byId.get(4101)?.checks, { build: 'succeeded', policies: 'approved' })
  assert.deepEqual(byId.get(4090)?.workItemIds, [1198])
  assert.equal(byId.get(4090)?.checks, null)
  assert.ok(review.every(pr => pr.workItemIds.length === 0 && pr.checks === null), 'PRs to review are not enriched')
})

test('caches expire on the polling budget', async () => {
  const { ado, clock, source } = setup()
  ado.on(call => isEvaluations(call) && evaluatedPr(call) === 4102, () => json(200, RUNNING))
  const tally = () => [isMineActive, isMineCompleted, isReviewList, isPrWorkItems, isEvaluations].map(match => ado.count(match))
  const evaluated = () => ado.calls.filter(isEvaluations).map(evaluatedPr)
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [2, 2, 2, 7, 5])

  clock.now += 2 * MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [4, 2, 4, 7, 6], 'at 2 minutes only the PR whose build runs is re-read')
  assert.deepEqual(evaluated().slice(5), [4102])

  clock.now += 3 * MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [6, 4, 6, 7, 7], 'completed lists last 5 minutes')

  clock.now += 5 * MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [8, 6, 8, 12, 8], 'work items of active PRs last 10 minutes')

  clock.now += 20 * MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [10, 8, 10, 17, 13], 'at 30 minutes every active PR is re-read')

  clock.now += 30 * MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(tally(), [12, 10, 12, 24, 18], 'work items of completed PRs last an hour')

  const changed = listed('pull-requests-mine').map(raw =>
    raw.pullRequestId === 4101
      ? { ...raw, reviewers: raw.reviewers?.map((reviewer, index) => (index === 0 ? { ...reviewer, vote: 5 } : reviewer)) }
      : raw.pullRequestId === 4103
        ? { ...raw, lastMergeSourceCommit: { commitId: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f' } }
        : raw
  )
  ado.on(isMineActive, call => json(200, { value: changed.filter(raw => raw.repository.project.id === projectOf(call)) }))
  clock.now += MINUTE
  await source.full(ME, PROJECTS, true)
  assert.deepEqual(evaluated().slice(18).sort(), [4101, 4103], 'a vote change or a push re-reads that PR at once')
})

test('the completed list of a project is read at most every 5 minutes', async () => {
  const { ado, clock, source } = setup()
  const web = PROJECTS.slice(0, 1)
  const first = await source.full(ME, web, false)
  for (const all of [false, true, false, true]) {
    clock.now += MINUTE
    const { mine } = await source.full(ME, web, all)
    assert.deepEqual(mine.map(pr => pr.prId), first.mine.map(pr => pr.prId), 'its last results are kept in between')
  }
  assert.deepEqual([ado.count(isMineActive), ado.count(isMineCompleted)], [5, 1], 'not even Refresh re-reads it sooner')

  clock.now += MINUTE
  await source.full(ME, web, false)
  assert.deepEqual([ado.count(isMineActive), ado.count(isMineCompleted)], [6, 2])
})

test('listed PRs and their checks land in the shared store', async () => {
  const { tables, source } = setup()
  await source.full(ME, PROJECTS, true)
  const mine = listed('pull-requests-mine')
  const everyListed = [...mine, ...listed('pull-requests-completed'), ...listed('pull-requests-review')]
  assert.deepEqual(tables.prs.entries().map(([key]) => key).sort(), everyListed.map(keyOf).sort())
  assert.deepEqual(tables.prs.get(keyOf(mine[0]))?.value.sourceCommit, mine[0].lastMergeSourceCommit?.commitId)
  assert.deepEqual(tables.prChecks.entries().map(([key]) => key).sort(), mine.map(keyOf).sort())
  assert.deepEqual(tables.prChecks.get(keyOf(mine[0]))?.value, {
    build: 'succeeded',
    policies: 'approved',
    commit: mine[0].lastMergeSourceCommit?.commitId,
    reviewers: tables.prs.get(keyOf(mine[0]))?.value.reviewers
  })
  assert.deepEqual(tables.prWorkItems.get(keyOf(mine[0]))?.value, [1204, 1207])
})

test('checks read for a chip are reused by the PRs tab while fresh', async () => {
  const { ado, clock, http, tables, source } = setup()
  const refs = listed('pull-requests-mine').map(raw => ({ projectId: raw.repository.project.id, repoId: raw.repository.id, prId: raw.pullRequestId }))
  const chips = await loadPrChips(http, ORG, refs, tables, () => clock.now)
  assert.equal(chips.length, 5)
  assert.equal(ado.count(isEvaluations), 5)

  clock.now += MINUTE
  const { mine } = await source.full(ME, PROJECTS, true)
  assert.equal(ado.count(isEvaluations), 5)
  assert.deepEqual(mine.find(pr => pr.prId === 4101)?.checks, { build: 'succeeded', policies: 'approved' })
})

test('reviews asks only for the to-review list of each project', async () => {
  const { ado, source } = setup()
  const review = await source.reviews(ME, PROJECTS, true)
  assert.deepEqual(review.map(pr => pr.prId), [4110, 4111])
  assert.equal(ado.calls.length, 2)
  assert.ok(ado.calls.every(isReviewList))
  assert.deepEqual(
    ado.calls.map(call => Object.fromEntries(call.query)),
    PROJECTS.map(() => ({ 'searchCriteria.reviewerId': ME, 'searchCriteria.status': 'active', $top: '100', 'api-version': '7.1' }))
  )
})
