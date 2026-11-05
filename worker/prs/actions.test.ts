import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrKey, RowResult } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, isPatch, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock } from '../test-support'
import { createPrActions } from './actions'
import { fakePrs, isMineActive, isPrWorkItems, ME } from './fake-prs'
import { createPrsService } from './service'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const NOT_CONNECTED = 'Connect this organization first.'
const NO_PERMISSION = 'TF401027: You need the PullRequestContribute permission.'
const OUTAGE = 'TF400733: the service is unavailable.'
const UNCHECKED = "Auto-complete set. Source branch kept: couldn't check for other pull requests."
const OTHER_REPO = '8e9f0a1b-3333-4d6e-9f7a-4b5c6d7e8f90'
const GRACE = { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper' }
const SAVED: AutoCompleteOptions = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true }
const ONE_PR = /\/_apis\/git\/repositories\/[^/]+\/pullrequests\/(\d+)$/i
const REVIEWER = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/reviewers\/([^/]+)$/

const isRead = (call: AdoCall) => call.method === 'GET' && ONE_PR.test(call.path)
const isVote = (call: AdoCall) => call.method === 'PUT' && REVIEWER.test(call.path)
const isBranchQuery = (call: AdoCall) => call.method === 'GET' && call.path.endsWith('/_apis/git/pullrequests') && call.query.has('searchCriteria.sourceRefName')
const idOf = (call: AdoCall) => Number((ONE_PR.exec(call.path) ?? REVIEWER.exec(call.path))?.[1])
const keyOf = (prId: number): PrKey => ({ projectId: PROJECT, repoId: REPO, prId })
const otherRepoKey = (prId: number): PrKey => ({ projectId: PROJECT, repoId: OTHER_REPO, prId })

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

function onBranch(source: string): Partial<RawPullRequest> {
  return { sourceRefName: `refs/heads/${source}` }
}

function inOtherRepo(base: RawPullRequest): RawPullRequest {
  return { ...base, repository: { ...base.repository, id: OTHER_REPO, name: 'api' } }
}

function setToComplete(deleteSourceBranch: boolean): Partial<RawPullRequest> {
  return { autoCompleteSetBy: { id: ME }, completionOptions: { deleteSourceBranch } }
}

function me(vote: number, isRequired: boolean, id = ME): NonNullable<RawPullRequest['reviewers']>[number] {
  return { id, displayName: 'Alex Contoso', vote, isRequired }
}

function refusal(status: number, message: string) {
  return (call: AdoCall) => json(status, { message, echoedAuthorization: call.headers.get('authorization') })
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
  ado.on(isBranchQuery, call => {
    const wanted = { repository: call.query.get('searchCriteria.repositoryId'), source: call.query.get('searchCriteria.sourceRefName') }
    const value = [...pulls.values()].filter(raw => raw.repository.id === wanted.repository && raw.sourceRefName === wanted.source && raw.status === 'active')
    return json(200, { value })
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
  const actions = createPrActions({ http, prs, settings: { autoComplete: () => saved } })
  return {
    ado,
    actions,
    prs,
    posts,
    pulls,
    add(...raws: RawPullRequest[]) {
      for (const raw of raws) pulls.set(raw.pullRequestId, raw)
    },
    votes: () => ado.calls.filter(isVote),
    patches: () => ado.calls.filter(isPatch),
    queries: () => ado.calls.filter(isBranchQuery)
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

function deletes(patches: AdoCall[]): [number, boolean][] {
  return patches.map(call => [idOf(call), call.body.completionOptions.deleteSourceBranch])
}

test('approveAll reports per-row results and continues past a failure', async () => {
  const h = harness()
  h.add(pull(5001), pull(5002, { reviewers: [me(10, false)] }), pull(5003, { isDraft: true }), pull(5004))
  h.ado.on(call => isVote(call) && idOf(call) === 5004, refusal(403, NO_PERMISSION))

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
  assert.equal(h.votes()[1].headers.get('authorization'), 'Bearer test-credential', 'the refused write did carry the credential')
  assert.ok(results.every(result => !result.message.includes('test-credential')))
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

test('a failing work-items endpoint cannot fail a row, because the actions never read work items', async () => {
  const h = harness()
  h.add(pull(5041), pull(5042))
  h.ado.on(isPrWorkItems, () => json(500, { message: OUTAGE }))

  const approved = await h.actions.approveAll({ org: ORG, prs: [keyOf(5041)] })
  const completed = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5042)] })

  assert.deepEqual(summary([...approved.results, ...completed.results]), [[5041, true, 'Approved.'], [5042, true, 'Auto-complete set.']])
  const firstWrite = h.ado.calls.findIndex(call => isVote(call) || isPatch(call))
  assert.deepEqual(h.ado.calls.slice(0, firstWrite).filter(isPrWorkItems), [], 'nothing asked for work items before the writes')
})

test('duplicate keys in one call collapse to one row, in order of first appearance', async () => {
  const h = harness()
  h.add(pull(5051), pull(5052))

  const approved = await h.actions.approveAll({ org: ORG, prs: [5051, 5052, 5051, 5052, 5051].map(keyOf) })
  assert.deepEqual(summary(approved.results), [[5051, true, 'Approved.'], [5052, true, 'Approved.']])
  assert.deepEqual(h.votes().map(idOf), [5051, 5052])
  assert.equal(h.ado.count(isRead), 2)

  const completed = await h.actions.autoCompleteAll({ org: ORG, prs: [5052, 5051, 5052].map(keyOf) })
  assert.deepEqual(summary(completed.results), [[5052, true, 'Auto-complete set.'], [5051, true, 'Auto-complete set.']])
  assert.deepEqual(h.patches().map(idOf), [5052, 5051])
})

test('autoCompleteAll sends the saved options', async () => {
  const h = harness(SAVED)
  h.add(pull(5061))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5061)] })

  assert.deepEqual(summary(results), [[5061, true, 'Auto-complete set.']])
  const [patch, ...rest] = h.patches()
  assert.deepEqual(rest, [])
  assert.equal(patch.path, `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullrequests/5061`)
  assert.deepEqual(patch.body, {
    autoCompleteSetBy: { id: ME },
    completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true, bypassPolicy: false }
  })
})

test('autoCompleteAll keeps the source branch while another active PR uses it', async () => {
  const h = harness(SAVED)
  h.add(pull(5071, onBranch('feature/shared')), pull(5072, onBranch('feature/shared')), pull(5073, onBranch('feature/solo')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5071, 5072, 5073].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5071, true, 'Auto-complete set. Source branch kept: Pull Request 5072 also uses it.'],
    [5072, true, 'Auto-complete set. Source branch kept: Pull Request 5071 also uses it.'],
    [5073, true, 'Auto-complete set.']
  ])
  assert.deepEqual(deletes(h.patches()), [[5071, false], [5072, false], [5073, true]])
})

test('a sibling by another author, found only through the branch query, keeps the branch', async () => {
  const h = harness(SAVED)
  h.add(pull(5081, onBranch('feature/shared')), pull(5082, { ...onBranch('feature/shared'), createdBy: GRACE }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5081)] })

  assert.deepEqual(summary(results), [[5081, true, 'Auto-complete set. Source branch kept: Pull Request 5082 also uses it.']])
  assert.deepEqual(deletes(h.patches()), [[5081, false]])
  const [query, ...rest] = h.queries()
  assert.deepEqual(rest, [])
  assert.equal(query.path, `/${ORG}/${PROJECT}/_apis/git/pullrequests`)
  assert.deepEqual(
    [query.query.get('searchCriteria.repositoryId'), query.query.get('searchCriteria.sourceRefName'), query.query.get('searchCriteria.status')],
    [REPO, 'refs/heads/feature/shared', 'active']
  )
})

test('a PR that the query finds only itself on keeps deleting its branch', async () => {
  const h = harness(SAVED)
  h.add(pull(5091, onBranch('feature/lonely')), pull(5092, { ...onBranch('feature/lonely'), status: 'completed' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5091)] })

  assert.deepEqual(summary(results), [[5091, true, 'Auto-complete set.']])
  assert.deepEqual(deletes(h.patches()), [[5091, true]])
})

test('when the branch query fails the branch is kept, and PRs read in this call are still named', async () => {
  const h = harness(SAVED)
  h.add(pull(5101, onBranch('feature/alone')), pull(5102, onBranch('feature/shared')), pull(5103, onBranch('feature/shared')))
  h.ado.on(isBranchQuery, refusal(500, OUTAGE))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5101, 5102, 5103].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5101, true, UNCHECKED],
    [5102, true, 'Auto-complete set. Source branch kept: Pull Request 5103 also uses it.'],
    [5103, true, 'Auto-complete set. Source branch kept: Pull Request 5102 also uses it.']
  ])
  assert.deepEqual(deletes(h.patches()), [[5101, false], [5102, false], [5103, false]])
  assert.equal(h.queries().length, 2)
  assert.ok(results.every(result => !result.message.includes('test-credential')))
})

test('no branch query is made while the saved options keep source branches', async () => {
  const h = harness({ ...SAVED, deleteSourceBranch: false })
  h.add(pull(5111, onBranch('feature/shared')), pull(5112, onBranch('feature/shared')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5111, 5112].map(keyOf) })

  assert.deepEqual(results.map(result => result.message), ['Auto-complete set.', 'Auto-complete set.'])
  assert.deepEqual(deletes(h.patches()), [[5111, false], [5112, false]])
  assert.deepEqual(h.queries(), [])
})

test('one branch query per distinct repository and source branch, and the same branch name in another repository is no sibling', async () => {
  const h = harness(SAVED)
  h.add(
    pull(5121, onBranch('feature/x')),
    inOtherRepo(pull(5122, onBranch('feature/x'))),
    pull(5123, onBranch('feature/y')),
    pull(5124, onBranch('feature/z')),
    pull(5125, onBranch('feature/z'))
  )

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5121), otherRepoKey(5122), keyOf(5123), keyOf(5124), keyOf(5125)] })

  assert.deepEqual(summary(results), [
    [5121, true, 'Auto-complete set.'],
    [5122, true, 'Auto-complete set.'],
    [5123, true, 'Auto-complete set.'],
    [5124, true, 'Auto-complete set. Source branch kept: Pull Request 5125 also uses it.'],
    [5125, true, 'Auto-complete set. Source branch kept: Pull Request 5124 also uses it.']
  ])
  assert.deepEqual(deletes(h.patches()), [[5121, true], [5122, true], [5123, true], [5124, false], [5125, false]])
  const asked = h.queries().map(call => `${call.query.get('searchCriteria.repositoryId')} ${call.query.get('searchCriteria.sourceRefName')}`)
  assert.deepEqual(asked.sort(), [
    `${REPO} refs/heads/feature/x`,
    `${REPO} refs/heads/feature/y`,
    `${REPO} refs/heads/feature/z`,
    `${OTHER_REPO} refs/heads/feature/x`
  ])
})

test('an already-set sibling that will delete the shared branch is flagged, never rewritten, and the other row says so', async () => {
  const h = harness(SAVED)
  h.add(pull(5131, { ...onBranch('feature/shared'), ...setToComplete(true) }), pull(5132, onBranch('feature/shared')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5131, 5132].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5131, true, 'Already set to auto-complete. It will delete the source branch Pull Request 5132 also uses; turn that off in Azure DevOps.'],
    [5132, true, 'Auto-complete set. Pull Request 5131 will delete the shared source branch when it completes.']
  ])
  assert.deepEqual(deletes(h.patches()), [[5132, false]], 'only the new PR is patched, and it keeps the branch')
})

test('an already-set PR the call does not list still warns the PR that is auto-completed beside it', async () => {
  const h = harness(SAVED)
  h.add(pull(5141, { ...onBranch('feature/shared'), ...setToComplete(true), createdBy: GRACE }), pull(5142, onBranch('feature/shared')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5142)] })

  assert.deepEqual(summary(results), [[5142, true, 'Auto-complete set. Pull Request 5141 will delete the shared source branch when it completes.']])
  assert.deepEqual(deletes(h.patches()), [[5142, false]])
})

test('an already-set PR is only flagged when it deletes a branch another active PR uses', async () => {
  const h = harness(SAVED)
  h.add(
    pull(5151, setToComplete(true)),
    pull(5152, { ...onBranch('feature/shared'), ...setToComplete(false) }),
    pull(5153, onBranch('feature/shared'))
  )

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5151, 5152, 5153].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5151, true, 'Already set to auto-complete.'],
    [5152, true, 'Already set to auto-complete.'],
    [5153, true, 'Auto-complete set. Source branch kept: Pull Request 5152 also uses it.']
  ])
  assert.deepEqual(h.patches().map(idOf), [5153])
})

test('an already-set PR that deletes a shared branch is flagged even when the saved options keep branches', async () => {
  const h = harness({ ...SAVED, deleteSourceBranch: false })
  h.add(pull(5161, { ...onBranch('feature/shared'), ...setToComplete(true) }), pull(5162, onBranch('feature/shared')))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5161, 5162].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5161, true, 'Already set to auto-complete. It will delete the source branch Pull Request 5162 also uses; turn that off in Azure DevOps.'],
    [5162, true, 'Auto-complete set.']
  ])
  assert.deepEqual(deletes(h.patches()), [[5162, false]])
})

test('autoCompleteAll skips PRs already set, completed or abandoned', async () => {
  const h = harness(SAVED)
  h.add(
    pull(5171, setToComplete(false)),
    pull(5172, { status: 'completed', closedDate: '2026-11-04T09:00:00Z' }),
    pull(5173, { status: 'abandoned' }),
    pull(5174, { isDraft: true }),
    pull(5175)
  )

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5171, 5172, 5173, 5174, 5175].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5171, true, 'Already set to auto-complete.'],
    [5172, true, "Skipped: it's completed."],
    [5173, true, "Skipped: it's abandoned."],
    [5174, true, "Skipped: it's a draft. Publish it first."],
    [5175, true, 'Auto-complete set.']
  ])
  assert.deepEqual(h.patches().map(idOf), [5175])
  assert.deepEqual(h.votes(), [])
})

test('autoCompleteAll reports a refused PR on its own row and sets the others', async () => {
  const h = harness(SAVED)
  h.add(pull(5181), pull(5182), pull(5183))
  const refused = 'TF401179: The pull request cannot be completed automatically.'
  h.ado.on(call => isPatch(call) && idOf(call) === 5182, refusal(409, refused))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [5181, 5182, 5183].map(keyOf) })

  assert.deepEqual(summary(results), [
    [5181, true, 'Auto-complete set.'],
    [5182, false, refused],
    [5183, true, 'Auto-complete set.']
  ])
  assert.equal(h.patches()[1].headers.get('authorization'), 'Bearer test-credential', 'the refused write did carry the credential')
  assert.ok(results.every(result => !result.message.includes('test-credential')))
})

test('at most three PRs are read, queried and written at a time', async () => {
  const h = harness(SAVED)
  const ids = [5191, 5192, 5193, 5194, 5195, 5196, 5197]
  h.add(...ids.map(id => pull(id)))
  const reads = meter()
  const queries = meter()
  const writes = meter()
  h.ado.on(isRead, call => reads.during(() => json(200, h.pulls.get(idOf(call)))))
  h.ado.on(isBranchQuery, call => queries.during(() => json(200, { value: [h.pulls.get(Number(call.query.get('searchCriteria.sourceRefName')?.split('/').pop()))] })))
  h.ado.on(isVote, call => writes.during(() => json(200, call.body)))
  h.ado.on(isPatch, call => writes.during(() => json(200, call.body)))

  const approved = await h.actions.approveAll({ org: ORG, prs: ids.map(keyOf) })
  const completed = await h.actions.autoCompleteAll({ org: ORG, prs: ids.map(keyOf) })

  assert.ok([...approved.results, ...completed.results].every(result => result.ok))
  assert.deepEqual([reads.peak(), queries.peak(), writes.peak()], [3, 3, 3])
})

test('the snapshot is refreshed after the actions without the answer waiting for it', async () => {
  const h = harness(SAVED)
  h.add(pull(5201))
  const held = h.ado.hold(isMineActive)

  const { results } = await h.actions.approveAll({ org: ORG, prs: [keyOf(5201)] })
  await drain()

  assert.deepEqual(summary(results), [[5201, true, 'Approved.']])
  assert.ok(h.ado.count(isMineActive) > 0, 'the refresh has started')
  assert.deepEqual(h.posts, [], 'and is still waiting for the held list')
  held.release()
  await drain()
  assert.equal(h.posts.length, 1, 'the refreshed snapshot was posted')
})

test('the refresh starts a fresh load after the writes instead of joining one that began before them', async () => {
  const h = harness(SAVED)
  h.add(pull(5211))
  const held = h.ado.hold(isMineActive)
  const before = h.prs.snapshot(ORG)
  await drain()

  await h.actions.approveAll({ org: ORG, prs: [keyOf(5211)] })
  await drain()
  const wroteAt = h.ado.calls.findIndex(isVote)
  assert.equal(h.ado.count(isMineActive), 2, 'only the load that began before the write has listed so far')
  held.release()
  await before
  await drain()

  const listedAfterWrite = h.ado.calls.flatMap((call, index) => (isMineActive(call) ? [index > wroteAt] : []))
  assert.deepEqual(listedAfterWrite, [false, false, true, true], 'a second full load listed my PRs after the write')
  assert.equal(h.posts.length, 2, 'the stale load and the fresh one were both posted, the fresh one last')
})

test('a refresh that fails after the actions changes none of the rows', async () => {
  const h = harness(SAVED)
  h.add(pull(5221))
  h.ado.on(isMineActive, () => json(500, { message: 'TF246017: the database is unavailable.' }))

  const { results } = await h.actions.autoCompleteAll({ org: ORG, prs: [keyOf(5221)] })
  await drain()

  assert.deepEqual(summary(results), [[5221, true, 'Auto-complete set.']])
  assert.ok(h.ado.count(isMineActive) > 0, 'the refresh did run, and failed')
})

test('an org that is not connected is refused before anything is read or written', async () => {
  const h = harness(SAVED)

  for (const run of [() => h.actions.approveAll({ org: 'fabrikam', prs: [keyOf(4102)] }), () => h.actions.autoCompleteAll({ org: 'fabrikam', prs: [keyOf(4102)] })]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof AdoError)
      assert.deepEqual([error.code, error.status, error.message], ['unauthorized', 401, NOT_CONNECTED])
      return true
    })
  }
  assert.equal(h.ado.calls.length, 0)
})
