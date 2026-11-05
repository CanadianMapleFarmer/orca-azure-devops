import { assert, test } from 'orca/testing'
import type { RunSummary } from '../../src/shared/pipelines'
import type { RawApproval } from '../ado/approvals'
import type { RawBuild } from '../ado/builds'
import { AdoError, createAdoHttp } from '../ado/http'
import { json, PROJECT, type AdoCall } from '../boards/fake-ado'
import { PLATFORM } from '../prs/fake-prs'
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
import { createRunSource } from './load'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const MINUTE = 60_000
const ORG = 'contoso'
const PROJECTS = [
  { id: PLATFORM, name: 'Fabrikam Platform' },
  { id: PROJECT, name: 'Fabrikam Web' }
]
const MALFORMED_BUILD = 'Azure DevOps returned an unexpected pipeline run response.'
const MALFORMED_APPROVAL = 'Azure DevOps returned an unexpected approval response.'

function setup() {
  const ado = fakePipelines()
  const clock = { now: T0 }
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, clock, source: createRunSource(http, ORG, () => clock.now) }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function addBuild(ado: FakePipelines, id: number, over: Partial<RawBuild> = {}): RawBuild {
  const base = structuredClone(ado.runs.builds.get(4505) ?? assert.fail('no build 4505'))
  const raw: RawBuild = { ...base, id, buildNumber: `20261105.${id}`, _links: undefined, ...over }
  ado.runs.builds.set(id, raw)
  return raw
}

function running(ado: FakePipelines, id: number, queuedAt: number, over: Partial<RawBuild> = {}): RawBuild {
  return addBuild(ado, id, {
    status: 'inProgress',
    result: undefined,
    queueTime: iso(queuedAt),
    startTime: iso(queuedAt + 5_000),
    finishTime: undefined,
    requestedFor: { id: GRACE, displayName: 'Grace Hopper' },
    ...over
  })
}

function finished(ado: FakePipelines, id: number, finishedAt: number, over: Partial<RawBuild> = {}): RawBuild {
  return addBuild(ado, id, { status: 'completed', result: 'succeeded', queueTime: iso(finishedAt - 5 * MINUTE), finishTime: iso(finishedAt), ...over })
}

function approvalOn(ado: FakePipelines, approvalId: string, buildId: number): RawApproval {
  const base = structuredClone(ado.runs.approvals.get(APPROVAL_4531) ?? assert.fail('no approval on 4531'))
  const raw: RawApproval = { ...base, id: approvalId, pipeline: { ...base.pipeline, owner: { id: buildId, name: `20261105.${buildId}` } } }
  ado.runs.approvals.set(approvalId, raw)
  return raw
}

function ids(runs: readonly RunSummary[]): number[] {
  return runs.map(run => run.buildId)
}

function timelineIds(calls: readonly AdoCall[]): number[] {
  return calls.filter(isTimeline).map(buildIdOf)
}

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('a full load unions my runs, running runs and approval runs, ordered, with the watched flag', async () => {
  const { ado, source } = setup()
  const { runs, off } = await source.full(ME, PROJECTS, [{ projectId: PROJECT, buildId: 4531 }])

  assert.deepEqual(ids(runs), [4531, 4520, 4512, 4505, 4498, 4490])
  assert.deepEqual(off, { approvals: false })
  const byId = new Map(runs.map(run => [run.buildId, run]))
  assert.deepEqual([byId.get(4531)?.watched, byId.get(4531)?.mine, byId.get(4520)?.watched, byId.get(4520)?.mine], [true, false, false, true])
  assert.deepEqual(runs.map(run => run.state), ['waiting', 'waiting', 'failed', 'succeeded', 'succeeded', 'failed'])

  assert.deepEqual([isMineRuns, isRunningRuns, isApprovals, isBuildsByIds].map(match => ado.count(match)), [2, 2, 2, 0])
  const [mine] = ado.calls.filter(isMineRuns)
  assert.deepEqual(Object.fromEntries(mine.query), {
    requestedFor: ME,
    minTime: iso(T0 - 7 * 24 * 60 * MINUTE),
    queryOrder: 'queueTimeDescending',
    $top: '50',
    'api-version': '7.1'
  })
  const [active] = ado.calls.filter(isRunningRuns)
  assert.deepEqual(Object.fromEntries(active.query), { statusFilter: 'inProgress', queryOrder: 'queueTimeDescending', $top: '25', 'api-version': '7.1' })
  assert.deepEqual(ado.calls.filter(isApprovals).map(runsProjectOf), [PLATFORM, PROJECT])
})

test('runs that approvals wait on or that are watched, but are not listed, come in one batch per project', async () => {
  const { ado, source } = setup()
  addBuild(ado, 4532, { status: 'notStarted', result: undefined, queueTime: iso(T0 - MINUTE), startTime: undefined, finishTime: undefined, requestedFor: { id: GRACE, displayName: 'Grace Hopper' } })
  approvalOn(ado, 'a0000000-0000-4000-8000-000000004532', 4532)
  finished(ado, 4401, T0 - 60 * MINUTE, { requestedFor: { id: GRACE, displayName: 'Grace Hopper' } })
  finished(ado, 4701, T0 - 90 * MINUTE, { requestedFor: { id: GRACE, displayName: 'Grace Hopper' }, project: { id: PLATFORM, name: 'Fabrikam Platform' } })

  const watched = [{ projectId: PROJECT, buildId: 4401 }, { projectId: PLATFORM, buildId: 4701 }, { projectId: PROJECT, buildId: 4520 }]
  const { runs } = await source.full(ME, PROJECTS, watched)
  const batches = ado.calls.filter(isBuildsByIds).map(call => [runsProjectOf(call), call.query.get('buildIds')?.split(',').map(Number).sort()])
  assert.deepEqual(batches.sort(), [[PLATFORM, [4701]], [PROJECT, [4401, 4532]]].sort())

  const byId = new Map(runs.map(run => [run.buildId, run]))
  assert.deepEqual([4532, 4401, 4701, 4520].map(id => [byId.get(id)?.state, byId.get(id)?.watched]), [
    ['waiting', false],
    ['succeeded', true],
    ['succeeded', true],
    ['waiting', true]
  ])
  assert.deepEqual(ids(runs).slice(0, 3), [4532, 4531, 4520], 'running runs first, newest first')

  const quiet = setup()
  await quiet.source.full(ME, PROJECTS, [{ projectId: PROJECT, buildId: 4520 }])
  assert.equal(quiet.ado.count(isBuildsByIds), 0, 'nothing to batch when every run is listed')
})

test('chips: at most 8 active runs every load, and at most 8 newly finished runs once per finish', async () => {
  const { ado, clock, source } = setup()
  for (let index = 0; index < 10; index += 1) running(ado, 4600 + index, T0 - 90 * MINUTE + index * MINUTE)
  for (let index = 0; index < 6; index += 1) finished(ado, 4700 + index, T0 - (100 + index) * MINUTE, { requestedFor: { id: ME, displayName: 'Alex Contoso' } })

  const first = await source.full(ME, PROJECTS, [])
  const activeFirst = [4531, 4520, 4609, 4608, 4607, 4606, 4605, 4604]
  const finishedFirst = [4512, 4700, 4701, 4702, 4703, 4704, 4705, 4505]
  assert.deepEqual(timelineIds(ado.calls).sort(), [...activeFirst, ...finishedFirst].sort())
  const byId = new Map(first.runs.map(run => [run.buildId, run]))
  assert.deepEqual(byId.get(4520)?.stages, [
    { id: '6b2c3d4e-6001-4b3c-8d4e-5f6a7b8c9d01', name: 'Build', state: 'succeeded' },
    { id: '6b2c3d4e-6008-4b3c-8d4e-5f6a7b8c9d08', name: 'Image', state: 'succeeded' },
    { id: '6b2c3d4e-6014-4b3c-8d4e-5f6a7b8c9d14', name: 'Deploy production', state: 'waiting' }
  ])
  assert.deepEqual(byId.get(4512)?.stages?.map(chip => chip.state), ['succeeded', 'failed', 'skipped'])
  assert.deepEqual(byId.get(4505)?.stages, [], 'a run with no stages has no chips')
  assert.deepEqual([byId.get(4603)?.stages, byId.get(4498)?.stages], [null, null], 'beyond the caps there are no chips yet')

  const before = ado.calls.length
  clock.now += 30_000
  await source.full(ME, PROJECTS, [])
  assert.deepEqual(timelineIds(ado.calls.slice(before)).sort(), [...activeFirst, 4498, 4490].sort(), 'the rest of the finished runs')

  const again = ado.calls.length
  const retried = ado.runs.builds.get(4512) ?? assert.fail('no build 4512')
  retried.finishTime = iso(T0 + 20_000)
  clock.now += 30_000
  await source.full(ME, PROJECTS, [])
  assert.deepEqual(timelineIds(ado.calls.slice(again)).sort(), [...activeFirst, 4512].sort(), 'a run that finished again is read again')
})

test('an approval is placed on its run timeline and named by its check suite, once', async () => {
  const { ado, clock, source } = setup()
  const { runs } = await source.full(ME, PROJECTS, [])
  const byId = new Map(runs.map(run => [run.buildId, run]))
  const [waiting] = byId.get(4520)?.approvals ?? []
  assert.deepEqual(waiting, {
    projectId: PROJECT,
    buildId: 4520,
    approvalId: APPROVAL_4520,
    stage: 'Deploy production',
    environment: 'production',
    approvers: [{ id: 'd4e5f6a7-5555-4d9e-9f0a-2b3c4d5e6f70', name: '[Fabrikam Web]\\Release Approvers', uniqueName: 'vstfs:///Classification/TeamProject/4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d\\Release Approvers', isGroup: true }],
    minRequired: 1,
    instructions: '',
    createdAt: Date.parse('2026-11-05T09:38:57.2000000Z'),
    canApprove: false
  })
  const [unplaced] = byId.get(4531)?.approvals ?? []
  assert.deepEqual([unplaced.approvalId, unplaced.stage, unplaced.environment, unplaced.canApprove], [APPROVAL_4531, null, null, true])
  assert.equal(ado.count(isCheckSuite), 1)
  assert.deepEqual(timelineIds(ado.calls).filter(id => id === 4520 || id === 4531).sort(), [4520, 4531], 'placement reuses the chip reads')

  clock.now += 30_000
  await source.full(ME, PROJECTS, [])
  assert.equal(ado.count(isCheckSuite), 1, 'the place is cached by approval id')

  const background = setup()
  await background.source.background(ME, PROJECTS, [])
  assert.deepEqual(timelineIds(background.ado.calls).sort(), [4520, 4531], 'a new approval reads its run timeline once')
  assert.equal(background.ado.count(isCheckSuite), 1)
  background.clock.now += 5 * MINUTE
  const { runs: later } = await background.source.background(ME, PROJECTS, [])
  assert.deepEqual(timelineIds(background.ado.calls).sort(), [4520, 4531])
  assert.equal(background.ado.count(isCheckSuite), 1)
  assert.equal(later.find(run => run.buildId === 4520)?.approvals[0].environment, 'production')
})

test('a forbidden approvals list turns approvals off for 10 minutes while runs keep loading', async () => {
  const { ado, clock, source } = setup()
  let refused = true
  ado.on(call => refused && isApprovals(call), () => json(403, { message: 'TF400813: not authorized.' }))

  const first = await source.full(ME, PROJECTS, [])
  assert.deepEqual(ids(first.runs), [4531, 4520, 4512, 4505, 4498, 4490])
  assert.ok(first.runs.every(run => run.approvals.length === 0))
  assert.equal(first.runs.find(run => run.buildId === 4520)?.state, 'running')
  assert.deepEqual(first.off, { approvals: true })
  const tried = ado.count(isApprovals)

  clock.now += 10 * MINUTE - 1
  assert.deepEqual((await source.full(ME, PROJECTS, [])).off, { approvals: true })
  assert.deepEqual((await source.background(ME, PROJECTS, [])).off, { approvals: true })
  assert.equal(ado.count(isApprovals), tried, 'approvals are not asked for 10 minutes')

  refused = false
  clock.now += 1
  const back = await source.full(ME, PROJECTS, [])
  assert.deepEqual(back.off, { approvals: false })
  assert.equal(back.runs.find(run => run.buildId === 4520)?.state, 'waiting')
})

test('a background load reads my runs, approvals and the batch, and carries chips while state and finish are unchanged', async () => {
  const { ado, clock, source } = setup()
  const full = await source.full(ME, PROJECTS, [])
  const chips = new Map(full.runs.map(run => [run.buildId, run.stages]))
  const before = ado.calls.length

  const done = ado.runs.builds.get(4520) ?? assert.fail('no build 4520')
  Object.assign(done, { status: 'completed', result: 'failed', finishTime: iso(T0 + MINUTE) })
  clock.now += 5 * MINUTE
  const { runs } = await source.background(ME, PROJECTS, [])
  const calls = ado.calls.slice(before)

  assert.deepEqual([isMineRuns, isRunningRuns, isApprovals, isBuildsByIds, isTimeline, isCheckSuite].map(match => calls.filter(match).length), [2, 0, 2, 1, 0, 0])
  assert.deepEqual(calls.filter(isBuildsByIds).map(call => call.query.get('buildIds')), ['4531'])
  assert.deepEqual(ids(runs), [4531, 4520, 4512, 4505, 4498, 4490])
  const byId = new Map(runs.map(run => [run.buildId, run]))
  assert.deepEqual(byId.get(4531)?.stages, chips.get(4531))
  assert.deepEqual(byId.get(4512)?.stages, chips.get(4512))
  assert.equal(byId.get(4520)?.state, 'failed')
  assert.equal(byId.get(4520)?.stages, null, 'a run that changed has no chips until the next full load')

  const cold = setup()
  const { runs: first } = await cold.source.background(ME, PROJECTS, [])
  assert.ok(first.every(run => run.stages === null), 'no chips without a full load')
})

test('watched reads one batch per project holding a watched run', async () => {
  const { ado, source } = setup()
  finished(ado, 4701, T0 - 90 * MINUTE, { project: { id: PLATFORM, name: 'Fabrikam Platform' } })
  const runs = await source.watched(ME, [{ projectId: PROJECT, buildId: 4531 }, { projectId: PLATFORM, buildId: 4701 }, { projectId: PROJECT, buildId: 4512 }])

  assert.deepEqual(ids(runs).sort(), [4512, 4531, 4701])
  assert.ok(runs.every(run => run.watched && run.stages === null && run.approvals.length === 0))
  assert.deepEqual(ado.calls.map(call => [runsProjectOf(call), call.query.get('buildIds')]).sort(), [[PLATFORM, '4701'], [PROJECT, '4531,4512']].sort())
  assert.equal(ado.calls.length, 2)
})

test('approval reads a pending approval fresh with its run and place, and answers null once it is gone', async () => {
  const { ado, source } = setup()
  const pair = await source.approval(ME, { projectId: PROJECT, approvalId: APPROVAL_4520 })
  assert.deepEqual([pair?.run.buildId, pair?.run.state, pair?.run.approvals, pair?.approval.stage, pair?.approval.environment], [
    4520,
    'waiting',
    [pair?.approval],
    'Deploy production',
    'production'
  ])
  assert.deepEqual(pair?.run.stages?.map(chip => chip.name), ['Build', 'Image', 'Deploy production'])
  assert.deepEqual([isApprovals, isOneBuild, isTimeline, isCheckSuite].map(match => ado.count(match)), [1, 1, 1, 1])
  assert.equal(ado.calls.find(isApprovals)?.query.get('approvalIds'), APPROVAL_4520)

  const decided = ado.runs.approvals.get(APPROVAL_4531) ?? assert.fail('no approval on 4531')
  decided.status = 'approved'
  assert.equal(await source.approval(ME, { projectId: PROJECT, approvalId: APPROVAL_4531 }), null, 'no longer pending')
  ado.runs.approvals.delete(APPROVAL_4520)
  assert.equal(await source.approval(ME, { projectId: PROJECT, approvalId: APPROVAL_4520 }), null, 'gone')

  const orphan = setup()
  orphan.ado.runs.builds.delete(4531)
  assert.equal(await orphan.source.approval(ME, { projectId: PROJECT, approvalId: APPROVAL_4531 }), null, 'its run is gone')
})

test('one malformed build or approval fails the load with the fixed message', async () => {
  const builds = setup()
  const broken = builds.ado.runs.builds.get(4505) ?? assert.fail('no build 4505')
  delete (broken as Partial<RawBuild>).buildNumber
  assert.equal((await failure(builds.source.full(ME, PROJECTS, []))).message, MALFORMED_BUILD)

  const approvals = setup()
  const orphan = approvals.ado.runs.approvals.get(APPROVAL_4531) ?? assert.fail('no approval on 4531')
  delete orphan.pipeline
  assert.equal((await failure(approvals.source.background(ME, PROJECTS, []))).message, MALFORMED_APPROVAL)
})

test('a signal reaches every request of a load', async () => {
  const { ado, source } = setup()
  const controller = new AbortController()
  await source.full(ME, PROJECTS, [{ projectId: PROJECT, buildId: 4401 }], controller.signal)
  await source.background(ME, PROJECTS, [], controller.signal)
  await source.watched(ME, [{ projectId: PROJECT, buildId: 4531 }], controller.signal)
  await source.approval(ME, { projectId: PROJECT, approvalId: APPROVAL_4531 }, controller.signal)
  controller.abort()
  assert.ok(ado.calls.length > 20)
  assert.ok(ado.calls.every(call => call.signal?.aborted), 'every request carried the signal')
})
