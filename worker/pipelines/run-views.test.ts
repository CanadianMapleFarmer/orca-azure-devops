import { assert, test } from 'orca/testing'
import type { RunView } from '../../src/shared/pipelines'
import type { OrgStatus } from '../../src/shared/types'
import type { RawBuild } from '../ado/builds'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawRecord, RawTimeline } from '../ado/timeline'
import { fixture, json, ORG, ORG_URL, PROJECT, type AdoCall } from '../boards/fake-ado'
import { byteLength } from '../budget'
import { createEntities } from '../data/entities'
import { PLATFORM } from '../prs/fake-prs'
import { fakeClock, paced } from '../test-support'
import {
  APPROVAL_4520,
  buildIdOf,
  fakePipelines,
  isApprovals,
  isCheckSuite,
  isLogLines,
  isLogs,
  isOneBuild,
  isTimeline,
  ME,
  type FakePipelines
} from './fake-pipelines'
import { createRunViews } from './run-views'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const MINUTE = 60_000
const ANSWER_BYTES = 900 * 1024
const RUN_GONE = "That run no longer exists, or you can't see it."
const NOT_CONNECTED = 'Connect this organization first.'
const TRIMMED = 'Some issue details were left out to keep this run view small.'
const CUT = 'Some steps were left out to keep this run view small.'
const OUTAGE = 'VS800075: The service is down for maintenance.'
const APPROVALS_NEED_ACCESS = 'Pending approvals need more access, so Needs me may be incomplete.'
const APPROVALS_UNREADABLE = "Some pending approvals couldn't be read, so Needs me may be incomplete."
const BAD_RUN = "That run can't be opened."
const IMAGE_4512 = '9a2b3c4d-6108-4b3c-8d4e-5f6a7b8c9e08'
const DEPLOY_4520 = '6b2c3d4e-6014-4b3c-8d4e-5f6a7b8c9d14'

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
  const ado = fakePipelines()
  const clock = fakeClock(T0)
  const changes: { org: string; buildId: number }[] = []
  const watched = new Set<number>()
  let orgs = [status()]
  const { pressure, scheduler } = paced(clock)
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {}, observe: pressure.observe })
  const views = createRunViews({
    http,
    orgs: async () => structuredClone(orgs),
    scheduler,
    watched: (org, buildId) => org === ORG && watched.has(buildId),
    changed: change => changes.push(change),
    now: clock.now,
    entities: createEntities(clock.now)
  })
  views.onOrgs(structuredClone(orgs))
  return {
    ado,
    clock,
    changes,
    watched,
    views,
    pressure,
    view: (buildId: number) => views.view({ org: ORG, projectId: PROJECT, buildId }),
    show: (buildId: number, visible = true) => views.setVisible({ org: ORG, visible, run: { projectId: PROJECT, buildId } }),
    setOrgs(next: OrgStatus[]) {
      orgs = next
      views.onOrgs(structuredClone(next))
    },
    since: (count: number) => tally(ado.calls.slice(count))
  }
}

function tally(calls: readonly AdoCall[]) {
  return {
    builds: calls.filter(isOneBuild).length,
    timelines: calls.filter(isTimeline).length,
    logs: calls.filter(isLogs).length,
    approvals: calls.filter(isApprovals).length,
    checkSuites: calls.filter(isCheckSuite).length,
    lines: calls.filter(isLogLines).length,
    all: calls.length
  }
}

const NO_CALLS = { builds: 0, timelines: 0, logs: 0, approvals: 0, checkSuites: 0, lines: 0, all: 0 }

function changeIds(calls: readonly AdoCall[]): (string | null)[] {
  return calls.filter(isTimeline).map(call => call.query.get('changeId'))
}

function build(ado: FakePipelines, id: number): RawBuild {
  return ado.runs.builds.get(id) ?? assert.fail(`no build ${id}`)
}

function adoError(code: AdoError['code'], status: number, message: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    assert.deepEqual([error.code, error.status, error.message], [code, status, message])
    return true
  }
}

function rawRecord(over: Partial<RawRecord>): RawRecord {
  return { id: '', type: 'Task', name: '', state: 'completed', result: 'failed', ...over }
}

function bigTimeline(steps: number, over: (n: number) => Partial<RawRecord>): RawTimeline {
  const records = [rawRecord({ id: 'stage', type: 'Stage', name: 'Build', identifier: 'Build' }), rawRecord({ id: 'job', parentId: 'stage', type: 'Job', name: 'Build' })]
  for (let n = 0; n < steps; n += 1) records.push(rawRecord({ id: `task-${n}`, parentId: 'job', name: `Step ${n}`, order: n, log: { id: n + 1 }, ...over(n) }))
  return { changeId: 9, records }
}

function recordsIn(view: RunView): number {
  return view.stages.reduce((total, stage) => total + 1 + stage.jobs.reduce((jobs, job) => jobs + 1 + job.steps.length, 0), 0)
}

function stageOf(view: RunView, id: string) {
  return view.stages.find(stage => stage.id === id) ?? assert.fail(`no stage ${id}`)
}

function logOf(lines: (n: number) => string, count: number) {
  return (call: AdoCall) => {
    const first = Number(call.query.get('startLine'))
    const last = Math.min(Number(call.query.get('endLine')), count)
    const value = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => lines(first + index))
    return json(200, { count: value.length, value })
  }
}

function serveLog(ado: FakePipelines, buildId: number, logId: number, count: number, lines: (n: number) => string): void {
  ado.on(call => isLogs(call) && buildIdOf(call) === buildId, () => json(200, { count: 1, value: [{ id: logId, lineCount: count }] }))
  ado.on(call => isLogLines(call) && buildIdOf(call) === buildId, logOf(lines, count))
}

test('view builds stages, failures and the waiting approval', async () => {
  const h = harness()
  h.watched.add(4520)
  const waiting = await h.view(4520)
  assert.deepEqual(h.since(0), { builds: 1, timelines: 1, logs: 1, approvals: 1, checkSuites: 1, lines: 0, all: 5 })
  assert.deepEqual(h.ado.calls.filter(isApprovals).map(call => call.query.get('approvalIds')), [APPROVAL_4520])
  assert.deepEqual([waiting.org, waiting.run.buildId, waiting.run.state, waiting.run.mine, waiting.run.watched], [ORG, 4520, 'waiting', true, true])
  assert.deepEqual(waiting.run.stages?.map(chip => [chip.name, chip.state]), [['Build', 'succeeded'], ['Image', 'succeeded'], ['Deploy production', 'waiting']])
  assert.deepEqual(waiting.stages.map(stage => [stage.name, stage.state, stage.approvalId, stage.canRetry]), [
    ['Build', 'succeeded', null, false],
    ['Image', 'succeeded', null, false],
    ['Deploy production', 'waiting', APPROVAL_4520, false]
  ])
  assert.deepEqual(
    waiting.run.approvals.map(approval => [approval.approvalId, approval.buildId, approval.stage, approval.environment, approval.canApprove]),
    [[APPROVAL_4520, 4520, 'Deploy production', 'production', false]]
  )
  assert.deepEqual([waiting.failures, waiting.canCancel, waiting.stale, waiting.message, waiting.updatedAt], [[], true, false, undefined, T0])

  const failed = await h.view(4512)
  assert.deepEqual([failed.run.state, failed.run.watched, failed.canCancel, failed.run.approvals], ['failed', false, false, []])
  assert.deepEqual(failed.failures.map(failure => [failure.stageId, failure.path, failure.logId, failure.issues.length]), [
    [IMAGE_4512, 'Image › Build image › Build and push image', 9, 2]
  ])
  assert.deepEqual(failed.failures[0].issues[0].file, { path: '/home/vsts/work/1/s/src/Api/Program.cs', line: 42, column: 17 })
  assert.equal(stageOf(failed, IMAGE_4512).canRetry, true)
  const image = stageOf(failed, IMAGE_4512).jobs[0]
  assert.deepEqual(image.steps.map(step => [step.name, step.logId, step.logLines]), [
    ['Initialize job', 7, 41],
    ['Log in to registry', 8, 29],
    ['Build and push image', 9, 240],
    ['Finalize Job', 10, 24]
  ])

  for (const [raw, canCancel] of [['cancelling', false], ['notStarted', true], ['postponed', true], ['somethingNew', true]] as const) {
    Object.assign(build(h.ado, 4505), { status: raw, result: undefined, finishTime: undefined })
    await h.clock.tick(MINUTE)
    assert.equal((await h.view(4505)).canCancel, canCancel, raw)
  }
})

test('a visible active run polls every five seconds and posts viewChanged only on change', async () => {
  const h = harness()
  await h.view(4520)
  const opened = h.ado.calls.length
  h.show(4520)
  await h.clock.tick(0)
  assert.deepEqual(h.since(opened), NO_CALLS, 'a view read moments ago is not read again')

  await h.clock.tick(5_000)
  assert.deepEqual(h.since(opened), { builds: 1, timelines: 1, logs: 1, approvals: 1, checkSuites: 0, lines: 0, all: 4 }, 'the place of the approval is kept')
  assert.deepEqual(h.changes, [], 'nothing changed')
  const second = h.ado.calls.length
  await h.clock.tick(4_999)
  assert.deepEqual(h.since(second), NO_CALLS)

  h.ado.on(call => isLogs(call) && buildIdOf(call) === 4520, () => json(200, { count: 1, value: [{ id: 4, lineCount: 61 }] }))
  await h.clock.tick(1)
  assert.equal(h.since(second).builds, 1)
  assert.deepEqual(h.changes, [{ org: ORG, buildId: 4520 }])
  await h.clock.tick(5_000)
  assert.deepEqual(h.changes, [{ org: ORG, buildId: 4520 }], 'the same view again posts nothing')
})

test('the second read sends the held changeId and merges the delta', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  assert.deepEqual(h.changes, [{ org: ORG, buildId: 4520 }], 'the first view is news to the tab')
  h.ado.on(call => isTimeline(call) && call.query.get('changeId') === '41', () => json(200, fixture('timeline-4520-delta')))

  await h.clock.tick(5_000)
  assert.deepEqual(changeIds(h.ado.calls), [null, '41'])
  assert.equal(h.ado.calls.filter(isApprovals).length, 1, 'no stage waits any more, so approvals are not read')
  assert.equal(h.changes.length, 2)
  const merged = await h.view(4520)
  assert.deepEqual([merged.run.state, merged.run.approvals], ['running', []])
  assert.deepEqual([stageOf(merged, DEPLOY_4520).state, stageOf(merged, DEPLOY_4520).approvalId], ['running', null])
  assert.deepEqual(merged.stages.map(stage => [stage.name, stage.jobs.flatMap(job => job.steps).length]), [['Build', 4], ['Image', 3], ['Deploy production', 0]])

  await h.clock.tick(5_000)
  assert.deepEqual(changeIds(h.ado.calls), [null, '41', '44'])
})

test('a delta that closes a parent loop with the held timeline leaves the view stale with the timeline message', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  const good = await h.view(4520)
  const held = fixture<RawTimeline>('timeline-4520')
  const stage = held.records.find(record => record.type === 'Stage') ?? assert.fail('no stage')
  const job = held.records.find(record => record.type === 'Job' && record.parentId !== stage.id && held.records.some(phase => phase.id === record.parentId && phase.parentId === stage.id)) ?? assert.fail('no job under the stage')
  h.ado.on(call => isTimeline(call) && call.query.get('changeId') === '41', () => json(200, { changeId: 44, records: [{ ...stage, parentId: job.id }] }))

  await h.clock.tick(5_000)
  const stale = await h.view(4520)
  assert.deepEqual({ ...stale, updatedAt: good.updatedAt }, { ...good, stale: true, message: 'Azure DevOps returned an unexpected run timeline.' })
  await h.clock.tick(5_000)
  assert.deepEqual(changeIds(h.ado.calls), [null, '41', '41'], 'the looping delta is never held')
})

test('a finished run polls the build every minute', async () => {
  const h = harness()
  h.show(4512)
  await h.clock.tick(0)
  assert.deepEqual(h.since(0), { builds: 1, timelines: 1, logs: 1, approvals: 0, checkSuites: 0, lines: 0, all: 3 })
  const loaded = h.ado.calls.length
  await h.clock.tick(MINUTE - 1)
  assert.deepEqual(h.since(loaded), NO_CALLS)
  await h.clock.tick(1)
  assert.deepEqual(h.since(loaded), { ...NO_CALLS, builds: 1, all: 1 })
  await h.clock.tick(MINUTE)
  assert.deepEqual(h.since(loaded), { ...NO_CALLS, builds: 2, all: 2 })
  assert.equal(h.changes.length, 1)
})

test('a finished run retried elsewhere resumes fast polling', async () => {
  const h = harness()
  h.show(4512)
  await h.clock.tick(0)
  const finished = h.ado.calls.length

  Object.assign(build(h.ado, 4512), { status: 'inProgress', result: undefined, finishTime: undefined })
  const timeline = h.ado.runs.timelines.get(4512) ?? assert.fail('no timeline 4512')
  for (const record of timeline.records) {
    if (record.id === IMAGE_4512) Object.assign(record, { state: 'inProgress', result: null, attempt: 2, finishTime: null })
  }
  timeline.changeId = 52
  await h.clock.tick(MINUTE)
  assert.deepEqual(h.since(finished), { builds: 1, timelines: 1, logs: 1, approvals: 0, checkSuites: 0, lines: 0, all: 3 })
  assert.deepEqual(changeIds(h.ado.calls.slice(finished)), [null], 'a full reload starts from no held timeline')
  assert.equal(h.changes.length, 2)
  const resumed = await h.view(4512)
  assert.deepEqual([resumed.run.state, resumed.canCancel, stageOf(resumed, IMAGE_4512).state, stageOf(resumed, IMAGE_4512).attempt], ['running', true, 'running', 2])

  const reloaded = h.ado.calls.length
  await h.clock.tick(5_000)
  assert.deepEqual(h.since(reloaded), { builds: 1, timelines: 1, logs: 1, approvals: 0, checkSuites: 0, lines: 0, all: 3 })
  assert.deepEqual(changeIds(h.ado.calls.slice(reloaded)), ['52'])
})

test('a run that disappears stops polling and says so', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  assert.equal(h.changes.length, 1)

  h.ado.runs.builds.delete(4520)
  await h.clock.tick(5_000)
  assert.deepEqual(h.changes, [{ org: ORG, buildId: 4520 }, { org: ORG, buildId: 4520 }], 'the tab hears that its run changed')
  const gone = h.ado.calls.length
  await assert.rejects(h.view(4520), adoError('not_found', 404, RUN_GONE))
  assert.equal(h.since(gone).builds, 1, 'the tab asks once and is told')
  const asked = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.since(asked), NO_CALLS, 'and nothing polls it any more')
  assert.equal(h.changes.length, 2)
})

test('a run asked for under another project leaves the open tab polling', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  await assert.rejects(h.views.view({ org: ORG, projectId: PLATFORM, buildId: 4520 }), adoError('not_found', 404, RUN_GONE))
  const asked = h.ado.calls.length
  await h.clock.tick(5_000)
  assert.deepEqual(
    h.ado.calls.slice(asked).filter(isOneBuild).map(call => call.path),
    [`/${ORG}/${PROJECT}/_apis/build/builds/4520`]
  )
})

test('nothing is posted after the org signs out', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  assert.equal(h.changes.length, 1)

  const hung = h.ado.hang(isOneBuild)
  await h.clock.tick(5_000)
  assert.equal(hung.length, 1, 'a poll is in flight')
  const asking = h.view(4520).then(
    () => assert.fail('the view is not answered'),
    (error: unknown) => error
  )
  h.setOrgs([status({ state: 'disconnected', account: null })])
  assert.equal(hung[0].signal?.aborted, true, 'signing out aborts the poll')
  assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await asking))

  const after = h.ado.calls.length
  h.show(4520)
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.since(after), NO_CALLS)
  assert.equal(h.changes.length, 1, 'nothing is posted for the org after it left')
  await assert.rejects(h.view(4520), adoError('unauthorized', 401, NOT_CONNECTED))
  await assert.rejects(h.views.log({ org: ORG, projectId: PROJECT, buildId: 4512, logId: 9 }), adoError('unauthorized', 401, NOT_CONNECTED))
  assert.deepEqual(h.since(after), NO_CALLS)
})

test('a hidden view stops polling', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  h.show(4520, false)
  const hidden = h.ado.calls.length
  assert.equal((await h.view(4520)).run.buildId, 4520)
  assert.deepEqual(h.since(hidden), NO_CALLS, 'the hidden view stays cached')
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.since(hidden), NO_CALLS)

  h.show(4520)
  await h.clock.tick(0)
  assert.equal(h.since(hidden).builds, 1, 'showing it again polls again')
  h.views.setVisible({ org: ORG, visible: false })
  const all = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.since(all), NO_CALLS, "hiding the org's run tabs stops them all")
})

test('hidden views are cached ten at a time and a visible one is never dropped', async () => {
  const h = harness()
  for (let id = 4600; id < 4611; id += 1) h.ado.runs.builds.set(id, { ...structuredClone(build(h.ado, 4505)), id })
  h.show(4600)
  await h.clock.tick(0)
  for (let id = 4601; id < 4611; id += 1) await h.view(id)
  const cached = h.ado.calls.length
  for (const id of [4600, 4602, 4610]) await h.view(id)
  assert.deepEqual(h.since(cached), NO_CALLS, 'the visible view and the newest hidden ones are cached')
  await h.view(4601)
  assert.equal(h.since(cached).builds, 1, 'the oldest hidden view was dropped')
})

test('a delayed org polls an active run view at forty seconds', async () => {
  const h = harness()
  const reads: number[] = []
  h.ado.on(
    call => {
      if (isOneBuild(call)) reads.push(h.clock.now() - T0)
      return isOneBuild(call) && reads.length === 1
    },
    call => json(200, structuredClone(build(h.ado, buildIdOf(call))), { 'x-ratelimit-delay': '2' })
  )
  h.show(4520)
  await h.clock.tick(0)
  await h.clock.tick(5 * MINUTE + 10_000)
  assert.deepEqual(reads, [0, 40_000, 80_000, 120_000, 160_000, 200_000, 240_000, 280_000, 300_000, 305_000, 310_000], 'eight times the five seconds, then five seconds from the moment the delay passes')
})

test('a run action reloads its open view in full at once', async () => {
  const h = harness()
  h.show(4512)
  await h.clock.tick(0)
  const before = h.ado.calls.length
  Object.assign(build(h.ado, 4512), { status: 'notStarted', result: undefined, finishTime: undefined })
  h.views.refreshNow(ORG, 4512)
  await h.clock.tick(0)
  assert.deepEqual(h.since(before), { builds: 1, timelines: 1, logs: 1, approvals: 0, checkSuites: 0, lines: 0, all: 3 }, 'without waiting a minute')
  assert.deepEqual(changeIds(h.ado.calls.slice(before)), [null])
  assert.equal(h.changes.length, 2)

  h.show(4520)
  await h.clock.tick(0)
  const active = h.ado.calls.length
  h.views.refreshNow(ORG, 4520)
  await h.clock.tick(0)
  assert.deepEqual(changeIds(h.ado.calls.slice(active)), [null], 'an active run drops its held timeline too')
  h.views.refreshNow(ORG, 4999)
  await h.clock.tick(0)
  assert.equal(h.ado.calls.filter(call => buildIdOf(call) === 4999).length, 0, 'a run without a view is not read')
})

test('a view over 900 KiB keeps three issues per record and says so', async () => {
  const h = harness()
  const issue = (n: number) => ({ type: 'error', message: `${n} ${'e'.repeat(1990)}` })
  const issues = Array.from({ length: 10 }, (_, n) => issue(n))
  const timeline = bigTimeline(40, () => ({ issues }))
  Object.assign(timeline.records[1], { issues })
  h.ado.runs.timelines.set(4490, timeline)

  const view = await h.view(4490)
  assert.equal(view.message, TRIMMED)
  assert.ok(byteLength(view) <= ANSWER_BYTES)
  const job = view.stages[0].jobs[0]
  assert.deepEqual([job.issues.length, job.steps.length], [3, 40])
  assert.ok(job.steps.every(step => step.issues.length === 3))
  assert.deepEqual([view.failures.length, view.failures.every(failure => failure.issues.length === 3)], [40, true])
  assert.equal((await h.view(4512)).message, undefined, 'a small view is left whole')
})

test('a timeline of thousands of records is cut to two thousand and says so', async () => {
  const h = harness()
  h.ado.runs.timelines.set(4490, bigTimeline(6_000, () => ({ result: 'succeeded' })))

  const view = await h.view(4490)
  assert.ok(byteLength(view) <= ANSWER_BYTES, `a view of ${byteLength(view)} bytes`)
  assert.equal(recordsIn(view), 2_000)
  assert.equal(view.message, CUT)
  const steps = view.stages[0].jobs[0].steps
  assert.deepEqual([steps.length, steps[0].name, steps.at(-1)?.name], [1_998, 'Step 0', 'Step 1997'], 'the steps from the end are the ones left out')
  assert.deepEqual(view.run.stages?.map(chip => chip.name), ['Build'])
  assert.equal((await h.view(4512)).message, undefined, 'a small view is left whole')
})

test('a view whose issues overflow the answer loses its issues, not its steps', async () => {
  const h = harness()
  const issues = Array.from({ length: 10 }, (_, n) => ({ type: 'error', message: `${n} ${'e'.repeat(1990)}` }))
  h.ado.runs.timelines.set(4490, bigTimeline(150, () => ({ issues, errorCount: 10 })))

  const view = await h.view(4490)
  assert.ok(byteLength(view) <= ANSWER_BYTES, `a view of ${byteLength(view)} bytes`)
  assert.equal(view.message, TRIMMED)
  const steps = view.stages[0].jobs[0].steps
  assert.deepEqual([steps.length, steps.every(step => step.issues.length === 0 && step.errorCount === 10)], [150, true], 'the counts stay')
  assert.deepEqual([view.failures.length, view.failures.every(failure => failure.issues.length === 0)], [150, true])
})

test('a view still too large after its issues go loses steps from the end', async () => {
  const h = harness()
  const issues = [{ type: 'error', message: 'e'.repeat(1990) }]
  h.ado.runs.timelines.set(4490, bigTimeline(1_000, n => ({ name: `Step ${n} ${'n'.repeat(5_000)}`, issues })))

  const view = await h.view(4490)
  assert.ok(byteLength(view) <= ANSWER_BYTES, `a view of ${byteLength(view)} bytes`)
  assert.equal(view.message, `${TRIMMED} ${CUT}`)
  const steps = view.stages[0].jobs[0].steps
  assert.ok(steps.length > 50 && steps.length < 200, `${steps.length} steps kept`)
  assert.deepEqual(steps.map(step => step.id), Array.from({ length: steps.length }, (_, n) => `task-${n}`), 'the first steps are the ones kept')
  assert.deepEqual(view.failures.map(failure => failure.stepId), steps.map(step => step.id), 'failures follow the steps')
  assert.ok(byteLength(view) > ANSWER_BYTES - 12_000, 'as many steps as fit are kept')
})

test('a run id that is not a positive safe integer is refused everywhere', async () => {
  const h = harness()
  const refused = adoError('bad_request', 400, BAD_RUN)
  for (const buildId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '4520' as unknown as number]) {
    await assert.rejects(h.views.view({ org: ORG, projectId: PROJECT, buildId }), refused)
    await assert.rejects(h.views.log({ org: ORG, projectId: PROJECT, buildId, logId: 4 }), refused)
    assert.throws(() => h.views.setVisible({ org: ORG, visible: true, run: { projectId: PROJECT, buildId } }), refused)
  }
  assert.equal(h.ado.calls.length, 0)
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, 0, 'nothing was marked visible')
})

test('a failed poll keeps the last view as stale, tells the tab once, recovers and pauses when throttled', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  const good = await h.view(4520)
  assert.deepEqual(h.changes, [{ org: ORG, buildId: 4520 }])

  let failing: (() => Response) | null = () => json(500, { message: OUTAGE })
  h.ado.on(call => failing !== null && isOneBuild(call), () => failing?.() ?? assert.fail('the failure ended'))
  await h.clock.tick(5_000)
  const stale = await h.view(4520)
  assert.deepEqual({ ...stale, updatedAt: good.updatedAt }, { ...good, stale: true, message: OUTAGE })
  assert.equal(h.changes.length, 2, 'the tab hears about the failure')
  await h.clock.tick(5_000)
  assert.equal(h.changes.length, 2, 'the same failure again is not news')
  assert.equal((await h.view(4520)).message, OUTAGE)

  failing = null
  await h.clock.tick(5_000)
  const recovered = await h.view(4520)
  assert.deepEqual({ ...recovered, updatedAt: good.updatedAt }, good, 'the stale mark and message are cleared')
  assert.equal(h.changes.length, 3, 'and the tab hears that too')

  failing = () => json(429, { message: 'Too many requests.' }, { 'retry-after': '90' })
  await h.clock.tick(5_000)
  const throttled = h.ado.calls.length
  assert.equal((await h.view(4520)).stale, true)
  assert.equal(h.pressure.state(ORG).resumeAt, h.clock.now() + 90_000, 'the org is blocked for what ADO asked')
  await h.clock.tick(80_000)
  assert.deepEqual(h.since(throttled), NO_CALLS, 'polling waits out the org\'s resumeAt')
  failing = null
  await h.clock.tick(10_000)
  assert.equal(h.since(throttled).builds, 1, 'and resumes after it')
  assert.equal((await h.view(4520)).stale, false)
})

test('approvals that cannot be read are reported on the view and the run keeps loading', async () => {
  const forbidden = harness()
  forbidden.ado.on(isApprovals, () => json(403, { message: 'TF400813: not authorized.' }))
  const noAccess = await forbidden.view(4520)
  assert.deepEqual([noAccess.stale, noAccess.message, noAccess.run.approvals, noAccess.run.state], [false, APPROVALS_NEED_ACCESS, [], 'running'])
  assert.equal(stageOf(noAccess, DEPLOY_4520).state, 'waiting')

  const malformed = harness()
  malformed.ado.on(isApprovals, () => json(200, { count: 1, value: 'nope' }))
  const unreadable = await malformed.view(4520)
  assert.deepEqual([unreadable.stale, unreadable.message, unreadable.run.approvals], [false, APPROVALS_UNREADABLE, []])

  const odd = harness()
  Reflect.deleteProperty(odd.ado.runs.approvals.get(APPROVAL_4520) ?? assert.fail('no approval on 4520'), 'pipeline')
  const skipped = await odd.view(4520)
  assert.deepEqual([skipped.message, skipped.run.approvals], [APPROVALS_UNREADABLE, []])
})

test('disposing the run views stops every poll and posts nothing more', async () => {
  const h = harness()
  h.show(4520)
  await h.clock.tick(0)
  assert.equal(h.changes.length, 1)

  const hung = h.ado.hang(isOneBuild)
  await h.clock.tick(5_000)
  assert.equal(hung.length, 1, 'a poll is in flight')
  const asking = h.view(4520).then(
    () => assert.fail('the view is not answered'),
    (error: unknown) => error
  )
  h.views.dispose()
  assert.equal(hung[0].signal?.aborted, true, 'disposing aborts the load')
  assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await asking))

  h.views.refreshNow(ORG, 4520)
  h.views.onOrgs([status()])
  h.show(4520)
  const after = h.ado.calls.length
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.since(after), NO_CALLS)
  assert.equal(h.changes.length, 1)
  await assert.rejects(h.view(4520), adoError('unauthorized', 401, NOT_CONNECTED))
})

test('runs.log reads the tail by default and earlier lines on request', async () => {
  const h = harness()
  serveLog(h.ado, 4520, 4, 2_500, n => `line ${n}`)
  const tail = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, logId: 4 })
  assert.deepEqual([tail.logId, tail.first, tail.lines.length, tail.lines[0], tail.lines.at(-1), tail.total], [4, 1501, 1000, 'line 1501', 'line 2500', 2500])
  assert.deepEqual(h.ado.calls.filter(isLogLines).map(call => [call.query.get('startLine'), call.query.get('endLine')]), [['1501', '2500']])
  assert.equal(h.ado.calls.filter(isLogs).length, 1, 'without a view the logs list gives the total')

  await h.view(4520)
  h.ado.on(call => isLogs(call) && buildIdOf(call) === 4520, () => json(200, { count: 1, value: [{ id: 4, lineCount: 2_600 }] }))
  const listed = h.ado.calls.length
  const earlier = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, logId: 4, first: 501 })
  assert.deepEqual([earlier.first, earlier.lines.length, earlier.lines[0], earlier.lines.at(-1), earlier.total], [501, 1000, 'line 501', 'line 1500', 2500])
  const end = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, logId: 4, first: 2001 })
  assert.deepEqual([end.first, end.lines.length, end.lines.at(-1), end.total], [2001, 500, 'line 2500', 2500])
  const past = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, logId: 4, first: 2501 })
  assert.deepEqual(past, { logId: 4, first: 2501, lines: [], total: 2500 })
  assert.deepEqual(h.since(listed), { ...NO_CALLS, lines: 2, all: 2 }, "the view's line count is the total")

  serveLog(h.ado, 4531, 3, 300, n => `short ${n}`)
  const short = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4531, logId: 3 })
  assert.deepEqual([short.first, short.lines.length, short.total], [1, 300, 300])
  const missing = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4531, logId: 77 })
  assert.deepEqual(missing, { logId: 77, first: 1, lines: [], total: 0 })

  for (const bad of [{ logId: -1 }, { logId: 1.5 }, { logId: 4, first: 0 }, { logId: 4, first: 2.5 }]) {
    await assert.rejects(h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, ...bad }), adoError('bad_request', 400, BAD_RUN))
  }
})

test('runs.log cuts long lines and caps a chunk by lines and bytes', async () => {
  const h = harness()
  serveLog(h.ado, 4520, 4, 3, n => (n === 2 ? `<script>${'x'.repeat(300_000)}` : `line ${n}`))
  const long = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4520, logId: 4 })
  assert.deepEqual(long.lines.map(line => line.length), [6, 2000, 6])
  assert.ok(long.lines[1].startsWith('<script>xxx') && long.lines[1].endsWith('…'))

  const wide = (n: number) => `${String(n).padStart(4, '0')} ${'w'.repeat(1495)}`
  serveLog(h.ado, 4531, 5, 1_000, wide)
  const tail = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4531, logId: 5 })
  assert.ok(byteLength(tail) <= ANSWER_BYTES, `a tail chunk of ${byteLength(tail)} bytes`)
  assert.ok(tail.lines.length < 1000 && tail.lines.length > 500)
  assert.deepEqual([tail.lines.at(-1), tail.first + tail.lines.length - 1, tail.total], [wide(1000), 1000, 1000], 'a tail read drops lines from its start')
  assert.equal(tail.lines[0], wide(tail.first))

  const earlier = await h.views.log({ org: ORG, projectId: PROJECT, buildId: 4531, logId: 5, first: 1 })
  assert.ok(byteLength(earlier) <= ANSWER_BYTES)
  assert.deepEqual([earlier.first, earlier.lines[0], earlier.lines.length], [1, wide(1), tail.lines.length], 'an earlier read drops lines from its end')
})
