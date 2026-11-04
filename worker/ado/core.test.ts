import { assert, test } from 'orca/testing'
import { getConnectionData, listProjects, listTeams } from './core'
import { createAdoHttp } from './http'

const DATA = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace' } }

test('getConnectionData reads GET /_apis/connectionData, falling back to the preview api-version', async () => {
  const calls: Request[] = []
  const replies = [
    new Response(JSON.stringify({ typeKey: 'VssInvalidPreviewVersionException', message: 'Preview only.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    }),
    new Response(JSON.stringify(DATA), { status: 200, headers: { 'content-type': 'application/json' } })
  ]
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    return replies[calls.length - 1].clone()
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' })
  assert.deepEqual(await getConnectionData(http, 'contoso'), DATA)
  assert.deepEqual(calls.map(c => c.method), ['GET', 'GET'])
  assert.deepEqual(calls.map(c => c.url), [
    'https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1',
    'https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1-preview'
  ])
})

function pagedHttp(pages: { body: unknown; token?: string }[]) {
  const calls: URL[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(new URL(request.url))
    const page = pages[Math.min(calls.length, pages.length) - 1]
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (page.token) headers['x-ms-continuationtoken'] = page.token
    return new Response(JSON.stringify(page.body), { headers })
  }
  return { calls, http: createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' }) }
}

test('listProjects follows the continuation token across pages and sorts by name ignoring case', async () => {
  const { calls, http } = pagedHttp([
    { body: { count: 2, value: [{ id: 'p3', name: 'charlie', state: 'wellFormed' }, { id: 'p1', name: 'Bravo' }] }, token: 'next/page+1=' },
    { body: { count: 2, value: [{ id: 'p2', name: 'alpha' }, { id: 'p4', name: 'Delta' }] } }
  ])
  assert.deepEqual(await listProjects(http, 'contoso'), [
    { id: 'p2', name: 'alpha' },
    { id: 'p1', name: 'Bravo' },
    { id: 'p3', name: 'charlie' },
    { id: 'p4', name: 'Delta' }
  ])
  assert.deepEqual(calls.map(url => url.origin + url.pathname), Array(2).fill('https://dev.azure.com/contoso/_apis/projects'))
  assert.deepEqual(calls.map(url => url.searchParams.get('$top')), ['500', '500'])
  assert.deepEqual(calls.map(url => url.searchParams.get('continuationToken')), [null, 'next/page+1='])
})

test('listProjects stops after 20 pages and returns what it has', async () => {
  let page = 0
  const calls: Request[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    page += 1
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (page < 30) headers['x-ms-continuationtoken'] = `t${page}`
    return new Response(JSON.stringify({ count: 1, value: [{ id: `p${page}`, name: `Project ${page}` }] }), { headers })
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' })
  const projects = await listProjects(http, 'contoso')
  assert.equal(calls.length, 20)
  assert.equal(projects.length, 20)
})

test('listTeams reads the teams of one project and sorts by name ignoring case', async () => {
  const { calls, http } = pagedHttp([{ body: { count: 2, value: [{ id: 't2', name: 'web', projectId: 'p/1' }, { id: 't1', name: 'API' }] } }])
  assert.deepEqual(await listTeams(http, 'contoso', 'p/1'), [{ id: 't1', name: 'API' }, { id: 't2', name: 'web' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].origin + calls[0].pathname, 'https://dev.azure.com/contoso/_apis/projects/p%2F1/teams')
  assert.equal(calls[0].searchParams.get('$top'), '500')
})
