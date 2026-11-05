import { assert, test } from 'orca/testing'
import type { Failure, StageView, StepState } from '../../src/shared/pipelines'
import { fakeAdo, fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { AdoError, createAdoHttp } from './http'
import {
  approvalPlaceOf,
  failuresOf,
  getTimeline,
  mergeTimeline,
  runStages,
  stageChips,
  stepStateOf,
  type RawIssue,
  type RawRecord,
  type RawTimeline
} from './timeline'

const APPROVAL_4520 = '8d4e5f6a-7002-4d5e-8f6a-7b8c9d0e1f22'
const CHECK_SUITE_4520 = '7c3d4e5f-7001-4c4d-9e5f-6a7b8c9d0e11'
const DEPLOY_STAGE_4520 = '6b2c3d4e-6014-4b3c-8d4e-5f6a7b8c9d14'

const isTimeline = (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/build/builds/4520/timeline`
const time = (text: string) => Date.parse(`2026-11-05T${text}Z`)

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

const timeline = (name: string): RawTimeline => fixture<RawTimeline>(name)

function logCounts(): Map<number, number> {
  const { value } = fixture<{ value: { id: number; lineCount: number }[] }>('logs-4512')
  return new Map(value.map(log => [log.id, log.lineCount]))
}

function rec(id: string, type: string, name: string, over: Partial<RawRecord> = {}): RawRecord {
  return { id, parentId: null, type, name, order: 1, state: 'completed', result: 'succeeded', ...over }
}

function singleStage(over: Partial<RawRecord>, issues: RawIssue[] | null = null): RawTimeline {
  return {
    changeId: 1,
    records: [
      rec('s', 'Stage', 'Release', { identifier: 'Release' }),
      rec('j', 'Job', 'Deploy', { parentId: 's' }),
      rec('t', 'Task', 'Run', { parentId: 'j', issues, ...over })
    ]
  }
}

function stepOf(stages: readonly StageView[]) {
  return stages[0].jobs[0].steps[0]
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

function isFixedError(error: AdoError): boolean {
  return error.code === 'server' && error.message === MALFORMED.timeline
}

test('runStages builds stages, jobs and steps in order with durations and log line counts', () => {
  const stages = runStages(timeline('timeline-4512'), logCounts(), false)
  assert.deepEqual(
    stages.map(stage => [stage.name, stage.identifier, stage.state, stage.attempt, stage.canRetry, stage.approvalId]),
    [
      ['Build', 'Build', 'succeeded', 1, false, null],
      ['Image', 'Image', 'failed', 1, true, null],
      ['Deploy production', 'Deploy_production', 'skipped', 1, false, null]
    ]
  )
  assert.deepEqual(
    stages.map(stage => [stage.startedAt, stage.finishedAt]),
    [
      [time('08:04:23.4000000'), time('08:06:10.1000000')],
      [time('08:06:12.3000000'), time('08:09:45.0000000')],
      [null, time('08:09:45.0000000')]
    ]
  )
  assert.deepEqual(stages[0].jobs.map(job => [job.name, job.state, job.steps.map(step => step.name)]), [
    ['Build', 'succeeded', ['Initialize job', 'Checkout web-app@refs/pull/4101/merge', 'Build and test', 'Finalize Job']]
  ])
  assert.deepEqual(stages[2].jobs, [])

  const image = stages[1]
  assert.deepEqual(image.jobs.map(job => [job.name, job.state, job.startedAt, job.finishedAt]), [
    ['Build image', 'failed', time('08:06:14.0000000'), time('08:09:44.5000000')]
  ])
  assert.deepEqual(
    image.jobs[0].steps.map(step => [step.name, step.state, step.logId, step.logLines]),
    [
      ['Initialize job', 'succeeded', 7, 41],
      ['Log in to registry', 'succeeded', 8, 29],
      ['Build and push image', 'failed', 9, 240],
      ['Finalize Job', 'succeeded', 10, 24]
    ]
  )
  assert.deepEqual(image.jobs[0].steps[2], {
    id: '9a2b3c4d-6113-4b3c-8d4e-5f6a7b8c9e13',
    name: 'Build and push image',
    state: 'failed',
    startedAt: time('08:06:30.0000000'),
    finishedAt: time('08:09:40.0000000'),
    logId: 9,
    logLines: 240,
    errorCount: 2,
    warningCount: 0,
    issues: [
      {
        type: 'error',
        message: '/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002: ; expected',
        file: { path: '/home/vsts/work/1/s/src/Api/Program.cs', line: 42, column: 17 }
      },
      { type: 'error', message: "Bash exited with code '1'.", file: null }
    ]
  })
})

test('runStages leaves a log line count unset when the logs list has no entry', () => {
  const stages = runStages(timeline('timeline-4512'), new Map([[9, 240]]), false)
  assert.deepEqual(
    stages[1].jobs[0].steps.map(step => [step.logId, step.logLines]),
    [[7, null], [8, null], [9, 240], [10, null]]
  )
  assert.deepEqual(stages[0].jobs[0].steps.map(step => step.logId), [2, 3, 4, 5])
})

test('runStages orders siblings by order then name whatever the order of the records', () => {
  const base = timeline('timeline-4512')
  const shuffled: RawTimeline = { ...base, records: [...base.records].reverse() }
  assert.deepEqual(runStages(shuffled, logCounts(), false), runStages(base, logCounts(), false))

  const ties: RawTimeline = {
    changeId: 1,
    records: [
      rec('s', 'Stage', 'Release', { identifier: 'Release' }),
      rec('j-b', 'Job', 'beta', { parentId: 's', order: 2 }),
      rec('j-c', 'Job', 'gamma', { parentId: 's', order: 1 }),
      rec('j-a', 'Job', 'alpha', { parentId: 's', order: 1 }),
      rec('t-2', 'Task', 'second', { parentId: 'j-a', order: 5 }),
      rec('t-1', 'Task', 'first', { parentId: 'j-a', order: 5 })
    ]
  }
  const [stage] = runStages(ties, new Map(), false)
  assert.deepEqual(stage.jobs.map(job => job.name), ['alpha', 'gamma', 'beta'])
  assert.deepEqual(stage.jobs[0].steps.map(step => step.name), ['first', 'second'])
})

test('runStages finds jobs under nested phases and directly under a stage and ignores checkpoints', () => {
  const nested: RawTimeline = {
    changeId: 1,
    records: [
      rec('s', 'Stage', 'Release', { identifier: 'Release' }),
      rec('p1', 'Phase', 'Matrix', { parentId: 's', order: 1 }),
      rec('p2', 'Phase', 'Inner', { parentId: 'p1', order: 1 }),
      rec('j-deep', 'Job', 'deep', { parentId: 'p2' }),
      rec('j-direct', 'Job', 'direct', { parentId: 's', order: 2 }),
      rec('c', 'Checkpoint', 'Checkpoint', { parentId: 's', order: 3 }),
      rec('t-direct', 'Task', 'stray task', { parentId: 's', order: 4 })
    ]
  }
  const [stage] = runStages(nested, new Map(), false)
  assert.deepEqual(stage.jobs.map(job => job.name), ['deep', 'direct'])
})

test('runStages tolerates records that carry only an id, a type and a name', () => {
  const bare: RawTimeline = {
    changeId: 1,
    records: [rec('s', 'Stage', 'Release', { state: undefined, result: undefined, order: undefined }), { id: 'j', parentId: 's', type: 'Job', name: 'Deploy' }]
  }
  const [stage] = runStages(bare, new Map(), false)
  assert.deepEqual(
    [stage.identifier, stage.state, stage.startedAt, stage.finishedAt, stage.attempt, stage.canRetry, stage.jobs[0].state, stage.jobs[0].steps],
    [null, 'pending', null, null, 1, false, 'pending', []]
  )
})

test('a stage reports its attempt', () => {
  const attemptOf = (attempt?: number) =>
    runStages({ changeId: 1, records: [rec('s', 'Stage', 'Release', attempt === undefined ? {} : { attempt })] }, new Map(), false)[0].attempt
  assert.deepEqual([attemptOf(3), attemptOf(1), attemptOf(0), attemptOf()], [3, 1, 1, 1])
})

test('a step reads its log, counts and times defensively', () => {
  const messy = singleStage({
    log: { id: 3.5 },
    startTime: 'later',
    finishTime: null,
    errorCount: -2,
    warningCount: 1.5
  })
  const step = stepOf(runStages(messy, new Map([[3, 10]]), false))
  assert.deepEqual(
    [step.logId, step.logLines, step.startedAt, step.finishedAt, step.errorCount, step.warningCount],
    [null, null, null, null, 0, 0]
  )
  const counted = stepOf(runStages(singleStage({ log: { id: 3 }, errorCount: 2, warningCount: 5 }), new Map([[3, 10]]), false))
  assert.deepEqual([counted.logId, counted.logLines, counted.errorCount, counted.warningCount], [3, 10, 2, 5])
})

test('a waiting approval makes its stage waiting and approvalPlaceOf finds it', () => {
  const base = timeline('timeline-4520')
  const stages = runStages(base, new Map(), true)
  assert.deepEqual(
    stages.map(stage => [stage.name, stage.state, stage.approvalId, stage.canRetry]),
    [
      ['Build', 'succeeded', null, false],
      ['Image', 'succeeded', null, false],
      ['Deploy production', 'waiting', APPROVAL_4520, false]
    ]
  )
  assert.deepEqual(approvalPlaceOf(base, APPROVAL_4520), {
    stageId: DEPLOY_STAGE_4520,
    stage: 'Deploy production',
    checkSuiteId: CHECK_SUITE_4520
  })
})

test('approvalPlaceOf matches ids without regard to case and finds nothing for other ids or records', () => {
  const base = timeline('timeline-4520')
  assert.equal(approvalPlaceOf(base, APPROVAL_4520.toUpperCase())?.stage, 'Deploy production')
  assert.equal(approvalPlaceOf(base, '00000000-0000-0000-0000-000000000000'), null)
  assert.equal(approvalPlaceOf(base, CHECK_SUITE_4520), null)
  assert.equal(approvalPlaceOf(base, DEPLOY_STAGE_4520), null)
  assert.equal(approvalPlaceOf({ changeId: 1, records: [] }, APPROVAL_4520), null)
})

test('approvalPlaceOf reports no check suite for an approval outside a checkpoint and nothing without a stage', () => {
  const loose: RawTimeline = {
    changeId: 1,
    records: [rec('s', 'Stage', 'Release'), rec('a', 'Checkpoint.Approval', 'Checkpoint.Approval', { parentId: 's', state: 'inProgress', result: null })]
  }
  assert.deepEqual(approvalPlaceOf(loose, 'a'), { stageId: 's', stage: 'Release', checkSuiteId: null })

  const orphan: RawTimeline = { changeId: 1, records: [rec('a', 'Checkpoint.Approval', 'Checkpoint.Approval')] }
  assert.equal(approvalPlaceOf(orphan, 'a'), null)

  const loop: RawTimeline = {
    changeId: 1,
    records: [
      rec('a', 'Checkpoint.Approval', 'Checkpoint.Approval', { parentId: 'c' }),
      rec('c', 'Checkpoint', 'Checkpoint', { parentId: 'a' })
    ]
  }
  assert.equal(approvalPlaceOf(loop, 'a'), null)
})

test('stepStateOf maps every state and result', () => {
  const stateOf = (state: string | undefined, result?: string | null): StepState => stepStateOf(rec('x', 'Task', 'x', { state, result }))
  assert.equal(stateOf('pending'), 'pending')
  assert.equal(stateOf('pending', 'succeeded'), 'pending')
  assert.equal(stateOf('inProgress'), 'running')
  assert.equal(stateOf('inProgress', 'failed'), 'running')
  assert.equal(stateOf('completed', 'succeeded'), 'succeeded')
  assert.equal(stateOf('completed', 'succeededWithIssues'), 'warning')
  assert.equal(stateOf('completed', 'failed'), 'failed')
  assert.equal(stateOf('completed', 'canceled'), 'canceled')
  assert.equal(stateOf('completed', 'abandoned'), 'canceled')
  assert.equal(stateOf('completed', 'skipped'), 'skipped')
  assert.equal(stateOf('completed', 'somethingNew'), 'warning')
  assert.equal(stateOf('completed', null), 'warning')
  assert.equal(stateOf('completed'), 'warning')
  assert.equal(stateOf(undefined), 'pending')
  assert.equal(stateOf('somethingNew'), 'pending')
})

test('stepStateOf makes only an unfinished stage with an in-progress approval below it waiting', () => {
  const approval = (state: string) => rec('a', 'Checkpoint.Approval', 'Checkpoint.Approval', { parentId: 'c', state, result: null })
  const checkpoint = rec('c', 'Checkpoint', 'Checkpoint', { parentId: 's', state: 'inProgress', result: null })
  const stage = (state: string, result: string | null = null) => rec('s', 'Stage', 'Deploy', { state, result })

  assert.equal(stepStateOf(stage('inProgress'), [checkpoint, approval('inProgress')]), 'waiting')
  assert.equal(stepStateOf(stage('pending'), [checkpoint, approval('inProgress')]), 'waiting')
  assert.equal(stepStateOf(stage('inProgress'), [checkpoint, approval('completed')]), 'running')
  assert.equal(stepStateOf(stage('inProgress'), [checkpoint]), 'running')
  assert.equal(stepStateOf(stage('inProgress'), []), 'running')
  assert.equal(stepStateOf(stage('inProgress')), 'running')
  assert.equal(stepStateOf(stage('completed', 'succeeded'), [checkpoint, approval('inProgress')]), 'succeeded')
  const job = rec('j', 'Job', 'Deploy', { state: 'inProgress', result: null })
  assert.equal(stepStateOf(job, [checkpoint, approval('inProgress')]), 'running')
})

test('a timeline without stages gets one synthetic stage', () => {
  const classic: RawTimeline = {
    changeId: 3,
    records: [
      rec('p', 'Phase', 'Job', { order: 1 }),
      rec('j2', 'Job', 'Test', { parentId: 'p', order: 2, result: 'failed', startTime: '2026-11-05T10:01:00.0000000Z', finishTime: '2026-11-05T10:02:00.0000000Z' }),
      rec('j1', 'Job', 'Build', { parentId: 'p', order: 1, startTime: '2026-11-05T10:00:00.0000000Z', finishTime: '2026-11-05T10:01:00.0000000Z' }),
      rec('t', 'Task', 'Compile', { parentId: 'j2', log: { id: 4 } })
    ]
  }
  const stages = runStages(classic, new Map([[4, 12]]), false)
  assert.equal(stages.length, 1)
  const [stage] = stages
  assert.deepEqual(
    [stage.id, stage.identifier, stage.name, stage.state, stage.attempt, stage.canRetry, stage.approvalId],
    ['__run', null, 'All jobs', 'failed', 1, false, null]
  )
  assert.deepEqual([stage.startedAt, stage.finishedAt], [time('10:00:00.0000000'), time('10:02:00.0000000')])
  assert.deepEqual(stage.jobs.map(job => [job.id, job.name, job.steps.map(step => [step.name, step.logLines])]), [
    ['j1', 'Build', []],
    ['j2', 'Test', [['Compile', 12]]]
  ])
})

test('the synthetic stage rolls its jobs up and has no stage when the timeline holds no jobs', () => {
  const rolled = (...states: [string, string | null][]): StageView => {
    const jobs = states.map(([state, result], index) => rec(`j${index}`, 'Job', `job ${index}`, { order: index, state, result }))
    return runStages({ changeId: 1, records: jobs }, new Map(), false)[0]
  }
  const done: [string, string | null] = ['completed', 'succeeded']
  const finished = '2026-11-05T10:03:00.0000000Z'

  assert.equal(rolled(done, done).state, 'succeeded')
  assert.equal(rolled(done, ['completed', 'succeededWithIssues']).state, 'warning')
  assert.equal(rolled(done, ['completed', 'failed']).state, 'failed')
  assert.equal(rolled(['completed', 'failed'], ['inProgress', null]).state, 'running')
  assert.equal(rolled(['completed', 'failed'], ['pending', null]).state, 'failed')
  assert.equal(rolled(done, ['completed', 'canceled']).state, 'canceled')
  assert.equal(rolled(done, ['pending', null]).state, 'running')
  assert.equal(rolled(['pending', null], ['pending', null]).state, 'pending')
  assert.equal(rolled(['completed', 'skipped'], ['completed', 'skipped']).state, 'skipped')
  assert.equal(rolled(done, ['completed', 'skipped']).state, 'succeeded')

  const open = runStages(
    { changeId: 1, records: [rec('j0', 'Job', 'a', { finishTime: finished }), rec('j1', 'Job', 'b', { state: 'inProgress', result: null })] },
    new Map(),
    true
  )[0]
  assert.deepEqual([open.state, open.finishedAt], ['running', null])

  assert.deepEqual(runStages({ changeId: 1, records: [] }, new Map(), true), [])
  assert.deepEqual(runStages({ changeId: 1, records: [rec('t', 'Task', 'stray')] }, new Map(), true), [])
})

test('canRetry only for a failed or canceled stage with an identifier on a finished run', () => {
  const stageRecords: RawRecord[] = [
    rec('a', 'Stage', 'Failed', { order: 1, result: 'failed', identifier: 'Failed' }),
    rec('b', 'Stage', 'Canceled', { order: 2, result: 'canceled', identifier: 'Canceled' }),
    rec('c', 'Stage', 'Abandoned', { order: 3, result: 'abandoned', identifier: 'Abandoned' }),
    rec('d', 'Stage', 'No identifier', { order: 4, result: 'failed', identifier: null }),
    rec('e', 'Stage', 'Empty identifier', { order: 5, result: 'failed', identifier: '' }),
    rec('f', 'Stage', 'Succeeded', { order: 6, result: 'succeeded', identifier: 'Succeeded' }),
    rec('g', 'Stage', 'Skipped', { order: 7, result: 'skipped', identifier: 'Skipped' }),
    rec('h', 'Stage', 'Running', { order: 8, state: 'inProgress', result: null, identifier: 'Running' })
  ]
  const retryable = (runActive: boolean) =>
    runStages({ changeId: 1, records: stageRecords }, new Map(), runActive).map(stage => stage.canRetry)
  assert.deepEqual(retryable(false), [true, true, true, false, false, false, false, false])
  assert.deepEqual(retryable(true), [false, false, false, false, false, false, false, false])
})

test('issues carry a file from sourcepath or from the message', () => {
  const issues: RawIssue[] = [
    { type: 'error', message: 'compile failed', data: { sourcepath: '/home/vsts/work/1/s/src/a.cs', linenumber: '7', columnnumber: '3' } },
    { type: 'error', message: 'src/app.ts(3,5): error TS2322: nope' },
    { type: 'warning', message: 'plain warning', data: { type: 'Warning' } },
    { type: 'error', message: 'src/other.ts(1,1): error TS1', data: { sourcepath: 'src/real.ts', linenumber: '9' } },
    { type: 'error', message: 'no position', data: { sourcepath: 'C:\\src\\b.cs', linenumber: 'abc', columnnumber: '0' } },
    { type: 'error', message: './cmd/main.go:12:3: undefined: x', data: { sourcepath: '   ' } },
    { type: 'warning', message: 'long path', data: { sourcepath: `/${'p'.repeat(3000)}.cs` } }
  ]
  assert.deepEqual(
    stepOf(runStages(singleStage({}, issues), new Map(), false)).issues.map(issue => [issue.type, issue.message, issue.file]),
    [
      ['error', 'compile failed', { path: '/home/vsts/work/1/s/src/a.cs', line: 7, column: 3 }],
      ['error', 'src/app.ts(3,5): error TS2322: nope', { path: 'src/app.ts', line: 3, column: 5 }],
      ['error', 'src/other.ts(1,1): error TS1', { path: 'src/real.ts', line: 9, column: null }],
      ['error', 'no position', { path: 'C:\\src\\b.cs', line: null, column: null }],
      ['error', './cmd/main.go:12:3: undefined: x', { path: './cmd/main.go', line: 12, column: 3 }],
      ['warning', 'plain warning', null],
      ['warning', 'long path', null]
    ]
  )
})

test('issues keep only errors and warnings that have a message', () => {
  const issues = [
    { type: 'info', message: 'ignored' },
    { type: undefined, message: 'ignored too' },
    { type: 'error' },
    null,
    'text',
    { type: 'warning', message: 'kept' }
  ] as unknown as RawIssue[]
  assert.deepEqual(
    stepOf(runStages(singleStage({}, issues), new Map(), false)).issues.map(issue => [issue.type, issue.message]),
    [['warning', 'kept']]
  )
  assert.deepEqual(stepOf(runStages(singleStage({}, null), new Map(), false)).issues, [])
  assert.deepEqual(stepOf(runStages(singleStage({ issues: 'nope' as unknown as RawIssue[] }), new Map(), false)).issues, [])
})

test('issues are capped at ten and cut at 2,000 characters', () => {
  const many = Array.from({ length: 13 }, (_, index): RawIssue => ({ type: 'error', message: `error ${index}` }))
  const capped = stepOf(runStages(singleStage({ errorCount: 13 }, many), new Map(), false))
  assert.deepEqual(capped.issues.map(issue => issue.message), many.slice(0, 10).map(issue => issue.message))
  assert.equal(capped.errorCount, 13)

  const long = stepOf(runStages(singleStage({}, [{ type: 'error', message: 'e'.repeat(5000) }]), new Map(), false)).issues[0]
  assert.equal(long.message.length, 2000)
  assert(long.message.endsWith('e…'))

  const exact = stepOf(runStages(singleStage({}, [{ type: 'warning', message: 'w'.repeat(2000) }]), new Map(), false)).issues[0]
  assert.equal(exact.message, 'w'.repeat(2000))
})

test('a file reference past the 2,000th character of a message is not read', () => {
  const message = `${'e'.repeat(2100)} src/late.ts:3:5`
  assert.equal(stepOf(runStages(singleStage({}, [{ type: 'error', message }]), new Map(), false)).issues[0].file, null)
})

test('capped issues keep the errors ahead of the warnings', () => {
  const warnings = Array.from({ length: 12 }, (_, index): RawIssue => ({ type: 'warning', message: `warning ${index}` }))
  const failing: RawIssue = { type: 'error', message: 'the real failure' }
  const kept = stepOf(runStages(singleStage({}, [...warnings, failing]), new Map(), false)).issues
  assert.equal(kept.length, 10)
  assert.deepEqual([kept[0].type, kept[0].message], ['error', 'the real failure'])
  assert.deepEqual(kept.slice(1).map(issue => issue.message), warnings.slice(0, 9).map(issue => issue.message))
})

test('failuresOf lists the failing step with its path', () => {
  const stages = runStages(timeline('timeline-4512'), logCounts(), false)
  const [image] = stages.filter(stage => stage.name === 'Image')
  const step = image.jobs[0].steps[2]
  assert.deepEqual(failuresOf(stages), [
    {
      stageId: image.id,
      jobId: image.jobs[0].id,
      stepId: step.id,
      path: 'Image › Build image › Build and push image',
      issues: step.issues,
      logId: 9
    }
  ])
  assert.deepEqual(failuresOf(runStages(timeline('timeline-4520'), new Map(), true)), [])
})

test('failuresOf lists every failed step in timeline order', () => {
  const records: RawRecord[] = [
    rec('s2', 'Stage', 'Second', { order: 2 }),
    rec('j2', 'Job', 'Only', { parentId: 's2', result: 'failed' }),
    rec('t2', 'Task', 'Boom', { parentId: 'j2', result: 'failed', log: { id: 5 } }),
    rec('s1', 'Stage', 'First', { order: 1 }),
    rec('j1b', 'Job', 'Later', { parentId: 's1', order: 2, result: 'failed' }),
    rec('t1b', 'Task', 'Last', { parentId: 'j1b', result: 'failed' }),
    rec('j1a', 'Job', 'Earlier', { parentId: 's1', order: 1, result: 'failed' }),
    rec('t1a2', 'Task', 'Two', { parentId: 'j1a', order: 2, result: 'failed' }),
    rec('t1a1', 'Task', 'One', { parentId: 'j1a', order: 1, result: 'failed' }),
    rec('t1a0', 'Task', 'Fine', { parentId: 'j1a', order: 0 })
  ]
  const failures = failuresOf(runStages({ changeId: 1, records }, new Map(), false))
  assert.deepEqual(failures.map((failure: Failure) => failure.path), [
    'First › Earlier › One',
    'First › Earlier › Two',
    'First › Later › Last',
    'Second › Only › Boom'
  ])
  assert.deepEqual(failures.map(failure => failure.logId), [null, null, null, 5])
})

test('a failed job without a failed step is its own failure', () => {
  const records: RawRecord[] = [
    rec('s', 'Stage', 'Release', { result: 'failed' }),
    rec('j', 'Job', 'Deploy', { parentId: 's', result: 'failed' }),
    rec('t', 'Task', 'Initialize job', { parentId: 'j' })
  ]
  assert.deepEqual(failuresOf(runStages({ changeId: 1, records }, new Map(), false)), [
    { stageId: 's', jobId: 'j', stepId: 'j', path: 'Release › Deploy', issues: [], logId: null }
  ])
  const noSteps = records.filter(record => record.type !== 'Task')
  assert.equal(failuresOf(runStages({ changeId: 1, records: noSteps }, new Map(), false))[0].stepId, 'j')
  assert.deepEqual(failuresOf([]), [])
})

test('a failed job without a failed step carries its own issues and log', () => {
  const records: RawRecord[] = [
    rec('s', 'Stage', 'Release', { result: 'failed' }),
    rec('j', 'Job', 'Deploy', {
      parentId: 's',
      result: 'failed',
      log: { id: 3 },
      issues: [
        { type: 'warning', message: 'Pool is nearly full.' },
        { type: 'error', message: 'The agent lost communication with the server.' },
        { type: 'info', message: 'Ignored.' }
      ]
    }),
    rec('t', 'Task', 'Initialize job', { parentId: 'j' })
  ]
  const stages = runStages({ changeId: 1, records }, new Map(), false)
  const issues = [
    { type: 'error', message: 'The agent lost communication with the server.', file: null },
    { type: 'warning', message: 'Pool is nearly full.', file: null }
  ]
  assert.deepEqual([stages[0].jobs[0].logId, stages[0].jobs[0].issues], [3, issues])
  assert.deepEqual(failuresOf(stages), [
    { stageId: 's', jobId: 'j', stepId: 'j', path: 'Release › Deploy', issues, logId: 3 }
  ])
  assert.deepEqual(
    stages[0].jobs[0].steps.map(step => step.issues),
    [[]]
  )
})

test('a job reads its log and issues defensively', () => {
  const stages = runStages(timeline('timeline-4512'), new Map(), false)
  assert.deepEqual(stages.flatMap(stage => stage.jobs.map(job => [job.name, job.logId, job.issues])), [
    ['Build', 1, []],
    ['Build image', 6, []]
  ])
  const odd: RawTimeline = {
    changeId: 1,
    records: [rec('j', 'Job', 'Odd', { log: { id: -1 }, issues: 'nope' as unknown as RawIssue[] })]
  }
  assert.deepEqual(runStages(odd, new Map(), false)[0].jobs.map(job => [job.logId, job.issues]), [[null, []]])
})

test('stageChips follows the stages', () => {
  assert.deepEqual(stageChips(timeline('timeline-4512')), [
    { id: '9a2b3c4d-6101-4b3c-8d4e-5f6a7b8c9e01', name: 'Build', state: 'succeeded' },
    { id: '9a2b3c4d-6108-4b3c-8d4e-5f6a7b8c9e08', name: 'Image', state: 'failed' },
    { id: '9a2b3c4d-6115-4b3c-8d4e-5f6a7b8c9e15', name: 'Deploy production', state: 'skipped' }
  ])
  assert.deepEqual(
    stageChips(timeline('timeline-4520')).map(chip => [chip.name, chip.state]),
    [['Build', 'succeeded'], ['Image', 'succeeded'], ['Deploy production', 'waiting']]
  )
  assert.deepEqual(stageChips({ changeId: 1, records: [rec('j', 'Job', 'Only', { state: 'inProgress', result: null })] }), [
    { id: '__run', name: 'All jobs', state: 'running' }
  ])
  assert.deepEqual(stageChips({ changeId: 0, records: [] }), [])
})

test('mergeTimeline applies an incremental answer', () => {
  const base = timeline('timeline-4520')
  const delta = timeline('timeline-4520-delta')
  const before = structuredClone(base)
  const merged = mergeTimeline(base, delta)
  assert.equal(merged.changeId, 44)
  assert.equal(merged.records.length, 16)
  assert.deepEqual(new Set(merged.records.map(record => record.id)).size, 16)
  for (const changed of delta.records) assert.deepEqual(merged.records.find(record => record.id === changed.id), changed)
  const changedIds = new Set(delta.records.map(record => record.id))
  for (const record of base.records.filter(record => !changedIds.has(record.id))) {
    assert.deepEqual(merged.records.find(other => other.id === record.id), record)
  }
  const orders = merged.records.map(record => record.order ?? 0)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  assert.deepEqual(base, before)

  const stage = runStages(merged, new Map(), true)[2]
  assert.deepEqual([stage.name, stage.state, stage.approvalId], ['Deploy production', 'running', null])
})

test('mergeTimeline adds a record the held timeline does not have', () => {
  const base = timeline('timeline-4520')
  const added = rec('7d4e5f6a-8001-4d5e-8f6a-7b8c9d0e1f33', 'Job', 'Deploy', { parentId: DEPLOY_STAGE_4520, order: 2, state: 'inProgress', result: null })
  const merged = mergeTimeline(base, { changeId: 45, records: [added] })
  assert.equal(merged.records.length, 17)
  assert.deepEqual(merged.records.find(record => record.id === added.id), added)
  assert.equal(merged.changeId, 45)
})

test('mergeTimeline gives the same result when ADO ignores changeId', () => {
  const base = timeline('timeline-4520')
  const delta = timeline('timeline-4520-delta')
  const changed = new Map(delta.records.map(record => [record.id, record]))
  const full: RawTimeline = {
    changeId: delta.changeId,
    records: base.records.map(record => changed.get(record.id) ?? record).reverse()
  }
  assert.deepEqual(mergeTimeline(base, full), mergeTimeline(base, delta))
  assert.deepEqual(mergeTimeline(null, full), mergeTimeline(base, delta))
  assert.deepEqual(mergeTimeline(mergeTimeline(base, delta), full), mergeTimeline(base, delta))
})

test('mergeTimeline keeps the held timeline for a null or older answer', () => {
  const base = timeline('timeline-4520')
  const stale: RawTimeline = {
    changeId: 40,
    records: [rec(DEPLOY_STAGE_4520, 'Stage', 'Deploy production', { state: 'completed', result: 'failed', identifier: 'Deploy_production' })]
  }
  assert.equal(mergeTimeline(base, null), base)
  assert.equal(mergeTimeline(base, stale), base)
  const same = mergeTimeline(base, { changeId: 41, records: [] })
  assert.deepEqual([same.changeId, same.records.length], [41, 16])
})

test('mergeTimeline starts from the first answer and from nothing', () => {
  const delta = timeline('timeline-4520-delta')
  const first = mergeTimeline(null, delta)
  assert.equal(first.changeId, 44)
  assert.deepEqual(first.records.map(record => record.id).sort(), delta.records.map(record => record.id).sort())
  assert.deepEqual(mergeTimeline(null, null), { changeId: 0, records: [] })
})

test('getTimeline sends changeId only when held and maps 204 to null', async () => {
  const { ado, http } = setup()
  ado.on(isTimeline, () => json(200, fixture('timeline-4520')))
  const first = await getTimeline(http, ORG, PROJECT, 4520)
  assert.equal(first?.changeId, 41)
  assert.equal(first?.records.length, 16)
  assert.deepEqual(first?.records, timeline('timeline-4520').records)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/build/builds/4520/timeline`)
  assert.equal(call.query.has('changeId'), false)
  assert.equal(call.query.get('api-version'), '7.1')

  ado.on(isTimeline, () => json(200, fixture('timeline-4520-delta')))
  const delta = await getTimeline(http, ORG, PROJECT, 4520, 41)
  assert.equal(delta?.changeId, 44)
  assert.equal(ado.calls[1].query.get('changeId'), '41')

  ado.on(isTimeline, () => new Response(null, { status: 204 }))
  assert.equal(await getTimeline(http, ORG, PROJECT, 4520, 44), null)
  assert.equal(ado.calls[2].query.get('changeId'), '44')

  ado.on(isTimeline, () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }))
  assert.equal(await getTimeline(http, ORG, PROJECT, 4520, 44), null)

  ado.on(isTimeline, () => json(200, { changeId: 0, records: [] }))
  assert.deepEqual(await getTimeline(http, ORG, PROJECT, 4520, 0), { changeId: 0, records: [] })
  assert.equal(ado.calls[4].query.get('changeId'), '0')
})

test('a malformed timeline becomes the fixed error', async () => {
  const { ado, http } = setup()
  const record = { id: 'a', type: 'Stage', name: 'Build' }
  const bodies: unknown[] = [
    {},
    { changeId: 1 },
    { records: [] },
    { changeId: '1', records: [] },
    { changeId: 1, records: 'nope' },
    { changeId: 1, records: [null] },
    { changeId: 1, records: [{ type: 'Stage', name: 'Build' }] },
    { changeId: 1, records: [{ id: 'a', name: 'Build' }] },
    { changeId: 1, records: [{ id: 'a', type: 'Stage' }] },
    { changeId: 1, records: [record, record] },
    { changeId: 1, records: [{ ...record, parentId: 'a' }] },
    { changeId: 1, records: [{ ...record, parentId: 'b' }, { id: 'b', type: 'Job', name: 'Deploy', parentId: 'a' }] },
    {
      changeId: 1,
      records: [
        { id: 'a', type: 'Phase', name: 'one', parentId: 'c' },
        { id: 'b', type: 'Phase', name: 'two', parentId: 'a' },
        { id: 'c', type: 'Phase', name: 'three', parentId: 'b' },
        { id: 'd', type: 'Stage', name: 'Build' }
      ]
    },
    null,
    []
  ]
  for (const body of bodies) {
    ado.on(isTimeline, () => json(200, body))
    assert(isFixedError(await failure(getTimeline(http, ORG, PROJECT, 4520))), JSON.stringify(body))
  }
})

test('a timeline with shared or dangling parents is not a loop', async () => {
  const { ado, http } = setup()
  const records = [
    { id: 's', type: 'Stage', name: 'Build' },
    { id: 'j1', type: 'Job', name: 'one', parentId: 's' },
    { id: 'j2', type: 'Job', name: 'two', parentId: 's' },
    { id: 't', type: 'Task', name: 'run', parentId: 'j1' },
    { id: 'x', type: 'Job', name: 'orphan', parentId: 'gone' }
  ]
  ado.on(isTimeline, () => json(200, { changeId: 5, records }))
  assert.deepEqual(await getTimeline(http, ORG, PROJECT, 4520), { changeId: 5, records })
})

test('the timeline read stops when its signal aborts and ADO errors pass through', async () => {
  const { ado, http } = setup()
  ado.on(isTimeline, () => json(200, fixture('timeline-4520')))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(getTimeline(http, ORG, PROJECT, 4520, undefined, controller.signal))
  assert.equal(ado.calls.length, 0)

  ado.on(isTimeline, () => json(404, { message: 'Build 4520 does not exist.' }))
  const gone = await failure(getTimeline(http, ORG, PROJECT, 4520))
  assert.deepEqual([gone.code, gone.message], ['not_found', 'Build 4520 does not exist.'])
})
