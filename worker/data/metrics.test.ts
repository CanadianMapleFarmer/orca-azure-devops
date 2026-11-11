import { assert, test } from 'orca/testing'
import type { AdoRequest } from '../ado/http'
import { inLane } from './context'
import { createMetrics, endpointOf, metricsLines, type MetricsReport } from './metrics'
import type { PressureState } from './rate-limit'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const TEAM = '6a7b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const REPO = '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'
const wiql: AdoRequest = { org: 'contoso', method: 'POST', path: `/${TEAM}/_apis/wit/wiql` }
const pr = (id: number): AdoRequest => ({ org: 'contoso', path: `/_apis/git/pullrequests/${id}` })

function meter() {
  const clock = { now: T0 }
  const metrics = createMetrics(() => clock.now)
  const answer = (req: AdoRequest, status = 200, headers: Record<string, string> = {}) => metrics.observe(req, status, new Headers(headers))
  return { clock, metrics, answer }
}

function report(overrides: Partial<MetricsReport>): MetricsReport {
  return { total: 0, perMinute: [0, 0, 0, 0, 0], byFeature: {}, byEndpoint: [], throttled: 0, delayed: 0, cost: null, etags: [], last: null, ...overrides }
}

function pressure(overrides: Partial<PressureState>): PressureState {
  return { level: 'normal', factor: 1, resumeAt: 0, calmAt: 0, last: null, ...overrides }
}

test('requests are counted per minute for five minutes, by feature and endpoint', () => {
  const { clock, metrics, answer } = meter()
  inLane('board', 'hidden', () => {
    answer(wiql)
    answer(wiql)
  })
  clock.now = T0 + 2 * MINUTE
  inLane('work', 'user', () => answer(pr(1)))
  clock.now = T0 + 4 * MINUTE + 59_000
  inLane('board', 'hidden', () => answer(wiql))
  inLane('work', 'user', () => answer(pr(2)))
  answer({ org: 'fabrikam', path: '/_apis/projects' })

  const contoso = metrics.report('contoso')
  assert.equal(contoso.total, 5)
  assert.deepEqual(contoso.perMinute, [2, 0, 1, 0, 2])
  assert.deepEqual(contoso.byFeature, { board: 3, work: 2 })
  assert.deepEqual(contoso.byEndpoint, [
    { endpoint: 'POST /{team}/_apis/wit/wiql', count: 3 },
    { endpoint: 'GET /_apis/git/pullrequests/{id}', count: 2 }
  ])
  assert.deepEqual(metrics.report('fabrikam').byFeature, { other: 1 })
  assert.deepEqual(metrics.report('adatum'), report({}))
})

test('endpoints replace ids, GUIDs and team segments with placeholders', () => {
  assert.equal(endpointOf(wiql), 'POST /{team}/_apis/wit/wiql')
  assert.equal(endpointOf({ org: 'contoso', method: 'POST', path: '/Web%20Team/_apis/wit/wiql' }), 'POST /{team}/_apis/wit/wiql')
  assert.equal(endpointOf(pr(322)), 'GET /_apis/git/pullrequests/{id}')
  assert.equal(
    endpointOf({ org: 'contoso', project: 'Web', path: `/_apis/git/repositories/${REPO}/pullrequests/7/threads/41` }),
    'GET /_apis/git/repositories/{id}/pullrequests/{id}/threads/{id}'
  )
  assert.equal(endpointOf({ org: 'contoso', path: '/_apis/git/pullrequests', query: { 'searchCriteria.status': 'active' } }), 'GET /_apis/git/pullrequests')
  assert.equal(endpointOf({ org: 'contoso', host: 'vssps', path: '/_apis/identities' }), 'GET vssps /_apis/identities')
  assert.equal(endpointOf({ org: 'contoso', method: 'PATCH', path: '/_apis/wit/workitems/12' }), 'PATCH /_apis/wit/workitems/{id}')
  assert.equal(endpointOf({ org: 'contoso', path: '/_apis/wit/workitemtypes/Bug/states' }), 'GET /_apis/wit/workitemtypes/Bug/states')
})

test('429s, delayed answers, the cost sum and ETag endpoints are tracked', () => {
  const { clock, metrics, answer } = meter()
  answer(wiql, 429, { 'Retry-After': '30' })
  answer(wiql, 200, { 'X-RateLimit-Delay': '0.5', 'X-RateLimit-Cost': '0.75' })
  answer({ org: 'contoso', path: '/_apis/projects' }, 200, { ETag: '"p1"' })
  clock.now = T0 + MINUTE + 10_000
  answer(pr(3), 200, { ETag: '"r9"', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '152', 'X-RateLimit-Cost': '0.5' })
  answer(pr(4), 200, { ETag: '"r10"' })

  const contoso = metrics.report('contoso')
  assert.equal(contoso.throttled, 1)
  assert.equal(contoso.delayed, 1)
  assert.equal(contoso.cost, 1.25)
  assert.deepEqual(contoso.etags, ['GET /_apis/git/pullrequests/{id}', 'GET /_apis/projects'])
  assert.deepEqual(contoso.last, { at: T0 + MINUTE + 10_000, headers: { limit: 200, remaining: 152, cost: 0.5 } })

  answer({ org: 'fabrikam', path: '/_apis/projects' })
  assert.equal(metrics.report('fabrikam').cost, null)
  assert.equal(metrics.report('fabrikam').last, null)
})

test('counts older than five minutes drop out', () => {
  const { clock, metrics, answer } = meter()
  answer(wiql, 429, { 'Retry-After': '30', 'X-RateLimit-Cost': '1' })
  clock.now = T0 + 3 * MINUTE
  answer(pr(1), 200, { ETag: '"r1"' })

  clock.now = T0 + 5 * MINUTE
  const later = metrics.report('contoso')
  assert.equal(later.total, 1)
  assert.deepEqual(later.perMinute, [0, 0, 1, 0, 0])
  assert.deepEqual(later.byEndpoint, [{ endpoint: 'GET /_apis/git/pullrequests/{id}', count: 1 }])
  assert.deepEqual([later.throttled, later.cost, later.etags], [0, null, ['GET /_apis/git/pullrequests/{id}']])
  assert.equal(later.last?.at, T0)

  clock.now = T0 + 8 * MINUTE
  answer(pr(2))
  assert.deepEqual(metrics.report('contoso').perMinute, [0, 0, 0, 0, 1])

  metrics.forget('contoso')
  assert.deepEqual(metrics.report('contoso'), report({}))
})

test('metricsLines shows totals, the busiest endpoints and the rate-limit state', () => {
  const busy = report({
    total: 41,
    byFeature: { work: 9, pipelines: 6, board: 18, prs: 8 },
    byEndpoint: [
      { endpoint: 'POST /{team}/_apis/wit/wiql', count: 14 },
      { endpoint: 'GET /_apis/git/pullrequests', count: 7 },
      { endpoint: 'POST /_apis/wit/workitemsbatch', count: 5 },
      { endpoint: 'GET /_apis/build/builds', count: 4 }
    ],
    last: { at: T0 - 40_000, headers: { limit: 200, remaining: 152 } }
  })
  assert.deepEqual(metricsLines(busy, pressure({ level: 'near', factor: 2 }), T0), [
    '  Requests, last 5 min: 41 (board 18, work 9, prs 8, pipelines 6)',
    '  Busiest: POST /{team}/_apis/wit/wiql 14 · GET /_apis/git/pullrequests 7 · POST /_apis/wit/workitemsbatch 5',
    '  Rate limit: near, 152 of 200 TSTU left, polling ×2 (headers 40 s ago)'
  ])

  const throttled = { ...busy, throttled: 2, delayed: 3, cost: 1.25 }
  assert.equal(metricsLines(throttled, pressure({ level: 'near', factor: 2 }), T0)[3], '  Throttled 2, delayed 3, cost 1.25 TSTU')

  const quiet = report({ total: 2, byFeature: { prs: 1, board: 1 }, byEndpoint: [{ endpoint: 'GET /_apis/git/pullrequests', count: 2 }] })
  assert.deepEqual(metricsLines(quiet, pressure({}), T0), [
    '  Requests, last 5 min: 2 (board 1, prs 1)',
    '  Busiest: GET /_apis/git/pullrequests 2',
    '  Rate limit: no pressure seen'
  ])
  assert.deepEqual(metricsLines({ ...quiet, cost: 0.02 }, pressure({}), T0)[3], '  Throttled 0, delayed 0, cost 0.02 TSTU')

  const blocked = { ...quiet, last: { at: T0 - 5 * MINUTE, headers: { retryAfterMs: 30_000 } } }
  assert.equal(metricsLines(blocked, pressure({ level: 'blocked', factor: 8 }), T0)[2], '  Rate limit: blocked, polling ×8 (headers 5 min ago)')
  const calm = { ...quiet, last: { at: T0 - 1_000, headers: { limit: 200, remaining: 190 } } }
  assert.equal(metricsLines(calm, pressure({}), T0)[2], '  Rate limit: normal, 190 of 200 TSTU left (headers 1 s ago)')
})

test('metricsLines shows the pressure level when no rate-limit headers were seen', () => {
  const bare = report({ total: 1, byFeature: { prs: 1 }, byEndpoint: [{ endpoint: 'GET /_apis/git/pullrequests', count: 1 }], throttled: 1 })
  assert.equal(metricsLines(bare, pressure({ level: 'blocked', factor: 8 }), T0)[2], '  Rate limit: blocked, polling ×8')
  assert.equal(metricsLines(bare, pressure({ level: 'delayed', factor: 8 }), T0)[2], '  Rate limit: delayed, polling ×8')
  assert.equal(metricsLines(bare, pressure({}), T0)[2], '  Rate limit: no pressure seen')
})

test('metricsLines shows nothing for an org with no traffic', () => {
  assert.deepEqual(metricsLines(report({}), pressure({ level: 'near', factor: 2 }), T0), [])
})
