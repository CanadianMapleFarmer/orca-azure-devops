import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrgConfig, OrgStatus } from '../src/shared/types'
import { AdoError } from './ado/http'
import { basicAuth } from './auth/pat'
import * as worker from './main'

const PAT = 'pat-main-test-6e1f0b'
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const CAPABILITIES = ['storage:own', 'secrets:own', 'settings:own']
const ADA_DATA = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: 'ada@contoso.com' } } } }

const PAT_ORG = {
  org: 'contoso',
  url: 'https://dev.azure.com/contoso',
  tenantId: TENANT,
  method: 'pat',
  pinned: null,
  boards: null,
  codeProjects: 'all'
} satisfies OrgConfig

const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' },
  { id: 'proj-infra', name: 'infra' }
]
const TEAMS: Record<string, { id: string; name: string }[]> = {
  'proj-boards': [{ id: 'team-ops', name: 'Ops' }, { id: 'team-alpha', name: 'Alpha' }],
  'proj-web': [{ id: 'team-web', name: 'Web Team' }]
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
  if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
  if (url.pathname === '/contoso/_apis/connectionData') return json(ADA_DATA)
  if (url.pathname === '/contoso/_apis/projects') return json({ count: PROJECTS.length, value: PROJECTS })
  const teams = /^\/contoso\/_apis\/projects\/([^/]+)\/teams$/.exec(url.pathname)
  if (teams) return json({ value: TEAMS[teams[1]] ?? [] })
  return new Response('', { status: 404 })
}) as typeof fetch

async function withFakeFetch(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

function adoErrorWith(code: AdoError['code'], status: number, message: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError)
    assert.deepEqual({ code: error.code, status: error.status, message: error.message }, { code, status, message })
    return true
  }
}

function orgsChanged(posts: readonly { event: string; payload?: unknown }[]): OrgStatus[][] {
  return posts.filter(post => post.event === 'orgs.changed').map(post => (post.payload as { orgs: OrgStatus[] }).orgs)
}

test('ping answers with the plugin version', async () => {
  const w = await mountWorker(worker)
  const out = await w.request('plugin.ping', {})
  assert.match(out.version, /^\d+\.\d+\.\d+$/)
  assert.equal(w.refusals.length, 0)
})

test('activate shows the status bar item and the status command reports no orgs', async () => {
  const w = await mountWorker(worker)
  assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
    id: 'status',
    text: 'ADO',
    tone: 'neutral',
    tooltip: 'Azure DevOps: not connected'
  })
  assert.equal(await w.command('status'), 'Not connected. Open the Azure DevOps panel to connect.')
  assert.deepEqual(await w.request('orgs.list', {}), [])
  assert.equal(w.refusals.length, 0)
})

test('orgs handlers connect, sign out and remove an org', async () => {
  await withFakeFetch(async () => {
    const w = await mountWorker(worker)
    const status = await w.request('orgs.connect', { orgInput: 'https://dev.azure.com/contoso', method: 'pat', pat: PAT })
    assert.equal(status.state, 'connected')
    assert.equal(status.account?.uniqueName, 'ada@contoso.com')
    assert.deepEqual(orgsChanged(w.posts).map(orgs => orgs[0].state), ['signing-in', 'connected'])
    assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
      id: 'status',
      text: 'ADO',
      tone: 'success',
      tooltip: 'Azure DevOps: contoso (ada@contoso.com)'
    })
    assert.equal(await w.command('status'), 'contoso — connected as ada@contoso.com')
    assert.equal((await w.request('orgs.list', {}))[0].state, 'connected')
    assert.equal(Object.keys(w.host.data().secrets).includes('pat:contoso'), true)

    const signedOut = await w.request('orgs.signOut', { org: 'contoso' })
    assert.equal(signedOut.state, 'disconnected')
    assert.equal(signedOut.account, null)
    assert.equal(Object.keys(w.host.data().secrets).includes('pat:contoso'), false)

    assert.deepEqual(await w.request('orgs.remove', { org: 'contoso' }), { ok: true })
    assert.deepEqual(await w.request('orgs.list', {}), [])
    assert.deepEqual(orgsChanged(w.posts).at(-1), [])
    assert.equal(w.refusals.length, 0)

    const seen = JSON.stringify([w.posts, w.logs, w.host.calls.filter(call => !call.method.startsWith('secrets.')), w.host.data().storage])
    assert.ok(!seen.includes(PAT) && !seen.includes(basicAuth(PAT).slice(6)), 'the PAT leaked outside orca.secrets')
  })
})

test('activate resets an org left signing-in by the previous worker', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, storage: { orgs: [PAT_ORG], 'signing-in': ['contoso'] } })
  const w = await mountWorker(worker, { host })
  const [status] = await w.request('orgs.list', {})
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Sign-in was interrupted. Try again.')
  assert.deepEqual(host.data().storage['signing-in'], [])
  assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
    id: 'status',
    text: 'ADO',
    tone: 'neutral',
    tooltip: 'Azure DevOps: contoso: Sign-in was interrupted. Try again.'
  })
  assert.equal(w.refusals.length, 0)
})

async function connected(): Promise<Awaited<ReturnType<typeof mountWorker>>> {
  const w = await mountWorker(worker)
  await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: PAT })
  return w
}

function storedOrg(w: Awaited<ReturnType<typeof mountWorker>>): OrgConfig {
  return (w.host.data().storage.orgs as OrgConfig[])[0]
}

test('ado.projects and ado.teams list sorted names through the connected org', async () => {
  await withFakeFetch(async () => {
    const w = await connected()
    assert.deepEqual(await w.request('ado.projects', { org: 'contoso' }), [
      { id: 'proj-boards', name: 'Boards' },
      { id: 'proj-infra', name: 'infra' },
      { id: 'proj-web', name: 'Web' }
    ])
    assert.deepEqual(await w.request('ado.teams', { org: 'contoso', projectId: 'proj-boards' }), [
      { id: 'team-alpha', name: 'Alpha' },
      { id: 'team-ops', name: 'Ops' }
    ])
    assert.equal(w.refusals.length, 0)
  })
})

test('ado.projects refuses an org that is not connected', async () => {
  await withFakeFetch(async () => {
    const w = await mountWorker(worker)
    await assert.rejects(w.request('ado.projects', { org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
  })
})

test('orgs.setBoards stores the project and team names and posts orgs.changed', async () => {
  await withFakeFetch(async () => {
    const w = await connected()
    const status = await w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' })
    const boards = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
    assert.deepEqual(status.boards, boards)
    assert.deepEqual(storedOrg(w).boards, boards)
    assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].boards, boards)
    assert.equal(w.refusals.length, 0)
  })
})

test('orgs.setBoards refuses an unknown project or team and saves nothing', async () => {
  await withFakeFetch(async () => {
    const w = await connected()
    const posts = w.posts.length
    const gone = adoErrorWith('bad_request', 400, 'That project or team no longer exists.')
    await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-gone', teamId: 'team-ops' }), gone)
    await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-web' }), gone)
    assert.equal(storedOrg(w).boards, null)
    assert.equal(w.posts.length, posts)
  })
})

test('orgs.setCodeProjects stores all, or the named projects resolved by id', async () => {
  await withFakeFetch(async () => {
    const w = await connected()
    const some = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web', 'proj-infra'] })
    const expected = [{ id: 'proj-web', name: 'Web' }, { id: 'proj-infra', name: 'infra' }]
    assert.deepEqual(some.codeProjects, expected)
    assert.deepEqual(storedOrg(w).codeProjects, expected)
    assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].codeProjects, expected)

    const all = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: 'all' })
    assert.equal(all.codeProjects, 'all')
    assert.equal(storedOrg(w).codeProjects, 'all')
    assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].codeProjects, 'all')
    assert.equal(w.refusals.length, 0)
  })
})

test('orgs.setCodeProjects refuses an unknown project id and saves nothing', async () => {
  await withFakeFetch(async () => {
    const w = await connected()
    await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web'] })
    const posts = w.posts.length
    await assert.rejects(
      w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-infra', 'proj-gone'] }),
      adoErrorWith('bad_request', 400, 'One or more projects no longer exist.')
    )
    assert.deepEqual(storedOrg(w).codeProjects, [{ id: 'proj-web', name: 'Web' }])
    assert.equal(w.posts.length, posts)
  })
})
