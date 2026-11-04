import { assert, test } from 'orca/testing'
import type { PrSummary } from '../../src/shared/prs'
import { fakeAdo, fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { AdoError, createAdoHttp } from './http'
import {
  codeProjects,
  getPullRequest,
  listPullRequests,
  pullRequestWorkItems,
  toPrSummary,
  toReviewer,
  type RawPullRequest,
  type RawReviewer
} from './pullrequests'

const WEB_URL = `${ORG_URL}/Fabrikam%20Web/_git/web-app`
const PLATFORM = '2b3c4d5e-7777-4f8a-9b0c-1d2e3f4a5b6c'
const ALEX = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
const DENNIS = 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e'
const TEAM = 'c3d4e5f6-5555-4c8d-8e9f-1a2b3c4d5e6f'
const TEAM_UNIQUE_NAME = `vstfs:///Classification/TeamProject/${PROJECT}\\Fabrikam Web Team`
const DAY = 24 * 60 * 60 * 1000

const isPullRequests = (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/git/pullrequests`
const isRepositories = (call: AdoCall) => call.path === `/${ORG}/_apis/git/repositories`
const isProjects = (call: AdoCall) => call.path === `/${ORG}/_apis/projects`

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

function mine(index: number): RawPullRequest {
  return structuredClone(fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value[index])
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

function thrown(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function isFixedError(error: AdoError): boolean {
  return error.code === 'server' && error.message === MALFORMED.pullRequest
}

test('toPrSummary maps status, branches, reviewers, merge status and auto-complete', () => {
  const expected: PrSummary = {
    org: ORG,
    projectId: PROJECT,
    projectName: 'Fabrikam Web',
    repoId: REPO,
    repoName: 'web-app',
    prId: 4101,
    title: 'Add vehicle search filters',
    url: `${WEB_URL}/pullrequest/4101`,
    source: 'feature/1204-vehicle-search',
    target: 'develop',
    status: 'active',
    isDraft: false,
    mergeStatus: 'ok',
    createdBy: { id: ALEX, name: 'Alex Contoso' },
    createdAt: Date.parse('2026-11-03T14:20:11.5Z'),
    closedAt: null,
    reviewers: [
      { id: GRACE, name: 'Grace Hopper', uniqueName: 'grace@contoso.example', vote: 10, isRequired: true, isGroup: false, hasDeclined: false },
      { id: TEAM, name: '[Fabrikam Web]\\Fabrikam Web Team', uniqueName: TEAM_UNIQUE_NAME, vote: 0, isRequired: true, isGroup: true, hasDeclined: false },
      { id: DENNIS, name: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example', vote: -5, isRequired: false, isGroup: false, hasDeclined: false }
    ],
    autoComplete: true,
    workItemIds: [],
    checks: null
  }
  assert.deepEqual(toPrSummary(mine(0), ORG), expected)
})

test('toPrSummary reads auto-complete, draft, closed and merge status from the response', () => {
  assert.equal(toPrSummary(mine(1), ORG).autoComplete, false)
  assert.equal(toPrSummary(mine(1), ORG).target, 'qa')
  assert.equal(toPrSummary(mine(4), ORG).isDraft, true)
  assert.equal(toPrSummary(mine(3), ORG).repoName, 'api')
  assert.equal(toPrSummary(mine(3), ORG).source, 'bugfix/1205-pagination-offset')

  const mergeStatusOf = (mergeStatus: string | undefined) => toPrSummary({ ...mine(0), mergeStatus }, ORG).mergeStatus
  assert.equal(mergeStatusOf('succeeded'), 'ok')
  assert.equal(mergeStatusOf('conflicts'), 'conflicts')
  assert.equal(mergeStatusOf('failure'), 'failed')
  assert.equal(mergeStatusOf('rejectedByPolicy'), 'failed')
  assert.equal(mergeStatusOf('queued'), 'pending')
  assert.equal(mergeStatusOf('notSet'), 'pending')
  assert.equal(mergeStatusOf(undefined), 'pending')

  const [completed] = fixture<{ value: RawPullRequest[] }>('pull-requests-completed').value
  const summary = toPrSummary(completed, ORG)
  assert.deepEqual([summary.status, summary.closedAt], ['completed', Date.parse('2026-11-02T16:05:42.3Z')])
  assert.equal(toPrSummary({ ...mine(0), status: 'abandoned' }, ORG).status, 'abandoned')
  assert.equal(toPrSummary({ ...mine(0), status: 'notSet' }, ORG).status, 'active')
})

test('toPrSummary keeps only the branch name and treats a missing reviewer list as empty', () => {
  const raw = { ...mine(0), sourceRefName: 'refs/heads/feature/refs/heads/x', reviewers: undefined }
  const summary = toPrSummary(raw, ORG)
  assert.equal(summary.source, 'feature/refs/heads/x')
  assert.deepEqual(summary.reviewers, [])
})

test('toPrSummary builds the web URL from names when webUrl is missing', () => {
  const raw = mine(0)
  delete raw.repository.webUrl
  assert.equal(toPrSummary(raw, ORG).url, 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101')
})

test('toReviewer maps a group and treats a missing vote as 0', () => {
  const group = toReviewer({ id: TEAM, displayName: 'Team', isContainer: true })
  assert.deepEqual(group, { id: TEAM, name: 'Team', uniqueName: '', vote: 0, isRequired: false, isGroup: true, hasDeclined: false })
  assert.equal(toReviewer({ id: GRACE, displayName: 'Grace Hopper', vote: -10, hasDeclined: true }).hasDeclined, true)
})

test('listPullRequests sends the search criteria', async () => {
  const { ado, http } = setup()
  ado.on(isPullRequests, () => json(200, fixture('pull-requests-mine')))
  const active = await listPullRequests(http, ORG, PROJECT, { creatorId: 'u1', status: 'active', top: 100 })
  assert.deepEqual(active.map(pr => pr.pullRequestId), [4101, 4102, 4103, 4104, 4105])
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/git/pullrequests`)
  assert.equal(call.query.get('searchCriteria.creatorId'), 'u1')
  assert.equal(call.query.get('searchCriteria.status'), 'active')
  assert.equal(call.query.get('$top'), '100')
  assert.equal(call.query.get('api-version'), '7.1')
  assert.equal(call.query.has('searchCriteria.reviewerId'), false)
  assert.equal(call.query.has('searchCriteria.queryTimeRangeType'), false)
  assert.equal(call.query.has('searchCriteria.minTime'), false)

  const closedSince = Date.parse('2026-10-22T09:00:00Z') + 5 * DAY
  await listPullRequests(http, ORG, PROJECT, { creatorId: 'u1', status: 'completed', closedSince, top: 50 })
  const completed = ado.calls[1]
  assert.equal(completed.query.get('searchCriteria.status'), 'completed')
  assert.equal(completed.query.get('searchCriteria.queryTimeRangeType'), 'closed')
  assert.equal(completed.query.get('searchCriteria.minTime'), new Date(closedSince).toISOString())
  assert.equal(completed.query.get('$top'), '50')
})

test('listPullRequests filters by reviewer when asked and stops when its signal aborts', async () => {
  const { ado, http } = setup()
  ado.on(isPullRequests, () => json(200, fixture('pull-requests-review')))
  const review = await listPullRequests(http, ORG, PROJECT, { reviewerId: 'u1', status: 'active', top: 100 })
  assert.deepEqual(review.map(pr => pr.pullRequestId), [4110, 4111])
  assert.equal(ado.calls[0].query.get('searchCriteria.reviewerId'), 'u1')
  assert.equal(ado.calls[0].query.has('searchCriteria.creatorId'), false)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(listPullRequests(http, ORG, PROJECT, { creatorId: 'u1', status: 'active', top: 100 }, controller.signal))
  assert.equal(ado.calls.length, 1)
})

test('getPullRequest reads one PR through its repository path', async () => {
  const { ado, http } = setup()
  ado.on(call => call.path.endsWith('/pullrequests/4101'), () => json(200, mine(0)))
  const pr = await getPullRequest(http, ORG, { projectId: PROJECT, repoId: REPO, prId: 4101 })
  assert.equal(pr.pullRequestId, 4101)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullrequests/4101`)
})

test('getPullRequest passes a missing pull request on as not_found', async () => {
  const { ado, http } = setup()
  ado.on(call => call.path.endsWith('/pullrequests/4999'), () => json(404, { message: 'TF401180: The requested pull request was not found.' }))
  assert.equal((await failure(getPullRequest(http, ORG, { projectId: PROJECT, repoId: REPO, prId: 4999 }))).code, 'not_found')
})

test('pullRequestWorkItems returns numeric ids', async () => {
  const { ado, http } = setup()
  const isWorkItems = (call: AdoCall) => call.path.endsWith('/pullRequests/4101/workitems')
  ado.on(isWorkItems, () => json(200, fixture('pull-request-workitems')))
  const key = { projectId: PROJECT, repoId: REPO, prId: 4101 }
  assert.deepEqual(await pullRequestWorkItems(http, ORG, key), [1204, 1207])
  assert.equal(ado.calls[0].path, `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4101/workitems`)

  ado.on(isWorkItems, () => json(200, { count: 4, value: [{ id: '1204' }, { id: 'abc' }, { id: '12x' }, { id: '1207' }] }))
  assert.deepEqual(await pullRequestWorkItems(http, ORG, key), [1204, 1207])
})

test('codeProjects lists projects that hold repositories and falls back to every project when the org-wide list is refused', async () => {
  const { ado, http } = setup()
  ado.on(isRepositories, () => json(200, fixture('repositories')))
  assert.deepEqual(await codeProjects(http, ORG, 'all'), [
    { id: PLATFORM, name: 'Fabrikam Platform' },
    { id: PROJECT, name: 'Fabrikam Web' }
  ])
  assert.equal(ado.count(isRepositories), 1)
  assert.equal(ado.count(isProjects), 0)

  const everyProject = [
    { id: PROJECT, name: 'Fabrikam Web' },
    { id: PLATFORM, name: 'Fabrikam Platform' },
    { id: 'e5f6a7b8-8888-4a9b-8c0d-2e3f4a5b6c7d', name: 'Contoso Mobile' }
  ]
  ado.on(isProjects, () => json(200, { count: 3, value: everyProject }))
  for (const status of [404, 400]) {
    ado.on(isRepositories, () => json(status, { message: 'refused' }))
    assert.deepEqual(await codeProjects(http, ORG, 'all'), [everyProject[2], everyProject[1], everyProject[0]])
  }
})

test('codeProjects does not hide other failures behind the fallback', async () => {
  const { ado, http } = setup()
  ado.on(isRepositories, () => json(403, { message: 'no access' }))
  assert.equal((await failure(codeProjects(http, ORG, 'all'))).code, 'forbidden')
  assert.equal(ado.count(isProjects), 0)
})

test('codeProjects returns a chosen list as given without a request', async () => {
  const { ado, http } = setup()
  const chosen = [{ id: PROJECT, name: 'Fabrikam Web' }]
  assert.equal(await codeProjects(http, ORG, chosen), chosen)
  assert.equal(ado.calls.length, 0)
})

test('malformed responses become the fixed error', async () => {
  const { ado, http } = setup()
  const key = { projectId: PROJECT, repoId: REPO, prId: 4101 }

  ado.on(isPullRequests, () => json(200, { count: 1, value: 'not a list' }))
  assert(isFixedError(await failure(listPullRequests(http, ORG, PROJECT, { status: 'active', top: 100 }))))

  ado.on(call => call.path.endsWith('/pullrequests/4101'), () => json(200, null))
  assert(isFixedError(await failure(getPullRequest(http, ORG, key))))

  ado.on(call => call.path.endsWith('/workitems'), () => json(200, { count: 1, value: { id: '1204' } }))
  assert(isFixedError(await failure(pullRequestWorkItems(http, ORG, key))))

  ado.on(isRepositories, () => json(200, { count: 1, value: [{ id: 'r', name: 'web-app' }] }))
  assert(isFixedError(await failure(codeProjects(http, ORG, 'all'))))

  for (const raw of [
    { ...mine(0), sourceRefName: undefined },
    { ...mine(0), repository: undefined },
    { ...mine(0), pullRequestId: '4101' },
    { ...mine(0), createdBy: undefined },
    { ...mine(0), reviewers: [{ displayName: 'No id' }] }
  ]) {
    assert(isFixedError(thrown(() => toPrSummary(raw as unknown as RawPullRequest, ORG))))
  }
  assert(isFixedError(thrown(() => toReviewer({ displayName: 'No id' } as unknown as RawReviewer))))
})
