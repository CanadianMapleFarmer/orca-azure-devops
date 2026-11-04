import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrgConfig, OrgStatus } from '../src/shared/types'
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

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
  if (url.pathname === '/contoso/_apis/connectionData' && request.headers.get('authorization') === basicAuth(PAT)) {
    return new Response(JSON.stringify(ADA_DATA), { headers: { 'content-type': 'application/json' } })
  }
  return new Response('', { status: 401 })
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
