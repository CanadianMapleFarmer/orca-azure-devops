import { assert, test } from 'orca/testing'
import { MAX_COMMENT } from '../../src/shared/pipelines'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawApproval } from '../ado/approvals'
import type { RawTimeline } from '../ado/timeline'
import { json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { drain } from '../test-support'
import { createRunActions } from './actions'
import {
  APPROVAL_4520,
  APPROVAL_4531,
  fakePipelines,
  isApprovalPatch,
  isApprovals,
  isBuildPatch,
  isOneBuild,
  isStagePatch,
  isTimeline,
  ME,
  type FakePipelines
} from './fake-pipelines'

const NOT_CONNECTED = 'Connect this organization first.'
const NOT_PENDING = 'This approval is no longer pending.'
const NO_PERMISSION = 'TF401027: You need the Administer permission on the environment.'
const OUTAGE = 'TF400733: the service is unavailable.'
const NOT_RETRYABLE = 'Only a failed or canceled stage of a finished run can be rerun.'
const STAGE_GONE = "That stage isn't in this run any more."
const FINISHED = 'This run has already finished.'
const UNEXPECTED_APPROVAL = 'Azure DevOps returned an unexpected approval response.'
const DEPLOY_4520 = '6b2c3d4e-6014-4b3c-8d4e-5f6a7b8c9d14'
const IMAGE_4520 = '6b2c3d4e-6008-4b3c-8d4e-5f6a7b8c9d08'
const BUILD_4512 = '9a2b3c4d-6101-4b3c-8d4e-5f6a7b8c9e01'
const IMAGE_4512 = '9a2b3c4d-6108-4b3c-8d4e-5f6a7b8c9e08'
const DEPLOY_4512 = '9a2b3c4d-6115-4b3c-8d4e-5f6a7b8c9e15'
const SECOND_APPROVER = { id: 'c3d4e5f6-6666-4a7b-9c8d-0e1f2a3b4c5d', displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }

interface Reached {
  org: string
  buildId: number
  calls: number
}

function harness(options: { after?: (org: string, buildId: number) => unknown } = {}) {
  const ado = fakePipelines()
  const reached: Reached[] = []
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const actions = createRunActions({
    http,
    me: async org => {
      if (org !== ORG) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
      return ME
    },
    after: (org, buildId) => {
      reached.push({ org, buildId, calls: ado.calls.length })
      return options.after?.(org, buildId)
    }
  })
  return {
    ado,
    actions,
    reached,
    decide: (approvalId: string, decision: 'approved' | 'rejected' = 'approved', comment = '') =>
      actions.decide({ org: ORG, projectId: PROJECT, approvalId, decision, comment }),
    retryStage: (buildId: number, stageId: string) => actions.retryStage({ org: ORG, projectId: PROJECT, buildId, stageId }),
    cancel: (buildId: number) => actions.cancel({ org: ORG, projectId: PROJECT, buildId }),
    approvalPatches: () => ado.calls.filter(isApprovalPatch),
    stagePatches: () => ado.calls.filter(isStagePatch),
    buildPatches: () => ado.calls.filter(isBuildPatch)
  }
}

function refusal(status: number, message: string) {
  return (call: AdoCall) => json(status, { message, echoedAuthorization: call.headers.get('authorization') })
}

function approvalOf(ado: FakePipelines, id: string): RawApproval {
  return ado.runs.approvals.get(id) ?? assert.fail(`no approval ${id}`)
}

function timelineOf(ado: FakePipelines, buildId: number): RawTimeline {
  return ado.runs.timelines.get(buildId) ?? assert.fail(`no timeline ${buildId}`)
}

function requireApprovers(raw: RawApproval, minimum: number, approvers: number): void {
  const [first] = raw.steps ?? assert.fail('no steps')
  raw.minRequiredApprovers = minimum
  raw.steps = [
    first,
    ...Array.from({ length: approvers - 1 }, (_, index) => ({
      assignedApprover: { ...SECOND_APPROVER, id: `${SECOND_APPROVER.id.slice(0, -1)}${index}` },
      status: 'pending'
    }))
  ]
}

function decideElsewhere(raw: RawApproval, status: string): void {
  raw.status = status
  for (const step of raw.steps ?? []) step.status = status
}

function failDeploy(ado: FakePipelines): void {
  Object.assign(ado.runs.builds.get(4520) ?? assert.fail('no build 4520'), { status: 'completed', result: 'failed', finishTime: '2026-11-05T09:50:00Z' })
  const deploy = timelineOf(ado, 4520).records.find(record => record.id === DEPLOY_4520) ?? assert.fail('no deploy stage')
  Object.assign(deploy, { state: 'completed', result: 'failed' })
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  const waiting = Symbol('waiting')
  const winner = await Promise.race([promise, drain(300).then(() => waiting)])
  return winner === waiting ? assert.fail('the action is still waiting') : (winner as T)
}

async function rejection(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AdoError, 'an AdoError was expected')
    return error
  }
  return assert.fail('the call should have been refused')
}

test('decide reads the approval fresh and reports what ADO did', async () => {
  const h = harness()

  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: true, message: 'Approved.' })
  assert.deepEqual(h.ado.calls.filter(call => isApprovals(call) || isApprovalPatch(call)).map(call => call.method), ['GET', 'PATCH'], 'one read, then one write')
  assert.deepEqual(h.approvalPatches().map(call => call.body), [[{ approvalId: APPROVAL_4531, status: 'approved', comment: '' }]])
  assert.equal(h.approvalPatches()[0].path, `/${ORG}/${PROJECT}/_apis/pipelines/approvals`)

  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: false, message: NOT_PENDING }, 'the second press read the approval again and found it decided')
  assert.equal(h.approvalPatches().length, 1, 'nothing was written for it')
  assert.equal(h.ado.count(isApprovals), 2)

  decideElsewhere(approvalOf(h.ado, APPROVAL_4520), 'approved')
  assert.deepEqual(await h.decide(APPROVAL_4520), { ok: false, message: NOT_PENDING }, 'someone else approved it before the press')
  assert.equal(h.approvalPatches().length, 1)
})

test('decide says how many approvals are still missing', async () => {
  const h = harness()
  requireApprovers(approvalOf(h.ado, APPROVAL_4531), 2, 2)
  requireApprovers(approvalOf(h.ado, APPROVAL_4520), 3, 3)

  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: true, warn: true, message: 'Approved. It still needs 1 more approval.' })
  assert.deepEqual(await h.decide(APPROVAL_4520), { ok: true, warn: true, message: 'Approved. It still needs 2 more approvals.' })
  assert.equal(h.approvalPatches().length, 2)

  h.ado.on(isApprovalPatch, () => {
    const answer = structuredClone(approvalOf(h.ado, APPROVAL_4531))
    for (const step of answer.steps ?? []) step.status = 'approved'
    return json(200, { count: 1, value: [answer] })
  })
  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: true, warn: true, message: 'Approved.' }, 'a count ADO did not give is not claimed')
})

test('decide reports a refusal as the row and writes once', async () => {
  const h = harness()
  h.ado.on(isApprovalPatch, refusal(403, NO_PERMISSION))

  const result = await h.decide(APPROVAL_4531, 'approved', 'Looks good.')

  assert.deepEqual(result, { ok: false, message: NO_PERMISSION })
  assert.equal(h.approvalPatches().length, 1, 'the refused write was not retried')
  assert.equal(h.approvalPatches()[0].headers.get('authorization'), 'Bearer test-credential', 'the refused write did carry the credential')
  assert.ok(!JSON.stringify(result).includes('test-credential'))
  assert.equal(h.reached.length, 1)
})

test('decide that cannot read the approval writes nothing', async () => {
  const h = harness()
  h.ado.on(isApprovals, () => json(500, { message: OUTAGE }))

  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: false, message: OUTAGE })
  assert.deepEqual(h.approvalPatches(), [])
})

test('decide treats an approval that ADO does not list as no longer pending', async () => {
  const h = harness()

  assert.deepEqual(await h.decide('00000000-0000-4000-8000-000000000000'), { ok: false, message: NOT_PENDING })
  assert.deepEqual(h.approvalPatches(), [])
})

test('decide claims nothing ADO did not answer', async () => {
  const h = harness()
  const answer = (status: string) => (call: AdoCall) => {
    const raw = approvalOf(h.ado, (call.body as { approvalId: string }[])[0].approvalId)
    return json(200, { count: 1, value: [{ ...structuredClone(raw), status }] })
  }

  h.ado.on(isApprovalPatch, answer('timedOut'))
  assert.deepEqual(await h.decide(APPROVAL_4531), { ok: false, message: NOT_PENDING })
  h.ado.on(isApprovalPatch, answer('approved'))
  assert.deepEqual(await h.decide(APPROVAL_4520, 'rejected'), { ok: false, message: NOT_PENDING }, 'a rejection that came back approved is not reported as rejected')
  h.ado.on(isApprovalPatch, answer('pending'))
  assert.deepEqual(await h.decide(APPROVAL_4520, 'rejected'), { ok: false, message: UNEXPECTED_APPROVAL }, 'a rejection that is still pending is not reported as rejected')
})

test('reject sends the trimmed comment', async () => {
  const h = harness()

  const result = await h.decide(APPROVAL_4531, 'rejected', '  Needs the migration first.\n')

  assert.deepEqual(result, { ok: true, message: 'Rejected.' })
  assert.deepEqual(h.approvalPatches().map(call => call.body), [[{ approvalId: APPROVAL_4531, status: 'rejected', comment: 'Needs the migration first.' }]])
  assert.equal(approvalOf(h.ado, APPROVAL_4531).status, 'rejected')
})

test('a long comment is refused before any call', async () => {
  const h = harness()

  const error = await rejection(h.decide(APPROVAL_4531, 'approved', 'x'.repeat(MAX_COMMENT + 1)))

  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, 'Keep the comment under 1,000 characters.'])
  assert.equal(h.ado.calls.length, 0)
  assert.deepEqual(h.reached, [])

  const padded = ` ${'x'.repeat(MAX_COMMENT)}\n`
  assert.deepEqual(await h.decide(APPROVAL_4531, 'approved', padded), { ok: true, message: 'Approved.' }, 'the limit counts the trimmed comment')
  assert.equal((h.approvalPatches()[0].body as { comment: string }[])[0].comment.length, MAX_COMMENT)
})

test('retryStage reruns a failed stage by its identifier', async () => {
  const h = harness()
  failDeploy(h.ado)

  const result = await h.retryStage(4520, DEPLOY_4520)

  assert.deepEqual(result, { ok: true, message: 'Rerunning Deploy production.' })
  const [patch, ...rest] = h.stagePatches()
  assert.deepEqual(rest, [], 'one write')
  assert.equal(patch.path, `/${ORG}/${PROJECT}/_apis/build/builds/4520/stages/Deploy_production`)
  assert.deepEqual(patch.body, { state: 'retry', forceRetryAllJobs: false })
  assert.equal(h.ado.count(isOneBuild), 1, 'the run was read fresh')
  const timeline = h.ado.calls.find(isTimeline) ?? assert.fail('the timeline was not read')
  assert.equal(timeline.query.has('changeId'), false, 'the whole timeline was read')
})

test('retryStage refuses a stage that is not failed or canceled, a run still in progress and a stage without an identifier', async () => {
  const h = harness()

  assert.deepEqual(await h.retryStage(4512, BUILD_4512), { ok: false, message: NOT_RETRYABLE }, 'a succeeded stage')
  assert.deepEqual(await h.retryStage(4512, DEPLOY_4512), { ok: false, message: NOT_RETRYABLE }, 'a skipped stage')

  Object.assign(timelineOf(h.ado, 4520).records.find(record => record.id === IMAGE_4520) ?? assert.fail('no image stage'), { result: 'failed' })
  assert.deepEqual(await h.retryStage(4520, IMAGE_4520), { ok: false, message: NOT_RETRYABLE }, 'a failed stage of a run that is still going')

  Object.assign(timelineOf(h.ado, 4512).records.find(record => record.id === IMAGE_4512) ?? assert.fail('no image stage'), { identifier: null })
  assert.deepEqual(await h.retryStage(4512, IMAGE_4512), { ok: false, message: NOT_RETRYABLE }, 'a failed stage that ADO gave no identifier')

  assert.deepEqual(h.stagePatches(), [], 'nothing was written')
  assert.equal(h.reached.length, 4)
})

test('retryStage reruns a canceled stage of a finished run', async () => {
  const h = harness()
  Object.assign(timelineOf(h.ado, 4512).records.find(record => record.id === IMAGE_4512) ?? assert.fail('no image stage'), { result: 'canceled' })

  assert.deepEqual(await h.retryStage(4512, IMAGE_4512), { ok: true, message: 'Rerunning Image.' })
  assert.equal(h.stagePatches().length, 1)
})

test('retryStage reports a stage that is gone', async () => {
  const h = harness()

  assert.deepEqual(await h.retryStage(4512, 'a-stage-from-an-older-view'), { ok: false, message: STAGE_GONE })
  assert.deepEqual(h.stagePatches(), [])

  h.ado.on(isTimeline, () => new Response(null, { status: 204 }))
  assert.deepEqual(await h.retryStage(4512, IMAGE_4512), { ok: false, message: STAGE_GONE }, 'a run with no timeline has no stages')
  assert.deepEqual(h.stagePatches(), [])
})

test('retryStage reports ADO refusing the rerun, or the run being gone, as the result', async () => {
  const h = harness()

  h.ado.on(isStagePatch, refusal(403, NO_PERMISSION))
  assert.deepEqual(await h.retryStage(4512, IMAGE_4512), { ok: false, message: NO_PERMISSION })
  assert.equal(h.stagePatches().length, 1, 'the refused write was not retried')

  assert.deepEqual(await h.retryStage(4999, IMAGE_4512), { ok: false, message: 'The requested build 4999 could not be found.' })
  assert.equal(h.stagePatches().length, 1)
})

test('cancel cancels a running run and leaves finished or cancelling ones alone', async () => {
  const h = harness()

  assert.deepEqual(await h.cancel(4520), { ok: true, message: 'Cancelling the run.' })
  assert.deepEqual(h.buildPatches().map(call => [call.path, call.body]), [[`/${ORG}/${PROJECT}/_apis/build/builds/4520`, { status: 'cancelling' }]])

  assert.deepEqual(await h.cancel(4520), { ok: false, message: 'The run is already cancelling.' }, 'the second press read the run again')
  assert.deepEqual(await h.cancel(4512), { ok: false, message: FINISHED })
  assert.equal(h.buildPatches().length, 1, 'only the first press wrote')
  assert.equal(h.ado.count(isOneBuild), 3)
})

test('cancel cancels a queued run', async () => {
  const h = harness()
  Object.assign(h.ado.runs.builds.get(4531) ?? assert.fail('no build 4531'), { status: 'notStarted' })

  assert.deepEqual(await h.cancel(4531), { ok: true, message: 'Cancelling the run.' })
})

test('cancel reports ADO refusing the write, or the run being gone, as the result', async () => {
  const h = harness()
  h.ado.on(isBuildPatch, refusal(403, NO_PERMISSION))

  assert.deepEqual(await h.cancel(4520), { ok: false, message: NO_PERMISSION })
  assert.equal(h.buildPatches().length, 1, 'the refused write was not retried')
  assert.deepEqual(await h.cancel(4999), { ok: false, message: 'The requested build 4999 could not be found.' })
  assert.equal(h.buildPatches().length, 1)
})

test('every attempt that reached ADO triggers after, unawaited', async () => {
  const h = harness({ after: () => new Promise<never>(() => {}) })
  failDeploy(h.ado)
  h.ado.on(isBuildPatch, refusal(403, NO_PERMISSION))

  const results = [
    await settled(h.decide(APPROVAL_4531)),
    await settled(h.decide(APPROVAL_4531)),
    await settled(h.decide(APPROVAL_4520, 'rejected', 'No.')),
    await settled(h.retryStage(4520, DEPLOY_4520)),
    await settled(h.retryStage(4512, BUILD_4512)),
    await settled(h.cancel(4531)),
    await settled(h.cancel(4512))
  ]

  assert.deepEqual(
    results.map(result => result.ok),
    [true, false, true, true, false, false, false],
    'a decision, a stale decision, a rejection, a rerun, a refused rerun, a refused cancel and a cancel of a finished run'
  )
  assert.deepEqual(h.reached.map(({ buildId }) => buildId), [4531, 4531, 4520, 4520, 4512, 4531, 4512])
  assert.ok(h.reached.every(({ org }) => org === ORG))
})

test('after runs once the attempt has made all of its calls, and not for a refusal that made none', async () => {
  const h = harness()

  await h.decide(APPROVAL_4531, 'approved', 'Ship it.')
  await h.retryStage(4512, IMAGE_4512)
  await h.cancel(4520)

  assert.deepEqual(
    h.reached.map(({ buildId, calls }) => [buildId, calls]),
    [[4531, 2], [4512, 5], [4520, 7]],
    'the approval read and write, then the build, timeline and stage write, then the build read and write'
  )

  const before = h.ado.calls.length
  await rejection(h.decide(APPROVAL_4520, 'approved', 'x'.repeat(MAX_COMMENT + 1)))
  assert.equal(h.ado.calls.length, before)
  assert.equal(h.reached.length, 3, 'a refusal before any call does not trigger after')
})

test('an org that is not connected is refused before anything is read or written', async () => {
  const h = harness()

  const runs: (() => Promise<unknown>)[] = [
    () => h.actions.decide({ org: 'fabrikam', projectId: PROJECT, approvalId: APPROVAL_4531, decision: 'approved', comment: '' }),
    () => h.actions.retryStage({ org: 'fabrikam', projectId: PROJECT, buildId: 4512, stageId: IMAGE_4512 }),
    () => h.actions.cancel({ org: 'fabrikam', projectId: PROJECT, buildId: 4520 })
  ]
  for (const run of runs) {
    const error = await rejection(run())
    assert.deepEqual([error.code, error.status, error.message], ['unauthorized', 401, NOT_CONNECTED])
  }
  assert.equal(h.ado.calls.length, 0)
  assert.deepEqual(h.reached, [])
})
