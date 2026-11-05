import { assert, test } from 'orca/testing'
import { createAdoHttp } from '../ado/http'
import { ORG, PROJECT, REPO } from '../boards/fake-ado'
import { fakePrs, isEvaluations, isMineActive, isMineCompleted, isPrWorkItems, isReviewList, ME, PLATFORM } from './fake-prs'
import { createPrSource } from './load'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const PROJECTS = [
  { id: PROJECT, name: 'Fabrikam Web' },
  { id: PLATFORM, name: 'Fabrikam Platform' }
]

function setup() {
  const ado = fakePrs()
  const clock = { now: T0 }
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, clock, source: createPrSource(http, ORG, () => clock.now) }
}

test('a signal reaches every request of a full load', async () => {
  const { ado, source } = setup()
  const controller = new AbortController()
  const { mine, review } = await source.full(ME, PROJECTS, controller.signal)

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
  const { mine, review } = await source.full(ME, PROJECTS)
  const byId = new Map(mine.map(pr => [pr.prId, pr]))

  assert.deepEqual(byId.get(4101)?.workItemIds, [1204, 1207])
  assert.deepEqual(byId.get(4101)?.checks, { build: 'succeeded', policies: 'approved' })
  assert.deepEqual(byId.get(4090)?.workItemIds, [1198])
  assert.equal(byId.get(4090)?.checks, null)
  assert.ok(review.every(pr => pr.workItemIds.length === 0 && pr.checks === null), 'PRs to review are not enriched')
})

test('caches expire on the polling budget', async () => {
  const { ado, clock, source } = setup()
  const tally = () => [isMineActive, isMineCompleted, isReviewList, isPrWorkItems, isEvaluations].map(match => ado.count(match))
  await source.full(ME, PROJECTS)
  assert.deepEqual(tally(), [2, 2, 2, 7, 5])

  clock.now += 2 * MINUTE
  await source.full(ME, PROJECTS)
  assert.deepEqual(tally(), [4, 2, 4, 7, 10], 'checks last 2 minutes')

  clock.now += 3 * MINUTE
  await source.full(ME, PROJECTS)
  assert.deepEqual(tally(), [6, 4, 6, 7, 15], 'completed lists last 5 minutes')

  clock.now += 5 * MINUTE
  await source.full(ME, PROJECTS)
  assert.deepEqual(tally(), [8, 6, 8, 12, 20], 'work items of active PRs last 10 minutes')

  clock.now += 50 * MINUTE
  await source.full(ME, PROJECTS)
  assert.deepEqual(tally(), [10, 8, 10, 19, 25], 'work items of completed PRs last an hour')
})

test('reviews asks only for the to-review list of each project', async () => {
  const { ado, source } = setup()
  const review = await source.reviews(ME, PROJECTS)
  assert.deepEqual(review.map(pr => pr.prId), [4110, 4111])
  assert.equal(ado.calls.length, 2)
  assert.ok(ado.calls.every(isReviewList))
  assert.deepEqual(
    ado.calls.map(call => Object.fromEntries(call.query)),
    PROJECTS.map(() => ({ 'searchCriteria.reviewerId': ME, 'searchCriteria.status': 'active', $top: '100', 'api-version': '7.1' }))
  )
})
