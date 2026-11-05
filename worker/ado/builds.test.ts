import { assert, test } from 'orca/testing'
import type { RunState, RunSummary } from '../../src/shared/pipelines'
import { fakeAdo, fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { MALFORMED, UNKNOWN_AUTHOR } from '../messages'
import { buildsByIds, getBuild, listBuilds, runStateOf, runWebUrl, toRunSummary, type RawBuild } from './builds'
import { AdoError, createAdoHttp } from './http'

const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'

const isBuilds = (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/build/builds`
const isBuild = (id: number) => (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/build/builds/${id}`

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

function build(id: number): RawBuild {
  const found = fixture<{ value: RawBuild[] }>('builds-mine').value.find(raw => raw.id === id)
  return structuredClone(found ?? assert.fail(`no build ${id} in the fixture`))
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
  return error.code === 'server' && error.message === MALFORMED.build
}

test('toRunSummary maps a PR validation run', () => {
  const expected: RunSummary = {
    org: ORG,
    projectId: PROJECT,
    buildId: 4512,
    projectName: 'Fabrikam Web',
    pipeline: { id: 8, name: 'web-app-ci' },
    runNumber: '20261105.1',
    url: `${ORG_URL}/${PROJECT}/_build/results?buildId=4512`,
    branch: 'feature/1204-vehicle-search',
    prId: 4101,
    reason: 'pullRequest',
    repository: { id: REPO, name: 'web-app' },
    requestedFor: { id: ME, name: 'Alex Contoso' },
    state: 'failed',
    queuedAt: Date.parse('2026-11-05T08:04:12.31Z'),
    startedAt: Date.parse('2026-11-05T08:04:21.01Z'),
    finishedAt: Date.parse('2026-11-05T08:09:47.5Z'),
    stages: null,
    approvals: [],
    mine: true,
    watched: false
  }
  assert.deepEqual(toRunSummary(build(4512), ORG, ME), expected)
})

test('toRunSummary builds the web URL from names when the link is missing', () => {
  const raw = build(4520)
  delete raw._links
  assert.equal(toRunSummary(raw, ORG, ME).url, `${ORG_URL}/Fabrikam%20Web/_build/results?buildId=4520`)
  assert.equal(runWebUrl(ORG, 'Fabrikam Web', 4520), `${ORG_URL}/Fabrikam%20Web/_build/results?buildId=4520`)
})

test('toRunSummary percent-encodes a raw space in the link and falls back to names when it cannot be parsed', () => {
  const spaced = build(4520)
  spaced._links = { web: { href: `${ORG_URL}/Fabrikam Web/_build/results?buildId=4520` } }
  assert.equal(toRunSummary(spaced, ORG, ME).url, `${ORG_URL}/Fabrikam%20Web/_build/results?buildId=4520`)
  const unparsable = build(4520)
  unparsable._links = { web: { href: 'not a url' } }
  assert.equal(toRunSummary(unparsable, ORG, ME).url, `${ORG_URL}/Fabrikam%20Web/_build/results?buildId=4520`)
  const empty = build(4520)
  empty._links = { web: {} }
  assert.equal(toRunSummary(empty, ORG, ME).url, `${ORG_URL}/Fabrikam%20Web/_build/results?buildId=4520`)
})

test('toRunSummary reads every build of the mine and running fixtures', () => {
  const rows = [...fixture<{ value: RawBuild[] }>('builds-mine').value, ...fixture<{ value: RawBuild[] }>('builds-running').value]
    .map(raw => toRunSummary(raw, ORG, ME))
    .map(run => [run.buildId, run.pipeline.id, run.pipeline.name, run.runNumber, run.branch, run.state, run.mine])
  assert.deepEqual(rows, [
    [4520, 12, 'web-app-cd', '20261105.3', 'main', 'running', true],
    [4512, 8, 'web-app-ci', '20261105.1', 'feature/1204-vehicle-search', 'failed', true],
    [4505, 8, 'web-app-ci', '20261104.2', 'develop', 'succeeded', true],
    [4498, 9, 'api-ci', '20261104.1', 'develop', 'succeeded', true],
    [4490, 8, 'web-app-ci', '20261103.1', 'develop', 'failed', true],
    [4531, 12, 'web-app-cd', '20261105.4', 'main', 'running', false],
    [4520, 12, 'web-app-cd', '20261105.3', 'main', 'running', true]
  ])
})

test('toRunSummary leaves a running run unfinished and reads its start', () => {
  const run = toRunSummary(build(4520), ORG, ME)
  assert.deepEqual(
    [run.state, run.reason, run.finishedAt, run.startedAt, run.queuedAt],
    ['running', 'individualCI', null, Date.parse('2026-11-05T09:31:00.8466667Z'), Date.parse('2026-11-05T09:30:41.0233333Z')]
  )
})

test('toRunSummary compares the requester with me without regard to case and reads a missing requester as unknown', () => {
  assert.equal(toRunSummary(build(4512), ORG, ME.toUpperCase()).mine, true)
  assert.equal(toRunSummary(build(4512), ORG, 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d').mine, false)
  const raw = build(4512)
  delete raw.requestedFor
  const run = toRunSummary(raw, ORG, ME)
  assert.deepEqual([run.mine, run.requestedFor], [false, { id: '', name: UNKNOWN_AUTHOR }])
  assert.equal(toRunSummary(raw, ORG, '').mine, false)
})

test('toRunSummary takes the branch from the PR trigger and the PR number from the trigger or the merge ref', () => {
  const ci = toRunSummary(build(4505), ORG, ME)
  assert.deepEqual([ci.branch, ci.prId], ['develop', null])

  const merge = { ...build(4512), triggerInfo: undefined, sourceBranch: 'refs/pull/4102/merge' }
  assert.equal(toRunSummary(merge, ORG, ME).prId, 4102)

  for (const garbage of ['', 'abc', '12.5', '1e3', '0', '-4']) {
    const raw = build(4512)
    raw.triggerInfo = { 'pr.number': garbage }
    assert.equal(toRunSummary(raw, ORG, ME).prId, 4101, `merge ref after "${garbage}"`)
    raw.sourceBranch = 'refs/heads/develop'
    assert.equal(toRunSummary(raw, ORG, ME).prId, null, `no PR after "${garbage}"`)
  }

  const unprefixed = build(4512)
  unprefixed.triggerInfo = { 'pr.number': '4101', 'pr.sourceBranch': 'feature/1204-vehicle-search' }
  assert.equal(toRunSummary(unprefixed, ORG, ME).branch, 'feature/1204-vehicle-search')
})

test('toRunSummary reports a repository only for Azure Repos git', () => {
  const github: RawBuild = { ...build(4520), repository: { id: 'acme/web-app', name: 'acme/web-app', type: 'GitHub' } }
  assert.equal(toRunSummary(github, ORG, ME).repository, null)
  const missing = build(4520)
  delete missing.repository
  assert.equal(toRunSummary(missing, ORG, ME).repository, null)
  assert.deepEqual(toRunSummary(build(4498), ORG, ME).repository, { id: '8e9f0a1b-3333-4d6e-9f7a-4b5c6d7e8f90', name: 'api' })
})

test('toRunSummary reads bad dates as unset and a missing reason as empty', () => {
  const raw = { ...build(4512), queueTime: 'yesterday', startTime: 'later', finishTime: undefined, reason: undefined }
  const run = toRunSummary(raw, ORG, ME)
  assert.deepEqual([run.queuedAt, run.startedAt, run.finishedAt, run.reason], [0, null, null, ''])
  const noQueue = { ...build(4512), queueTime: undefined }
  assert.equal(toRunSummary(noQueue, ORG, ME).queuedAt, 0)
})

test('toRunSummary turns a response that is missing required fields into the fixed error', () => {
  const missing = (change: (raw: RawBuild) => void) => {
    const raw = build(4512)
    change(raw)
    return raw
  }
  const cases: RawBuild[] = [
    missing(raw => Reflect.deleteProperty(raw, 'definition')),
    missing(raw => Reflect.deleteProperty(raw, 'project')),
    missing(raw => Reflect.deleteProperty(raw, 'buildNumber')),
    missing(raw => Reflect.deleteProperty(raw, 'sourceBranch')),
    { ...build(4512), id: '4512' as unknown as number },
    { ...build(4512), definition: { id: 8.5, name: 'web-app-ci' } },
    { ...build(4512), requestedFor: { id: ME } as RawBuild['requestedFor'] },
    null as unknown as RawBuild
  ]
  for (const raw of cases) assert(isFixedError(thrown(() => toRunSummary(raw, ORG, ME))), JSON.stringify(raw))
})

test('runStateOf maps every status and result', () => {
  const state = (status: string, result?: string): RunState => runStateOf({ status, result })
  assert.equal(state('notStarted'), 'queued')
  assert.equal(state('postponed'), 'queued')
  assert.equal(state('inProgress'), 'running')
  assert.equal(state('inProgress', 'succeeded'), 'running')
  assert.equal(state('cancelling'), 'cancelling')
  assert.equal(state('completed', 'succeeded'), 'succeeded')
  assert.equal(state('completed', 'partiallySucceeded'), 'warning')
  assert.equal(state('completed', 'failed'), 'failed')
  assert.equal(state('completed', 'canceled'), 'canceled')
  assert.equal(state('completed', 'none'), 'warning')
  assert.equal(state('completed'), 'warning')
  assert.equal(state('none'), 'warning')
  assert.equal(state('all'), 'warning')
  assert.equal(state('somethingNew', 'failed'), 'warning')
})

test('listBuilds sends the criteria', async () => {
  const { ado, http } = setup()
  ado.on(isBuilds, () => json(200, fixture('builds-mine')))
  const since = Date.parse('2026-10-29T10:00:00Z')
  const mine = await listBuilds(http, ORG, PROJECT, { requestedFor: ME, minTime: since, top: 50 })
  assert.deepEqual(mine.map(raw => raw.id), [4520, 4512, 4505, 4498, 4490])
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/build/builds`)
  assert.equal(call.query.get('requestedFor'), ME)
  assert.equal(call.query.get('minTime'), '2026-10-29T10:00:00.000Z')
  assert.equal(call.query.get('queryOrder'), 'queueTimeDescending')
  assert.equal(call.query.get('$top'), '50')
  assert.equal(call.query.get('api-version'), '7.1')
  assert.equal(call.query.has('statusFilter'), false)

  ado.on(isBuilds, () => json(200, fixture('builds-running')))
  const running = await listBuilds(http, ORG, PROJECT, { statusFilter: 'inProgress', top: 25 })
  assert.deepEqual(running.map(raw => raw.id), [4531, 4520])
  const second = ado.calls[1]
  assert.equal(second.query.get('statusFilter'), 'inProgress')
  assert.equal(second.query.get('queryOrder'), 'queueTimeDescending')
  assert.equal(second.query.get('$top'), '25')
  assert.equal(second.query.has('requestedFor'), false)
  assert.equal(second.query.has('minTime'), false)
})

test('buildsByIds sends one comma list and makes no call for none', async () => {
  const { ado, http } = setup()
  ado.on(isBuilds, () => json(200, fixture('builds-running')))
  const found = await buildsByIds(http, ORG, PROJECT, [4531, 4520])
  assert.deepEqual(found.map(raw => raw.id), [4531, 4520])
  assert.equal(ado.calls.length, 1)
  assert.equal(ado.calls[0].path, `/${ORG}/${PROJECT}/_apis/build/builds`)
  assert.equal(ado.calls[0].query.get('buildIds'), '4531,4520')
  assert.equal(ado.calls[0].query.get('api-version'), '7.1')

  assert.deepEqual(await buildsByIds(http, ORG, PROJECT, []), [])
  assert.equal(ado.calls.length, 1)
})

test('buildsByIds reads at most 100 builds in one call', async () => {
  const { ado, http } = setup()
  ado.on(isBuilds, () => json(200, { count: 0, value: [] }))
  const ids = Array.from({ length: 100 }, (_, index) => 4000 + index)
  await buildsByIds(http, ORG, PROJECT, ids)
  assert.equal(ado.calls[0].query.get('buildIds')?.split(',').length, 100)
  await assert.rejects(buildsByIds(http, ORG, PROJECT, [...ids, 4100]))
  assert.equal(ado.calls.length, 1)
})

test('getBuild reads one run', async () => {
  const { ado, http } = setup()
  ado.on(isBuild(4520), () => json(200, fixture('build-4520')))
  const raw = await getBuild(http, ORG, PROJECT, 4520)
  assert.equal(raw.id, 4520)
  assert.equal(toRunSummary(raw, ORG, ME).pipeline.name, 'web-app-cd')
  assert.equal(ado.calls.length, 1)
  assert.equal(ado.calls[0].method, 'GET')
  assert.equal(ado.calls[0].path, `/${ORG}/${PROJECT}/_apis/build/builds/4520`)
  assert.equal(ado.calls[0].query.get('api-version'), '7.1')
})

test('a missing run is a not-found error and an empty answer is the fixed error', async () => {
  const { ado, http } = setup()
  ado.on(isBuild(9999), () => json(404, { message: 'Build 9999 does not exist.' }))
  const gone = await failure(getBuild(http, ORG, PROJECT, 9999))
  assert.deepEqual([gone.code, gone.message], ['not_found', 'Build 9999 does not exist.'])

  ado.on(isBuild(4520), () => new Response(null, { status: 204 }))
  assert(isFixedError(await failure(getBuild(http, ORG, PROJECT, 4520))))
})

test('a malformed run list becomes the fixed error', async () => {
  const { ado, http } = setup()
  for (const body of [{ value: 'nope' }, { count: 1 }, null]) {
    ado.on(isBuilds, () => json(200, body))
    assert(isFixedError(await failure(listBuilds(http, ORG, PROJECT, { statusFilter: 'inProgress', top: 25 }))), JSON.stringify(body))
    assert(isFixedError(await failure(buildsByIds(http, ORG, PROJECT, [4520]))), JSON.stringify(body))
  }
})

test('the reads stop when their signal aborts and ADO errors pass through', async () => {
  const { ado, http } = setup()
  ado.on(isBuilds, () => json(200, fixture('builds-mine')))
  ado.on(isBuild(4520), () => json(200, fixture('build-4520')))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(listBuilds(http, ORG, PROJECT, { requestedFor: ME, top: 50 }, controller.signal))
  await assert.rejects(buildsByIds(http, ORG, PROJECT, [4520], controller.signal))
  await assert.rejects(getBuild(http, ORG, PROJECT, 4520, controller.signal))
  assert.equal(ado.calls.length, 0)

  ado.on(isBuilds, () => json(403, { message: 'No access to builds.' }))
  const forbidden = await failure(listBuilds(http, ORG, PROJECT, { requestedFor: ME, top: 50 }))
  assert.deepEqual([forbidden.code, forbidden.message], ['forbidden', 'No access to builds.'])
})
