import { assert, test } from 'orca/testing'
import { AdoError, createAdoHttp, type AdoRequest } from './http'

const AUTH = 'Bearer secret-token-value'

type Reply = Response | Error

function fakeFetch(...replies: Reply[]) {
  const calls: Request[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const reply = replies[Math.min(calls.length, replies.length) - 1]
    if (reply instanceof Error) throw reply
    return reply.clone()
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

function hangingFetch() {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) return reject(signal.reason)
      signal?.addEventListener('abort', () => reject(signal.reason))
    })) as typeof globalThis.fetch
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function clientFor(fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createAdoHttp>[0]> = {}) {
  return createAdoHttp({ fetch, authHeader: async () => AUTH, sleep: async () => {}, ...extra })
}

const REPOS: AdoRequest = { org: 'contoso', path: '/_apis/git/repositories' }

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the request to fail')
}

test('builds project-scoped URLs with api-version 7.1', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({ value: [] }))
  await clientFor(fetch).json({ ...REPOS, project: 'Web App' })
  assert.equal(calls[0].url, 'https://dev.azure.com/contoso/Web%20App/_apis/git/repositories?api-version=7.1')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.get('authorization'), AUTH)
})

test('builds org-scoped URLs without a project segment', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}))
  await clientFor(fetch).json({ org: 'contoso', path: '/_apis/projects' })
  assert.equal(calls[0].url, 'https://dev.azure.com/contoso/_apis/projects?api-version=7.1')
})

test('host vssps builds the vssps URL', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}), jsonResponse({}))
  const http = clientFor(fetch)
  await http.json({ org: 'contoso', host: 'vssps', method: 'POST', path: '/_apis/graph/subjectquery', apiVersion: '7.1-preview.1', body: {} })
  assert.equal(calls[0].url, 'https://vssps.dev.azure.com/contoso/_apis/graph/subjectquery?api-version=7.1-preview.1')
  await http.json({ org: 'contoso', path: '/_apis/projects' })
  assert.equal(calls[1].url, 'https://dev.azure.com/contoso/_apis/projects?api-version=7.1')
})

test('a search request goes to almsearch.dev.azure.com', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({ count: 0, results: [] }), jsonResponse({}))
  const http = clientFor(fetch)
  const body = { searchText: 'redirect', $top: 25, $skip: 0, filters: { Wiki: ['Fabrikam Web.wiki'] }, includeFacets: false }
  await http.json({
    org: 'contoso',
    host: 'almsearch',
    project: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    method: 'POST',
    path: '/_apis/search/wikisearchresults',
    body
  })
  assert.equal(
    calls[0].url,
    'https://almsearch.dev.azure.com/contoso/4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d/_apis/search/wikisearchresults?api-version=7.1'
  )
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.get('authorization'), AUTH)
  assert.deepEqual(await calls[0].json(), body)
  await http.json({ org: 'contoso', path: '/_apis/projects' })
  assert.equal(calls[1].url, 'https://dev.azure.com/contoso/_apis/projects?api-version=7.1')
})

test('per-call apiVersion and query', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}))
  await clientFor(fetch).json({ ...REPOS, apiVersion: '7.1-preview.4', query: { $top: 5, x: undefined, name: 'a b', all: true } })
  assert.equal(calls[0].url, 'https://dev.azure.com/contoso/_apis/git/repositories?$top=5&name=a%20b&all=true&api-version=7.1-preview.4')
})

test('retries once with -preview on VssInvalidPreviewVersionException', async () => {
  const { fetch, calls } = fakeFetch(
    jsonResponse({ typeKey: 'VssInvalidPreviewVersionException', message: 'The version is under preview.' }, 400),
    jsonResponse({ value: [1] })
  )
  const { data } = await clientFor(fetch).json<{ value: number[] }>(REPOS)
  assert.deepEqual(data, { value: [1] })
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1].url).searchParams.get('api-version'), '7.1-preview')
})

test('does not retry the preview exception more than once', async () => {
  const preview = jsonResponse({ typeKey: 'VssInvalidPreviewVersionException', message: 'Preview only.' }, 400)
  const { fetch, calls } = fakeFetch(preview, preview)
  const error = await failure(clientFor(fetch).json(REPOS))
  assert.equal(error.code, 'bad_request')
  assert.equal(calls.length, 2)
})

test('maps statuses to codes', async () => {
  const cases: [Response, string, number][] = [
    [new Response('', { status: 401 }), 'unauthorized', 401],
    [new Response('<html>Sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }), 'unauthorized', 203],
    [jsonResponse({ message: 'Denied.' }, 403), 'forbidden', 403],
    [jsonResponse({ message: 'Gone.' }, 404), 'not_found', 404],
    [jsonResponse({ message: 'Clash.' }, 409), 'conflict', 409],
    [jsonResponse({ message: 'Stale.' }, 412), 'precondition_failed', 412],
    [jsonResponse({ message: 'Bad field.' }, 400), 'bad_request', 400],
    [jsonResponse({ message: 'Boom.' }, 500), 'server', 500],
    [new Response('upstream down', { status: 503 }), 'server', 503]
  ]
  for (const [reply, code, status] of cases) {
    const error = await failure(clientFor(fakeFetch(reply).fetch).json(REPOS))
    assert.equal(error.code, code)
    assert.equal(error.status, status)
  }
})

test('uses the JSON message when present and a fixed sentence otherwise', async () => {
  const withMessage = await failure(clientFor(fakeFetch(jsonResponse({ message: 'TF401019: no such repo.', typeKey: 'X' }, 404)).fetch).json(REPOS))
  assert.equal(withMessage.message, 'TF401019: no such repo.')
  const bare = await failure(clientFor(fakeFetch(new Response('Not found', { status: 404 })).fetch).json(REPOS))
  assert.equal(bare.message, 'Azure DevOps could not find that resource.')
  assert.equal(bare.name, 'AdoError')
})

test('honours Retry-After then gives up after two retries', async () => {
  const throttled = () => jsonResponse({ message: 'Slow down.' }, 429, { 'retry-after': '2' })
  const { fetch, calls } = fakeFetch(throttled(), throttled(), throttled())
  const waits: number[] = []
  const http = clientFor(fetch, { sleep: async ms => void waits.push(ms) })
  const error = await failure(http.json(REPOS))
  assert.deepEqual(waits, [2000, 2000])
  assert.equal(calls.length, 3)
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.status, 429)
  assert.equal(error.retryAfterMs, 2000)
})

test('fails at once without sleeping when Retry-After is over ten seconds', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({ message: 'Slow down.' }, 429, { 'retry-after': '120' }), jsonResponse({}))
  const waits: number[] = []
  const error = await failure(clientFor(fetch, { sleep: async ms => void waits.push(ms) }).json(REPOS))
  assert.deepEqual(waits, [])
  assert.equal(calls.length, 1)
  assert.equal(error.code, 'rate_limited')
  assert.equal(error.status, 429)
  assert.equal(error.retryAfterMs, 120000)
})

test('still waits when Retry-After is exactly ten seconds', async () => {
  const { fetch, calls } = fakeFetch(new Response('', { status: 429, headers: { 'retry-after': '10' } }), jsonResponse({ ok: true }))
  const waits: number[] = []
  await clientFor(fetch, { sleep: async ms => void waits.push(ms) }).json(REPOS)
  assert.deepEqual(waits, [10000])
  assert.equal(calls.length, 2)
})

test('recovers when the throttle lifts after one retry', async () => {
  const { fetch, calls } = fakeFetch(new Response('', { status: 429, headers: { 'retry-after': '1' } }), jsonResponse({ ok: true }))
  const waits: number[] = []
  const { data } = await clientFor(fetch, { sleep: async ms => void waits.push(ms) }).json<{ ok: boolean }>(REPOS)
  assert.deepEqual(data, { ok: true })
  assert.deepEqual(waits, [1000])
  assert.equal(calls.length, 2)
})

test('treats 503 with Retry-After as throttling but 503 without it as a server error', async () => {
  const waits: number[] = []
  const sleep = async (ms: number) => void waits.push(ms)
  const retry = () => new Response('', { status: 503, headers: { 'retry-after': '3' } })
  const throttled = await failure(clientFor(fakeFetch(retry(), retry(), retry()).fetch, { sleep }).json(REPOS))
  assert.equal(throttled.code, 'rate_limited')
  assert.equal(throttled.status, 503)
  assert.equal(throttled.retryAfterMs, 3000)
  assert.deepEqual(waits, [3000, 3000])

  waits.length = 0
  const plain = await failure(clientFor(fakeFetch(new Response('', { status: 503 })).fetch, { sleep }).json(REPOS))
  assert.equal(plain.code, 'server')
  assert.deepEqual(waits, [])
})

test('401 asks onUnauthorized once', async () => {
  const headers = ['Bearer old', 'Bearer fresh']
  let issued = 0
  const asked: string[] = []
  const { fetch, calls } = fakeFetch(new Response('', { status: 401 }), jsonResponse({ ok: true }))
  const http = clientFor(fetch, {
    authHeader: async () => headers[Math.min(issued++, headers.length - 1)],
    onUnauthorized: async org => {
      asked.push(org)
      return true
    }
  })
  await http.json(REPOS)
  assert.deepEqual(asked, ['contoso'])
  assert.deepEqual(calls.map(c => c.headers.get('authorization')), ['Bearer old', 'Bearer fresh'])
})

test('a second 401 throws unauthorized without asking again', async () => {
  const asked: string[] = []
  const { fetch, calls } = fakeFetch(new Response('', { status: 401 }), new Response('', { status: 401 }))
  const http = clientFor(fetch, {
    onUnauthorized: async org => {
      asked.push(org)
      return true
    }
  })
  const error = await failure(http.json(REPOS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(asked.length, 1)
  assert.equal(calls.length, 2)
})

test('a refused refresh or a missing onUnauthorized throws without retrying', async () => {
  const refused = fakeFetch(new Response('', { status: 401 }), jsonResponse({}))
  const refusedError = await failure(clientFor(refused.fetch, { onUnauthorized: async () => false }).json(REPOS))
  assert.equal(refusedError.code, 'unauthorized')
  assert.equal(refused.calls.length, 1)

  const bare = fakeFetch(new Response('', { status: 401 }), jsonResponse({}))
  const bareError = await failure(clientFor(bare.fetch).json(REPOS))
  assert.equal(bareError.code, 'unauthorized')
  assert.equal(bare.calls.length, 1)
})

test('203 sign-in pages also trigger the refresh', async () => {
  const signIn = new Response('<html></html>', { status: 203, headers: { 'content-type': 'text/html' } })
  const { fetch, calls } = fakeFetch(signIn, jsonResponse({ ok: true }))
  await clientFor(fetch, { onUnauthorized: async () => true }).json(REPOS)
  assert.equal(calls.length, 2)
})

test('never puts the Authorization value in error messages', async () => {
  const replies = [
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
    jsonResponse({ message: 'Denied.' }, 500),
    new Error(`fetch failed for ${AUTH}`)
  ]
  for (const reply of replies) {
    const error = await failure(clientFor(fakeFetch(reply).fetch).json(REPOS))
    assert.equal(error.message.includes(AUTH), false)
    assert.equal(error.message.includes('secret-token-value'), false)
  }
})

test('sends the body, content type and If-Match only when given', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}), jsonResponse({}), jsonResponse({}))
  const http = clientFor(fetch)
  await http.json(REPOS)
  await http.json({ ...REPOS, method: 'POST', body: { name: 'x' } })
  await http.json({
    ...REPOS,
    method: 'PATCH',
    body: [{ op: 'add', path: '/fields/System.Title', value: 'T' }],
    contentType: 'application/json-patch+json',
    ifMatch: '"3"'
  })
  assert.equal(calls[0].headers.get('content-type'), null)
  assert.equal(calls[0].headers.get('if-match'), null)
  assert.equal(calls[0].headers.get('accept'), 'application/json')
  assert.equal(calls[1].headers.get('content-type'), 'application/json')
  assert.equal(await calls[1].text(), '{"name":"x"}')
  assert.equal(calls[2].method, 'PATCH')
  assert.equal(calls[2].headers.get('content-type'), 'application/json-patch+json')
  assert.equal(calls[2].headers.get('if-match'), '"3"')
  assert.equal(await calls[2].text(), '[{"op":"add","path":"/fields/System.Title","value":"T"}]')
})

test('returns the response headers alongside the data', async () => {
  const { fetch } = fakeFetch(jsonResponse({ value: [] }, 200, { 'x-ms-continuationtoken': 'next' }))
  const { headers } = await clientFor(fetch).json(REPOS)
  assert.equal(headers.get('x-ms-continuationtoken'), 'next')
})

test('json resolves with undefined data on 204 and on an empty body', async () => {
  for (const reply of [new Response(null, { status: 204 }), new Response('', { status: 200 })]) {
    const result = await clientFor(fakeFetch(reply).fetch).json<undefined>(REPOS)
    assert.equal(result.data, undefined)
    assert.ok(result.headers instanceof Headers)
  }
})

test('a success body that is not JSON is a server error', async () => {
  const error = await failure(clientFor(fakeFetch(new Response('<html>oops</html>', { status: 200 })).fetch).json(REPOS))
  assert.equal(error.code, 'server')
  assert.equal(error.status, 200)
})

test('network failures become a network error', async () => {
  const error = await failure(clientFor(fakeFetch(new TypeError('fetch failed')).fetch).json(REPOS))
  assert.equal(error.code, 'network')
  assert.equal(error.status, 0)
  assert.equal(error.message, 'Could not reach Azure DevOps.')
})

test('a request that outlives timeoutMs becomes a network error', async () => {
  const error = await failure(clientFor(hangingFetch(), { timeoutMs: 20 }).json(REPOS))
  assert.equal(error.code, 'network')
  assert.equal(error.status, 0)
  assert.equal(error.message, 'Azure DevOps did not respond in time.')
})

test('a caller abort surfaces as an abort, not a network error', async () => {
  const controller = new AbortController()
  const pending = clientFor(hangingFetch(), { timeoutMs: 5000 }).json({ ...REPOS, signal: controller.signal })
  controller.abort()
  try {
    await pending
    assert.fail('expected the request to abort')
  } catch (error) {
    assert(!(error instanceof AdoError))
    assert.equal((error as Error).name, 'AbortError')
  }
})

test('asks fetch not to follow redirects', async () => {
  const { fetch, calls } = fakeFetch(jsonResponse({}))
  await clientFor(fetch).json(REPOS)
  assert.equal(calls[0].redirect, 'manual')
})

test('maps any 3xx to unauthorized', async () => {
  for (const status of [301, 302, 307]) {
    const redirect = new Response('', { status, headers: { location: 'https://login.microsoftonline.com/common/oauth2/authorize' } })
    const { fetch, calls } = fakeFetch(redirect, jsonResponse({ ok: true }))
    const error = await failure(clientFor(fetch).json(REPOS))
    assert.equal(error.code, 'unauthorized')
    assert.equal(error.status, status)
    assert.equal(calls.length, 1)
  }
})

test('a redirect asks onUnauthorized once like any other auth failure', async () => {
  const redirect = new Response('', { status: 302, headers: { location: 'https://login.microsoftonline.com/' } })
  const { fetch, calls } = fakeFetch(redirect, jsonResponse({ ok: true }))
  const asked: string[] = []
  const http = clientFor(fetch, {
    onUnauthorized: async org => {
      asked.push(org)
      return true
    }
  })
  await http.json(REPOS)
  assert.deepEqual(asked, ['contoso'])
  assert.equal(calls.length, 2)
})

test('a 2xx HTML body is unauthorized but other non-JSON bodies stay server errors', async () => {
  for (const contentType of ['text/html', 'text/html; charset=utf-8', 'Text/HTML']) {
    const page = new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': contentType } })
    const error = await failure(clientFor(fakeFetch(page).fetch).json(REPOS))
    assert.equal(error.code, 'unauthorized')
    assert.equal(error.status, 200)
  }
  for (const contentType of ['text/plain', 'application/octet-stream']) {
    const body = new Response('not json', { status: 200, headers: { 'content-type': contentType } })
    const error = await failure(clientFor(fakeFetch(body).fetch).json(REPOS))
    assert.equal(error.code, 'server')
    assert.equal(error.status, 200)
  }
})

test('an already-aborted signal never reaches authHeader or fetch', async () => {
  const controller = new AbortController()
  controller.abort()
  const { fetch, calls } = fakeFetch(jsonResponse({}))
  let authCalls = 0
  const http = clientFor(fetch, {
    authHeader: async () => {
      authCalls += 1
      return AUTH
    }
  })
  try {
    await http.json({ ...REPOS, signal: controller.signal })
    assert.fail('expected the request to abort')
  } catch (error) {
    assert(!(error instanceof AdoError))
    assert.equal((error as Error).name, 'AbortError')
  }
  assert.equal(authCalls, 0)
  assert.equal(calls.length, 0)
})

test('aborting between attempts stops the retry before it asks for auth again', async () => {
  const controller = new AbortController()
  const { fetch, calls } = fakeFetch(new Response('', { status: 429, headers: { 'retry-after': '1' } }), jsonResponse({}))
  let authCalls = 0
  const http = clientFor(fetch, {
    authHeader: async () => {
      authCalls += 1
      return AUTH
    },
    sleep: async () => controller.abort()
  })
  try {
    await http.json({ ...REPOS, signal: controller.signal })
    assert.fail('expected the request to abort')
  } catch (error) {
    assert((error as Error).name === 'AbortError')
  }
  assert.equal(authCalls, 1)
  assert.equal(calls.length, 1)
})
