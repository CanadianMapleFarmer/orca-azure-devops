import { assert, test } from 'orca/testing'
import { AdoError, createAdoHttp, type AdoHttp } from '../ado/http'
import { json, ORG } from '../boards/fake-ado'
import { createPressure, PRESSURE_MS } from './pressure'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const REQUEST = { org: ORG, path: '/_apis/build/builds' }

function answering(headers: Record<string, string>): AdoHttp {
  return { json: async <T,>() => ({ data: { value: [] } as T, headers: new Headers(headers) }) }
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

test('an answer carrying retry-after or x-ratelimit-delay slows its org for five minutes', async () => {
  for (const header of ['Retry-After', 'X-RateLimit-Delay']) {
    const clock = { now: T0 }
    const pressure = createPressure(() => clock.now)
    const http = pressure.wrap(answering({ [header]: '3' }), ORG)
    assert.equal(pressure.slowed(ORG), false, header)

    assert.deepEqual((await http.json(REQUEST)).data, { value: [] }, 'the answer passes through')
    assert.equal(pressure.slowed(ORG), true, header)
    assert.equal(pressure.slowed('fabrikam'), false, 'other orgs are not slowed')

    clock.now += PRESSURE_MS - 1
    assert.equal(pressure.slowed(ORG), true)
    clock.now += 1
    assert.equal(pressure.slowed(ORG), false, 'five minutes later')
  }
  assert.equal(PRESSURE_MS, 5 * 60_000)
})

test('every answer under pressure restarts the five minutes, and plain answers do not', async () => {
  const clock = { now: T0 }
  const pressure = createPressure(() => clock.now)
  const headers: Record<string, string> = { 'retry-after': '1' }
  const http = pressure.wrap({ json: async <T,>() => ({ data: null as T, headers: new Headers(headers) }) }, ORG)

  await http.json(REQUEST)
  clock.now += 4 * 60_000
  await http.json(REQUEST)
  clock.now += 4 * 60_000
  assert.equal(pressure.slowed(ORG), true, 'the second answer moved the end')

  delete headers['retry-after']
  await http.json(REQUEST)
  clock.now += 60_000
  assert.equal(pressure.slowed(ORG), false, 'a plain answer neither slows nor extends')
})

test('only answers that reach the caller count; a throttled call is left to http and the scheduler', async () => {
  const clock = { now: T0 }
  const pressure = createPressure(() => clock.now)
  const replies = [json(429, { message: 'Too many requests' }, { 'retry-after': '1' }), json(200, { value: [] })]
  const retried = createAdoHttp({ fetch: (async () => replies.shift()) as unknown as typeof fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  await pressure.wrap(retried, ORG).json(REQUEST)
  assert.equal(pressure.slowed(ORG), false, 'a 429 that http retried to success is not seen')

  const refused = createAdoHttp({
    fetch: (async () => json(429, { message: 'Too many requests' }, { 'retry-after': '600' })) as unknown as typeof fetch,
    authHeader: async () => 'Bearer test-credential',
    sleep: async () => {}
  })
  const error = await failure(pressure.wrap(refused, ORG).json(REQUEST))
  assert.deepEqual([error.code, error.retryAfterMs], ['rate_limited', 600_000])
  assert.equal(pressure.slowed(ORG), false, 'a thrown rate_limited pauses through the scheduler instead')
})

test('wrapByOrg slows the org each request names, so one wrapper serves every org', async () => {
  const clock = { now: T0 }
  const pressure = createPressure(() => clock.now)
  const http = pressure.wrapByOrg({
    json: async <T,>(req: { org: string }) => ({ data: null as T, headers: new Headers(req.org === ORG ? { 'x-ratelimit-delay': '2' } : {}) })
  })

  await http.json({ org: 'fabrikam', path: '/_apis/build/builds' })
  assert.equal(pressure.slowed('fabrikam'), false, 'a plain answer slows nobody')
  await http.json(REQUEST)
  assert.deepEqual([pressure.slowed(ORG), pressure.slowed('fabrikam')], [true, false])
  clock.now += PRESSURE_MS
  assert.equal(pressure.slowed(ORG), false)
})
