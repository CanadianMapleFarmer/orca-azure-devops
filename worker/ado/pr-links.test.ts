import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { PrChip } from '../../src/shared/work'
import { createEntities, type OrgEntities } from '../data/entities'
import { prKey, type CheckRecord, type PrRecord } from '../data/records'
import { AdoError, createAdoHttp } from './http'
import { MAX_CHECK_READS } from './policy'
import { loadPrChips, SWEEP_TOP } from './pr-links'
import type { PrRef } from './workitems'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const PLATFORM = '2b3c4d5e-7777-4f8a-9b0c-1d2e3f4a5b6c'
const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const MINUTE = 60 * 1000
const BASE = 'https://dev.azure.com/contoso'
const WEB_URL = `${BASE}/Fabrikam%20Web/_git/web-app`

type Json = Record<string, any>

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Json
}

function pullRequest(prId: number, status: string, target = 'refs/heads/main', projectId = PROJECT): Json {
  const raw = fixture('pull-request-active')
  return { ...raw, pullRequestId: prId, status, targetRefName: target, repository: { ...raw.repository, project: { id: projectId, name: 'Fabrikam' } } }
}

function evaluations(...builds: { status: string; displayName?: string; settings?: Json }[]): Json {
  const review = fixture('policy-evaluations').value[0] as Json
  return {
    count: builds.length + 1,
    value: [
      review,
      ...builds.map((build, index) => ({
        evaluationId: `eval-${index}`,
        status: build.status,
        configuration: {
          id: 100 + index,
          type: { id: '0609b952-1397-4640-95ec-e00a01b2c241', displayName: build.displayName ?? 'Build' },
          settings: build.settings ?? { buildDefinitionId: 42 }
        }
      }))
    ]
  }
}

const NO_BUILD = { count: 1, value: [(fixture('policy-evaluations').value as Json[])[0]] }

function ref(prId: number, projectId = PROJECT): PrRef {
  return { projectId, repoId: REPO, prId }
}

function prUrl(prId: number): string {
  return `${BASE}/${PROJECT}/_apis/git/pullrequests/${prId}?api-version=7.1`
}

function listUrl(projectId = PROJECT): string {
  return `${BASE}/${projectId}/_apis/git/pullrequests?searchCriteria.status=active&$top=500&api-version=7.1`
}

function activeList(prs: Json[], projectId = PROJECT): Record<string, unknown> {
  return { [listUrl(projectId)]: { count: prs.length, value: prs } }
}

function evaluationsUrl(prId: number, projectId = PROJECT): string {
  const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`)
  return `${BASE}/${projectId}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`
}

class Failure {
  constructor(readonly status: number, readonly body: unknown) {}
}

function server(routes: Record<string, unknown>, delayMs = 0) {
  const requested: string[] = []
  let inFlight = 0
  const peak = { inFlight: 0 }
  const fetch = async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    inFlight += 1
    peak.inFlight = Math.max(peak.inFlight, inFlight)
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    inFlight -= 1
    const route = url === listUrl() && !(url in routes) ? { count: 0, value: [] } : routes[url]
    const failure = route === undefined ? new Failure(404, { message: 'not found' }) : route instanceof Failure ? route : undefined
    return new Response(JSON.stringify(failure ? failure.body : route), {
      status: failure?.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer secret-token-value' })
  return { http, requested, peak }
}

function routesFor(prId: number, status: string, evals: unknown = NO_BUILD, target?: string): Record<string, unknown> {
  return { [prUrl(prId)]: pullRequest(prId, status, target), [evaluationsUrl(prId)]: evals }
}

function storeAt(clock: { now: number }): OrgEntities {
  return createEntities(() => clock.now).of(ORG)
}

function newStore(): OrgEntities {
  return storeAt({ now: 0 })
}

function record(prId: number, status: PrRecord['status'], projectId = PROJECT): PrRecord {
  return { projectId, repoId: REPO, prId, status, target: 'main', sourceCommit: `c${prId}`, reviewers: '', url: `${WEB_URL}/pullrequest/${prId}` }
}

function checks(prId: number, build: CheckRecord['build'] = 'succeeded'): CheckRecord {
  return { build, policies: 'approved', commit: `c${prId}`, reviewers: '' }
}

async function chipFor(status: string, evals: unknown): Promise<PrChip> {
  const { http } = server(routesFor(1, status, evals))
  const [chip] = await loadPrChips(http, ORG, [ref(1)], newStore(), () => 0)
  return chip
}

const isList = (url: string) => url.includes('/_apis/git/pullrequests?')
const isEvaluations = (url: string) => url.includes('/_apis/policy/evaluations')

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('loadPrChips maps status and build policy, and sweeps an open pull request again after 2 min', async () => {
  const routes = {
    ...activeList([pullRequest(322, 'active')]),
    [prUrl(321)]: fixture('pull-request-completed'),
    [evaluationsUrl(321)]: fixture('policy-evaluations'),
    [evaluationsUrl(322)]: evaluations({ status: 'running' })
  }
  const { http, requested } = server(routes)
  const clock = { now: 1_000_000 }
  const store = storeAt(clock)
  const first = await loadPrChips(http, ORG, [ref(321), ref(322)], store, () => clock.now)
  assert.deepEqual(first, [
    { prId: 321, repoId: REPO, projectId: PROJECT, target: 'release/2026.11', state: 'merged', build: 'none', url: `${WEB_URL}/pullrequest/321` },
    { prId: 322, repoId: REPO, projectId: PROJECT, target: 'main', state: 'open', build: 'running', url: `${WEB_URL}/pullrequest/322` }
  ])
  assert.deepEqual(requested, [listUrl(), prUrl(321), evaluationsUrl(322)])

  clock.now += 2 * MINUTE - 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321), ref(322)], store, () => clock.now), first)
  assert.equal(requested.length, 3)

  clock.now += 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321), ref(322)], store, () => clock.now), first)
  assert.deepEqual(requested.slice(3), [listUrl(), evaluationsUrl(322)], 'the merged one is not read again')
})

test('a merged or abandoned PR in the store is never fetched again', async () => {
  const { http, requested } = server({})
  const clock = { now: 0 }
  const store = storeAt(clock)
  store.prs.put(prKey(ref(1)), record(1, 'completed'))
  store.prs.put(prKey(ref(2)), record(2, 'abandoned'))
  clock.now = 24 * 60 * MINUTE
  const chips = await loadPrChips(http, ORG, [ref(1), ref(2)], store, () => clock.now)
  assert.deepEqual(chips.map(chip => [chip.prId, chip.state, chip.build]), [[1, 'merged', 'none'], [2, 'abandoned', 'none']])
  assert.deepEqual(requested, [])
})

test('stale active refs refresh with one active-list read per project', async () => {
  const web = [1, 2, 3].map(prId => pullRequest(prId, 'active'))
  const platform = [4, 5].map(prId => pullRequest(prId, 'active', 'refs/heads/main', PLATFORM))
  const evaluated = [...[1, 2, 3].map(prId => evaluationsUrl(prId)), ...[4, 5].map(prId => evaluationsUrl(prId, PLATFORM))]
  const routes = Object.assign(activeList(web), activeList(platform, PLATFORM), ...evaluated.map(url => ({ [url]: NO_BUILD })))
  const { http, requested } = server(routes)
  const refs = [ref(1), ref(2), ref(3), ref(4, PLATFORM), ref(5, PLATFORM)]
  const chips = await loadPrChips(http, ORG, refs, newStore(), () => 0)
  assert.deepEqual(chips.map(chip => [chip.prId, chip.state]), [[1, 'open'], [2, 'open'], [3, 'open'], [4, 'open'], [5, 'open']])
  assert.deepEqual(requested.filter(isList), [listUrl(), listUrl(PLATFORM)])
  assert.deepEqual(requested.filter(url => url.includes('/pullrequests/')), [], 'no PR is read by id')
  assert.deepEqual(requested.filter(isEvaluations), evaluated)
})

test('the sweep stores only the PRs it was asked about', async () => {
  const listed = Array.from({ length: 10 }, (_, index) => pullRequest(600 + index, 'active'))
  const { http } = server({ ...activeList(listed), [evaluationsUrl(603)]: NO_BUILD, [evaluationsUrl(607)]: NO_BUILD })
  const store = newStore()
  await loadPrChips(http, ORG, [ref(603), ref(607)], store, () => 0)
  assert.deepEqual(store.prs.entries().map(([key]) => key), [prKey(ref(603)), prKey(ref(607))])
})

test('a ref missing from a short active list is read once by id and becomes final', async () => {
  const { http, requested } = server({ ...activeList([pullRequest(322, 'active')]), ...routesFor(321, 'completed') })
  const clock = { now: 0 }
  const store = storeAt(clock)
  assert.deepEqual((await loadPrChips(http, ORG, [ref(321)], store, () => clock.now)).map(chip => chip.state), ['merged'])
  assert.deepEqual(requested, [listUrl(), prUrl(321)])

  clock.now += 3 * 60 * MINUTE
  assert.deepEqual((await loadPrChips(http, ORG, [ref(321)], store, () => clock.now)).map(chip => chip.state), ['merged'])
  assert.equal(requested.length, 2)
})

test('a full active list does not prove a missing ref closed, so it is read by id', async () => {
  const full = Array.from({ length: SWEEP_TOP }, (_, index) => pullRequest(1000 + index, 'active'))
  const { http, requested } = server({ ...activeList(full), ...routesFor(9999, 'active') })
  const chips = await loadPrChips(http, ORG, [ref(9999)], newStore(), () => 0)
  assert.deepEqual(chips.map(chip => [chip.prId, chip.state]), [[9999, 'open']])
  assert.deepEqual(requested, [listUrl(), prUrl(9999), evaluationsUrl(9999)])
})

test('no more than 8 evaluation reads per load, oldest first', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => 700 + index)
  const clock = { now: 0 }
  const store = storeAt(clock)
  for (const prId of ids) {
    clock.now = (prId - 700) * MINUTE
    store.prChecks.put(prKey(ref(prId)), checks(prId))
  }
  clock.now = 3 * 60 * MINUTE
  for (const prId of ids) store.prs.put(prKey(ref(prId)), record(prId, 'active'))
  const { http, requested } = server(Object.assign({}, ...[...ids].reverse().map(prId => ({ [evaluationsUrl(prId)]: evaluations({ status: 'running' }) }))))
  const chips = await loadPrChips(http, ORG, [...ids].reverse().map(prId => ref(prId)), store, () => clock.now)
  assert.equal(MAX_CHECK_READS, 8)
  assert.deepEqual(requested, ids.slice(0, 8).map(prId => evaluationsUrl(prId)))
  assert.deepEqual(chips.map(chip => [chip.prId, chip.build]), [...ids].reverse().map(prId => [prId, prId < 708 ? 'running' : 'succeeded']))
})

test('loadPrChips asks for policy evaluations only for open pull requests', async () => {
  const approved = evaluations({ status: 'approved' })
  const routes = { ...routesFor(321, 'completed', approved), ...routesFor(322, 'abandoned', approved), ...routesFor(323, 'active', approved) }
  const { http, requested } = server(routes)
  const chips = await loadPrChips(http, ORG, [ref(321), ref(322), ref(323)], newStore(), () => 0)
  assert.deepEqual(chips.map(chip => [chip.prId, chip.state, chip.build]), [[321, 'merged', 'none'], [322, 'abandoned', 'none'], [323, 'open', 'succeeded']])
  assert.deepEqual(requested.filter(isEvaluations), [evaluationsUrl(323)])
})

test('loadPrChips asks for the policy evaluations of the pull request artifact at the preview api version', async () => {
  const { http, requested } = server({ ...activeList([pullRequest(321, 'active')]), [evaluationsUrl(321)]: NO_BUILD })
  await loadPrChips(http, ORG, [ref(321)], newStore(), () => 0)
  assert.deepEqual(requested, [listUrl(), evaluationsUrl(321)])
})

test('loadPrChips maps the PR status to merged, abandoned or open', async () => {
  assert.equal((await chipFor('completed', NO_BUILD)).state, 'merged')
  assert.equal((await chipFor('abandoned', NO_BUILD)).state, 'abandoned')
  assert.equal((await chipFor('active', NO_BUILD)).state, 'open')
  assert.equal((await chipFor('notSet', NO_BUILD)).state, 'open')
})

test('loadPrChips maps the build policy status to running, succeeded, failed or none', async () => {
  assert.equal((await chipFor('active', evaluations({ status: 'queued' }))).build, 'running')
  assert.equal((await chipFor('active', evaluations({ status: 'running' }))).build, 'running')
  assert.equal((await chipFor('active', evaluations({ status: 'approved' }))).build, 'succeeded')
  assert.equal((await chipFor('active', evaluations({ status: 'rejected' }))).build, 'failed')
  assert.equal((await chipFor('active', NO_BUILD)).build, 'none')
  assert.equal((await chipFor('active', evaluations({ status: 'notApplicable' }))).build, 'none')
  assert.equal((await chipFor('active', { count: 0, value: [] })).build, 'none')
})

test('loadPrChips finds the build policy by its type name when the settings name no build definition', async () => {
  assert.equal((await chipFor('active', evaluations({ status: 'approved', settings: {} }))).build, 'succeeded')
})

test('loadPrChips finds the build policy by its build definition when the type name is localised', async () => {
  const localised = evaluations({ status: 'rejected', displayName: 'Bou' })
  assert.equal((await chipFor('active', localised)).build, 'failed')
  const notABuild = evaluations({ status: 'rejected', displayName: 'Status check', settings: { statusName: 'lint' } })
  assert.equal((await chipFor('active', notABuild)).build, 'none')
})

test('loadPrChips reports the worst of several build policies', async () => {
  const approved = { status: 'approved' }
  const running = { status: 'running' }
  const rejected = { status: 'rejected' }
  assert.equal((await chipFor('active', evaluations(approved, running))).build, 'running')
  assert.equal((await chipFor('active', evaluations(approved, running, rejected))).build, 'failed')
  assert.equal((await chipFor('active', evaluations(approved, approved))).build, 'succeeded')
})

test('loadPrChips builds the link from the project and repository ids when the repository has no web url', async () => {
  const pr = pullRequest(321, 'active')
  delete pr.repository.webUrl
  const { http } = server({ [prUrl(321)]: pr, [evaluationsUrl(321)]: NO_BUILD })
  const [chip] = await loadPrChips(http, ORG, [ref(321)], newStore(), () => 0)
  assert.equal(chip.url, `${BASE}/${PROJECT}/_git/${REPO}/pullrequest/321`)
})

test('loadPrChips keeps only the branch name of the target', async () => {
  const { http } = server(routesFor(1, 'active', NO_BUILD, 'refs/heads/feature/refs/heads/x'))
  const [chip] = await loadPrChips(http, ORG, [ref(1)], newStore(), () => 0)
  assert.equal(chip.target, 'feature/refs/heads/x')
})

test('loadPrChips skips a pull request that no longer exists and keeps the others', async () => {
  const { http } = server({ ...routesFor(322, 'active') })
  const store = newStore()
  const chips = await loadPrChips(http, ORG, [ref(321), ref(322)], store, () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), [322])
  assert.deepEqual(store.prs.entries().map(([key]) => key), [prKey(ref(322))])
})

test('loadPrChips remembers a missing pull request for 2 min so a dead link costs one sweep and one read', async () => {
  const { http, requested } = server({})
  const missing = new Map<string, number>()
  let now = 5_000
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321)], newStore(), () => now, missing), [])
  assert.deepEqual(requested, [listUrl(), prUrl(321)])

  now += 2 * MINUTE - 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321)], newStore(), () => now, missing), [])
  assert.equal(requested.length, 2)

  now += 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321)], newStore(), () => now, missing), [])
  assert.deepEqual(requested.slice(2), [listUrl(), prUrl(321)])
})

test('loadPrChips returns a pull request again once its link stops being dead', async () => {
  const routes: Record<string, unknown> = {}
  const { http } = server(routes)
  const missing = new Map<string, number>()
  const store = newStore()
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321)], store, () => 0, missing), [])
  Object.assign(routes, routesFor(321, 'active'))
  assert.deepEqual((await loadPrChips(http, ORG, [ref(321)], store, () => 2 * MINUTE, missing)).map(chip => chip.prId), [321])
})

test('a project the active list cannot find leaves its refs to be read by id', async () => {
  const { http, requested } = server({ [listUrl()]: new Failure(404, { message: 'TF200016: The project does not exist.' }), ...routesFor(321, 'completed') })
  assert.deepEqual((await loadPrChips(http, ORG, [ref(321)], newStore(), () => 0)).map(chip => chip.state), ['merged'])
  assert.deepEqual(requested, [listUrl(), prUrl(321)])
})

test('loadPrChips propagates errors other than a missing pull request', async () => {
  const { http } = server({ ...routesFor(322, 'active'), [prUrl(321)]: new Failure(403, { message: 'no access' }) })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321), ref(322)], newStore(), () => 0))).code, 'forbidden')
  const refused = server({ [listUrl()]: new Failure(403, { message: 'no access' }), ...routesFor(322, 'active') })
  assert.equal((await failure(loadPrChips(refused.http, ORG, [ref(322)], newStore(), () => 0))).code, 'forbidden')
})

test('loadPrChips does not skip a pull request whose policy evaluations are missing', async () => {
  const { http } = server({ [prUrl(321)]: pullRequest(321, 'active') })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321)], newStore(), () => 0))).code, 'not_found')
})

test('loadPrChips fails with a server error when the pull request has no target branch', async () => {
  const pr = { ...pullRequest(321, 'active'), targetRefName: undefined }
  const { http } = server({ [prUrl(321)]: pr, [evaluationsUrl(321)]: NO_BUILD })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321)], newStore(), () => 0))).code, 'server')
})

test('loadPrChips fetches each distinct pull request once and keeps the order of the first mention', async () => {
  const { http, requested } = server({ ...routesFor(322, 'active'), ...routesFor(321, 'completed') })
  const chips = await loadPrChips(http, ORG, [ref(322), ref(321), ref(322)], newStore(), () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), [322, 321])
  assert.deepEqual(requested, [listUrl(), prUrl(322), prUrl(321), evaluationsUrl(322)])
})

test('loadPrChips fetches only what is not cached and keeps the order', async () => {
  const routes = { ...routesFor(321, 'completed'), ...routesFor(322, 'active'), ...routesFor(323, 'abandoned') }
  const { http, requested } = server(routes)
  const store = newStore()
  await loadPrChips(http, ORG, [ref(322)], store, () => 0)
  requested.length = 0
  const chips = await loadPrChips(http, ORG, [ref(321), ref(322), ref(323)], store, () => 1000)
  assert.deepEqual(chips.map(chip => chip.prId), [321, 322, 323])
  assert.deepEqual(requested.filter(url => url.includes('/pullrequests/')), [prUrl(321), prUrl(323)])
})

test('loadPrChips runs at most six pull request lookups at once', async () => {
  const ids = Array.from({ length: 15 }, (_, index) => 500 + index)
  const routes = Object.assign({}, ...ids.map(id => routesFor(id, 'active')))
  const { http, peak } = server(routes, 5)
  const chips = await loadPrChips(http, ORG, ids.map(id => ref(id)), newStore(), () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), ids)
  assert.equal(peak.inFlight, 6)
})

test('loadPrChips with no references makes no request', async () => {
  const { http, requested } = server({})
  assert.deepEqual(await loadPrChips(http, ORG, [], newStore(), () => 0), [])
  assert.equal(requested.length, 0)
})
