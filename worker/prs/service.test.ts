import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrSnapshot } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawThread } from '../ado/pr-review'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { byteLength } from '../budget'
import { createEntities } from '../data/entities'
import { cacheKey, createPersisted, VALUE_BUDGET_BYTES, type Saved } from '../data/persist'
import { createSavedTables } from '../data/saved-tables'
import type { Shown } from '../pipelines/notify'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock, memoryCache } from '../test-support'
import {
  fakePrs,
  isEvaluations,
  isMineActive,
  isMineCompleted,
  isPrList,
  isPrWorkItems,
  isRepositories,
  isReviewList,
  isThreads,
  ME,
  NO_PR_NOTIFICATIONS,
  PLATFORM,
  projectOf,
  threadsPrIdOf
} from './fake-prs'
import { createPrNotifier, type PrNotifier } from './notify'
import { createPrsService } from './service'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const OTHER_ACCOUNT = '5e6f7a8b-8888-4c9d-8e0f-1a2b3c4d5e6f'
const SHOWING_SAVED = 'Showing what was saved last time. Refreshing…'
const AUTO: AutoCompleteOptions = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: false }
const TRIMMED = 'Showing the newest pull requests only.'
const NEED_CODE_READ = 'Pull requests need Code (Read) access.'
const LOAD_FAILED = "Couldn't load pull requests."
const NOT_CONNECTED = 'Connect this organization first.'
const OUTAGE = 'TF246017: the database is unavailable.'
const WORK_ITEMS_NEED_ACCESS = 'Linked work items need more access, so sets are grouped by branch only.'
const CHECKS_NEED_ACCESS = 'Build and policy status need more access.'

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

function harness(options: { cache?: Record<string, unknown>; at?: number; notifier?: PrNotifier } = {}) {
  const ado = fakePrs()
  const clock = fakeClock(options.at ?? T0)
  const posts: PrSnapshot[] = []
  const counts: [string, number | null][] = []
  const failing = { orgs: false, settings: false }
  let orgs = [status()]
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const scheduler = createScheduler(clock)
  const entities = createEntities(clock.now)
  const cache = memoryCache(options.cache)
  const persisted = createPersisted({ port: cache.port, orgs: async () => structuredClone(orgs), now: clock.now, clock, log: () => {} })
  const service = createPrsService({
    http,
    orgs: async () => {
      if (failing.orgs) throw new Error('the org list could not be read')
      return structuredClone(orgs)
    },
    scheduler,
    autoComplete: () => {
      if (failing.settings) throw new Error('the settings could not be read')
      return AUTO
    },
    post: snapshot => posts.push(structuredClone(snapshot)),
    counts: (org, count) => counts.push([org, count]),
    now: clock.now,
    entities,
    persisted,
    savedTables: createSavedTables(entities, persisted),
    ...NO_PR_NOTIFICATIONS,
    ...(options.notifier ? { notifier: options.notifier } : {})
  })
  return {
    ado,
    clock,
    posts,
    counts,
    failing,
    service,
    scheduler,
    cache,
    persisted,
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
    evaluations: ado.count(isEvaluations),
    all: ado.calls.length
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

  assert.deepEqual(tally(h.ado), { repositories: 1, active: 2, completed: 2, review: 2, workItems: 7, evaluations: 5, all: 19 })
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
  assert.deepEqual(tally(h.ado), { repositories: 1, active: 3, completed: 2, review: 3, workItems: 7, evaluations: 5, all: 21 })
  assert.equal(h.posts.length, 2)
})

test('a background run asks only for reviews and updates the count', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado), { repositories: 1, active: 0, completed: 0, review: 2, workItems: 0, evaluations: 0, all: 3 })
  assert.deepEqual(h.counts, [[ORG, 1]])
  assert.deepEqual(h.posts, [], 'no snapshot is posted before its sets were loaded')

  await h.clock.tick(5 * MINUTE - 1)
  assert.equal(h.ado.calls.length, 3)
  await h.clock.tick(1)
  assert.deepEqual(tally(h.ado), { repositories: 1, active: 0, completed: 0, review: 4, workItems: 0, evaluations: 0, all: 5 })
  assert.deepEqual(h.posts, [])

  const snapshot = await h.service.snapshot(ORG)
  assert.equal(snapshot.sets.length, 3)
  h.ado.on(isReviewList, () => json(200, { value: [] }))
  await h.clock.tick(5 * MINUTE)
  assert.deepEqual(h.counts.at(-1), [ORG, 0])
  assert.deepEqual(h.posts.at(-1), { ...snapshot, toReview: [], toReviewCount: 0, reviewed: [] }, 'once the sets are loaded, a review update is posted')
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
  assert.deepEqual([background.ado.count(isMineActive), background.ado.count(isReviewList)], [2, 3], "the full load keeps the quiet project's review list the reviews load just read")
})

test('a code-project list limits the fan-out', async () => {
  const h = harness()
  h.setOrgs([status({ codeProjects: [{ id: PROJECT, name: 'Fabrikam Web' }] })])
  h.show()
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado), { repositories: 0, active: 1, completed: 1, review: 1, workItems: 7, evaluations: 5, all: 15 })
  assert.ok(h.ado.calls.filter(isPrList).every(call => projectOf(call) === PROJECT))
})

const INFRA_REPO = '9f0a1b2c-3333-4e7f-8a8b-5c6d7e8f9a01'

function inPlatform(pr: RawPullRequest): RawPullRequest {
  return { ...pr, repository: { ...pr.repository, id: INFRA_REPO, name: 'infra', project: { id: PLATFORM, name: 'Fabrikam Platform' } } }
}

function reviewsAlso(ado: ReturnType<typeof fakePrs>, extra: RawPullRequest[]): void {
  const listed = [...fixture<{ value: RawPullRequest[] }>('pull-requests-review').value, ...extra]
  ado.on(isReviewList, call => json(200, { value: listed.filter(pr => pr.repository.project.id === projectOf(call)) }))
}

function listedProjects(calls: readonly AdoCall[]) {
  return {
    active: calls.filter(isMineActive).map(projectOf).sort(),
    completed: calls.filter(isMineCompleted).map(projectOf).sort(),
    review: calls.filter(isReviewList).map(projectOf).sort()
  }
}

test("a visible PR tick lists only hot projects and keeps the cold projects' last results, until the next tick would be too late", async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const first = h.posts.at(-1)
  reviewsAlso(h.ado, [inPlatform(toReviewPr(4300, T0, 'Asked in a quiet project'))])

  let before = h.ado.calls.length
  await h.clock.tick(MINUTE)
  assert.deepEqual(listedProjects(h.ado.calls.slice(before)), { active: [PROJECT], completed: [], review: [PROJECT] }, 'minute 1')
  assert.deepEqual(h.posts.at(-1), { ...first, updatedAt: T0 + MINUTE }, 'the cold project and the completed lists keep their last results')

  before = h.ado.calls.length
  await h.clock.tick(2 * MINUTE)
  assert.deepEqual(
    listedProjects(h.ado.calls.slice(before)),
    { active: [PLATFORM, PROJECT], completed: [], review: [PLATFORM, PROJECT] },
    'minute 3: a quiet tab ticks every 2 minutes, so waiting for minute 5 could land at minute 7'
  )
  assert.equal(h.posts.at(-1)?.toReviewCount, 2)
})

test('a hidden PR tick reads every project', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  await h.clock.tick(MINUTE)
  h.show(false)

  for (let tick = 1; tick <= 3; tick += 1) {
    const before = h.ado.calls.length
    await h.clock.tick(5 * MINUTE)
    assert.deepEqual(listedProjects(h.ado.calls.slice(before)), { active: [], completed: [], review: [PLATFORM, PROJECT] }, `hidden tick ${tick}`)
  }
})

test('Refresh lists every project', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  await h.clock.tick(MINUTE)
  const every = { active: [PLATFORM, PROJECT], completed: [], review: [PLATFORM, PROJECT] }

  let before = h.ado.calls.length
  await h.service.refresh(ORG)
  assert.deepEqual(listedProjects(h.ado.calls.slice(before)), every, 'Refresh')
  before = h.ado.calls.length
  await h.service.reloadFresh(ORG)
  assert.deepEqual(listedProjects(h.ado.calls.slice(before)), every, 'a reload after an action')

  before = h.ado.calls.length
  await h.clock.tick(2 * MINUTE)
  assert.deepEqual(listedProjects(h.ado.calls.slice(before)), { active: [PROJECT], completed: [], review: [PROJECT] }, 'the next tick lists hot projects only')
})

test('Refresh during a visible tick in flight still lists every project', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const before = h.ado.calls.length
  const held = h.ado.hold(isMineActive)
  await h.clock.tick(MINUTE)

  const refreshed = h.service.refresh(ORG)
  await drain()
  held.release()
  await refreshed
  const listed = listedProjects(h.ado.calls.slice(before))
  assert.deepEqual(listed, { active: [PLATFORM, PROJECT, PROJECT], completed: [], review: [PLATFORM, PROJECT, PROJECT] }, 'the tick lists the hot project, then Refresh every project')
})

async function ticksUntil(h: ReturnType<typeof harness>, done: () => boolean, limitMs: number): Promise<number> {
  const start = h.clock.now()
  while (!done()) {
    if (h.clock.now() - start > limitMs) return assert.fail(`nothing within ${limitMs / MINUTE} minutes`)
    await h.clock.tick(1_000)
  }
  return h.clock.now() - start
}

test('a review request just after a cold project was read notifies within 5 minutes, visible or hidden', async () => {
  for (const visible of [true, false]) {
    const mode = visible ? 'visible' : 'hidden'
    const shown: Shown[] = []
    const notifier = createPrNotifier({ show: async note => shown.push(note), prefs: () => ({ reviews: true, comments: false }), log: () => {} })
    const h = harness({ notifier })
    h.setOrgs([status()])
    h.show(visible)
    await h.clock.tick(0)
    await h.clock.tick(10 * MINUTE)
    const coldReads = () => h.ado.calls.filter(call => isReviewList(call) && projectOf(call) === PLATFORM).length
    const read = coldReads()
    await ticksUntil(h, () => coldReads() > read, 5 * MINUTE)
    reviewsAlso(h.ado, [inPlatform(toReviewPr(4300, h.clock.now(), 'Asked in a quiet project'))])

    const waited = await ticksUntil(h, () => shown.length > 0, 10 * MINUTE)
    assert.ok(waited <= 5 * MINUTE, `${mode}: notified after ${waited / 1000} s`)
    assert.deepEqual(shown.map(note => note.title), ['Review requested: Pull Request 4300'], mode)
  }
})

async function minutesThatRan(h: ReturnType<typeof harness>, minutes: number): Promise<number[]> {
  const ran: number[] = []
  for (let minute = 1; minute <= minutes; minute += 1) {
    const before = h.ado.count(isReviewList)
    await h.clock.tick(MINUTE)
    if (h.ado.count(isReviewList) > before) ran.push(minute)
  }
  return ran
}

test('an unchanged PR poll backs off to 120 seconds', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  assert.deepEqual(await minutesThatRan(h, 8), [1, 3, 5, 7], 'every 2 minutes while nothing changes')

  reviewsAlso(h.ado, [toReviewPr(4300, T0, 'A new request')])
  assert.deepEqual(await minutesThatRan(h, 4), [1, 2, 4], 'a change brings it back to every minute, then it backs off again')
})

test('a hidden PR poll never backs off past 5 minutes', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  await minutesThatRan(h, 5)
  h.show(false)

  for (let tick = 1; tick <= 4; tick += 1) {
    const before = h.ado.count(isReviewList)
    await h.clock.tick(5 * MINUTE)
    assert.ok(h.ado.count(isReviewList) > before, `hidden tick ${tick}`)
  }
})

test('opening the PRs tab shows the last load at once, even when older than a minute, and refreshes it', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const last = h.posts.at(-1)
  h.show(false)
  await h.clock.tick(3 * MINUTE)

  const gate = h.ado.hold(() => true)
  const loads = h.ado.count(isMineActive)
  let answered: PrSnapshot | null = null
  const opening = h.service.snapshot(ORG).then(snapshot => (answered = snapshot))
  await drain()
  assert.deepEqual(answered, last, 'the last load, three minutes old, at once')

  gate.release()
  await opening
  await drain()
  assert.ok(h.ado.count(isMineActive) > loads, 'then it is loaded again')
  assert.deepEqual(h.posts.at(-1), { ...last, updatedAt: T0 + 3 * MINUTE })
})

test('the last load is shown at once only to the account it was loaded for', async () => {
  const h = harness()
  h.setOrgs([status()])
  assert.equal((await h.service.snapshot(ORG)).me, ME)
  h.setOrgs([status({ account: { ...status().account!, adoId: OTHER_ACCOUNT } })])

  const snapshot = await h.service.snapshot(ORG)
  assert.deepEqual([snapshot.me, snapshot.stale], [OTHER_ACCOUNT, false])
})

const GRACE = { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper' }

function commentAt(id: number, at: number, content: string): NonNullable<RawThread['comments']>[number] {
  return { id, author: GRACE, content, publishedDate: new Date(at).toISOString(), commentType: 'text' }
}

test('a new comment on a quiet PR notifies once within 10 minutes', async () => {
  for (const visible of [true, false]) {
    const mode = visible ? 'visible' : 'hidden'
    const shown: Shown[] = []
    const notifier = createPrNotifier({ show: async note => shown.push(note), prefs: () => ({ reviews: false, comments: true }), log: () => {} })
    const h = harness({ notifier })
    const open: RawThread = { id: 201, status: 'active', comments: [commentAt(1, T0 - HOUR, 'Please add a test.')] }
    h.ado.on(isThreads, call => json(200, { value: threadsPrIdOf(call) === 4101 ? [open] : [] }))
    h.setOrgs([status()])
    h.show(visible)
    await h.clock.tick(0)
    await h.clock.tick(30 * MINUTE)
    const reads = h.ado.calls.filter(call => isThreads(call) && threadsPrIdOf(call) === 4101).length
    assert.equal(reads, 5, `${mode}: its threads were re-read after 2 or more, then 4, 8 and 10 minutes`)

    open.comments?.push(commentAt(2, h.clock.now(), 'One more thing.'))
    await h.clock.tick(10 * MINUTE)
    assert.deepEqual(shown.map(note => note.title), ['New comment on Pull Request 4101'], mode)
    await h.clock.tick(10 * MINUTE)
    assert.equal(shown.length, 1, `${mode}: once`)
  }
})

test('a hidden observe lists my active PRs in every project at each 5-minute tick, cold ones included', async () => {
  const notifier = createPrNotifier({ show: async () => {}, prefs: () => ({ reviews: false, comments: true }), log: () => {} })
  const h = harness({ notifier })
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  h.show(false)

  let before = h.ado.calls.length
  await h.clock.tick(5 * MINUTE)
  assert.deepEqual(listedProjects(h.ado.calls.slice(before)).active, [], 'the tab load is under 10 minutes old, so its list is reused')
  for (let tick = 2; tick <= 4; tick += 1) {
    before = h.ado.calls.length
    await h.clock.tick(5 * MINUTE)
    assert.deepEqual(listedProjects(h.ado.calls.slice(before)), { active: [PLATFORM, PROJECT], completed: [], review: [PLATFORM, PROJECT] }, `hidden tick ${tick}`)
  }
})

test('a comment on my new PR in a cold project notifies within about 5 minutes while the PRs tab is hidden', async () => {
  const shown: Shown[] = []
  const notifier = createPrNotifier({ show: async note => shown.push(note), prefs: () => ({ reviews: false, comments: true }), log: () => {} })
  const h = harness({ notifier })
  const mine = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value
  const opened: RawPullRequest[] = []
  const threads: RawThread[] = []
  h.ado.on(isMineActive, call => json(200, { value: [...mine, ...opened].filter(pr => pr.repository.project.id === projectOf(call)) }))
  h.ado.on(isThreads, call => json(200, { value: threadsPrIdOf(call) === 4300 ? threads : [] }))
  h.setOrgs([status()])
  await h.clock.tick(0)
  await h.clock.tick(12 * MINUTE)

  opened.push(inPlatform(rawPr(4300, h.clock.now(), 'Opened in a quiet project')))
  await h.clock.tick(5 * MINUTE)
  threads.push({ id: 301, status: 'active', comments: [commentAt(1, h.clock.now(), 'Please rename this.')] })

  const waited = await ticksUntil(h, () => shown.length > 0, 15 * MINUTE)
  assert.ok(waited <= 5 * MINUTE, `notified after ${waited / 1000} s`)
  assert.deepEqual(shown.map(note => note.title), ['New comment on Pull Request 4300'])
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
  assert.deepEqual(snapshot.reviewed.map(pr => pr.prId), [4111])
  assert.deepEqual({ ...snapshot, sets: [], toReview: [], reviewed: [] }, {
    org: ORG,
    me: ME,
    sets: [],
    toReview: [],
    toReviewCount: 1,
    reviewed: [],
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
  assert.deepEqual(await h.service.snapshot(ORG), snapshot, 'an older one is answered at once')
  await drain()
  assert.equal(h.ado.count(isMineActive), 3, 'and loaded again')

  assert.deepEqual(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4101 }), search.prs[0])
  assert.deepEqual(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4110 }), snapshot.toReview[0])
  assert.equal(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 9999 }), null)
  assert.equal(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4105 })?.status, 'active')
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

  for (const flag of ['orgs', 'settings'] as const) {
    const plain = harness()
    plain.failing[flag] = true
    assert.equal((await rejection(plain.service.snapshot(ORG))).message, LOAD_FAILED, `snapshot, ${flag}`)
    assert.equal((await rejection(plain.service.refresh(ORG))).message, LOAD_FAILED, `refresh, ${flag}`)
  }
})

test('a forbidden PR list pauses PR loads for 10 minutes with the scope message', async () => {
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

test('a forbidden enrichment turns off only that enrichment for 10 minutes', async () => {
  const checksOk = { build: 'succeeded', policies: 'approved' }
  const cases = [
    { refused: isPrWorkItems, message: WORK_ITEMS_NEED_ACCESS, search: { workItemIds: [], checks: checksOk } },
    { refused: isEvaluations, message: CHECKS_NEED_ACCESS, search: { workItemIds: [1204, 1207], checks: null } }
  ]
  for (const { refused, message, search } of cases) {
    const h = harness()
    h.ado.on(refused, () => json(403, { message: 'TF401019: no access.' }))
    h.setOrgs([status()])
    h.show()
    await h.clock.tick(0)

    const snapshot = h.posts.at(-1)
    assert.deepEqual(snapshot?.sets.map(set => set.prs.map(pr => pr.prId)), [[4105], [4104], [4101, 4102, 4103]], message)
    const [pr] = snapshot?.sets[2].prs ?? []
    assert.deepEqual({ workItemIds: pr.workItemIds, checks: pr.checks }, search)
    assert.deepEqual([snapshot?.stale, snapshot?.message, snapshot?.toReviewCount], [false, message, 1])

    const tried = h.ado.count(refused)
    await h.clock.tick(9 * MINUTE)
    assert.equal(h.ado.count(isMineActive), 9, 'the lists keep loading, every 2 minutes once nothing changes, and the quiet project at minutes 3 and 7')
    assert.equal(h.ado.count(refused), tried, 'the refused enrichment is not asked for 10 minutes')
    assert.equal(h.posts.at(-1)?.message, message)

    await h.clock.tick(2 * MINUTE)
    assert.ok(h.ado.count(refused) > tried, 'and is asked again after 10 minutes')
  }
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
  assert.equal(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4101 }), null)

  h.setOrgs([status({ account: null })])
  const idle = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, idle, 'an org without a pinned account has no job')
  assert.equal((await rejection(h.service.refresh(ORG))).message, NOT_CONNECTED)
})

test('leaving or disposing aborts every PR load, whoever started it', async () => {
  const leaves = {
    'sign-out': (h: ReturnType<typeof harness>) => h.setOrgs([status({ state: 'disconnected', account: null })]),
    deactivate: (h: ReturnType<typeof harness>) => {
      h.scheduler.dispose()
      h.service.dispose()
    }
  }
  for (const [name, leave] of Object.entries(leaves)) {
    const h = harness()
    const hung = h.ado.hang(isPrList)
    const answer = rejection(h.service.snapshot(ORG))
    await drain()
    h.setOrgs([status()])
    h.show()
    await drain()
    assert.equal(hung.length, 4, `${name}: the job joined the load the snapshot started`)

    leave(h)
    await drain()
    assert.ok(hung.every(call => call.signal?.aborted), `${name}: every request is aborted`)
    assert.deepEqual(await answer, new AdoError('unauthorized', 401, NOT_CONNECTED))
    assert.deepEqual(h.posts, [])
    assert.ok(h.counts.every(([, count]) => count === null), `${name}: no count is set`)
    assert.deepEqual(await rejection(h.service.snapshot(ORG)), new AdoError('unauthorized', 401, NOT_CONNECTED), `${name}: no new load starts`)
    assert.deepEqual(h.posts, [])
  }
})

test("a job's own abort ends only its wait, not the load it joined", async () => {
  const h = harness()
  const held = h.ado.hold(isMineActive)
  const answer = h.service.snapshot(ORG)
  await drain()
  h.setOrgs([status()])
  h.show()
  await drain()
  h.scheduler.dispose()
  held.release()
  assert.equal((await answer).sets.length, 3)
  assert.equal(h.posts.length, 1)
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
    assert.equal(h.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 4101 }), null)
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
  await h.persisted.flush()
  const saved = (h.cache.data[cacheKey(ORG, 'prs')] as Saved<PrSnapshot>).value
  assert.ok(byteLength(saved) <= VALUE_BUDGET_BYTES, `the saved copy is ${byteLength(saved)} bytes`)
  assert.ok(saved.sets.length > 0 && saved.sets.length < snapshot.sets.length)
  assert.equal(saved.message, TRIMMED)

  const small = harness()
  const many = Array.from({ length: 60 }, (_, index) => rawPr(5000 + index, T0 - index * MINUTE, `Change ${index}`))
  const queue = Array.from({ length: 120 }, (_, index) => toReviewPr(6000 + index, T0 - index * MINUTE, `Review ${index}`))
  small.ado.on(isMineActive, call => json(200, { value: projectOf(call) === PROJECT ? many : [] }))
  small.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? queue : [] }))
  const capped = await small.service.snapshot(ORG)
  assert.deepEqual([capped.sets.length, capped.toReview.length, capped.toReviewCount, capped.message], [50, 100, 120, TRIMMED])
  assert.equal(capped.sets[0].prs[0].prId, 5000)
})

function votedPr(prId: number, createdAt: number, title: string, vote = 10): RawPullRequest {
  return rawPr(prId, createdAt, title, {
    createdBy: { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper' },
    reviewers: [{ id: ME, displayName: 'Alex Contoso', vote }]
  })
}

test('the snapshot carries at most 50 reviewed PRs within the post budget', async () => {
  const h = harness()
  const title = (prId: number) => `${prId} ${'x'.repeat(4000)}`
  const waiting = Array.from({ length: 5 }, (_, index) => toReviewPr(6000 + index, T0 - index * MINUTE, title(6000 + index)))
  const voted = Array.from({ length: 60 }, (_, index) => votedPr(7000 + index, T0 - index * MINUTE, title(7000 + index)))
  h.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? [...waiting, ...voted] : [] }))

  const snapshot = await h.service.snapshot(ORG)
  assert.ok(byteLength(snapshot) <= 240 * 1024, `${byteLength(snapshot)} bytes`)
  assert.equal(snapshot.message, TRIMMED)
  assert.deepEqual(snapshot.toReview.map(pr => pr.prId), waiting.map(pr => pr.pullRequestId), 'To review is fitted first')
  assert.ok(snapshot.reviewed.length > 0 && snapshot.reviewed.length < 50, `${snapshot.reviewed.length} reviewed`)
  assert.deepEqual(snapshot.reviewed.map(pr => pr.prId), voted.slice(0, snapshot.reviewed.length).map(pr => pr.pullRequestId))
  assert.deepEqual(h.posts, [snapshot])

  const small = harness()
  const many = Array.from({ length: 80 }, (_, index) => votedPr(7000 + index, T0 - index * MINUTE, `Voted ${index}`, index % 2 === 0 ? 10 : -5))
  small.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? many : [] }))
  const capped = await small.service.snapshot(ORG)
  assert.deepEqual([capped.reviewed.length, capped.toReview.length, capped.toReviewCount, capped.message], [50, 0, 0, TRIMMED])
  assert.deepEqual(capped.reviewed.map(pr => pr.prId), many.slice(0, 50).map(pr => pr.pullRequestId))
  assert.equal(small.service.cached(ORG, { projectId: PROJECT, repoId: REPO, prId: 7079 })?.prId, 7079, 'a PR left out of the post is still known to actions')
})

test('a background reviews-only poll moves a PR I voted on from To review to Reviewed by you', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  const first = await h.service.snapshot(ORG)
  assert.deepEqual([first.toReview.map(pr => pr.prId), first.reviewed.map(pr => pr.prId)], [[4110], [4111]])

  const listed = fixture<{ value: RawPullRequest[] }>('pull-requests-review').value
  for (const pr of listed) for (const reviewer of pr.reviewers ?? []) if (reviewer.id === ME) reviewer.vote = pr.pullRequestId === 4110 ? 10 : 5
  h.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? listed : [] }))
  await h.clock.tick(5 * MINUTE)

  const posted = h.posts.at(-1)
  assert.deepEqual([posted?.toReview, posted?.toReviewCount], [[], 0])
  assert.deepEqual(posted?.reviewed.map(pr => pr.prId), [4111, 4110])
  assert.equal(posted?.reviewed.find(pr => pr.prId === 4110)?.reviewers.find(reviewer => reviewer.id === ME)?.vote, 10)
  assert.deepEqual(posted?.sets, first.sets, 'the sets are kept from the last full load')
  assert.deepEqual(h.counts.at(-1), [ORG, 0])
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
  assert.equal(h.ado.count(isMineActive), 3, 'and the visible cadence picks up from the last run')
})

test('becoming visible during a background run still loads in full', async () => {
  const h = harness()
  const held = h.ado.hold(isReviewList)
  h.setOrgs([status()])
  await h.clock.tick(0)
  h.show()
  await drain()
  assert.equal(h.ado.count(isMineActive), 0, 'the background run is still in flight')

  held.release()
  await drain()
  assert.equal(h.ado.count(isMineActive), 2, 'a full load follows at once')
  assert.equal(h.posts.length, 1)
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

test('me answers the pinned account, and refuses an org that is not signed in or whose list cannot be read', async () => {
  const h = harness()
  assert.equal(await h.service.me(ORG), ME)
  assert.deepEqual(await rejection(h.service.me('fabrikam')), new AdoError('unauthorized', 401, NOT_CONNECTED))

  h.failing.orgs = true
  assert.equal((await rejection(h.service.me(ORG))).message, LOAD_FAILED)
  h.failing.orgs = false
  h.setOrgs([status({ account: null })])
  assert.deepEqual(await rejection(h.service.me(ORG)), new AdoError('unauthorized', 401, NOT_CONNECTED))
  assert.equal(h.ado.calls.length, 0)
})

test('reloadFresh waits for the load in flight and then runs a full load of its own', async () => {
  const alone = harness()
  const snapshot = await alone.service.reloadFresh(ORG)
  assert.equal(snapshot.sets.length, 3)
  assert.equal(alone.ado.count(isMineActive), 2)

  const h = harness()
  const held = h.ado.hold(isMineActive)
  const first = h.service.snapshot(ORG)
  await drain()
  const fresh = h.service.reloadFresh(ORG)
  await drain()
  assert.equal(h.ado.count(isMineActive), 2, 'it is waiting, not joining or starting a second load')

  held.release()
  await first
  await fresh
  assert.equal(h.ado.count(isMineActive), 4)
  assert.equal(h.posts.length, 2)
  assert.deepEqual(await rejection(h.service.reloadFresh('fabrikam')), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('a quiet PRs tab keeps loading in full without rewriting its saved copy until that copy is 15 minutes old', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const writes = () => h.cache.writes.filter(entry => entry === cacheKey(ORG, 'prs')).length
  const loads = h.ado.count(isMineActive)

  await h.clock.tick(14 * MINUTE)
  assert.ok(h.ado.count(isMineActive) >= loads + 7, 'the hot project kept loading every 2 minutes')
  assert.equal(writes(), 1, 'written once, after the first load')
  assert.deepEqual(h.cache.writes.filter((key, index) => h.cache.writes.indexOf(key) !== index), [], 'the PR records, the meta and the index are written once too')
  await h.clock.tick(2 * MINUTE)
  assert.equal(writes(), 2)
})

async function savedPrs(): Promise<{ live: PrSnapshot; cache: Record<string, unknown> }> {
  const before = harness()
  const live = await before.service.snapshot(ORG)
  await before.persisted.flush()
  return { live, cache: structuredClone(before.cache.data) }
}

test('saved PRs whose read finishes after the org expired are not served', async () => {
  const { cache } = await savedPrs()
  const h = harness({ cache, at: T0 + HOUR })
  h.setOrgs([status()])
  const painting = h.service.snapshot(ORG)
  h.setOrgs([status({ state: 'expired' })])

  assert.deepEqual(await rejection(painting), new AdoError('unauthorized', 401, NOT_CONNECTED))
  await drain()
  assert.deepEqual(h.posts, [])
  assert.deepEqual(h.counts.filter(([, count]) => count !== null), [])
})

test('the PRs tab paints saved PRs at once, stale, then live', async () => {
  const { live, cache } = await savedPrs()
  const h = harness({ cache, at: T0 + 3 * HOUR })
  h.setOrgs([status()])
  const gate = h.ado.hold(() => true)

  const painted = await h.service.snapshot(ORG)
  assert.deepEqual(painted, { ...live, stale: true, message: SHOWING_SAVED })
  assert.equal(painted.updatedAt, T0)
  assert.ok(h.ado.calls.length <= 1, 'answered before the first request of the revalidation is answered')
  assert.equal(h.posts.length, 0)
  assert.equal(h.counts.length, 0, 'saved counts are not shown as live')

  gate.release()
  await drain()
  const latest = h.posts.at(-1)
  assert.deepEqual([latest?.stale, latest?.message, latest?.updatedAt], [false, undefined, T0 + 3 * HOUR])
  assert.equal(h.ado.count(isMineActive), 2)
  assert.deepEqual(await h.service.snapshot(ORG), latest)
})

test('restored PRs never raise review or comment notifications', async () => {
  const { cache } = await savedPrs()
  const shown: Shown[] = []
  const notifier = createPrNotifier({ show: async n => shown.push(n), prefs: () => ({ reviews: true, comments: true }), log: () => {} })
  const h = harness({ cache, at: T0 + HOUR, notifier })
  const listed = fixture<{ value: RawPullRequest[] }>('pull-requests-review').value
  let review = [...listed, toReviewPr(4300, T0 + 30 * MINUTE, 'Arrived while Orca was closed')]
  h.ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? review : [] }))
  h.setOrgs([status()])

  assert.equal((await h.service.snapshot(ORG)).stale, true)
  await drain()
  assert.equal(h.posts.at(-1)?.stale, false)
  assert.equal(shown.length, 0, 'the first live load sets the baseline; the saved PRs never did')

  review = [...review, toReviewPr(4301, T0 + 2 * HOUR, 'Asked for after the restart')]
  await h.clock.tick(5 * MINUTE)
  assert.deepEqual(shown.map(note => note.title), ['Review requested: Pull Request 4301'])
})

test('saved PRs from another account are ignored', async () => {
  const { cache } = await savedPrs()
  const other = status({ account: { ...status().account!, adoId: OTHER_ACCOUNT } })
  const h = harness({ cache, at: T0 + HOUR })
  h.setOrgs([other])

  const snapshot = await h.service.snapshot(ORG)
  assert.deepEqual([snapshot.stale, snapshot.message, snapshot.me, snapshot.updatedAt], [false, undefined, OTHER_ACCOUNT, T0 + HOUR])
  assert.equal(h.ado.count(isMineActive), 2, 'it loaded from Azure DevOps instead')
})

test('a share of a restored PR reads it from Azure DevOps first', async () => {
  const { live, cache } = await savedPrs()
  const h = harness({ cache, at: T0 + HOUR })
  h.setOrgs([status()])
  const gate = h.ado.hold(isMineActive)

  await h.service.snapshot(ORG)
  await drain()
  assert.deepEqual(h.counts, [[ORG, live.toReviewCount]], 'the live review list has landed')
  const [mine, asked] = [live.sets[0].prs[0], live.toReview[0]]
  assert.deepEqual([h.service.cached(ORG, mine), h.service.cached(ORG, asked)], [null, null], 'while restored, a share reads the PR first')

  gate.release()
  await drain()
  assert.deepEqual([h.service.cached(ORG, mine)?.prId, h.service.cached(ORG, asked)?.prId], [mine.prId, asked.prId])
})
