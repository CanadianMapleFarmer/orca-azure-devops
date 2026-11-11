import { assert, test } from 'orca/testing'
import { fakeAdo, fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import type { Stamped } from '../data/entities'
import type { CheckRecord, PrRecord } from '../data/records'
import { MALFORMED } from '../messages'
import { AdoError, createAdoHttp } from './http'
import { buildStateOf, checksDue, loadEvaluations, policyStateOf, readChecks, type RawEvaluation } from './policy'

const REVIEWERS_POLICY = 'Minimum number of reviewers'
const NOW = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const PR: PrRecord = { projectId: PROJECT, repoId: 'repo', prId: 4101, status: 'active', target: 'main', sourceCommit: 'c1', reviewers: 'a:10', url: '' }
const BUILD_POLICY = 'Build'

interface EvaluationOptions {
  displayName?: string
  settings?: Record<string, unknown>
  isBlocking?: boolean
  isEnabled?: boolean
}

function evaluation(status: string, options: EvaluationOptions = {}): RawEvaluation {
  const { displayName = REVIEWERS_POLICY, settings = {}, isBlocking = true, isEnabled = true } = options
  return { status, configuration: { isBlocking, isEnabled, type: { displayName }, settings } }
}

function build(status: string, options: EvaluationOptions = {}): RawEvaluation {
  return evaluation(status, { displayName: BUILD_POLICY, settings: { buildDefinitionId: 42 }, ...options })
}

const isEvaluations = (call: AdoCall) => call.path.endsWith('/_apis/policy/evaluations')

function setup() {
  const ado = fakeAdo()
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

test('loadEvaluations reads the evaluations of the pull request artifact at the preview api version', async () => {
  const { ado, http } = setup()
  const evaluations = await loadEvaluations(http, ORG, { projectId: PROJECT, repoId: 'repo', prId: 4101 })
  assert.deepEqual(evaluations, fixture('policy-evaluations').value)
  const [call] = ado.calls
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/policy/evaluations`)
  assert.equal(call.query.get('artifactId'), `vstfs:///CodeReview/CodeReviewId/${PROJECT}/4101`)
  assert.equal(call.query.get('api-version'), '7.1-preview.1')
})

test('policyStateOf: rejected wins, then pending, then approved; non-blocking, disabled and notApplicable are ignored', () => {
  assert.equal(policyStateOf([]), 'none')
  assert.equal(policyStateOf([evaluation('approved')]), 'approved')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('queued')]), 'pending')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('running')]), 'pending')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('running'), evaluation('rejected')]), 'rejected')
  assert.equal(policyStateOf([evaluation('rejected'), evaluation('approved')]), 'rejected')

  assert.equal(policyStateOf([evaluation('approved'), evaluation('rejected', { isBlocking: false })]), 'approved')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('running', { isEnabled: false })]), 'approved')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('notApplicable')]), 'approved')
  assert.equal(policyStateOf([evaluation('notApplicable'), evaluation('rejected', { isBlocking: false })]), 'none')
})

test('policyStateOf counts a broken blocking policy as rejected and ignores a broken non-blocking one', () => {
  assert.equal(policyStateOf([evaluation('broken')]), 'rejected')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('broken')]), 'rejected')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('broken', { isBlocking: false })]), 'approved')
  assert.equal(policyStateOf([evaluation('approved'), evaluation('broken', { isEnabled: false })]), 'approved')
})

test('policyStateOf leaves build policies to buildStateOf', () => {
  assert.equal(policyStateOf([build('rejected')]), 'none')
  assert.equal(policyStateOf([build('rejected'), evaluation('approved')]), 'approved')
  assert.equal(policyStateOf([build('rejected', { settings: {} }), evaluation('queued')]), 'pending')
})

test('policyStateOf counts a policy that does not say it is non-blocking or disabled', () => {
  const bare: RawEvaluation = { status: 'rejected', configuration: { type: { displayName: 'Status check' } } }
  assert.equal(policyStateOf([bare]), 'rejected')
  assert.equal(policyStateOf([{ status: 'queued' }]), 'pending')
})

test("buildStateOf keeps pr-links' worst-build rule", () => {
  assert.equal(buildStateOf([build('queued')]), 'running')
  assert.equal(buildStateOf([build('running')]), 'running')
  assert.equal(buildStateOf([build('approved')]), 'succeeded')
  assert.equal(buildStateOf([build('rejected')]), 'failed')
  assert.equal(buildStateOf([build('broken')]), 'failed')
  assert.equal(buildStateOf([build('approved'), build('broken')]), 'failed')
  assert.equal(buildStateOf([evaluation('broken')]), 'none')
  assert.equal(buildStateOf([build('notApplicable')]), 'none')
  assert.equal(buildStateOf([evaluation('approved')]), 'none')
  assert.equal(buildStateOf([]), 'none')

  assert.equal(buildStateOf([build('approved', { settings: {} })]), 'succeeded', 'found by its type name')
  assert.equal(buildStateOf([build('rejected', { displayName: 'Bou' })]), 'failed', 'found by its build definition')
  assert.equal(buildStateOf([evaluation('rejected', { displayName: 'Status check', settings: { statusName: 'lint' } })]), 'none')

  assert.equal(buildStateOf([build('approved'), build('running')]), 'running')
  assert.equal(buildStateOf([build('approved'), build('running'), build('rejected')]), 'failed')
  assert.equal(buildStateOf([build('approved'), build('approved')]), 'succeeded')
})

function held(value: Partial<CheckRecord>, ageMs: number): Stamped<CheckRecord> {
  return { value: { build: 'succeeded', policies: 'approved', commit: 'c1', reviewers: 'a:10', ...value }, at: NOW - ageMs }
}

test('checks are due when missing, after a push, after a reviewer or vote change, while running for 2 minutes, or at 30 minutes', () => {
  const cases: [string, PrRecord, Stamped<CheckRecord> | undefined, boolean][] = [
    ['no checks yet', PR, undefined, true],
    ['fresh checks', PR, held({}, MINUTE), false],
    ['a push', { ...PR, sourceCommit: 'c2' }, held({}, 0), true],
    ['a vote change', { ...PR, reviewers: 'a:-5' }, held({}, 0), true],
    ['a new reviewer', { ...PR, reviewers: 'a:10,b:0' }, held({}, 0), true],
    ['a running build under 2 minutes', PR, held({ build: 'running' }, 2 * MINUTE - 1), false],
    ['a running build at 2 minutes', PR, held({ build: 'running' }, 2 * MINUTE), true],
    ['pending policies at 2 minutes', PR, held({ policies: 'pending' }, 2 * MINUTE), false],
    ['idle checks under 30 minutes', PR, held({}, 30 * MINUTE - 1), false],
    ['idle checks at 30 minutes', PR, held({}, 30 * MINUTE), true],
    ['a completed PR with no checks', { ...PR, status: 'completed' }, undefined, false],
    ['an abandoned PR after a push', { ...PR, status: 'abandoned', sourceCommit: 'c2' }, held({}, 60 * MINUTE), false]
  ]
  for (const [name, pr, checks, due] of cases) assert.equal(checksDue(pr, checks, NOW), due, name)
})

test('readChecks keeps the commit and reviewers it read the evaluations at', async () => {
  const { ado, http } = setup()
  assert.deepEqual(await readChecks(http, ORG, PR), { build: 'succeeded', policies: 'approved', commit: 'c1', reviewers: 'a:10' })
  assert.equal(ado.calls[0].query.get('artifactId'), `vstfs:///CodeReview/CodeReviewId/${PROJECT}/4101`)
})

test('malformed responses become the fixed error', async () => {
  const { ado, http } = setup()
  ado.on(isEvaluations, () => json(200, { count: 1, value: 'not a list' }))
  const error = await failure(loadEvaluations(http, ORG, { projectId: PROJECT, repoId: 'repo', prId: 4101 }))
  assert.deepEqual([error.code, error.message], ['server', MALFORMED.pullRequest])
})
