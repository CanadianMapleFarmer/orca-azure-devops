import { assert, test } from 'orca/testing'
import type { ApprovalSummary } from '../../src/shared/pipelines'
import { fakeAdo, fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import {
  APPROVAL_UPDATE_PERMISSION,
  checkSuiteEnvironment,
  decideApproval,
  getApprovals,
  listPendingApprovals,
  runIdOf,
  toApprovalSummary,
  type RawApproval,
  type RawApprovalStep
} from './approvals'
import { AdoError, createAdoHttp } from './http'

const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const APPROVERS_GROUP = 'd4e5f6a7-5555-4d9e-9f0a-2b3c4d5e6f70'
const APPROVAL_4520 = '8d4e5f6a-7002-4d5e-8f6a-7b8c9d0e1f22'
const APPROVAL_4531 = '9e5f6a7b-7003-4e6f-9a7b-8c9d0e1f2a33'
const CHECK_SUITE_4520 = '7c3d4e5f-7001-4c4d-9e5f-6a7b8c9d0e11'
const APPROVALS = `/${ORG}/${PROJECT}/_apis/pipelines/approvals`
const INPUT = { projectId: PROJECT, me: ME, stage: 'Deploy production', environment: 'production' }

const isApprovals = (call: AdoCall) => call.path === APPROVALS
const isList = (call: AdoCall) => call.method === 'GET' && isApprovals(call)
const isDecide = (call: AdoCall) => call.method === 'PATCH' && isApprovals(call)
const isCheckSuite = (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/pipelines/checks/runs/${CHECK_SUITE_4520}`

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

function approval(buildId: number): RawApproval {
  const found = fixture<{ value: RawApproval[] }>('approvals-pending').value.find(raw => raw.pipeline?.owner?.id === buildId)
  return structuredClone(found ?? assert.fail(`no approval on ${buildId} in the fixture`))
}

function approverStep(id: string, name: string, over: Partial<RawApprovalStep> = {}): RawApprovalStep {
  return { assignedApprover: { id, displayName: name }, status: 'pending', ...over }
}

function summaryOf(over: Partial<RawApproval>, me = ME): ApprovalSummary {
  return toApprovalSummary({ ...approval(4531), ...over }, { ...INPUT, me })
}

function thrown(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
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
  return error.code === 'server' && error.message === MALFORMED.approval
}

test('toApprovalSummary maps approvers, groups, instructions and the waiting time', () => {
  const group: ApprovalSummary = {
    projectId: PROJECT,
    buildId: 4520,
    approvalId: APPROVAL_4520,
    stage: 'Deploy production',
    environment: 'production',
    approvers: [
      {
        id: APPROVERS_GROUP,
        name: '[Fabrikam Web]\\Release Approvers',
        uniqueName: 'vstfs:///Classification/TeamProject/4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d\\Release Approvers',
        isGroup: true
      }
    ],
    minRequired: 1,
    instructions: '',
    createdAt: Date.parse('2026-11-05T09:38:57.2Z'),
    canApprove: false
  }
  assert.deepEqual(toApprovalSummary(approval(4520), INPUT), group)
  const direct: ApprovalSummary = {
    projectId: PROJECT,
    buildId: 4531,
    approvalId: APPROVAL_4531,
    stage: null,
    environment: null,
    approvers: [{ id: ME, name: 'Alex Contoso', uniqueName: 'alex@contoso.example', isGroup: false }],
    minRequired: 1,
    instructions: 'Check the smoke tests on staging before approving.',
    createdAt: Date.parse('2026-11-05T09:47:30Z'),
    canApprove: true
  }
  assert.deepEqual(toApprovalSummary(approval(4531), { ...INPUT, stage: null, environment: null }), direct)
})

test('toApprovalSummary lists each approver once in step order and falls back for missing fields', () => {
  const summary = summaryOf({
    minRequiredApprovers: undefined,
    instructions: undefined,
    createdOn: undefined,
    steps: [
      approverStep('g-1', 'Release Approvers', { assignedApprover: { id: 'g-1', displayName: 'Release Approvers', isContainer: true } }),
      approverStep('u-2', 'Grace Hopper'),
      approverStep('G-1', 'Release Approvers', { assignedApprover: { id: 'G-1', displayName: 'Release Approvers', isContainer: true } }),
      approverStep('u-2', 'Grace Hopper', { status: 'approved' })
    ]
  })
  assert.deepEqual(summary.approvers, [
    { id: 'g-1', name: 'Release Approvers', uniqueName: '', isGroup: true },
    { id: 'u-2', name: 'Grace Hopper', uniqueName: '', isGroup: false }
  ])
  assert.deepEqual([summary.minRequired, summary.instructions, summary.createdAt], [2, '', 0])
})

test('toApprovalSummary reads the number of approvals required', () => {
  assert.equal(summaryOf({ minRequiredApprovers: 2 }).minRequired, 2)
  assert.equal(summaryOf({ minRequiredApprovers: 0 }).minRequired, 1)
  assert.equal(summaryOf({ minRequiredApprovers: 0, steps: [approverStep('u-1', 'Ada Lovelace'), approverStep('u-2', 'Grace Hopper')] }).minRequired, 2)
  assert.deepEqual(summaryOf({ steps: undefined }).approvers, [])
})

test('toApprovalSummary refuses an approval it cannot read', () => {
  const noStepApprover = { ...approval(4531), steps: [{ status: 'pending' } as unknown as RawApprovalStep] }
  const noName = { ...approval(4531), steps: [{ assignedApprover: { id: ME } } as unknown as RawApprovalStep] }
  const noId = { ...approval(4531), id: undefined } as unknown as RawApproval
  const noOwner = { ...approval(4531), pipeline: { id: 12, name: 'web-app-cd' } }
  for (const raw of [noStepApprover, noName, noId, noOwner]) {
    assert(isFixedError(thrown(() => toApprovalSummary(raw, INPUT))))
  }
})

test('canApprove from the permissions bit or a direct assignment', () => {
  assert.equal(APPROVAL_UPDATE_PERMISSION, 2)
  assert.equal(toApprovalSummary(approval(4520), INPUT).canApprove, false)
  assert.equal(toApprovalSummary(approval(4531), INPUT).canApprove, true)
  const grouped = approval(4520)
  grouped.permissions = 3
  assert.equal(toApprovalSummary(grouped, INPUT).canApprove, true)
  assert.equal(summaryOf({ permissions: 1 }).canApprove, true)
  assert.equal(summaryOf({ permissions: 1 }, 'someone-else').canApprove, false)
  assert.equal(summaryOf({ permissions: undefined }, 'someone-else').canApprove, false)
  assert.equal(summaryOf({ permissions: undefined }, ME.toUpperCase()).canApprove, true)
})

test('canApprove ignores a step that is no longer pending and an empty me', () => {
  const decided = { steps: [approverStep(ME, 'Alex Contoso', { status: 'approved' })], permissions: 1 }
  assert.equal(summaryOf(decided).canApprove, false)
  const nameless = { steps: [approverStep('', 'Nobody')], permissions: 1 }
  assert.equal(summaryOf(nameless, '').canApprove, false)
})

test('runIdOf reads the owner id and refuses an approval without one', () => {
  assert.equal(runIdOf(approval(4520)), 4520)
  assert.equal(runIdOf(approval(4531)), 4531)
  const ownerless: RawApproval[] = [
    { ...approval(4520), pipeline: undefined },
    { ...approval(4520), pipeline: { id: 12 } },
    { ...approval(4520), pipeline: { id: 12, owner: {} as { id: number } } },
    { ...approval(4520), pipeline: { id: 12, owner: { id: '4520' as unknown as number } } },
    { ...approval(4520), pipeline: { id: 12, owner: { id: 0 } } },
    { ...approval(4520), pipeline: { id: 12, owner: { id: 4520.5 } } }
  ]
  for (const raw of ownerless) assert(isFixedError(thrown(() => runIdOf(raw))))
})

test('listPendingApprovals asks for pending approvals with steps and permissions, and falls back to steps on a refusal', async () => {
  const { ado, http } = setup()
  ado.on(isList, () => json(200, fixture('approvals-pending')))
  const approvals = await listPendingApprovals(http, ORG, PROJECT)
  assert.deepEqual(approvals.map(raw => raw.id), [APPROVAL_4520, APPROVAL_4531])
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, APPROVALS)
  assert.deepEqual(
    [call.query.get('state'), call.query.get('$expand'), call.query.get('top'), call.query.get('api-version')],
    ['pending', 'steps,permissions', '50', '7.1']
  )

  const refused = setup()
  refused.ado.on(isList, request =>
    request.query.get('$expand') === 'steps,permissions'
      ? json(400, { message: 'The expand value permissions is not supported.' })
      : json(200, fixture('approvals-pending'))
  )
  const fallback = await listPendingApprovals(refused.http, ORG, PROJECT)
  assert.equal(fallback.length, 2)
  assert.deepEqual(refused.ado.calls.map(request => request.query.get('$expand')), ['steps,permissions', 'steps'])
  assert.deepEqual(refused.ado.calls.map(request => request.query.get('state')), ['pending', 'pending'])
  assert.deepEqual(refused.ado.calls.map(request => request.query.get('top')), ['50', '50'])
})

test('listPendingApprovals falls back once and only on a refused request', async () => {
  const twice = setup()
  twice.ado.on(isList, () => json(400, { message: 'Bad expand.' }))
  const error = await failure(listPendingApprovals(twice.http, ORG, PROJECT))
  assert.deepEqual([error.code, error.message, twice.ado.calls.length], ['bad_request', 'Bad expand.', 2])

  const forbidden = setup()
  forbidden.ado.on(isList, () => json(403, { message: 'No access to approvals.' }))
  const refused = await failure(listPendingApprovals(forbidden.http, ORG, PROJECT))
  assert.deepEqual([refused.code, refused.message, forbidden.ado.calls.length], ['forbidden', 'No access to approvals.', 1])
})

test('listPendingApprovals stops on an abort without asking again', async () => {
  const { ado, http } = setup()
  const controller = new AbortController()
  ado.on(isList, () => {
    controller.abort(new Error('stopped'))
    return json(400, { message: 'Bad expand.' })
  })
  await assert.rejects(listPendingApprovals(http, ORG, PROJECT, controller.signal), /stopped/)
  assert.equal(ado.calls.length, 1)
})

test('listPendingApprovals reads an empty list and refuses a malformed one', async () => {
  const empty = setup()
  empty.ado.on(isList, () => json(200, { count: 0, value: [] }))
  assert.deepEqual(await listPendingApprovals(empty.http, ORG, PROJECT), [])
  const broken = setup()
  broken.ado.on(isList, () => json(200, { count: 1, value: { id: 'x' } }))
  assert(isFixedError(await failure(listPendingApprovals(broken.http, ORG, PROJECT))))
})

test('getApprovals asks by id and makes no call for none', async () => {
  const { ado, http } = setup()
  ado.on(isList, () => json(200, fixture('approvals-pending')))
  assert.deepEqual(await getApprovals(http, ORG, PROJECT, []), [])
  assert.equal(ado.calls.length, 0)
  const approvals = await getApprovals(http, ORG, PROJECT, [APPROVAL_4520, APPROVAL_4531])
  assert.equal(approvals.length, 2)
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, APPROVALS)
  assert.deepEqual(
    [call.query.get('approvalIds'), call.query.get('$expand'), call.query.has('state'), call.query.get('api-version')],
    [`${APPROVAL_4520},${APPROVAL_4531}`, 'steps,permissions', false, '7.1']
  )
})

test('getApprovals falls back to steps on a refusal', async () => {
  const { ado, http } = setup()
  ado.on(isList, call =>
    call.query.get('$expand') === 'steps,permissions' ? json(400, { message: 'Bad expand.' }) : json(200, fixture('approval-decided'))
  )
  const approvals = await getApprovals(http, ORG, PROJECT, [APPROVAL_4531])
  assert.deepEqual(approvals.map(raw => [raw.id, raw.status]), [[APPROVAL_4531, 'approved']])
  assert.deepEqual(ado.calls.map(call => call.query.get('$expand')), ['steps,permissions', 'steps'])
  assert.deepEqual(ado.calls.map(call => call.query.get('approvalIds')), [APPROVAL_4531, APPROVAL_4531])
})

test('decideApproval sends one decision with the comment', async () => {
  const { ado, http } = setup()
  ado.on(isDecide, () => json(200, fixture('approval-decided')))
  const decided = await decideApproval(http, ORG, PROJECT, APPROVAL_4531, 'approved', 'Smoke tests are green.')
  assert.equal(decided.id, APPROVAL_4531)
  assert.equal(decided.status, 'approved')
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, APPROVALS)
  assert.equal(call.query.get('api-version'), '7.1')
  assert.equal(call.headers.get('content-type'), 'application/json')
  assert.deepEqual(call.body, [{ approvalId: APPROVAL_4531, status: 'approved', comment: 'Smoke tests are green.' }])
  assert.deepEqual(Object.keys(call.body[0]), ['approvalId', 'status', 'comment'])
})

test('decideApproval sends a rejection with its comment and an empty comment as is', async () => {
  const { ado, http } = setup()
  ado.on(isDecide, call => json(200, { count: 1, value: [{ ...approval(4531), id: call.body[0].approvalId, status: call.body[0].status }] }))
  const rejected = await decideApproval(http, ORG, PROJECT, APPROVAL_4531, 'rejected', 'Staging is red.')
  const quiet = await decideApproval(http, ORG, PROJECT, APPROVAL_4531, 'approved', '')
  assert.deepEqual([rejected.status, quiet.status], ['rejected', 'approved'])
  assert.deepEqual(ado.calls.map(call => call.body), [
    [{ approvalId: APPROVAL_4531, status: 'rejected', comment: 'Staging is red.' }],
    [{ approvalId: APPROVAL_4531, status: 'approved', comment: '' }]
  ])
})

test('decideApproval returns the matching element of the answer and refuses an answer without it', async () => {
  const { ado, http } = setup()
  const other = { ...approval(4520), status: 'pending' }
  const mine = { ...approval(4531), status: 'approved' }
  ado.on(isDecide, () => json(200, { count: 2, value: [other, mine] }))
  const decided = await decideApproval(http, ORG, PROJECT, APPROVAL_4531.toUpperCase(), 'approved', '')
  assert.equal(decided.id, APPROVAL_4531)

  const missing = setup()
  missing.ado.on(isDecide, () => json(200, { count: 1, value: [other] }))
  assert(isFixedError(await failure(decideApproval(missing.http, ORG, PROJECT, APPROVAL_4531, 'approved', ''))))
  const empty = setup()
  empty.ado.on(isDecide, () => json(200, { count: 0, value: [] }))
  assert(isFixedError(await failure(decideApproval(empty.http, ORG, PROJECT, APPROVAL_4531, 'approved', ''))))
  const statusless = setup()
  statusless.ado.on(isDecide, () => json(200, { count: 1, value: [{ ...mine, status: undefined }] }))
  assert(isFixedError(await failure(decideApproval(statusless.http, ORG, PROJECT, APPROVAL_4531, 'approved', ''))))
})

test('decideApproval is sent once and a refusal reaches the caller with its own message', async () => {
  for (const [status, code, message] of [
    [403, 'forbidden', 'You are not an approver for this check.'],
    [400, 'bad_request', 'The approval was already decided.'],
    [500, 'server', 'Approval service failed.']
  ] as const) {
    const { ado, http } = setup()
    ado.on(isDecide, call => json(status, { message, echoedAuthorization: call.headers.get('authorization') }))
    const error = await failure(decideApproval(http, ORG, PROJECT, APPROVAL_4531, 'approved', 'ok'))
    assert.deepEqual([error.code, error.message, ado.calls.length], [code, message, 1])
    assert(!error.message.includes('test-credential'))
  }
})

test('checkSuiteEnvironment finds the environment resource', async () => {
  const { ado, http } = setup()
  ado.on(isCheckSuite, () => json(200, fixture('check-suite-4520')))
  assert.equal(await checkSuiteEnvironment(http, ORG, PROJECT, CHECK_SUITE_4520), 'production')
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/pipelines/checks/runs/${CHECK_SUITE_4520}`)
  assert.deepEqual([call.query.get('$expand'), call.query.get('api-version')], ['resources', '7.1-preview.1'])
})

test('checkSuiteEnvironment takes the first environment resource and returns null without one', async () => {
  const mixed = setup()
  mixed.ado.on(isCheckSuite, () =>
    json(200, {
      id: CHECK_SUITE_4520,
      resources: [
        { type: 'repository', id: 'r', name: 'web-app' },
        { type: 'environment', id: '7', name: 'production' },
        { type: 'environment', id: '8', name: 'staging' }
      ]
    })
  )
  assert.equal(await checkSuiteEnvironment(mixed.http, ORG, PROJECT, CHECK_SUITE_4520), 'production')

  for (const body of [{ id: CHECK_SUITE_4520 }, { id: CHECK_SUITE_4520, resources: null }, { id: CHECK_SUITE_4520, resources: [] }, { id: CHECK_SUITE_4520, resources: [{ type: 'repository', name: 'web-app' }] }]) {
    const none = setup()
    none.ado.on(isCheckSuite, () => json(200, body))
    assert.equal(await checkSuiteEnvironment(none.http, ORG, PROJECT, CHECK_SUITE_4520), null)
  }
})

test('checkSuiteEnvironment refuses resources that are not a list and lets a refusal through', async () => {
  const broken = setup()
  broken.ado.on(isCheckSuite, () => json(200, { id: CHECK_SUITE_4520, resources: { type: 'environment', name: 'production' } }))
  assert(isFixedError(await failure(checkSuiteEnvironment(broken.http, ORG, PROJECT, CHECK_SUITE_4520))))
  const forbidden = setup()
  forbidden.ado.on(isCheckSuite, () => json(403, { message: 'No access to checks.' }))
  const error = await failure(checkSuiteEnvironment(forbidden.http, ORG, PROJECT, CHECK_SUITE_4520))
  assert.deepEqual([error.code, error.message], ['forbidden', 'No access to checks.'])
})

test('checkSuiteEnvironment encodes the check suite id', async () => {
  const urls: string[] = []
  const { ado } = setup()
  const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    return ado.fetch(input, init)
  }) as typeof fetch
  const http = createAdoHttp({ fetch: fetchSpy, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  ado.on(() => true, () => json(200, { id: 'x', resources: [] }))
  await checkSuiteEnvironment(http, ORG, PROJECT, 'a/b c')
  assert(urls[0].includes('/_apis/pipelines/checks/runs/a%2Fb%20c?'), urls[0])
})
