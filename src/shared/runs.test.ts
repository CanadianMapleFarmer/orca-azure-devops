import { assert, test } from 'orca/testing'
import type { ApprovalSummary, RunFilter, RunState, RunSummary, StepState } from './pipelines'
import {
  approvalsNeedingMe,
  approverNames,
  cancellableStatus,
  FAILED_WINDOW_MS,
  failedRuns,
  finishedStatus,
  isActive,
  needsMe,
  orderRuns,
  runCounts,
  RUN_STATE_TEXT,
  RUN_STATE_TONE,
  runsFor,
  STEP_GLYPH
} from './runs'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const ALEX = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'

function run(buildId: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    org: 'contoso',
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    projectName: 'Fabrikam Web',
    buildId,
    pipeline: { id: 8, name: 'web-app-ci' },
    runNumber: `20261105.${buildId}`,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=${buildId}`,
    branch: 'develop',
    prId: null,
    reason: 'individualCI',
    repository: null,
    requestedFor: { id: ALEX, name: 'Alex Contoso' },
    state: 'succeeded',
    queuedAt: NOW - 4 * HOUR,
    startedAt: null,
    finishedAt: null,
    stages: null,
    approvals: [],
    mine: true,
    watched: false,
    ...over
  }
}

function approval(approvalId: string, buildId: number, over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    buildId,
    approvalId,
    stage: 'Deploy production',
    environment: 'production',
    approvers: [{ id: ALEX, name: 'Alex Contoso', uniqueName: 'alex@contoso.example', isGroup: false }],
    minRequired: 1,
    instructions: '',
    createdAt: NOW - 20 * MINUTE,
    canApprove: false,
    ...over
  }
}

const ids = (runs: readonly RunSummary[]) => runs.map(item => item.buildId)

test('isActive is true for queued, running, waiting and cancelling runs only', () => {
  const states: [RunState, boolean][] = [
    ['queued', true],
    ['running', true],
    ['waiting', true],
    ['cancelling', true],
    ['succeeded', false],
    ['warning', false],
    ['failed', false],
    ['canceled', false]
  ]
  for (const [state, active] of states) assert.equal(isActive(run(1, { state })), active, state)
})

test('finishedStatus and cancellableStatus read the raw run status, so an unknown one is neither finished nor refused', () => {
  const statuses = ['notStarted', 'postponed', 'inProgress', 'cancelling', 'completed', 'somethingNew']
  assert.deepEqual(statuses.map(status => finishedStatus(status)), [false, false, false, false, true, false])
  assert.deepEqual(statuses.map(status => cancellableStatus(status)), [true, true, true, false, false, true])
})

test('orderRuns puts active runs first, newest first', () => {
  const runs = [
    run(4505, { state: 'succeeded', queuedAt: NOW - 30 * HOUR, finishedAt: NOW - 3 * HOUR }),
    run(4512, { state: 'failed', queuedAt: NOW - 2 * HOUR, finishedAt: NOW - HOUR }),
    run(4520, { state: 'running', queuedAt: NOW - 30 * MINUTE }),
    run(4540, { state: 'queued', queuedAt: NOW - MINUTE }),
    run(4531, { state: 'waiting', queuedAt: NOW - 20 * MINUTE }),
    run(4519, { state: 'cancelling', queuedAt: NOW - 40 * MINUTE })
  ]
  const before = ids(runs)
  assert.deepEqual(ids(orderRuns(runs)), [4540, 4531, 4520, 4519, 4512, 4505])
  assert.deepEqual(ids(runs), before)
})

test('orderRuns sorts finished runs by finish time, falls back to the queue time and breaks ties by build id', () => {
  const runs = [
    run(10, { state: 'succeeded', queuedAt: NOW - 5 * HOUR, finishedAt: NOW - 4 * HOUR }),
    run(11, { state: 'failed', queuedAt: NOW - 2 * HOUR, finishedAt: null }),
    run(12, { state: 'succeeded', queuedAt: NOW - 9 * HOUR, finishedAt: NOW - 4 * HOUR }),
    run(13, { state: 'canceled', queuedAt: NOW - 3 * HOUR, finishedAt: NOW - 3 * HOUR })
  ]
  assert.deepEqual(ids(orderRuns(runs)), [11, 13, 12, 10])
  assert.deepEqual(ids(orderRuns([run(7, { queuedAt: 5 }), run(9, { queuedAt: 5 }), run(8, { queuedAt: 5 })])), [9, 8, 7])
  assert.deepEqual(ids(orderRuns([run(7, { state: 'running', queuedAt: 5 }), run(9, { state: 'running', queuedAt: 5 })])), [9, 7])
})

test('orderRuns keeps a long-queued active run ahead of a run that finished a moment ago', () => {
  const runs = [run(2, { state: 'failed', finishedAt: NOW - MINUTE }), run(1, { state: 'running', queuedAt: NOW - 6 * HOUR })]
  assert.deepEqual(ids(orderRuns(runs)), [1, 2])
})

test('needsMe counts approvals I can give and approvals on my runs', () => {
  const waiting = (mine: boolean, ...canApprove: boolean[]) =>
    run(1, { state: 'waiting', mine, approvals: canApprove.map((can, index) => approval(`a${index}`, 1, { canApprove: can })) })
  assert.equal(needsMe(waiting(false, true)), true)
  assert.equal(needsMe(waiting(true, false)), true)
  assert.equal(needsMe(waiting(true, true)), true)
  assert.equal(needsMe(waiting(false, false)), false)
  assert.equal(needsMe(waiting(false, false, true)), true)
  assert.equal(needsMe(waiting(true)), false)
  assert.equal(needsMe(waiting(false)), false)
})

test('needsMe ignores approvals on a run that is no longer active', () => {
  const finished = (state: RunState) => run(1, { state, mine: true, approvals: [approval('a', 1, { canApprove: true })] })
  for (const state of ['succeeded', 'warning', 'failed', 'canceled'] as const) assert.equal(needsMe(finished(state)), false, state)
  assert.equal(needsMe(finished('running')), true)
})

test('approvalsNeedingMe lists the approvals I can give and those on my active runs, in run order', () => {
  const runs = [
    run(4531, { state: 'running', mine: false, requestedFor: { id: GRACE, name: 'Grace Hopper' }, approvals: [approval('give', 4531, { canApprove: true })] }),
    run(4520, { state: 'running', mine: true, approvals: [approval('mine', 4520), approval('mine-too', 4520, { canApprove: true })] }),
    run(4540, { state: 'running', mine: false, approvals: [approval('not-mine', 4540)] }),
    run(4500, { state: 'succeeded', mine: true, approvals: [approval('stale', 4500, { canApprove: true })] })
  ]
  assert.deepEqual(approvalsNeedingMe(runs).map(item => item.approvalId), ['give', 'mine', 'mine-too'])
  assert.deepEqual(approvalsNeedingMe([]), [])
})

test('failedRuns drops runs replaced by a newer run of the same pipeline and branch', () => {
  const failed = (buildId: number, branch: string, hoursAgo: number) =>
    run(buildId, { state: 'failed', branch, queuedAt: NOW - (hoursAgo + 1) * HOUR, finishedAt: NOW - hoursAgo * HOUR })
  const runs = [
    failed(4512, 'feature/1204-vehicle-search', 1),
    failed(4490, 'develop', 5),
    run(4505, { state: 'succeeded', branch: 'develop', queuedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR })
  ]
  assert.deepEqual(ids(failedRuns(runs, NOW)), [4512])
})

test('failedRuns is replaced only by a newer run that is active, succeeded or warning in the same pipeline and branch', () => {
  const failed = run(100, { state: 'failed', queuedAt: NOW - 5 * HOUR, finishedAt: NOW - 4 * HOUR })
  const kept = (other: RunSummary) => ids(failedRuns([failed, other], NOW)).includes(100)
  const newer = (state: RunState, over: Partial<RunSummary> = {}) => run(101, { state, queuedAt: NOW - 2 * HOUR, ...over })

  for (const state of ['queued', 'running', 'waiting', 'cancelling', 'succeeded', 'warning'] as const) {
    assert.equal(kept(newer(state)), false, `replaced by ${state}`)
  }
  for (const state of ['failed', 'canceled'] as const) assert.equal(kept(newer(state)), true, `kept after ${state}`)
  assert.equal(kept(newer('succeeded', { pipeline: { id: 12, name: 'web-app-cd' } })), true, 'other pipeline')
  assert.equal(kept(newer('succeeded', { branch: 'main' })), true, 'other branch')
  assert.equal(kept(newer('succeeded', { queuedAt: failed.queuedAt - 1 })), true, 'older run')
  assert.equal(kept(newer('succeeded', { queuedAt: failed.queuedAt })), true, 'same queue time')
  assert.equal(kept(newer('succeeded', { mine: false, requestedFor: { id: GRACE, name: 'Grace Hopper' } })), false, 'someone else')
})

test('failedRuns is not replaced by a run of the same pipeline id and branch in another project', () => {
  const OTHER_PROJECT = '7b2c3d4e-2222-4b3c-8d4e-1f2a3b4c5d6e'
  const failed = run(4512, { state: 'failed', branch: 'main', queuedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR })
  const elsewhere = run(4513, { projectId: OTHER_PROJECT, projectName: 'Fabrikam API', state: 'succeeded', branch: 'main', queuedAt: NOW - HOUR, finishedAt: NOW - 30 * MINUTE })
  const here = run(4514, { state: 'succeeded', branch: 'main', queuedAt: NOW - HOUR, finishedAt: NOW - 30 * MINUTE })

  assert.deepEqual(ids(failedRuns([failed, elsewhere], NOW)), [4512])
  assert.deepEqual(ids(runsFor('failed', [failed, elsewhere], NOW)), [4512])
  assert.equal(runCounts([failed, elsewhere], NOW).failedRuns, 1)
  assert.deepEqual(ids(failedRuns([failed, elsewhere, here], NOW)), [], 'a newer run in the same project still replaces it')
})

test("failedRuns ignores failures older than 24 hours and other people's unwatched runs", () => {
  const failed = (buildId: number, over: Partial<RunSummary> = {}) =>
    run(buildId, { state: 'failed', branch: `b${buildId}`, queuedAt: NOW - 2 * HOUR, finishedAt: NOW - HOUR, ...over })
  const theirs = { mine: false, requestedFor: { id: GRACE, name: 'Grace Hopper' } }
  const runs = [
    failed(1),
    failed(2, { finishedAt: NOW - FAILED_WINDOW_MS }),
    failed(3, { finishedAt: NOW - FAILED_WINDOW_MS - 1 }),
    failed(4, theirs),
    failed(5, { ...theirs, watched: true }),
    failed(6, { finishedAt: null }),
    failed(7, { state: 'canceled' }),
    failed(8, { state: 'succeeded' }),
    failed(9, { state: 'warning' })
  ]
  assert.deepEqual(ids(failedRuns(runs, NOW)).sort((a, b) => a - b), [1, 2, 5])
  assert.equal(FAILED_WINDOW_MS, 24 * 60 * 60 * 1000)
  assert.deepEqual(failedRuns([], NOW), [])
})

test('runsFor filters and runCounts counts', () => {
  const theirs = { mine: false, requestedFor: { id: GRACE, name: 'Grace Hopper' } }
  const runs = [
    run(4490, { state: 'failed', queuedAt: NOW - 50 * HOUR, finishedAt: NOW - 49 * HOUR }),
    run(4498, { state: 'succeeded', branch: 'develop', pipeline: { id: 9, name: 'api-ci' }, queuedAt: NOW - 25 * HOUR, finishedAt: NOW - 24 * HOUR }),
    run(4505, { state: 'succeeded', queuedAt: NOW - 19 * HOUR, finishedAt: NOW - 18 * HOUR }),
    run(4512, { state: 'failed', branch: 'feature/1204-vehicle-search', queuedAt: NOW - 2 * HOUR, finishedAt: NOW - HOUR }),
    run(4520, {
      state: 'running',
      branch: 'main',
      pipeline: { id: 12, name: 'web-app-cd' },
      queuedAt: NOW - 30 * MINUTE,
      approvals: [approval('on-mine', 4520)]
    }),
    run(4531, {
      ...theirs,
      state: 'waiting',
      branch: 'main',
      pipeline: { id: 12, name: 'web-app-cd' },
      queuedAt: NOW - 20 * MINUTE,
      approvals: [approval('can-give', 4531, { canApprove: true })]
    }),
    run(4533, { ...theirs, state: 'running', queuedAt: NOW - 5 * MINUTE, approvals: [approval('not-mine', 4533)] }),
    run(4534, { ...theirs, state: 'failed', branch: 'hotfix', queuedAt: NOW - 4 * HOUR, finishedAt: NOW - 3 * HOUR, watched: true })
  ]
  assert.deepEqual(ids(runsFor('mine', runs, NOW)), [4520, 4512, 4505, 4498, 4490])
  assert.deepEqual(ids(runsFor('running', runs, NOW)), [4533, 4531, 4520])
  assert.deepEqual(ids(runsFor('needsMe', runs, NOW)), [4531, 4520])
  assert.deepEqual(ids(runsFor('failed', runs, NOW)), [4512, 4534])
  assert.deepEqual(runCounts(runs, NOW), { failedRuns: 2, approvals: 2 })
  assert.deepEqual(runCounts([], NOW), { failedRuns: 0, approvals: 0 })

  const filters: RunFilter[] = ['mine', 'running', 'needsMe', 'failed']
  for (const filter of filters) assert.deepEqual(runsFor(filter, [], NOW), [], filter)
})

test('STEP_GLYPH has one glyph per step state', () => {
  const expected: Record<StepState, string> = {
    succeeded: '✓',
    failed: '✗',
    running: '●',
    waiting: '⏸',
    warning: '!',
    canceled: '⊘',
    skipped: '–',
    pending: '○'
  }
  assert.deepEqual(STEP_GLYPH, expected)
})

test('RUN_STATE_TEXT labels every run state', () => {
  assert.deepEqual(RUN_STATE_TEXT, {
    queued: 'queued',
    running: '● running',
    waiting: '⏸ waiting for approval',
    cancelling: 'cancelling',
    succeeded: '✓ succeeded',
    warning: '! partially succeeded',
    failed: '✗ failed',
    canceled: 'canceled'
  })
})

test('RUN_STATE_TONE gives every run state the tone the panel badge and the run tab share', () => {
  assert.deepEqual(RUN_STATE_TONE, {
    queued: 'neutral',
    running: 'accent',
    waiting: 'warning',
    cancelling: 'neutral',
    succeeded: 'success',
    warning: 'warning',
    failed: 'danger',
    canceled: 'neutral'
  })
})

test('approverNames lists people by name and groups with (group), in ADO order', () => {
  const approvers = [
    { id: GRACE, name: 'Grace Hopper', uniqueName: 'grace@contoso.example', isGroup: false },
    { id: 'g-release', name: 'Release Approvers', uniqueName: '[Fabrikam Web]\\Release Approvers', isGroup: true },
    { id: ALEX, name: 'Alex Contoso', uniqueName: 'alex@contoso.example', isGroup: false }
  ]
  assert.equal(approverNames(approval('ap', 4520, { approvers })), 'Grace Hopper, Release Approvers (group), Alex Contoso')
  assert.equal(approverNames(approval('ap', 4520, { approvers: [] })), '')
})
