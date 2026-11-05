import { assert, test } from 'orca/testing'
import { fakeAdo, fixture, isPatch, json, ORG, PROJECT } from '../boards/fake-ado'
import { cancelBuild, retryStage } from './build-actions'
import { AdoError, createAdoHttp } from './http'

const BUILD = `/${ORG}/${PROJECT}/_apis/build/builds/4520`

function setup() {
  const urls: string[] = []
  const ado = fakeAdo()
  ado.on(isPatch, () => json(200, fixture('build-4520')))
  const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    return ado.fetch(input, init)
  }) as typeof fetch
  const http = createAdoHttp({ fetch: fetchSpy, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http, urls }
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

test('cancelBuild sets cancelling', async () => {
  const { ado, http } = setup()
  assert.equal(await cancelBuild(http, ORG, PROJECT, 4520), undefined)
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, BUILD)
  assert.equal(call.query.get('api-version'), '7.1')
  assert.equal(call.headers.get('content-type'), 'application/json')
  assert.deepEqual(call.body, { status: 'cancelling' })
})

test('retryStage patches the stage by its identifier', async () => {
  const { ado, http } = setup()
  assert.equal(await retryStage(http, ORG, PROJECT, 4520, 'Deploy_production'), undefined)
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, `${BUILD}/stages/Deploy_production`)
  assert.equal(call.query.get('api-version'), '7.1')
  assert.equal(call.headers.get('content-type'), 'application/json')
  assert.deepEqual(call.body, { state: 'retry', forceRetryAllJobs: false })
  assert.deepEqual(Object.keys(call.body), ['state', 'forceRetryAllJobs'])
})

test('retryStage encodes the stage reference', async () => {
  const { http, urls } = setup()
  await retryStage(http, ORG, PROJECT, 4520, 'Deploy production/eu?x#y')
  assert(urls[0].includes(`${BUILD}/stages/Deploy%20production%2Feu%3Fx%23y?`), urls[0])
})

test('a refused write reaches the caller with its own message after one call', async () => {
  const writes: [string, (http: ReturnType<typeof setup>['http']) => Promise<void>][] = [
    ['cancelBuild', http => cancelBuild(http, ORG, PROJECT, 4520)],
    ['retryStage', http => retryStage(http, ORG, PROJECT, 4520, 'Deploy_production')]
  ]
  for (const [name, write] of writes) {
    for (const [status, code, message] of [
      [403, 'forbidden', 'You need the Stop builds permission.'],
      [409, 'conflict', 'The stage is already being retried.'],
      [500, 'server', 'Build service failed.']
    ] as const) {
      const { ado, http } = setup()
      ado.on(isPatch, call => json(status, { message, echoedAuthorization: call.headers.get('authorization') }))
      const error = await failure(write(http))
      assert.deepEqual([name, error.code, error.message, ado.calls.length], [name, code, message, 1])
      assert(!error.message.includes('test-credential'))
    }
  }
})
