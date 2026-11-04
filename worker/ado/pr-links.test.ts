import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { PrChip } from '../../src/shared/work'
import { AdoError, createAdoHttp } from './http'
import { loadPrChips } from './pr-links'
import type { PrRef } from './workitems'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const MINUTE = 60 * 1000
const BASE = 'https://dev.azure.com/contoso'
const WEB_URL = `${BASE}/Fabrikam%20Web/_git/web-app`

type Json = Record<string, any>

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Json
}

function pullRequest(prId: number, status: string, target = 'refs/heads/main'): Json {
  return { ...fixture('pull-request-active'), pullRequestId: prId, status, targetRefName: target }
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

function ref(prId: number): PrRef {
  return { projectId: PROJECT, repoId: REPO, prId }
}

function prUrl(prId: number): string {
  return `${BASE}/${PROJECT}/_apis/git/pullrequests/${prId}?api-version=7.1`
}

function evaluationsUrl(prId: number): string {
  const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${PROJECT}/${prId}`)
  return `${BASE}/${PROJECT}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`
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
    const route = routes[url]
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

function newCache(): Map<string, { at: number; chip: PrChip }> {
  return new Map()
}

async function chipFor(status: string, evals: unknown): Promise<PrChip> {
  const { http } = server(routesFor(1, status, evals))
  const [chip] = await loadPrChips(http, ORG, [ref(1)], newCache(), () => 0)
  return chip
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

test('loadPrChips maps status and build policy, and caches for 2 min', async () => {
  const routes = {
    [prUrl(321)]: fixture('pull-request-completed'),
    [evaluationsUrl(321)]: fixture('policy-evaluations'),
    [prUrl(322)]: fixture('pull-request-active'),
    [evaluationsUrl(322)]: evaluations({ status: 'running' })
  }
  const { http, requested } = server(routes)
  const cache = newCache()
  let now = 1_000_000
  const first = await loadPrChips(http, ORG, [ref(321), ref(322)], cache, () => now)
  assert.deepEqual(first, [
    { prId: 321, repoId: REPO, projectId: PROJECT, target: 'release/2026.11', state: 'merged', build: 'succeeded', url: `${WEB_URL}/pullrequest/321` },
    { prId: 322, repoId: REPO, projectId: PROJECT, target: 'main', state: 'open', build: 'running', url: `${WEB_URL}/pullrequest/322` }
  ])
  assert.equal(requested.length, 4)

  now += 2 * MINUTE - 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321), ref(322)], cache, () => now), first)
  assert.equal(requested.length, 4)

  now += 1
  assert.deepEqual(await loadPrChips(http, ORG, [ref(321), ref(322)], cache, () => now), first)
  assert.equal(requested.length, 8)
})

test('loadPrChips asks for the policy evaluations of the pull request artifact at the preview api version', async () => {
  const { http, requested } = server(routesFor(321, 'active'))
  await loadPrChips(http, ORG, [ref(321)], newCache(), () => 0)
  assert.deepEqual(requested, [prUrl(321), evaluationsUrl(321)])
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
  const [chip] = await loadPrChips(http, ORG, [ref(321)], newCache(), () => 0)
  assert.equal(chip.url, `${BASE}/${PROJECT}/_git/${REPO}/pullrequest/321`)
})

test('loadPrChips keeps only the branch name of the target', async () => {
  const { http } = server(routesFor(1, 'active', NO_BUILD, 'refs/heads/feature/refs/heads/x'))
  const [chip] = await loadPrChips(http, ORG, [ref(1)], newCache(), () => 0)
  assert.equal(chip.target, 'feature/refs/heads/x')
})

test('loadPrChips skips a pull request that no longer exists and keeps the others', async () => {
  const { http } = server({ ...routesFor(322, 'active') })
  const cache = newCache()
  const chips = await loadPrChips(http, ORG, [ref(321), ref(322)], cache, () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), [322])
  assert.deepEqual([...cache.keys()], ['322'])
})

test('loadPrChips propagates errors other than a missing pull request', async () => {
  const { http } = server({ ...routesFor(322, 'active'), [prUrl(321)]: new Failure(403, { message: 'no access' }) })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321), ref(322)], newCache(), () => 0))).code, 'forbidden')
})

test('loadPrChips does not skip a pull request whose policy evaluations are missing', async () => {
  const { http } = server({ [prUrl(321)]: pullRequest(321, 'active') })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321)], newCache(), () => 0))).code, 'not_found')
})

test('loadPrChips fails with a server error when the pull request has no target branch', async () => {
  const pr = { ...pullRequest(321, 'active'), targetRefName: undefined }
  const { http } = server({ [prUrl(321)]: pr, [evaluationsUrl(321)]: NO_BUILD })
  assert.equal((await failure(loadPrChips(http, ORG, [ref(321)], newCache(), () => 0))).code, 'server')
})

test('loadPrChips fetches each distinct pull request once and keeps the order of the first mention', async () => {
  const { http, requested } = server({ ...routesFor(322, 'active'), ...routesFor(321, 'completed') })
  const chips = await loadPrChips(http, ORG, [ref(322), ref(321), ref(322)], newCache(), () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), [322, 321])
  assert.equal(requested.length, 4)
})

test('loadPrChips fetches only what is not cached and keeps the order', async () => {
  const routes = { ...routesFor(321, 'completed'), ...routesFor(322, 'active'), ...routesFor(323, 'abandoned') }
  const { http, requested } = server(routes)
  const cache = newCache()
  await loadPrChips(http, ORG, [ref(322)], cache, () => 0)
  requested.length = 0
  const chips = await loadPrChips(http, ORG, [ref(321), ref(322), ref(323)], cache, () => 1000)
  assert.deepEqual(chips.map(chip => chip.prId), [321, 322, 323])
  assert.deepEqual(requested.filter(url => url.includes('/pullrequests/')), [prUrl(321), prUrl(323)])
})

test('loadPrChips runs at most six pull request lookups at once', async () => {
  const ids = Array.from({ length: 15 }, (_, index) => 500 + index)
  const routes = Object.assign({}, ...ids.map(id => routesFor(id, 'active')))
  const { http, peak } = server(routes, 5)
  const chips = await loadPrChips(http, ORG, ids.map(ref), newCache(), () => 0)
  assert.deepEqual(chips.map(chip => chip.prId), ids)
  assert.equal(peak.inFlight, 6)
})

test('loadPrChips with no references makes no request', async () => {
  const { http, requested } = server({})
  assert.deepEqual(await loadPrChips(http, ORG, [], newCache(), () => 0), [])
  assert.equal(requested.length, 0)
})
