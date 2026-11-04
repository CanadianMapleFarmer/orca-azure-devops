import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrSnapshot } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { byteLength } from '../budget'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock } from '../test-support'
import {
  fakePrs,
  isEvaluations,
  isMineActive,
  isMineCompleted,
  isPrList,
  isPrWorkItems,
  isRepositories,
  isReviewList,
  ME,
  PLATFORM,
  projectOf
} from './fake-prs'
import { createPrsService } from './service'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const AUTO: AutoCompleteOptions = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: false }
const TRIMMED = 'Showing the newest pull requests only.'
const NEED_CODE_READ = 'Pull requests need Code (Read) access.'
const LOAD_FAILED = "Couldn't load pull requests."
const NOT_CONNECTED = 'Connect this organization first.'
const OUTAGE = 'TF246017: the database is unavailable.'

function status(overrides: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all',
    ...overrides
  }
}

function harness() {
  const ado = fakePrs()
  const clock = fakeClock(T0)
  const posts: PrSnapshot[] = []
  const counts: [string, number | null][] = []
  const failing = { orgs: false }
  let orgs = [status()]
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const scheduler = createScheduler(clock)
  const service = createPrsService({
    http,
    orgs: async () => {
      if (failing.orgs) throw new Error('the org list could not be read')
      return structuredClone(orgs)
    },
    scheduler,
    autoComplete: () => AUTO,
    post: snapshot => posts.push(structuredClone(snapshot)),
    counts: (org, count) => counts.push([org, count]),
    now: clock.now
  })
  return {
    ado,
    clock,
    posts,
    counts,
    failing,
    service,
    setOrgs(next: OrgStatus[]) {
      orgs = next
      service.onOrgs(structuredClone(next))
    },
    show(visible = true) {
      return service.visibility({ org: ORG, visible })
    }
  }
}

function tally(ado: ReturnType<typeof fakePrs>) {
  return {
    repositories: ado.count(isRepositories),
    active: ado.count(isMineActive),
    completed: ado.count(isMineCompleted),
    review: ado.count(isReviewList),
    workItems: ado.count(isPrWorkItems),
    evaluations: ado.count(isEvaluations)
  }
}

function prIdOf(call: AdoCall): number {
  return Number(/pullRequests\/(\d+)\/workitems$/.exec(call.path)?.[1] ?? call.query.get('artifactId')?.split('/').pop())
}

async function rejection(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function rawPr(prId: number, createdAt: number, title: string, overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  const base = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value[1]
  return {
    ...structuredClone(base),
    pullRequestId: prId,
    title,
    sourceRefName: `refs/heads/feature/${prId}`,
    creationDate: new Date(createdAt).toISOString(),
    ...overrides
  }
}

function toReviewPr(prId: number, createdAt: number, title: string): RawPullRequest {
  return rawPr(prId, createdAt, title, {
    createdBy: { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper' },
    reviewers: [{ id: ME, displayName: 'Alex Contoso', vote: 0 }]
  })
}

test('a visible load fans out once per code project and caches the rest', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado), { repositories: 1, active: 2, completed: 2, review: 2, workItems: 7, evaluations: 5 })
  assert.deepEqual(h.ado.calls.filter(isMineActive).map(projectOf), [PLATFORM, PROJECT])
  assert.deepEqual(h.ado.calls.filter(isMineCompleted).map(projectOf), [PLATFORM, PROJECT])
  assert.deepEqual(h.ado.calls.filter(isReviewList).map(projectOf), [PLATFORM, PROJECT])
  assert.deepEqual(h.ado.calls.filter(isPrWorkItems).map(prIdOf).sort(), [4090, 4091, 4101, 4102, 4103, 4104, 4105])
  assert.deepEqual(h.ado.calls.filter(isEvaluations).map(prIdOf).sort(), [4101, 4102, 4103, 4104, 4105])

  const [active] = h.ado.calls.filter(isMineActive)
  const [completed] = h.ado.calls.filter(isMineCompleted)
  const [review] = h.ado.calls.filter(isReviewList)
  assert.deepEqual(Object.fromEntries(active.query), { 'searchCriteria.creatorId': ME, 'searchCriteria.status': 'active', $top: '100', 'api-version': '7.1' })
  assert.deepEqual(Object.fromEntries(completed.query), {
    'searchCriteria.creatorId': ME,
    'searchCriteria.status': 'completed',
    'searchCriteria.queryTimeRangeType': 'closed',
    'searchCriteria.minTime': new Date(T0 - 14 * DAY).toISOString(),
    $top: '50',
    'api-version': '7.1'
  })
  assert.deepEqual(Object.fromEntries(review.query), { 'searchCriteria.reviewerId': ME, 'searchCriteria.status': 'active', $top: '100', 'api-version': '7.1' })

  await h.clock.tick(MINUTE)
  assert.deepEqual(tally(h.ado), { repositories: 1, active: 4, completed: 2, review: 4, workItems: 7, evaluations: 5 })
  assert.equal(h.posts.length, 2)
})

test('a background run asks only for reviews and updates the count', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado), { repositories: 1, active: 0, completed: 0, review: 2, workItems: 0, evaluations: 0 })
  assert.deepEqual(h.counts, [[ORG, 1]])
  assert.deepEqual(h.posts, [], 'no snapshot is posted before its sets were loaded')

  await h.clock.tick(5 * MINUTE - 1)
  assert.equal(h.ado.count(isReviewList), 2)
  await h.clock.tick(1)
  assert.equal(h.ado.count(isReviewList), 4)
  assert.equal(h.ado.count(isMineActive), 0)
  assert.deepEqual(h.posts, [])

  const snapshot = await h.service.snapshot(ORG)
  assert.equal(snapshot.sets.length, 3)
  h.ado.on(isReviewList, () => json(200, { value: [] }))
  await h.clock.tick(5 * MINUTE)
  assert.deepEqual(h.counts.at(-1), [ORG, 0])
  assert.deepEqual(h.posts.at(-1), { ...snapshot, toReview: [], toReviewCount: 0 }, 'once the sets are loaded, a review update is posted')
})

test('loads are single-flight per org, and a full load waits for a reviews load in flight', async () => {
  const h = harness()
  const [first, second] = await Promise.all([h.service.snapshot(ORG), h.service.snapshot(ORG)])
  assert.deepEqual(first, second)
  assert.equal(h.ado.count(isMineActive), 2)

  const background = harness()
  const held = background.ado.hold(isReviewList)
  background.setOrgs([status()])
  await background.clock.tick(0)
  const full = background.service.snapshot(ORG)
  await drain()
  assert.equal(background.ado.count(isMineActive), 0, 'the full load waits')
  held.release()
  assert.equal((await full).sets.length, 3)
  assert.deepEqual([background.ado.count(isMineActive), background.ado.count(isReviewList)], [2, 4])
})

test('a code-project list limits the fan-out', async () => {
  const h = harness()
  h.setOrgs([status({ codeProjects: [{ id: PROJECT, name: 'Fabrikam Web' }] })])
  h.show()
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado), { repositories: 0, active: 1, completed: 1, review: 1, workItems: 7, evaluations: 5 })
  assert.ok(h.ado.calls.filter(isPrList).every(call => projectOf(call) === PROJECT))
})

test('the snapshot holds release sets, to-review PRs and the saved auto-complete options', async () => {
  const h = harness()
  const snapshot = await h.service.snapshot(ORG)

  assert.deepEqual(snapshot.sets.map(set => set.prs.map(pr => pr.prId)), [[4105], [4104], [4101, 4102, 4103]])
  const [, , search] = snapshot.sets
  assert.deepEqual({ ...search, prs: [] }, {
    key: `${ORG}:4101`,
    title: 'Add vehicle search filters',
    sources: ['feature/1204-vehicle-search'],
    workItemIds: [1204, 1207],
    prs: []
  })
  assert.deepEqual(search.prs[0].checks, { build: 'succeeded', policies: 'approved' })
  assert.deepEqual(snapshot.toReview.map(pr => pr.prId), [4110])
  assert.deepEqual({ ...snapshot, sets: [], toReview: [] }, {
    org: ORG,
    me: ME,
    sets: [],
    toReview: [],
    toReviewCount: 1,
    autoComplete: AUTO,
    updatedAt: T0,
    stale: false
  })
  assert.deepEqual(h.posts, [snapshot])
  assert.deepEqual(h.counts, [[ORG, 1]])

  const calls = h.ado.calls.length
  assert.deepEqual(await h.service.snapshot(ORG), snapshot)
  assert.equal(h.ado.calls.length, calls, 'a snapshot younger than a minute is answered from memory')
  await h.clock.tick(MINUTE)
  await h.service.snapshot(ORG)
  assert.equal(h.ado.count(isMineActive), 4, 'an older one is loaded again')

  assert.deepEqual(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4101 }), search.prs[0])
  assert.deepEqual(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4110 }), snapshot.toReview[0])
  assert.equal(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 9999 }), null)
  assert.deepEqual(h.service.activeMine(ORG).map(pr => pr.prId), [4101, 4102, 4103, 4104, 4105])

  const source = await h.service.source(ORG)
  assert.equal((await source.one({ projectId: PROJECT, repoId: REPO, prId: 4110 })).title, 'Harden the login redirect')
  assert.deepEqual(await rejection(h.service.snapshot('fabrikam')), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('a failed refresh keeps the last snapshot as stale', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const good = h.posts.at(-1)

  h.ado.on(isMineActive, () => json(500, { message: OUTAGE }))
  const stale = await h.service.refresh(ORG)
  assert.deepEqual(stale, { ...good, stale: true, message: OUTAGE })
  assert.deepEqual(h.posts.at(-1), stale)

  h.failing.orgs = true
  await h.clock.tick(MINUTE)
  assert.deepEqual(h.posts.at(-1), { ...good, stale: true, message: LOAD_FAILED }, 'a failure that is not from Azure DevOps says so plainly')

  const fresh = harness()
  fresh.ado.on(isMineActive, () => json(500, { message: OUTAGE }))
  assert.equal((await rejection(fresh.service.refresh(ORG))).message, OUTAGE)
  assert.deepEqual(fresh.posts, [])
})

test('a forbidden list pauses PR loads for 10 minutes with the scope message', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const good = h.posts.at(-1)

  h.ado.on(isReviewList, () => json(403, { message: 'TF401019: The Git repository does not exist or you do not have permissions.' }))
  await h.clock.tick(MINUTE)
  assert.deepEqual(h.posts.at(-1), { ...good, stale: true, message: NEED_CODE_READ })

  const calls = h.ado.calls.length
  await h.clock.tick(10 * MINUTE - 1)
  assert.equal((await h.service.snapshot(ORG)).message, NEED_CODE_READ)
  assert.equal((await h.service.refresh(ORG)).message, NEED_CODE_READ)
  assert.equal(h.ado.calls.length, calls, 'no PR calls for 10 minutes')

  await h.clock.tick(1)
  await h.service.refresh(ORG)
  assert.ok(h.ado.calls.length > calls, 'loads resume after 10 minutes')

  const fresh = harness()
  fresh.ado.on(isMineActive, () => json(403, { message: 'TF401019: no access.' }))
  assert.deepEqual(await rejection(fresh.service.refresh(ORG)), new AdoError('forbidden', 403, NEED_CODE_READ))
  const before = fresh.ado.calls.length
  assert.equal((await rejection(fresh.service.snapshot(ORG))).message, NEED_CODE_READ)
  assert.equal(fresh.ado.calls.length, before)
})

test('jobs and counts follow org status', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.deepEqual(h.counts, [[ORG, 1]])

  h.setOrgs([status({ state: 'expired' })])
  assert.deepEqual(h.counts, [[ORG, 1], [ORG, null]])
  const calls = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, calls, 'the job is gone')

  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.deepEqual(h.counts.at(-1), [ORG, 1])
  assert.ok(h.ado.calls.length > calls, 'reconnecting brings the job back')

  h.setOrgs([])
  assert.deepEqual(h.counts.at(-1), [ORG, null])
  assert.deepEqual(h.service.activeMine(ORG), [])

  h.setOrgs([status({ account: null })])
  const idle = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, idle, 'an org without a pinned account has no job')
  assert.equal((await rejection(h.service.refresh(ORG))).message, NOT_CONNECTED)
})

test('a load finishing after sign-out posts nothing', async () => {
  for (const after of [[status({ state: 'disconnected', account: null })], []]) {
    const h = harness()
    const held = h.ado.hold(isMineActive)
    const loading = h.service.snapshot(ORG).catch(() => null)
    await drain()
    h.setOrgs(after)
    held.release()
    await loading
    assert.deepEqual(h.posts, [], JSON.stringify(after))
    assert.ok(h.counts.every(([, count]) => count === null), 'no count is set')
    assert.deepEqual(h.service.activeMine(ORG), [])
  }
})

test('a snapshot over the post budget is trimmed with the message', async () => {
  const h = harness()
  const title = (prId: number) => `${prId} ${'x'.repeat(4000)}`
  const mine = Array.from({ length: 60 }, (_, index) => rawPr(5000 + index, T0 - index * MINUTE, title(5000 + index)))
  const review = Array.from({ length: 30 }, (_, index) => toReviewPr(6000 + index, T0 - index * MINUTE, title(6000 + index)))
  h.ado.on(isMineActive, call => json(200, { value: projectOf(call) === PROJECT ? mine : [] }))
  h.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? review : [] }))

  const snapshot = await h.service.snapshot(ORG)
  assert.ok(byteLength(snapshot) <= 240 * 1024, `${byteLength(snapshot)} bytes`)
  assert.equal(snapshot.message, TRIMMED)
  assert.ok(snapshot.sets.length > 0 && snapshot.sets.length < 60)
  assert.deepEqual(snapshot.sets.map(set => set.prs[0].prId), mine.slice(0, snapshot.sets.length).map(pr => pr.pullRequestId))
  assert.deepEqual(snapshot.toReview.map(pr => pr.prId), review.slice(0, snapshot.toReview.length).map(pr => pr.pullRequestId))
  assert.equal(snapshot.toReviewCount, 30)
  assert.deepEqual(h.posts, [snapshot])

  const small = harness()
  const many = Array.from({ length: 60 }, (_, index) => rawPr(5000 + index, T0 - index * MINUTE, `Change ${index}`))
  const queue = Array.from({ length: 120 }, (_, index) => toReviewPr(6000 + index, T0 - index * MINUTE, `Review ${index}`))
  small.ado.on(isMineActive, call => json(200, { value: projectOf(call) === PROJECT ? many : [] }))
  small.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? queue : [] }))
  const capped = await small.service.snapshot(ORG)
  assert.deepEqual([capped.sets.length, capped.toReview.length, capped.toReviewCount, capped.message], [50, 100, 120, TRIMMED])
  assert.equal(capped.sets[0].prs[0].prId, 5000)
})

test('becoming visible runs a full load when the last one is stale', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  await h.clock.tick(10_000)
  assert.equal(h.ado.count(isMineActive), 0)

  assert.deepEqual(h.show(), { ok: true })
  await drain()
  assert.equal(h.ado.count(isMineActive), 2, 'there was no full snapshot, though the last run was 10 s ago')
  assert.equal(h.posts.length, 1)

  h.show(false)
  await h.clock.tick(30_000)
  h.show()
  await drain()
  assert.equal(h.ado.count(isMineActive), 2, 'the full snapshot is 30 s old')
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isMineActive), 4, 'and the visible cadence picks up from the last run')
})

test('a removed job aborts its in-flight PR requests', async () => {
  const h = harness()
  const hung = h.ado.hang(isPrList)
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  assert.equal(hung.length, 4, 'at most 4 requests are in flight')

  h.setOrgs([status({ state: 'disconnected', account: null })])
  await drain()
  assert.ok(hung.every(call => call.signal?.aborted))
  assert.deepEqual(h.posts, [])
  assert.deepEqual(h.counts, [[ORG, null]])
})
