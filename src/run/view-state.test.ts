import { assert, test } from 'orca/testing'
import type { ApprovalSummary, JobView, RunSummary, RunView, StageView, StepState, StepView } from '../shared/pipelines'
import {
  approvalText,
  countsText,
  defaultSelection,
  durationText,
  issueFile,
  logNotice,
  nextSelection,
  openedText,
  RUN_STATE_TEXT,
  rerunTarget,
  selectedRecord,
  watchedOf
} from './view-state'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

function step(id: string, state: StepState, over: Partial<StepView> = {}): StepView {
  return {
    id,
    name: id,
    state,
    startedAt: state === 'pending' ? null : NOW - 5 * MINUTE,
    finishedAt: state === 'pending' || state === 'running' ? null : NOW - 4 * MINUTE,
    logId: state === 'pending' ? null : 9,
    logLines: state === 'pending' ? null : 13,
    errorCount: 0,
    warningCount: 0,
    issues: [],
    ...over
  }
}

function job(id: string, state: StepState, steps: StepView[], over: Partial<JobView> = {}): JobView {
  return { id, name: id, state, startedAt: null, finishedAt: null, logId: 4, issues: [], steps, ...over }
}

function stage(id: string, state: StepState, jobs: JobView[], over: Partial<StageView> = {}): StageView {
  return {
    id,
    identifier: id,
    name: id,
    state,
    startedAt: null,
    finishedAt: null,
    attempt: 1,
    jobs,
    canRetry: false,
    approvalId: null,
    ...over
  }
}

function approval(over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    projectId: 'proj-web',
    buildId: 4520,
    approvalId: 'AB12-approval',
    stage: 'Deploy production',
    environment: 'production',
    approvers: [
      { id: 'grace', name: 'Grace Fabrikam', uniqueName: 'grace@fabrikam.com', isGroup: false },
      { id: 'release', name: 'Release Managers', uniqueName: '[Fabrikam Web]\\Release Managers', isGroup: true }
    ],
    minRequired: 1,
    instructions: '',
    createdAt: NOW - 12 * MINUTE,
    canApprove: true,
    ...over
  }
}

function view(stages: StageView[], over: Partial<RunView> = {}): RunView {
  const run: RunSummary = {
    org: 'contoso',
    projectId: 'proj-web',
    projectName: 'Fabrikam Web',
    buildId: 4520,
    pipeline: { id: 8, name: 'web-app-cd' },
    runNumber: '20261105.3',
    url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4520',
    branch: 'main',
    prId: null,
    reason: 'individualCI',
    repository: null,
    requestedFor: { id: 'alex', name: 'Alex Contoso' },
    state: 'running',
    queuedAt: NOW - HOUR,
    startedAt: NOW - HOUR,
    finishedAt: null,
    stages: stages.map(({ id, name, state }) => ({ id, name, state })),
    approvals: [],
    mine: true,
    watched: false
  }
  return { org: 'contoso', run, stages, failures: [], canCancel: true, updatedAt: NOW, stale: false, ...over }
}

const succeededBuild = stage('Build', 'succeeded', [job('Build job', 'succeeded', [step('checkout', 'succeeded'), step('dotnet build', 'succeeded')])])

test('defaultSelection picks the failing step, else the running one, else the last', () => {
  const failed = view([
    succeededBuild,
    stage('Image', 'failed', [
      job('Image job', 'failed', [step('docker login', 'succeeded'), step('Build and push image', 'failed'), step('cleanup', 'failed')])
    ]),
    stage('Deploy production', 'skipped', [])
  ])
  assert.deepEqual(defaultSelection(failed), { stageId: 'Image', stepId: 'Build and push image' })

  const failedLater = view([stage('Tests', 'running', [job('Test job', 'running', [step('dotnet test', 'running')])]), failed.stages[1]])
  assert.deepEqual(defaultSelection(failedLater), { stageId: 'Image', stepId: 'Build and push image' })

  const jobFailed = view([stage('Image', 'failed', [job('Timed out job', 'failed', [step('docker login', 'succeeded')])])])
  assert.deepEqual(defaultSelection(jobFailed), { stageId: 'Image', stepId: 'Timed out job' })

  const running = view([
    succeededBuild,
    stage('Image', 'running', [
      job('Image job', 'running', [step('docker login', 'succeeded'), step('Build and push image', 'running'), step('cleanup', 'pending')])
    ]),
    stage('Deploy production', 'pending', [])
  ])
  assert.deepEqual(defaultSelection(running), { stageId: 'Image', stepId: 'Build and push image' })

  const waiting = view([succeededBuild, stage('Deploy production', 'waiting', [], { approvalId: 'ab12-approval' })])
  assert.deepEqual(defaultSelection(waiting), { stageId: 'Deploy production', stepId: null })

  const done = view([
    succeededBuild,
    stage('Image', 'succeeded', [job('Image job', 'succeeded', [step('docker login', 'succeeded'), step('Build and push image', 'succeeded')])]),
    stage('Smoke', 'succeeded', [job('Smoke A', 'succeeded', [step('probe a', 'succeeded')]), job('Smoke B', 'succeeded', [step('probe b', 'succeeded')])])
  ])
  assert.deepEqual(defaultSelection(done), { stageId: 'Smoke', stepId: 'probe b' })

  assert.deepEqual(defaultSelection(view([stage('Deploy production', 'skipped', [])])), { stageId: 'Deploy production', stepId: null })
  assert.deepEqual(defaultSelection(view([])), { stageId: null, stepId: null })
})

test('durationText formats seconds, minutes and hours', () => {
  assert.equal(durationText(null, null, NOW), '')
  assert.equal(durationText(null, NOW, NOW), '')
  assert.equal(durationText(NOW - 45 * SECOND, NOW, NOW + HOUR), '45s')
  assert.equal(durationText(NOW - 400, NOW, NOW), '0s')
  assert.equal(durationText(NOW - 3 * MINUTE - 5 * SECOND, null, NOW), '3m 5s')
  assert.equal(durationText(NOW - 7 * MINUTE, NOW, NOW), '7m 0s')
  assert.equal(durationText(NOW - HOUR - 2 * MINUTE - 30 * SECOND, NOW, NOW), '1h 2m')
  assert.equal(durationText(NOW - 26 * HOUR, null, NOW), '26h 0m')
  assert.equal(durationText(NOW, NOW - MINUTE, NOW), '0s')
})

test('nextSelection keeps a picked step, follows the run otherwise and never drops to nothing mid-stage', () => {
  const running = view([
    succeededBuild,
    stage('Image', 'running', [job('Image job', 'running', [step('docker login', 'succeeded'), step('push', 'running'), step('cleanup', 'pending')])])
  ])
  const picked = { stageId: 'Build', stepId: 'checkout' }
  assert.deepEqual(nextSelection(running, picked, true), picked)
  assert.deepEqual(nextSelection(running, picked, false), { stageId: 'Image', stepId: 'push' })
  assert.deepEqual(nextSelection(running, { stageId: 'Build', stepId: 'gone' }, true), { stageId: 'Image', stepId: 'push' })
  assert.deepEqual(nextSelection(running, { stageId: 'Build', stepId: null }, true), { stageId: 'Build', stepId: null })
  assert.deepEqual(nextSelection(running, { stageId: 'Gone', stepId: null }, true), { stageId: 'Image', stepId: 'push' })
  assert.deepEqual(nextSelection(running, null, false), { stageId: 'Image', stepId: 'push' })

  const between = view([
    succeededBuild,
    stage('Image', 'running', [job('Image job', 'running', [step('docker login', 'succeeded'), step('push', 'succeeded'), step('cleanup', 'pending')])])
  ])
  assert.deepEqual(nextSelection(between, { stageId: 'Image', stepId: 'push' }, false), { stageId: 'Image', stepId: 'push' })
  assert.deepEqual(nextSelection(between, null, false), { stageId: 'Image', stepId: null })
})

test('selectedRecord finds the picked step or job in its stage', () => {
  const failed = view([
    succeededBuild,
    stage('Image', 'failed', [job('Image job', 'failed', [step('docker login', 'succeeded'), step('push', 'failed')], { logId: 7 })])
  ])
  assert.equal(selectedRecord(failed, { stageId: 'Image', stepId: 'push' })?.id, 'push')
  assert.equal(selectedRecord(failed, { stageId: 'Image', stepId: 'Image job' })?.logId, 7)
  assert.equal(selectedRecord(failed, { stageId: 'Build', stepId: 'push' }), null)
  assert.equal(selectedRecord(failed, { stageId: 'Image', stepId: null }), null)
  assert.equal(selectedRecord(failed, null), null)
})

test('logNotice says when a step has not started or has no log yet', () => {
  assert.equal(logNotice(null), 'Select a step to see its log.')
  assert.equal(logNotice(step('cleanup', 'pending')), "This step hasn't started.")
  assert.equal(logNotice(step('cleanup', 'skipped', { logId: null, logLines: null })), 'This step was skipped.')
  assert.equal(
    logNotice(step('push', 'running', { logId: null, logLines: null })),
    "Azure DevOps hasn't published this step's log yet. It shows here as soon as it does."
  )
  assert.equal(logNotice(step('push', 'running')), null)
  assert.equal(logNotice(step('cleanup', 'skipped', { logId: 12 })), null)
})

test('rerunTarget prefers the selected stage, else the first that can be retried', () => {
  const stages = [
    stage('Build', 'failed', [], { canRetry: true }),
    stage('Image', 'canceled', [], { canRetry: true }),
    stage('Deploy production', 'succeeded', [])
  ]
  assert.equal(rerunTarget(view(stages), 'Image')?.id, 'Image')
  assert.equal(rerunTarget(view(stages), 'Deploy production')?.id, 'Build')
  assert.equal(rerunTarget(view(stages), null)?.id, 'Build')
  assert.equal(rerunTarget(view([stage('Build', 'failed', [])]), 'Build'), null)
})

test('approvalText names where the run waits, for how long and who can approve', () => {
  const waiting = [stage('Deploy production', 'waiting', [], { approvalId: 'ab12-approval' })]
  assert.equal(
    approvalText(approval(), waiting, NOW),
    'Waiting for approval at production for 12m 0s. Approvers: Grace Fabrikam, Release Managers (group).'
  )
  assert.equal(
    approvalText(approval({ environment: null, approvers: [] }), waiting, NOW),
    'Waiting for approval at Deploy production for 12m 0s.'
  )
  assert.equal(
    approvalText(approval({ environment: null, stage: null, createdAt: NOW - 2 * HOUR }), waiting, NOW),
    'Waiting for approval at Deploy production for 2h 0m. Approvers: Grace Fabrikam, Release Managers (group).'
  )
  assert.equal(approvalText(approval({ environment: null, stage: null, approvers: [] }), [], NOW), 'Waiting for approval for 12m 0s.')
})

test('countsText counts errors and warnings', () => {
  assert.equal(countsText(2, 1), '2 errors · 1 warning')
  assert.equal(countsText(1, 0), '1 error')
  assert.equal(countsText(0, 3), '3 warnings')
  assert.equal(countsText(0, 0), '')
})

test('watchedOf trusts a watch toggle until a newer view arrives', () => {
  const older = view([], { updatedAt: NOW - SECOND })
  assert.equal(watchedOf(older, null), false)
  assert.equal(watchedOf(older, { value: true, at: NOW }), true)
  assert.equal(watchedOf(view([]), { value: true, at: NOW }), false)
  assert.equal(watchedOf(view([], { updatedAt: NOW + SECOND }), { value: true, at: NOW }), false)
})

test('openedText reports what Open in Orca did', () => {
  assert.equal(openedText({ opened: true, path: 'src/Api/Program.cs', line: 42 }), 'Opened src/Api/Program.cs, line 42.')
  assert.equal(openedText({ opened: true, path: 'Dockerfile', line: null }), 'Opened Dockerfile.')
  assert.equal(openedText({ opened: false, message: "Couldn't find Program.cs in your local workspaces of web-app." }), "Couldn't find Program.cs in your local workspaces of web-app.")
  assert.equal(openedText({ opened: false }), 'Something went wrong.')
})

test('issueFile uses the issue file, else a file named in its message', () => {
  assert.deepEqual(
    issueFile({ type: 'error', message: 'whatever', file: { path: 'src/a.ts', line: 3, column: null } }),
    { path: 'src/a.ts', line: 3, column: null }
  )
  assert.deepEqual(issueFile({ type: 'error', message: 'src/Api/Program.cs(42,17): error CS1002: ; expected', file: null }), {
    path: 'src/Api/Program.cs',
    line: 42,
    column: 17
  })
  assert.equal(issueFile({ type: 'error', message: "Bash exited with code '1'.", file: null }), null)
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
