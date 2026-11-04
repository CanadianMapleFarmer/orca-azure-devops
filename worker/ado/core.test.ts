import { assert, test } from 'orca/testing'
import { getConnectionData, listProjects, listTeams, resolveBoards, resolveProjects } from './core'
import { AdoError, createAdoHttp } from './http'

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
  assert.equal(calls[0].searchParams.get('$skip'), '0')
})

function teamsHttp(totalTeams: number) {
  const calls: URL[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    calls.push(url)
    const skip = Number(url.searchParams.get('$skip'))
    const top = Number(url.searchParams.get('$top'))
    const value = Array.from({ length: Math.max(0, Math.min(top, totalTeams - skip)) }, (_, i) => ({ id: `t${skip + i}`, name: `Team ${skip + i}` }))
    return new Response(JSON.stringify({ count: value.length, value }), { headers: { 'content-type': 'application/json' } })
  }
  return { calls, http: createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' }) }
}

test('listTeams pages with $top and $skip until a page comes back short', async () => {
  const { calls, http } = teamsHttp(1203)
  const teams = await listTeams(http, 'contoso', 'p1')
  assert.deepEqual(calls.map(url => url.searchParams.get('$skip')), ['0', '500', '1000'])
  assert.equal(teams.length, 1203)
  assert.equal(new Set(teams.map(team => team.id)).size, 1203)
})

test('listTeams asks once more after an exactly full page, then stops on the empty one', async () => {
  const { calls, http } = teamsHttp(500)
  assert.equal((await listTeams(http, 'contoso', 'p1')).length, 500)
  assert.deepEqual(calls.map(url => url.searchParams.get('$skip')), ['0', '500'])
})

test('listTeams stops after 20 pages and returns what it has', async () => {
  const { calls, http } = teamsHttp(500 * 30)
  assert.equal((await listTeams(http, 'contoso', 'p1')).length, 500 * 20)
  assert.equal(calls.length, 20)
})

function orgHttp(opts: { projectsStatus?: number } = {}) {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(new Request(input, init).url)
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (pathname === '/contoso/_apis/projects') {
      return json(opts.projectsStatus ?? 200, { value: [{ id: 'p-web', name: 'Web' }, { id: 'p-ops', name: 'Ops' }] })
    }
    if (pathname === '/contoso/_apis/projects/p-web/teams') return json(200, { value: [{ id: 't-web', name: 'Web Team' }] })
    if (pathname === '/contoso/_apis/projects/p-ops/teams') return json(404, { message: 'gone' })
    return json(500, { message: 'unexpected' })
  }
  return createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' })
}

test('resolveBoards names the project and team, or returns null when either is gone', async () => {
  const http = orgHttp()
  assert.deepEqual(await resolveBoards(http, 'contoso', 'p-web', 't-web'), {
    projectId: 'p-web',
    projectName: 'Web',
    teamId: 't-web',
    teamName: 'Web Team'
  })
  assert.equal(await resolveBoards(http, 'contoso', 'p-gone', 't-web'), null)
  assert.equal(await resolveBoards(http, 'contoso', 'p-web', 't-gone'), null)
  assert.equal(await resolveBoards(http, 'contoso', 'p-ops', 't-web'), null)
  assert.equal(await resolveBoards(orgHttp({ projectsStatus: 404 }), 'contoso', 'p-web', 't-web'), null)
  await assert.rejects(resolveBoards(orgHttp({ projectsStatus: 500 }), 'contoso', 'p-web', 't-web'), (error: unknown) => {
    assert.ok(error instanceof AdoError)
    assert.equal(error.code, 'server')
    return true
  })
})

test('resolveProjects keeps each known project once in first-seen order, or returns null for an unknown id', async () => {
  const http = orgHttp()
  assert.deepEqual(await resolveProjects(http, 'contoso', ['p-ops', 'p-web', 'p-ops']), [
    { id: 'p-ops', name: 'Ops' },
    { id: 'p-web', name: 'Web' }
  ])
  assert.equal(await resolveProjects(http, 'contoso', ['p-web', 'p-gone']), null)
})
