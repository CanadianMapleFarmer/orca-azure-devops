import { assert, test } from 'orca/testing'
import type { RunSummary, RunsSnapshot } from '../../src/shared/pipelines'
import { runsFor } from '../../src/shared/runs'
import type { OrgStatus } from '../../src/shared/types'
import type { RawBuild } from '../ado/builds'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawTimeline } from '../ado/timeline'
import { json, ORG, ORG_URL, PROJECT, type AdoCall } from '../boards/fake-ado'
import { byteLength } from '../budget'
import { createEntities } from '../data/entities'
import { cacheKey, createPersisted, VALUE_BUDGET_BYTES, type Saved } from '../data/persist'
import { createSavedTables } from '../data/saved-tables'
import { isRepositories, PLATFORM } from '../prs/fake-prs'
import { drain, fakeClock, memoryCache, memoryStore, paced } from '../test-support'
import {
  APPROVAL_4520,
  APPROVAL_4531,
  buildIdOf,
  fakePipelines,
  GRACE,
  isApprovals,
  isBuildsByIds,
  isCheckSuite,
  isMineRuns,
  isOneBuild,
  isRunningRuns,
  isTimeline,
  ME,
  runsProjectOf,
  type FakePipelines
} from './fake-pipelines'
import { createNotifier } from './notify'
import { createPipelinesService } from './service'
import { createRunSignals, type RunSignals } from './signals'
import { createWatchList } from './watched'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SHOWING_SAVED = 'Showing what was saved last time. Refreshing…'
const WATCHED = `pipelines:watched:${ORG}`
const NOT_CONNECTED = 'Connect this organization first.'
const TRIMMED = 'Showing the newest runs only.'
const NEED_BUILD_READ = 'Pipelines need Build (Read) access.'
const LOAD_FAILED = "Couldn't load pipeline runs."
const APPROVALS_NEED_ACCESS = 'Pending approvals need more access, so Needs me may be incomplete.'
const APPROVALS_UNREADABLE = "Some pending approvals couldn't be read, so Needs me may be incomplete."
const ENVIRONMENTS_UNREAD = "Some approval environments couldn't be read."
const TOO_MANY_WATCHED = 'You can watch up to 20 runs.'
const ALREADY_FINISHED = 'This run has already finished.'
const RUN_GONE = "That run no longer exists, or you can't see it."
const OUTAGE = 'TF246017: the database is unavailable.'
const ACTIVE = [4520, 4531]
const FINISHED = [4490, 4498, 4505, 4512]

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

function harness(
  options: { store?: ReturnType<typeof memoryStore>; signals?: (now: () => number) => RunSignals; cache?: Record<string, unknown>; at?: number } = {}
) {
  const ado = fakePipelines()
  const clock = fakeClock(options.at ?? T0)
  const posts: RunsSnapshot[] = []
  const updates: [string, RunSummary[] | null][] = []
  const failing = { orgs: false }
  const memory = options.store ?? memoryStore()
  let orgs = [status()]
  const { pressure, scheduler } = paced(clock)
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {}, observe: pressure.observe })
  const entities = createEntities(clock.now)
  const cache = memoryCache(options.cache)
  const persisted = createPersisted({ port: cache.port, orgs: async () => structuredClone(orgs), now: clock.now, clock, log: () => {} })
  const service = createPipelinesService({
    http,
    orgs: async () => {
      if (failing.orgs) throw new Error('the org list could not be read')
      return structuredClone(orgs)
    },
    scheduler,
    watchList: createWatchList(memory.store),
    signals: options.signals?.(clock.now) ?? { update: (org, runs) => updates.push([org, runs === null ? null : structuredClone([...runs])]) },
    post: snapshot => posts.push(structuredClone(snapshot)),
    now: clock.now,
    entities,
    persisted,
    savedTables: createSavedTables(entities, persisted)
  })
  return {
    ado,
    clock,
    posts,
    updates,
    failing,
    service,
    scheduler,
    pressure,
    cache,
    persisted,
    data: memory.data,
    setOrgs(next: OrgStatus[]) {
      orgs = next
      service.onOrgs(structuredClone(next))
    },
    show(visible = true) {
      return service.visibility({ org: ORG, visible })
    }
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function ids(runs: readonly RunSummary[] | null | undefined): number[] {
  return (runs ?? []).map(run => run.buildId)
}

function runOf(snapshot: RunsSnapshot | undefined, buildId: number): RunSummary {
  return snapshot?.runs.find(run => run.buildId === buildId) ?? assert.fail(`no run ${buildId}`)
}

function timelines(calls: readonly AdoCall[]): number[] {
  return calls.filter(isTimeline).map(buildIdOf).sort()
}

function tally(calls: readonly AdoCall[]) {
  return {
    repositories: calls.filter(isRepositories).length,
    mine: calls.filter(isMineRuns).length,
    running: calls.filter(isRunningRuns).length,
    approvals: calls.filter(isApprovals).length,
    batches: calls.filter(isBuildsByIds).length,
    timelines: calls.filter(isTimeline).length,
    checkSuites: calls.filter(isCheckSuite).length,
    all: calls.length
  }
}

function addBuild(ado: FakePipelines, id: number, over: Partial<RawBuild>): RawBuild {
  const base = structuredClone(ado.runs.builds.get(4505) ?? assert.fail('no build 4505'))
  const raw: RawBuild = { ...base, id, buildNumber: `20261105.${id}`, _links: undefined, ...over }
  ado.runs.builds.set(id, raw)
  return raw
}

function finish(ado: FakePipelines, id: number, at: number, result = 'succeeded'): void {
  Object.assign(ado.runs.builds.get(id) ?? assert.fail(`no build ${id}`), { status: 'completed', result, finishTime: iso(at) })
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

test("a visible load reads each project's lists once and caps timelines", async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)

  assert.deepEqual(tally(h.ado.calls), { repositories: 1, mine: 2, running: 2, approvals: 2, batches: 0, timelines: 6, checkSuites: 1, all: 14 })
  assert.deepEqual(timelines(h.ado.calls).filter(id => ACTIVE.includes(id)), ACTIVE, 'every active run, at most 8')
  assert.deepEqual(timelines(h.ado.calls).filter(id => FINISHED.includes(id)), FINISHED, 'newly finished runs, once')

  const before = h.ado.calls.length
  await h.clock.tick(30_000)
  const later = h.ado.calls.slice(before)
  assert.deepEqual(tally(later), { repositories: 0, mine: 2, running: 2, approvals: 2, batches: 0, timelines: 2, checkSuites: 0, all: 8 })
  assert.deepEqual(timelines(later), ACTIVE, 'only active runs are read again')
  assert.equal(h.posts.length, 2)

  const busy = harness()
  for (let index = 0; index < 10; index += 1) {
    const queuedAt = T0 - 90 * MINUTE + index * MINUTE
    addBuild(busy.ado, 4600 + index, { status: 'inProgress', result: undefined, queueTime: iso(queuedAt), finishTime: undefined, requestedFor: { id: GRACE, displayName: 'Grace Hopper' } })
    addBuild(busy.ado, 4700 + index, { status: 'completed', result: 'succeeded', queueTime: iso(queuedAt), finishTime: iso(queuedAt + MINUTE) })
  }
  busy.setOrgs([status()])
  busy.show()
  await busy.clock.tick(0)
  const active = (id: number) => busy.ado.runs.builds.get(id)?.status === 'inProgress'
  const read = timelines(busy.ado.calls)
  assert.deepEqual([read.filter(active).length, read.filter(id => !active(id)).length], [8, 8], 'a cold load: 8 active runs and 8 newly finished')
  assert.deepEqual(tally(busy.ado.calls), { repositories: 1, mine: 2, running: 2, approvals: 2, batches: 0, timelines: 16, checkSuites: 1, all: 24 })
  const settled = busy.ado.calls.length
  await busy.clock.tick(30_000)
  const next = timelines(busy.ado.calls.slice(settled))
  assert.deepEqual([next.filter(active).length, next.filter(id => !active(id)).length], [8, 6], 'then the rest of the finished runs')
})

test('a background load reads my runs and approvals only and keeps the chips', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const full = h.posts.at(-1)
  h.show(false)

  const before = h.ado.calls.length
  await h.clock.tick(5 * MINUTE - 1)
  assert.equal(h.ado.calls.length, before, 'the hidden cadence is five minutes')
  await h.clock.tick(1)
  assert.deepEqual(tally(h.ado.calls.slice(before)), { repositories: 0, mine: 2, running: 0, approvals: 2, batches: 1, timelines: 0, checkSuites: 0, all: 5 })

  const background = h.posts.at(-1)
  assert.equal(h.posts.length, 2, 'once a full load exists, background loads are posted too')
  assert.deepEqual(ids(background?.runs), ids(full?.runs))
  assert.deepEqual(background?.runs.map(run => run.stages), full?.runs.map(run => run.stages))
  assert.equal(background?.updatedAt, T0 + 5 * MINUTE)

  const cold = harness()
  cold.setOrgs([status()])
  await cold.clock.tick(0)
  assert.deepEqual(tally(cold.ado.calls), { repositories: 1, mine: 2, running: 0, approvals: 2, batches: 1, timelines: 2, checkSuites: 1, all: 9 })
  assert.deepEqual(cold.posts, [], 'no snapshot is posted before a full load')
})

test('a waiting run carries its approval with the stage and environment', async () => {
  const h = harness()
  const snapshot = await h.service.snapshot(ORG)
  const run = runOf(snapshot, 4520)
  assert.equal(run.state, 'waiting')
  assert.deepEqual(run.stages?.map(chip => [chip.name, chip.state]), [['Build', 'succeeded'], ['Image', 'succeeded'], ['Deploy production', 'waiting']])
  assert.deepEqual(run.approvals.map(approval => [approval.approvalId, approval.stage, approval.environment, approval.canApprove]), [
    [APPROVAL_4520, 'Deploy production', 'production', false]
  ])
  assert.deepEqual({ ...snapshot, runs: [] }, { org: ORG, me: ME, runs: [], counts: { failedRuns: 1, approvals: 2 }, updatedAt: T0, stale: false })
  assert.deepEqual(h.posts, [snapshot])
})

test('Needs me and Failed come from the shared rules', async () => {
  const h = harness()
  const snapshot = await h.service.snapshot(ORG)
  assert.deepEqual(ids(snapshot.runs), [4531, 4520, 4512, 4505, 4498, 4490])
  assert.deepEqual(snapshot.counts, { failedRuns: 1, approvals: 2 })
  assert.deepEqual(ids(runsFor('needsMe', snapshot.runs, T0)), [4531, 4520])
  assert.deepEqual(ids(runsFor('failed', snapshot.runs, T0)), [4512], 'the older develop failure was replaced by a later run')
  assert.deepEqual(ids(runsFor('mine', snapshot.runs, T0)), [4520, 4512, 4505, 4498, 4490])
  assert.deepEqual(ids(runsFor('running', snapshot.runs, T0)), [4531, 4520])
})

test('every load updates the signals; an org that leaves clears them', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.deepEqual(h.updates.map(([org, runs]) => [org, ids(runs)]), [[ORG, [4531, 4520, 4512, 4505, 4498, 4490]]])
  assert.equal(h.posts.length, 0, 'a background load posts nothing before a full one')

  h.show()
  await drain()
  assert.equal(h.updates.length, 2, 'becoming visible ran a full load')
  assert.deepEqual(h.updates[1][1], h.posts.at(-1)?.runs)

  h.setOrgs([status({ state: 'expired' })])
  assert.deepEqual(h.updates.at(-1), [ORG, null])
  const calls = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, calls, 'the job is gone')
  assert.equal(h.service.cachedRun(ORG, 4520), null)

  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.updates.at(-1)?.[1]?.length, 6, 'reconnecting brings the job back')
  h.setOrgs([])
  assert.deepEqual(h.updates.at(-1), [ORG, null])
  h.setOrgs([status({ account: null })])
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.updates.at(-1), [ORG, null], 'an org without a pinned account has no job')
  assert.deepEqual(await rejection(h.service.refresh(ORG)), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('watching starts the watch job, a finished watched run is dropped and the job stops', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  h.show(false)

  const snapshot = await h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true })
  assert.equal(runOf(snapshot, 4531).watched, true)
  assert.deepEqual(h.posts.at(-1), snapshot, 'the recomputed snapshot is posted')
  assert.deepEqual(h.data[WATCHED], [{ projectId: PROJECT, buildId: 4531 }])
  assert.deepEqual([h.service.isWatched(ORG, 4531), h.service.isWatched(ORG, 4520)], [true, false])

  const before = h.ado.calls.length
  await h.clock.tick(30_000)
  const polls = h.ado.calls.slice(before)
  assert.deepEqual(polls.map(call => [call.query.get('buildIds'), call.path]), [
    ['4531', `/${ORG}/${PROJECT}/_apis/build/builds`],
    ['4531', `/${ORG}/${PROJECT}/_apis/build/builds`]
  ], 'one batch at once, then every 30 s, and nothing else')
  assert.deepEqual(runOf(h.posts.at(-1), 4531).approvals, runOf(snapshot, 4531).approvals, 'the merge keeps what the batch cannot know')
  assert.deepEqual(runOf(h.posts.at(-1), 4531).stages, runOf(snapshot, 4531).stages)
  assert.equal(runOf(h.posts.at(-1), 4531).state, 'waiting')

  finish(h.ado, 4531, T0 + 40_000)
  await h.clock.tick(30_000)
  const done = h.updates.at(-2)?.[1]?.find(run => run.buildId === 4531)
  assert.deepEqual([done?.state, done?.watched], ['succeeded', true], 'the signals see the finish while it is still watched')
  assert.equal(runOf(h.posts.at(-1), 4531).watched, false, 'then it is dropped')
  assert.deepEqual(h.updates.at(-1)?.[1], h.posts.at(-1)?.runs, 'and the signals take the posted list')
  assert.deepEqual(h.data[WATCHED], [])
  assert.equal(h.service.isWatched(ORG, 4531), false)

  const after = h.ado.calls.length
  await h.clock.tick(2 * MINUTE)
  assert.equal(h.ado.calls.length, after, 'the watch job stopped')

  const unwatch = harness()
  unwatch.setOrgs([status()])
  unwatch.show()
  await unwatch.clock.tick(0)
  await unwatch.service.watch({ org: ORG, projectId: PROJECT, buildId: 4520, watched: true })
  const stopped = await unwatch.service.watch({ org: ORG, projectId: PROJECT, buildId: 4520, watched: false })
  assert.equal(runOf(stopped, 4520).watched, false)
  assert.deepEqual(unwatch.data[WATCHED], [])
  await unwatch.clock.tick(0)
  unwatch.show(false)
  const quiet = unwatch.ado.calls.length
  await unwatch.clock.tick(2 * MINUTE)
  assert.equal(unwatch.ado.calls.length, quiet, 'unwatching the last run stops the watch job')
})

test('a watched run of someone else that fails is counted alike by the status bar and the snapshot and notifies once', async () => {
  const bar: Record<string, number | null> = {}
  const shown: { title: string; body: string }[] = []
  const h = harness({
    signals: now =>
      createRunSignals({
        bar: { setCount: (_org, kind, count) => void (bar[kind] = count) },
        notifier: createNotifier({
          show: async note => void shown.push(note),
          prefs: () => ({ failures: true, approvals: true, watched: true }),
          since: T0,
          log: message => assert.fail(message)
        }),
        now
      })
  })
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  await drain()
  h.show(false)
  const shownBefore = shown.length
  const watched = await h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true })
  assert.equal(runOf(watched, 4531).mine, false)

  finish(h.ado, 4531, T0 + 40_000, 'failed')
  await h.clock.tick(30_000)
  await drain()

  const posted = h.posts.at(-1)
  assert.equal(runOf(posted, 4531).watched, false)
  assert.equal(bar.failedRuns, posted?.counts.failedRuns, 'the status bar and the snapshot count the same failures')
  assert.equal(bar.approvals, posted?.counts.approvals)
  assert.deepEqual(shown.slice(shownBefore).map(note => note.title), [`${runOf(posted, 4531).pipeline.name} failed`], 'the finish notifies once')
  await h.clock.tick(30_000)
  await drain()
  assert.equal(shown.length, shownBefore + 1, 'and not again')
})

test("watching a loaded run stores the run's own project even when the caller names another", async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)

  await h.service.watch({ org: ORG, projectId: PLATFORM, buildId: 4531, watched: true })
  assert.deepEqual(h.data[WATCHED], [{ projectId: PROJECT, buildId: 4531 }])
  const before = h.ado.calls.length
  await h.clock.tick(30_000)
  assert.deepEqual([...new Set(h.ado.calls.slice(before).filter(isBuildsByIds).map(runsProjectOf))], [PROJECT], 'the watch job reads the run in its own project')
  assert.equal(h.service.isWatched(ORG, 4531), true, 'it is not dropped as gone')

  await h.service.watch({ org: ORG, projectId: PLATFORM, buildId: 4531, watched: false })
  assert.deepEqual(h.data[WATCHED], [])
})

test('watching a finished run or a 21st run is refused', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const posts = h.posts.length
  const finished = await rejection(h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4512, watched: true }))
  assert.deepEqual([finished.code, finished.status, finished.message], ['bad_request', 400, ALREADY_FINISHED])
  assert.equal(h.data[WATCHED], undefined)
  assert.equal(h.posts.length, posts)
  assert.equal(runOf(await h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4512, watched: false }), 4512).watched, false, 'unwatching is never refused')

  const keys = Array.from({ length: 20 }, (_, index) => ({ projectId: PROJECT, buildId: 5000 + index }))
  const full = harness({ store: memoryStore({ [WATCHED]: keys }) })
  const tooMany = await rejection(full.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true }))
  assert.deepEqual([tooMany.code, tooMany.status, tooMany.message], ['bad_request', 400, TOO_MANY_WATCHED])
  assert.deepEqual(full.data[WATCHED], keys)
  assert.deepEqual(full.ado.calls.filter(isBuildsByIds).map(call => call.query.get('buildIds')), ['4531'], 'a run not loaded yet is read fresh')
  assert.deepEqual(full.posts, [])

  const fresh = harness()
  finish(fresh.ado, 4531, T0 - MINUTE)
  assert.equal((await rejection(fresh.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true }))).message, ALREADY_FINISHED)
  const gone = await rejection(fresh.service.watch({ org: ORG, projectId: PROJECT, buildId: 9999, watched: true }))
  assert.deepEqual([gone.code, gone.status, gone.message], ['not_found', 404, RUN_GONE])
  assert.deepEqual(await rejection(fresh.service.watch({ org: 'fabrikam', projectId: PROJECT, buildId: 4531, watched: true })), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('the watch list survives a restart', async () => {
  const store = memoryStore()
  const first = harness({ store })
  first.setOrgs([status()])
  const watched = await first.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true })
  assert.equal(runOf(watched, 4531).watched, true)
  first.scheduler.dispose()
  first.service.dispose()

  const second = harness({ store })
  assert.equal(second.service.isWatched(ORG, 4531), false, 'nothing is known before the first load')
  second.setOrgs([status()])
  await second.clock.tick(0)
  assert.equal(second.service.isWatched(ORG, 4531), true)
  assert.equal(second.updates.at(-1)?.[1]?.find(run => run.buildId === 4531)?.watched, true)
  assert.equal(runOf(await second.service.snapshot(ORG), 4531).watched, true)

  const before = second.ado.count(isBuildsByIds)
  await second.clock.tick(30_000)
  assert.equal(second.ado.count(isBuildsByIds), before + 1, 'the watch job runs again after a restart')

  finish(second.ado, 4531, T0 + 40_000)
  await second.clock.tick(30_000)
  assert.deepEqual(store.data[WATCHED], [])
  second.scheduler.dispose()
  second.service.dispose()
  const third = harness({ store })
  finish(third.ado, 4531, T0 + 40_000)
  third.setOrgs([status()])
  await third.clock.tick(0)
  assert.equal(third.updates.at(-1)?.[1]?.find(run => run.buildId === 4531)?.watched, false, 'a dropped run is not watched after a restart, so it cannot notify again')
})

function timesOf(h: ReturnType<typeof harness>, match: (call: AdoCall) => boolean): number[] {
  const times: number[] = []
  h.ado.on(
    call => {
      if (match(call)) times.push(h.clock.now() - T0)
      return false
    },
    () => json(500, {})
  )
  return times
}

const delay = (h: ReturnType<typeof harness>) =>
  h.pressure.observe({ org: ORG, path: '/_apis/build/builds' }, 200, new Headers({ 'X-RateLimit-Delay': '1' }))

test('a delayed org polls its runs at eight times the interval until the delay passes', async () => {
  const h = harness()
  const loads = timesOf(h, isMineRuns)
  h.setOrgs([status()])
  delay(h)
  h.show()
  await h.clock.tick(0)
  await h.clock.tick(330_000)
  assert.deepEqual([...new Set(loads)], [0, 240_000, 300_000, 330_000], 'every 240 s while delayed, then every 30 s from the moment the delay passes')
})

test('a delayed org polls its hidden runs again five minutes after the delay, not forty', async () => {
  const h = harness()
  const loads = timesOf(h, isMineRuns)
  h.setOrgs([status()])
  delay(h)
  await h.clock.tick(0)
  await h.clock.tick(15 * MINUTE)
  assert.deepEqual([...new Set(loads)], [0, 300_000, 600_000, 900_000])
})

test('a delayed org watches its runs at eight times the interval until the delay passes', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  await h.clock.tick(100_000)
  const batches = timesOf(h, isBuildsByIds)
  delay(h)
  await h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true })
  await h.clock.tick(330_000)
  assert.deepEqual([...new Set(batches)], [100_000, 340_000, 400_000, 430_000], 'every 240 s while delayed, then every 30 s from the moment the delay passes')
})

test('a forbidden builds list pauses the org; a forbidden approvals list only turns approvals off', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const good = h.posts.at(-1)

  h.ado.on(isMineRuns, () => json(403, { message: 'TF215106: Access denied.' }))
  await h.clock.tick(30_000)
  assert.deepEqual(h.posts.at(-1), { ...good, stale: true, message: NEED_BUILD_READ })

  const calls = h.ado.calls.length
  await h.clock.tick(10 * MINUTE - 1)
  assert.equal((await h.service.snapshot(ORG)).message, NEED_BUILD_READ)
  assert.equal((await h.service.refresh(ORG)).message, NEED_BUILD_READ)
  assert.equal(h.ado.calls.length, calls, 'no calls for 10 minutes')
  await h.clock.tick(1)
  await h.service.refresh(ORG)
  assert.ok(h.ado.calls.length > calls, 'loads resume after 10 minutes')

  const fresh = harness()
  fresh.ado.on(isRunningRuns, () => json(403, { message: 'TF215106: Access denied.' }))
  assert.deepEqual(await rejection(fresh.service.refresh(ORG)), new AdoError('forbidden', 403, NEED_BUILD_READ))
  const before = fresh.ado.calls.length
  assert.equal((await rejection(fresh.service.snapshot(ORG))).message, NEED_BUILD_READ)
  assert.equal(fresh.ado.calls.length, before)
  assert.deepEqual(fresh.posts, [])

  const approvals = harness()
  approvals.ado.on(isApprovals, () => json(403, { message: 'TF400813: not authorized.' }))
  approvals.setOrgs([status()])
  approvals.show()
  await approvals.clock.tick(0)
  const snapshot = approvals.posts.at(-1)
  assert.deepEqual([snapshot?.stale, snapshot?.message, snapshot?.counts], [false, APPROVALS_NEED_ACCESS, { failedRuns: 1, approvals: 0 }])
  assert.equal(runOf(snapshot, 4520).state, 'running')
  const tried = approvals.ado.count(isApprovals)
  await approvals.clock.tick(9 * MINUTE)
  assert.equal(approvals.ado.count(isMineRuns), 38, 'runs keep loading every 30 s')
  assert.equal(approvals.ado.count(isApprovals), tried, 'approvals are not asked for 10 minutes')
  assert.equal(approvals.posts.at(-1)?.message, APPROVALS_NEED_ACCESS)
})

test('approval details that cannot be read are reported while the runs keep loading', async () => {
  const environments = harness()
  environments.ado.on(isCheckSuite, () => json(403, { message: 'TF400813: not authorized.' }))
  environments.setOrgs([status()])
  environments.show()
  await environments.clock.tick(0)
  const first = environments.posts.at(-1)
  assert.deepEqual([first?.stale, first?.message, first?.counts], [false, ENVIRONMENTS_UNREAD, { failedRuns: 1, approvals: 2 }])
  assert.deepEqual(ids(first?.runs), [4531, 4520, 4512, 4505, 4498, 4490])
  assert.equal(runOf(first, 4520).approvals[0].environment, null)
  assert.equal(runOf(first, 4520).approvals[0].stage, 'Deploy production')
  const mine = environments.ado.count(isMineRuns)
  await environments.clock.tick(30_000)
  assert.ok(environments.ado.count(isMineRuns) > mine, 'the org is not paused')
  assert.deepEqual([environments.posts.at(-1)?.stale, environments.posts.at(-1)?.message], [false, ENVIRONMENTS_UNREAD])

  const approvals = harness()
  Reflect.deleteProperty(approvals.ado.runs.approvals.get(APPROVAL_4531) ?? assert.fail('no approval on 4531'), 'pipeline')
  approvals.setOrgs([status()])
  approvals.show()
  await approvals.clock.tick(0)
  const second = approvals.posts.at(-1)
  assert.deepEqual([second?.stale, second?.message, second?.counts], [false, APPROVALS_UNREADABLE, { failedRuns: 1, approvals: 1 }])
  assert.deepEqual(ids(second?.runs), [4531, 4520, 4512, 4505, 4498, 4490])
  assert.equal(runOf(second, 4520).state, 'waiting')
  assert.equal(runOf(second, 4531).state, 'running')
})

test('a failed refresh keeps the last snapshot as stale', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  const good = h.posts.at(-1)

  h.ado.on(isMineRuns, () => json(500, { message: OUTAGE }))
  const stale = await h.service.refresh(ORG)
  assert.deepEqual(stale, { ...good, stale: true, message: OUTAGE })
  assert.deepEqual(h.posts.at(-1), stale)
  const signalled = h.updates.length

  h.failing.orgs = true
  await h.clock.tick(30_000)
  assert.deepEqual(h.posts.at(-1), { ...good, stale: true, message: LOAD_FAILED }, 'a failure that is not from Azure DevOps says so plainly')
  assert.equal(h.updates.length, signalled, 'a failed load leaves the signals alone')

  const fresh = harness()
  fresh.ado.on(isMineRuns, () => json(500, { message: OUTAGE }))
  assert.equal((await rejection(fresh.service.refresh(ORG))).message, OUTAGE)
  assert.deepEqual(fresh.posts, [])
  const plain = harness()
  plain.failing.orgs = true
  assert.equal((await rejection(plain.service.snapshot(ORG))).message, LOAD_FAILED)
})

test('a snapshot over the post budget is trimmed with the message', async () => {
  const h = harness()
  for (let index = 0; index < 40; index += 1) {
    const queuedAt = T0 - (60 + index) * MINUTE
    addBuild(h.ado, 5000 + index, {
      queueTime: iso(queuedAt),
      finishTime: iso(queuedAt + MINUTE),
      definition: { id: 30 + index, name: `${index} ${'x'.repeat(7000)}` }
    })
  }
  const stages = fixtureTimeline(h.ado).records
  const many: RawTimeline = {
    changeId: 1,
    records: Array.from({ length: 15 }, (_, index) => ({ ...stages[0], id: `stage-${index}`, name: `Stage ${index}`, identifier: `S${index}`, order: index }))
  }
  h.ado.runs.timelines.set(4520, many)

  const snapshot = await h.service.snapshot(ORG)
  assert.ok(byteLength(snapshot) <= 240 * 1024, `${byteLength(snapshot)} bytes`)
  assert.equal(snapshot.message, TRIMMED)
  assert.deepEqual(ids(snapshot.runs).slice(0, 2), [4531, 4520], 'active runs are kept first')
  const kept = snapshot.runs.slice(2)
  assert.ok(kept.length > 0 && kept.length < 40)
  const newest = [...h.ado.runs.builds.values()].filter(raw => raw.status === 'completed').sort((a, b) => Date.parse(b.queueTime ?? '') - Date.parse(a.queueTime ?? ''))
  assert.deepEqual(ids(kept).sort(), newest.slice(0, kept.length).map(raw => raw.id).sort(), 'then the newest finished runs')
  assert.equal(runOf(snapshot, 4520).stages?.length, 12, 'at most 12 chips per run')
  assert.equal(h.service.cachedRun(ORG, 4520)?.stages?.length, 15, 'the worker keeps them all')
  assert.deepEqual(snapshot.counts, { failedRuns: 1, approvals: 2 }, 'counts are taken before trimming')
  assert.deepEqual(h.posts, [snapshot])
  await h.persisted.flush()
  const saved = (h.cache.data[cacheKey(ORG, 'runs')] as Saved<RunsSnapshot>).value
  assert.ok(byteLength(saved) <= VALUE_BUDGET_BYTES, `the saved copy is ${byteLength(saved)} bytes`)
  assert.ok(saved.runs.length > 2 && saved.runs.length < snapshot.runs.length)
  assert.equal(saved.message, TRIMMED)

  const small = harness()
  for (let index = 0; index < 60; index += 1) {
    const queuedAt = T0 - (60 + index) * MINUTE
    for (const project of [{ id: PROJECT, name: 'Fabrikam Web' }, { id: PLATFORM, name: 'Fabrikam Platform' }]) {
      addBuild(small.ado, (project.id === PROJECT ? 5000 : 6000) + index, { project, queueTime: iso(queuedAt), finishTime: iso(queuedAt + MINUTE) })
    }
  }
  const capped = await small.service.snapshot(ORG)
  assert.deepEqual([capped.runs.length, capped.message], [100, TRIMMED])
  assert.deepEqual(ids(capped.runs).slice(0, 2), [4531, 4520])
})

test('a removed job aborts its requests and nothing is posted after sign-out', async () => {
  const h = harness()
  const hung = h.ado.hang(isMineRuns)
  h.setOrgs([status()])
  h.show()
  await h.clock.tick(0)
  assert.equal(hung.length, 2)

  h.setOrgs([status({ state: 'disconnected', account: null })])
  await drain()
  assert.ok(hung.every(call => call.signal?.aborted), 'every request is aborted')
  assert.deepEqual(h.posts, [])
  assert.deepEqual(h.updates, [[ORG, null]])

  for (const after of [[status({ state: 'disconnected', account: null })], []]) {
    const late = harness()
    const held = late.ado.hold(isMineRuns)
    const loading = late.service.snapshot(ORG).catch(() => null)
    await drain()
    late.setOrgs(after)
    held.release()
    assert.equal(await loading, null)
    assert.deepEqual(late.posts, [], JSON.stringify(after))
    assert.ok(late.updates.every(([, runs]) => runs === null), 'nothing is signalled')
    assert.equal(late.service.cachedRun(ORG, 4520), null)
  }

  const disposed = harness()
  const stuck = disposed.ado.hang(isMineRuns)
  const answer = rejection(disposed.service.snapshot(ORG))
  await drain()
  disposed.scheduler.dispose()
  disposed.service.dispose()
  await drain()
  assert.ok(stuck.every(call => call.signal?.aborted))
  assert.deepEqual(await answer, new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('approval returns the cached pair, else reads it fresh', async () => {
  const h = harness()
  const snapshot = await h.service.snapshot(ORG)
  const calls = h.ado.calls.length
  const pair = await h.service.approval(ORG, { projectId: PROJECT, approvalId: APPROVAL_4520 })
  assert.deepEqual(pair, { run: runOf(snapshot, 4520), approval: runOf(snapshot, 4520).approvals[0] })
  assert.equal(h.ado.calls.length, calls, 'from the last snapshot')
  assert.deepEqual(h.service.cachedRun(ORG, 4520), runOf(snapshot, 4520))
  assert.equal(h.service.cachedRun(ORG, 1), null)

  const other = harness()
  const first = await other.service.approval(ORG, { projectId: PROJECT, approvalId: APPROVAL_4520 })
  assert.deepEqual([first?.run.buildId, first?.run.state, first?.approval.stage, first?.approval.environment], [4520, 'waiting', 'Deploy production', 'production'])
  assert.deepEqual([isApprovals, isOneBuild, isTimeline, isCheckSuite].map(match => other.ado.count(match)), [1, 1, 1, 1])
  assert.equal(other.ado.calls.length, 4, 'a fresh read and nothing else')

  other.ado.runs.approvals.delete(APPROVAL_4520)
  assert.equal(await other.service.approval(ORG, { projectId: PROJECT, approvalId: APPROVAL_4520 }), null, 'gone')
  assert.deepEqual(await rejection(other.service.approval('fabrikam', { projectId: PROJECT, approvalId: APPROVAL_4520 })), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('snapshot answers from memory for 30 s; refresh and becoming visible load in full', async () => {
  const h = harness()
  const [first, second] = await Promise.all([h.service.snapshot(ORG), h.service.snapshot(ORG)])
  assert.deepEqual(first, second)
  assert.equal(h.ado.count(isMineRuns), 2, 'loads are single-flight')
  await h.clock.tick(30_000 - 1)
  assert.deepEqual(await h.service.snapshot(ORG), first)
  assert.equal(h.ado.count(isMineRuns), 2)
  await h.clock.tick(1)
  await h.service.snapshot(ORG)
  assert.equal(h.ado.count(isMineRuns), 4)

  h.setOrgs([status()])
  await h.clock.tick(0)
  const lists = h.ado.count(isRunningRuns)
  const refreshed = await h.service.refresh(ORG)
  assert.equal(refreshed.updatedAt, T0 + 30_000)
  assert.equal(h.ado.count(isRunningRuns), lists + 2, 'a hidden refresh still loads in full')

  const shown = harness()
  shown.setOrgs([status()])
  await shown.clock.tick(0)
  await shown.clock.tick(10_000)
  assert.deepEqual(shown.show(), { ok: true })
  await drain()
  assert.equal(shown.ado.count(isRunningRuns), 2, 'becoming visible without a full snapshot loads one')
  assert.equal(await shown.service.me(ORG), ME)
  assert.deepEqual(await rejection(shown.service.me('fabrikam')), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('reloadFresh starts a full load after the one already running instead of joining it', async () => {
  const h = harness()
  const held = h.ado.hold(isMineRuns)
  const before = h.service.snapshot(ORG)
  await drain()
  assert.equal(h.ado.count(isMineRuns), 2, 'the first load has listed my runs')

  const fresh = h.service.reloadFresh(ORG)
  await drain()
  assert.equal(h.ado.count(isMineRuns), 2, 'and the fresh one waits for it')
  held.release()
  await before
  const reloaded = await fresh

  assert.equal(h.ado.count(isMineRuns), 4, 'a second full load listed my runs after the first')
  assert.deepEqual(h.posts.map(post => post.updatedAt), [T0, T0], 'both loads were posted')
  assert.deepEqual(h.posts.at(-1), reloaded)
  assert.deepEqual(await rejection(h.service.reloadFresh('fabrikam')), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

function fixtureTimeline(ado: FakePipelines): RawTimeline {
  return structuredClone(ado.runs.timelines.get(4520) ?? assert.fail('no timeline for 4520'))
}

async function savedRuns(): Promise<{ live: RunsSnapshot; cache: Record<string, unknown> }> {
  const before = harness()
  const live = await before.service.snapshot(ORG)
  await before.persisted.flush()
  return { live, cache: structuredClone(before.cache.data) }
}

test('the Pipelines tab paints saved runs at once, stale, then live', async () => {
  const { live, cache } = await savedRuns()
  const h = harness({ cache, at: T0 + 3 * HOUR })
  h.setOrgs([status()])
  const gate = h.ado.hold(() => true)

  const painted = await h.service.snapshot(ORG)
  assert.deepEqual(painted, { ...live, stale: true, message: SHOWING_SAVED })
  assert.equal(painted.updatedAt, T0)
  assert.ok(h.ado.calls.length <= 1, 'answered before the first request of the revalidation is answered')
  assert.equal(h.posts.length, 0)
  assert.equal(h.updates.length, 0, 'saved runs never reach the status bar or notifications')

  gate.release()
  await drain()
  const latest = h.posts.at(-1)
  assert.deepEqual([latest?.stale, latest?.message, latest?.updatedAt], [false, undefined, T0 + 3 * HOUR])
  assert.equal(h.ado.count(isRunningRuns), 2, 'the revalidation is a full load')
  assert.deepEqual(h.updates.map(([, runs]) => ids(runs)), [ids(latest?.runs)])
  assert.deepEqual(await h.service.snapshot(ORG), latest)
})

test('an approval in restored runs is read from Azure DevOps before it is shared', async () => {
  const { cache } = await savedRuns()
  const h = harness({ cache, at: T0 + HOUR })
  h.setOrgs([status()])
  const gate = h.ado.hold(isMineRuns)

  const painted = await h.service.snapshot(ORG)
  assert.deepEqual(runOf(painted, 4520).approvals.map(approval => approval.approvalId), [APPROVAL_4520])
  Object.assign(h.ado.runs.approvals.get(APPROVAL_4520) ?? assert.fail('no approval'), { status: 'approved' })

  assert.equal(await h.service.approval(ORG, { projectId: PROJECT, approvalId: APPROVAL_4520 }), null)
  assert.ok(
    h.ado.calls.some(call => isApprovals(call) && call.query.get('approvalIds') === APPROVAL_4520),
    'the approval was read from Azure DevOps, not taken from the saved runs'
  )
  assert.equal(h.service.cachedRun(ORG, 4520), null, 'saved runs are not handed out as live')
  gate.release()
})

test('watching a run in restored runs reads it first', async () => {
  const { cache } = await savedRuns()
  const h = harness({ cache, at: T0 + HOUR })
  h.setOrgs([status()])
  const gate = h.ado.hold(isMineRuns)

  const painted = await h.service.snapshot(ORG)
  assert.equal(runOf(painted, 4531).state, 'waiting', 'the saved copy shows it still going')
  finish(h.ado, 4531, T0 + 30 * MINUTE)

  assert.equal((await rejection(h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4531, watched: true }))).message, ALREADY_FINISHED)
  assert.deepEqual(h.ado.calls.filter(isBuildsByIds).map(call => call.query.get('buildIds')), ['4531'])
  assert.deepEqual(h.data[WATCHED] ?? [], [])

  const watching = await h.service.watch({ org: ORG, projectId: PROJECT, buildId: 4520, watched: true })
  assert.deepEqual([watching.stale, runOf(watching, 4520).watched], [true, true])
  assert.deepEqual(h.ado.calls.filter(isBuildsByIds).map(call => call.query.get('buildIds')), ['4531', '4520'])
  await h.clock.tick(30_000)
  assert.equal(h.updates.length, 0, 'the watch job waits for live runs instead of merging into saved ones')

  gate.release()
  await drain()
  assert.equal(h.posts.at(-1)?.stale, false)
  assert.ok(h.updates.length > 0)
  assert.ok(h.updates.every(([, runs]) => runs?.find(run => run.buildId === 4531)?.state !== 'waiting'), 'the signals only ever saw live runs')
})

test('finished runs restored from storage keep their stage chips without a timeline read', async () => {
  const { live, cache } = await savedRuns()
  const h = harness({ cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status()])

  await h.service.snapshot(ORG)
  await drain()
  const latest = h.posts.at(-1)
  assert.equal(latest?.stale, false)
  assert.deepEqual(timelines(h.ado.calls), ACTIVE, 'only active runs are read')
  for (const id of FINISHED) assert.deepEqual(runOf(latest, id).stages, runOf(live, id).stages, `run ${id} keeps its chips`)
  assert.equal(h.ado.count(isRepositories), 0, 'the saved code projects are still fresh')
})
