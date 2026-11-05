import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrKey, RowResult } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, isPatch, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock } from '../test-support'
import { createPrActions } from './actions'
import { fakePrs, isMineActive, ME } from './fake-prs'
import { createPrsService } from './service'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const NOT_CONNECTED = 'Connect this organization first.'
const NO_PERMISSION = 'TF401027: You need the PullRequestContribute permission.'
const SAVED: AutoCompleteOptions = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true }
const ONE_PR = /\/_apis\/git\/repositories\/[^/]+\/pullrequests\/(\d+)$/i
const REVIEWER = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/reviewers\/([^/]+)$/

const isRead = (call: AdoCall) => call.method === 'GET' && ONE_PR.test(call.path)
const isVote = (call: AdoCall) => call.method === 'PUT' && REVIEWER.test(call.path)
const idOf = (call: AdoCall) => Number((ONE_PR.exec(call.path) ?? REVIEWER.exec(call.path))?.[1])
const keyOf = (prId: number): PrKey => ({ projectId: PROJECT, repoId: REPO, prId })

function status(): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

function pull(prId: number, overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  const [, base] = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value
  return { ...structuredClone(base), pullRequestId: prId, title: `Change ${prId}`, sourceRefName: `refs/heads/feature/${prId}`, reviewers: [], ...overrides }
}

function sharing(source: string): Partial<RawPullRequest> {
  return { sourceRefName: `refs/heads/${source}` }
}

function me(vote: number, isRequired: boolean, id = ME): NonNullable<RawPullRequest['reviewers']>[number] {
  return { id, displayName: 'Alex Contoso', vote, isRequired }
}

function harness(saved: AutoCompleteOptions = SAVED) {
  const ado = fakePrs()
  const clock = fakeClock(T0)
  const pulls = new Map(fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value.map(raw => [raw.pullRequestId, raw]))
  const posts: unknown[] = []
  ado.on(isRead, call => {
    const raw = pulls.get(idOf(call))
    return raw ? json(200, raw) : json(404, { message: 'TF401180: The requested pull request was not found.' })
  })
  ado.on(isVote, call => json(200, { id: ME, ...call.body }))
  ado.on(isPatch, call => json(200, { pullRequestId: idOf(call) }))
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const prs = createPrsService({
    http,
    orgs: async () => [status()],
    scheduler: createScheduler(clock),
    autoComplete: () => saved,
    post: snapshot => posts.push(structuredClone(snapshot)),
    counts: () => {},
    now: clock.now
  })
  const actions = createPrActions({ http, prs, orgs: async () => [status()], settings: { autoComplete: () => saved } })
  return {
    ado,
    http,
    actions,
    prs,
    posts,
    pulls,
    add(...raws: RawPullRequest[]) {
      for (const raw of raws) pulls.set(raw.pullRequestId, raw)
    },
    votes: () => ado.calls.filter(isVote),
    patches: () => ado.calls.filter(isPatch)
  }
}

function meter() {
  let active = 0
  let peak = 0
  return {
    peak: () => peak,
    async during<T>(respond: () => T): Promise<T> {
      active += 1
      peak = Math.max(peak, active)
      await drain(5)
      active -= 1
      return respond()
    }
  }
}

function summary(results: RowResult[]): [number, boolean, string][] {
  return results.map(result => [result.prId, result.ok, result.message])
}

test('approveAll reports per-row results and continues past a failure', async () => {
  const h = harness()
  h.add(pull(5001), pull(5002, { reviewers: [me(10, false)] }), pull(5003, { isDraft: true }), pull(5004))
  h.ado.on(call => isVote(call) && idOf(call) === 5004, () => json(403, { message: NO_PERMISSION }))

  const { results } = await h.actions.approveAll({ org: ORG, prs: [5001, 5002, 5003, 5004].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5001, true, 'Approved.'],
    [5002, true, 'Already approved.'],
    [5003, true, "Skipped: it's a draft. Publish it first."],
    [5004, false, NO_PERMISSION]
  ])
  assert.deepEqual(h.votes().map(idOf), [5001, 5004], 'no vote was sent for the approved or the draft PR')
  assert.deepEqual(h.votes().map(call => call.body), [{ vote: 10, isRequired: false }, { vote: 10, isRequired: false }])
  assert.ok(h.votes().every(call => call.path.endsWith(`/reviewers/${ME}`)))
  assert.equal(h.ado.count(isRead), 4)
})

test('approve keeps my required flag', async () => {
  const h = harness()
  h.add(pull(5011, { reviewers: [me(0, true, ME.toUpperCase())] }), pull(5012, { reviewers: [me(5, false)] }), pull(5013))

  const { results } = await h.actions.approveAll({ org: ORG, prs: [5011, 5012, 5013].map(keyOf) })

  assert.deepEqual(results.map(result => result.message), ['Approved.', 'Approved.', 'Approved.'])
  assert.deepEqual(h.votes().map(call => [idOf(call), call.body]), [
    [5011, { vote: 10, isRequired: true }],
    [5012, { vote: 10, isRequired: false }],
    [5013, { vote: 10, isRequired: false }]
  ])
})

test('approveAll skips completed and abandoned PRs without a vote', async () => {
  const h = harness()
  h.add(pull(5021, { status: 'completed', closedDate: '2026-11-04T09:00:00Z' }), pull(5022, { status: 'abandoned' }))

  const { results } = await h.actions.approveAll({ org: ORG, prs: [5021, 5022].map(keyOf) })

  assert.deepEqual(summary(results), [[5021, true, "Skipped: it's completed."], [5022, true, "Skipped: it's abandoned."]])
  assert.deepEqual(h.votes(), [])
})

test('a PR that cannot be read fails its own row and the others still go through', async () => {
  const h = harness()
  h.add(pull(5031), pull(5033))

  const { results } = await h.actions.approveAll({ org: ORG, prs: [5031, 5032, 5033].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5031, true, 'Approved.'],
    [5032, false, 'TF401180: The requested pull request was not found.'],
    [5033, true, 'Approved.']
  ])
  assert.deepEqual(h.votes().map(idOf), [5031, 5033])
})

test('autoCompleteAll sends the saved options', async () => {
  const h = harness(SAVED)
  h.add(pull(5041))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5041)] })

  assert.deepEqual(summary(results), [[5041, true, 'Auto-complete set.']])
  const [patch, ...rest] = h.patches()
  assert.deepEqual(rest, [])
  assert.equal(patch.path, `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullrequests/5041`)
  assert.deepEqual(patch.body, {
    autoCompleteSetBy: { id: ME },
    completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true, bypassPolicy: false }
  })
})

test('autoCompleteAll keeps the source branch while another active PR uses it', async () => {
  const h = harness(SAVED)
  h.add(pull(5051, sharing('feature/shared')), pull(5052, sharing('feature/shared')), pull(5053, sharing('feature/solo')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5051, 5052, 5053].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5051, true, 'Auto-complete set. Source branch kept: Pull Request 5052 also uses it.'],
    [5052, true, 'Auto-complete set. Source branch kept: Pull Request 5051 also uses it.'],
    [5053, true, 'Auto-complete set.']
  ])
  assert.deepEqual(h.patches().map(call => [idOf(call), call.body.completionOptions.deleteSourceBranch]), [[5051, false], [5052, false], [5053, true]])
})

test('autoCompleteAll counts active PRs from the loaded snapshot that the call does not read', async () => {
  const h = harness(SAVED)
  await h.prs.snapshot(ORG)

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(4102)] })

  assert.deepEqual(summary(results), [[4102, true, 'Auto-complete set. Source branch kept: Pull Request 4101 also uses it.']])
  assert.equal(h.patches()[0].body.completionOptions.deleteSourceBranch, false)
})

test('a sibling this call reads as no longer active does not keep the branch', async () => {
  const h = harness(SAVED)
  await h.prs.snapshot(ORG)
  h.add(pull(4101, { ...sharing('feature/1204-vehicle-search'), status: 'completed' }), pull(4103, { ...sharing('feature/1204-vehicle-search'), status: 'completed' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [4101, 4102, 4103].map(keyOf) })

  assert.deepEqual(summary(results), [
    [4101, true, "Skipped: it's completed."],
    [4102, true, 'Auto-complete set.'],
    [4103, true, "Skipped: it's completed."]
  ])
  assert.deepEqual(h.patches().map(call => [idOf(call), call.body.completionOptions.deleteSourceBranch]), [[4102, true]])
})

test('a sibling that cannot be read still keeps the branch from the loaded snapshot', async () => {
  const h = harness(SAVED)
  await h.prs.snapshot(ORG)
  h.add(pull(4101, { ...sharing('feature/1204-vehicle-search'), status: 'completed' }))
  h.ado.on(call => isRead(call) && idOf(call) === 4103, () => json(500, { message: 'TF400733: the service is unavailable.' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [4101, 4102, 4103].map(keyOf) })

  assert.deepEqual(summary(results), [
    [4101, true, "Skipped: it's completed."],
    [4102, true, 'Auto-complete set. Source branch kept: Pull Request 4103 also uses it.'],
    [4103, false, 'TF400733: the service is unavailable.']
  ])
})

test('autoCompleteAll does not claim a kept branch when the saved options never delete it', async () => {
  const h = harness({ ...SAVED, deleteSourceBranch: false })
  h.add(pull(5061, sharing('feature/shared')), pull(5062, sharing('feature/shared')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5061, 5062].map(keyOf) })

  assert.deepEqual(results.map(result => result.message), ['Auto-complete set.', 'Auto-complete set.'])
  assert.deepEqual(h.patches().map(call => call.body.completionOptions.deleteSourceBranch), [false, false])
})

test('autoCompleteAll skips PRs already set, completed or abandoned', async () => {
  const h = harness(SAVED)
  h.add(
    pull(5071, { autoCompleteSetBy: { id: ME } }),
    pull(5072, { status: 'completed', closedDate: '2026-11-04T09:00:00Z' }),
    pull(5073, { status: 'abandoned' }),
    pull(5074, { isDraft: true }),
    pull(5075)
  )

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5071, 5072, 5073, 5074, 5075].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5071, true, 'Already set to auto-complete.'],
    [5072, true, "Skipped: it's completed."],
    [5073, true, "Skipped: it's abandoned."],
    [5074, true, "Skipped: it's a draft. Publish it first."],
    [5075, true, 'Auto-complete set.']
  ])
  assert.deepEqual(h.patches().map(idOf), [5075])
  assert.deepEqual(h.votes(), [])
})

test('autoCompleteAll reports a refused PR on its own row and sets the others', async () => {
  const h = harness(SAVED)
  h.add(pull(5081), pull(5082), pull(5083))
  h.ado.on(call => isPatch(call) && idOf(call) === 5082, () => json(409, { message: 'TF401179: The pull request cannot be completed automatically.' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5081, 5082, 5083].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5081, true, 'Auto-complete set.'],
    [5082, false, 'TF401179: The pull request cannot be completed automatically.'],
    [5083, true, 'Auto-complete set.']
  ])
})

test('at most three PRs are read, and at most three written, at a time', async () => {
  const h = harness(SAVED)
  const ids = [5091, 5092, 5093, 5094, 5095, 5096, 5097]
  h.add(...ids.map(id => pull(id)))
  const reads = meter()
  const writes = meter()
  h.ado.on(isRead, call => reads.during(() => json(200, h.pulls.get(idOf(call)))))
  h.ado.on(isVote, call => writes.during(() => json(200, call.body)))

  const { results } = await h.actions.approveAll({ org: ORG, prs: ids.map(keyOf) })

  assert.ok(results.every(result => result.ok && result.message === 'Approved.'))
  assert.deepEqual([reads.peak(), writes.peak()], [3, 3])
})

test('the snapshot is refreshed after the actions without the answer waiting for it', async () => {
  const h = harness(SAVED)
  h.add(pull(5101))
  const held = h.ado.hold(isMineActive)

  const { results } = await h.actions.approveAll({ org: ORG, prs: [keyOf(5101)] })
  await drain()

  assert.deepEqual(summary(results), [[5101, true, 'Approved.']])
  assert.ok(h.ado.count(isMineActive) > 0, 'the refresh has started')
  assert.deepEqual(h.posts, [], 'and is still waiting for the held list')
  held.release()
  await drain()
  assert.equal(h.posts.length, 1, 'the refreshed snapshot was posted')
})

test('a refresh that fails after the actions changes none of the rows', async () => {
  const h = harness(SAVED)
  h.add(pull(5111))
  h.ado.on(isMineActive, () => json(500, { message: 'TF246017: the database is unavailable.' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5111)] })
  await drain()

  assert.deepEqual(summary(results), [[5111, true, 'Auto-complete set.']])
})

test('an org that is not connected is refused before anything is read or written', async () => {
  const h = harness(SAVED)
  const actions = createPrActions({ http: h.http, prs: h.prs, orgs: async () => [], settings: { autoComplete: () => SAVED } })

  for (const run of [() => actions.approveAll({ org: ORG, prs: [keyOf(4102)] }), () => actions.autoCompleteAll({ org: ORG, prs: [keyOf(4102)] })]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof AdoError)
      assert.deepEqual([error.code, error.status, error.message], ['unauthorized', 401, NOT_CONNECTED])
      return true
    })
  }
  assert.equal(h.ado.calls.length, 0)
})
