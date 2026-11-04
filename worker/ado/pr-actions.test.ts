import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrKey } from '../../src/shared/prs'
import { fakeAdo, fixture, isPatch, json, ORG, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { AdoError, createAdoHttp } from './http'
import { addReviewer, castVote, listReviewers, setAutoComplete } from './pr-actions'

const KEY: PrKey = { projectId: PROJECT, repoId: REPO, prId: 4101 }
const REVIEWERS = `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4101/reviewers`
const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
const TEAM = 'c3d4e5f6-5555-4c8d-8e9f-1a2b3c4d5e6f'
const DENNIS = 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e'
const NEWCOMER = 'e5f6a7b8-5555-4eaf-9fb1-3c4d5e6f7081'

const isListReviewers = (call: AdoCall) => call.method === 'GET' && call.path === REVIEWERS
const isPutReviewer = (call: AdoCall) => call.method === 'PUT' && call.path.startsWith(`${REVIEWERS}/`)

function setup() {
  const ado = fakeAdo()
  ado.on(isListReviewers, () => json(200, fixture('pull-request-reviewers')))
  ado.on(isPutReviewer, call => json(200, { id: call.path.split('/').pop(), ...call.body }))
  ado.on(isPatch, () => json(200, { pullRequestId: 4101 }))
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
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

test('castVote puts vote 10 on my reviewer entry and keeps the required flag', async () => {
  const { ado, http } = setup()
  await castVote(http, ORG, KEY, 'u1', true)
  await castVote(http, ORG, KEY, 'u1', false)
  const puts = ado.calls.filter(isPutReviewer)
  assert.deepEqual(puts.map(call => call.path), [`${REVIEWERS}/u1`, `${REVIEWERS}/u1`])
  assert.deepEqual(puts.map(call => call.body), [{ vote: 10, isRequired: true }, { vote: 10, isRequired: false }])
  assert.equal(puts[0].query.get('api-version'), '7.1')
  assert.equal(puts[0].host, 'dev.azure.com')
})

test('castVote lets a refusal through with the server message and nothing else from the body', async () => {
  const { ado, http } = setup()
  const refusal = 'TF401027: You need the PullRequestContribute permission.'
  ado.on(isPutReviewer, call => json(403, { message: refusal, echoedAuthorization: call.headers.get('authorization') }))
  const error = await failure(castVote(http, ORG, KEY, 'u1', false))
  assert.equal(ado.calls[0].headers.get('authorization'), 'Bearer test-credential')
  assert.deepEqual([error.code, error.status, error.message], ['forbidden', 403, refusal])
  assert(!error.message.includes('test-credential'))
})

test('setAutoComplete sends the options and me', async () => {
  const { ado, http } = setup()
  const options: AutoCompleteOptions = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: false }
  await setAutoComplete(http, ORG, KEY, 'u1', options)
  const [call] = ado.calls
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullrequests/4101`)
  assert.deepEqual(call.body, {
    autoCompleteSetBy: { id: 'u1' },
    completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: false, bypassPolicy: false }
  })
})

test('setAutoComplete never bypasses policy and never sends a merge commit message', async () => {
  const { ado, http } = setup()
  const options = {
    mergeStrategy: 'rebase',
    deleteSourceBranch: false,
    transitionWorkItems: true,
    bypassPolicy: true,
    mergeCommitMessage: 'ship it'
  } as AutoCompleteOptions
  await setAutoComplete(http, ORG, KEY, 'u1', options)
  const { completionOptions } = ado.calls[0].body
  assert.deepEqual(completionOptions, {
    mergeStrategy: 'rebase',
    deleteSourceBranch: false,
    transitionWorkItems: true,
    bypassPolicy: false
  })
})

test('addReviewer puts vote 0 and the required flag', async () => {
  const { ado, http } = setup()
  assert.equal(await addReviewer(http, ORG, KEY, NEWCOMER, true), 'added')
  assert.equal(await addReviewer(http, ORG, KEY, NEWCOMER, false), 'added')
  const puts = ado.calls.filter(isPutReviewer)
  assert.deepEqual(puts.map(call => call.path), [`${REVIEWERS}/${NEWCOMER}`, `${REVIEWERS}/${NEWCOMER}`])
  assert.deepEqual(puts.map(call => call.body), [{ vote: 0, isRequired: true }, { vote: 0, isRequired: false }])
})

test('addReviewer says already and never sends a vote for someone who is already a reviewer', async () => {
  const { ado, http } = setup()
  for (const id of [GRACE, GRACE.toUpperCase(), TEAM, DENNIS]) assert.equal(await addReviewer(http, ORG, KEY, id, true), 'already')
  assert.equal(ado.count(isPutReviewer), 0)
  assert.equal(ado.count(isListReviewers), 4)
})

test('addReviewer reads the reviewers again on every call', async () => {
  const { ado, http } = setup()
  assert.equal(await addReviewer(http, ORG, KEY, NEWCOMER, false), 'added')
  ado.on(isListReviewers, () =>
    json(200, { count: 1, value: [{ id: NEWCOMER, displayName: 'Margaret Hamilton', vote: 5, isRequired: false }] })
  )
  assert.equal(await addReviewer(http, ORG, KEY, NEWCOMER, false), 'already')
  assert.equal(ado.count(isPutReviewer), 1)
})

test('listReviewers maps groups and votes', async () => {
  const { ado, http } = setup()
  const reviewers = await listReviewers(http, ORG, KEY)
  assert.deepEqual(reviewers, [
    {
      id: GRACE,
      name: 'Grace Hopper',
      uniqueName: 'grace@contoso.example',
      vote: 10,
      isRequired: true,
      isGroup: false,
      hasDeclined: false
    },
    {
      id: TEAM,
      name: '[Fabrikam Web]\\Fabrikam Web Team',
      uniqueName: `vstfs:///Classification/TeamProject/${PROJECT}\\Fabrikam Web Team`,
      vote: 0,
      isRequired: true,
      isGroup: true,
      hasDeclined: false
    },
    {
      id: DENNIS,
      name: 'Dennis Ritchie',
      uniqueName: 'dennis@contoso.example',
      vote: -5,
      isRequired: false,
      isGroup: false,
      hasDeclined: true
    }
  ])
  assert.equal(ado.calls[0].path, REVIEWERS)
})

test('a malformed reviewers answer becomes the fixed pull request error', async () => {
  const { ado, http } = setup()
  for (const body of [{ count: 1, value: 'not a list' }, { count: 1, value: [{ displayName: 'No id' }] }, undefined]) {
    ado.on(isListReviewers, () => json(200, body))
    const error = await failure(listReviewers(http, ORG, KEY))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.pullRequest])
  }
})
