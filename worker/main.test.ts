import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { request } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JsonValue } from 'orca/worker'
import { assert, mockHost, test, type TestWorker } from 'orca/testing'
import type { RunsSnapshot } from '../src/shared/pipelines'
import type { PrSnapshot } from '../src/shared/prs'
import type { OrgConfig, OrgStatus } from '../src/shared/types'
import { AdoError } from './ado/http'
import type { RawPullRequest } from './ado/pullrequests'
import { accessToken, CLIENT_ID, fakeEntra, OID_ADA, tokenAnswer } from './auth/fake-entra'
import { basicAuth } from './auth/pat'
import { BOARDS, fakeAdo, fixture, isPatch, isWiql, json as reply, ORG_URL, PROJECT, REPO, STORIES, TEAM, type FakeAdo } from './boards/fake-ado'
import * as worker from './main'
import {
  APPROVAL_4520,
  APPROVAL_4531,
  buildIdOf,
  fakePipelines,
  isApprovalPatch,
  isBuildPatch,
  isMineRuns,
  isOneBuild,
  isRunningRuns,
  isStagePatch,
  type FakePipelines
} from './pipelines/fake-pipelines'
import { fakePrs, isMineActive, isPrList, isReviewList, ME, projectOf } from './prs/fake-prs'
import { fakeReviews, isThreads } from './reviews/fake-reviews'
import { connectError, drain, withMockTimers, withWorker } from './test-support'
import { fakeWiki, isPage, isSearch } from './wiki/fake-wiki'

function running(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern]).status === 0
}

async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return condition()
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-home-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    await run(home)
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

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

const LISTED_BUT_DELETED = 'proj-infra'
const outage = { projects: false }

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
  if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
  if (url.pathname === '/contoso/_apis/connectionData') return json(ADA_DATA)
  if (url.pathname === '/contoso/_apis/projects') {
    return outage.projects ? new Response('', { status: 404 }) : json({ count: PROJECTS.length, value: PROJECTS })
  }
  const teams = /^\/contoso\/_apis\/projects\/([^/]+)\/teams$/.exec(url.pathname)
  if (teams) return teams[1] === LISTED_BUT_DELETED ? new Response('', { status: 404 }) : json({ value: TEAMS[teams[1]] ?? [] })
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

function withoutMetrics(status: unknown): string {
  return String(status).split('\n').filter(line => !line.startsWith('  ')).join('\n')
}

function orgsChanged(posts: readonly { event: string; payload?: unknown }[]): OrgStatus[][] {
  return posts.filter(post => post.event === 'orgs.changed').map(post => (post.payload as { orgs: OrgStatus[] }).orgs)
}

test('ping answers with the plugin version', async () => {
  await withWorker(worker, {}, async w => {
    const out = await w.request('plugin.ping', {})
    assert.match(out.version, /^\d+\.\d+\.\d+$/)
    assert.equal(w.refusals.length, 0)
  })
})

test('activate shows the status bar item and the status command reports no orgs', async () => {
  await withWorker(worker, {}, async w => {
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
})

const NOT_CONNECTED = 'Not connected. Open the Azure DevOps panel to connect.'
const PROXY_INVALID = "The HTTPS proxy setting isn't an http:// or https:// address, so it's ignored."
const CA_UNREADABLE = "Couldn't read the extra CA certificates file, so it's ignored."
const CA_INVALID = "The extra CA certificates file isn't a PEM file of certificates, so it's ignored."

function networkGlobals() {
  return {
    httpAgent: process.getBuiltinModule('node:http').globalAgent,
    httpsAgent: process.getBuiltinModule('node:https').globalAgent,
    dispatcher: (globalThis as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')],
    cas: process.getBuiltinModule('node:tls').getCACertificates('default')
  }
}

async function withNetworkGlobalsUntouched(run: () => Promise<void>): Promise<void> {
  const before = networkGlobals()
  await run()
  const after = networkGlobals()
  assert.equal(after.httpAgent, before.httpAgent, 'the http agent was replaced')
  assert.equal(after.httpsAgent, before.httpsAgent, 'the https agent was replaced')
  assert.equal(after.dispatcher, before.dispatcher, 'the fetch dispatcher was replaced')
  assert.deepEqual(after.cas, before.cas, 'the trusted certificates changed')
}

test('the status command reports an ignored proxy setting', async () => {
  await withNetworkGlobalsUntouched(async () => {
    await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { httpsProxy: 'ftp://proxy.example.com' } }) }, async w => {
      assert.equal(await w.command('status'), `${NOT_CONNECTED}\n${PROXY_INVALID}`)
      assert.deepEqual(w.logs, [PROXY_INVALID])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('the status command reports a CA certificates file that is a folder, missing, too big or not certificates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-ca-'))
  try {
    const huge = path.join(dir, 'huge.pem')
    const notes = path.join(dir, 'notes.txt')
    await fs.writeFile(huge, '#'.repeat(1024 * 1024 + 1))
    await fs.writeFile(notes, 'not a certificate')
    const cases = [
      { file: dir, message: CA_UNREADABLE },
      { file: path.join(dir, 'missing.pem'), message: CA_UNREADABLE },
      { file: huge, message: CA_INVALID },
      { file: notes, message: CA_INVALID }
    ]
    await withNetworkGlobalsUntouched(async () => {
      for (const { file, message } of cases) {
        await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { caCertificatesFile: file } }) }, async w => {
          assert.equal(await w.command('status'), `${NOT_CONNECTED}\n${message}`, file)
          assert.deepEqual(w.logs, [message], file)
          assert.ok(!JSON.stringify(w.logs).includes(dir), 'the path stays out of the log')
        })
      }
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('orgs handlers connect, sign out and remove an org', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
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
      const [first, requests] = String(await w.command('status')).split('\n')
      assert.equal(first, 'contoso — connected as ada@contoso.com')
      assert.match(requests, /^ {2}Requests, last 5 min: \d+ \(.*\bconnect \d+/)
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
})

test('the status bar item still follows org changes', async () => {
  await withFakeFetch(async () => {
    const host = mockHost({ capabilities: CAPABILITIES })
    await withWorker(worker, { host }, async w => {
      await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: PAT })
      await w.request('orgs.signOut', { org: 'contoso' })
      await w.request('orgs.remove', { org: 'contoso' })
      const item = (tone: string, tooltip: string) => ({ id: 'status', text: 'ADO', tone, tooltip })
      assert.deepEqual(host.callsOf('statusBar.update'), [
        item('neutral', 'Azure DevOps: not connected'),
        item('neutral', 'Azure DevOps: contoso: signing in'),
        item('success', 'Azure DevOps: contoso (ada@contoso.com)'),
        item('neutral', 'Azure DevOps: contoso: not connected'),
        item('neutral', 'Azure DevOps: not connected')
      ])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('a failed first connect posts orgs.connectFailed and leaves no org behind', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
      const status = await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: 'pat-nobody-knows' })
      assert.equal(status.state, 'error')
      assert.deepEqual(await w.request('orgs.list', {}), [])
      assert.deepEqual(orgsChanged(w.posts).at(-1), [])
      assert.deepEqual(w.posts.filter(post => post.event === 'orgs.connectFailed').map(post => post.payload), [
        { org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'pat', message: 'Azure DevOps rejected the credentials.' }
      ])
      assert.deepEqual(w.host.data().storage.orgs, [])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('orgs.cancel stops a running az login, wrapper and all, and keeps none of its profile', async () => {
  const sleep = `sleep 30.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
  await withHome(async home => {
    const az = path.join(home, 'az')
    await fs.writeFile(az, `#!/bin/sh\n${sleep}\n`, { mode: 0o755 })
    try {
      await withFakeFetch(async () => {
        await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { azPath: az } }) }, async w => {
          const started = await w.request('orgs.connect', { orgInput: 'contoso', method: 'azure-cli' })
          assert.equal(started.state, 'signing-in')
          assert.ok(await until(() => running(sleep)), 'az login is running')

          const cancelled = await w.request('orgs.cancel', { org: 'contoso' })
          assert.equal(cancelled.state, 'disconnected')
          assert.equal(cancelled.message, 'Sign-in was cancelled.')
          assert.equal(running(sleep), false, 'nothing az started is left running')
          await assert.rejects(fs.stat(path.join(home, '.orca-azure-devops', 'az', 'contoso')), /ENOENT/)
          assert.equal(orgsChanged(w.posts).at(-1)?.[0].message, 'Sign-in was cancelled.')
          assert.equal(w.refusals.length, 0)
        })
      })
    } finally {
      spawnSync('pkill', ['-9', '-f', sleep])
    }
  })
})

test('deactivate stops a running az login, wrapper and all, within the 2 s budget', async () => {
  const sleep = `sleep 30.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
  await withHome(async home => {
    const az = path.join(home, 'az')
    await fs.writeFile(az, `#!/bin/sh\n${sleep}\n`, { mode: 0o755 })
    try {
      await withFakeFetch(async () => {
        await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { azPath: az } }) }, async w => {
          await w.request('orgs.connect', { orgInput: 'contoso', method: 'azure-cli' })
          assert.ok(await until(() => running(sleep)), 'az login is running')

          const started = Date.now()
          await w.deactivate()
          assert.ok(Date.now() - started < 2_000, 'within the deactivate budget')
          assert.equal(running(sleep), false, 'nothing az started is left running')
        })
      })
    } finally {
      spawnSync('pkill', ['-9', '-f', sleep])
    }
  })
})

const ENTRA_TOKEN = accessToken({ oid: OID_ADA, upn: 'ada@contoso.com' })
const MICROSOFT_HOST = { capabilities: CAPABILITIES, settings: { entraClientId: CLIENT_ID } }

function microsoftFetch(entra: ReturnType<typeof fakeEntra>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init)
    const url = new URL(call.url)
    if (url.hostname === 'login.microsoftonline.com') return entra.fetch(input, init)
    if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
    if (call.headers.get('authorization') !== `Bearer ${ENTRA_TOKEN}`) return new Response('', { status: 401 })
    if (url.pathname === '/contoso/_apis/connectionData') return json(ADA_DATA)
    return new Response('', { status: 404 })
  }) as typeof fetch
}

async function signInPage(w: TestWorker): Promise<URL> {
  const posted = () => orgsChanged(w.posts).flat().some(status => status.signInUrl !== undefined)
  assert.ok(await until(posted), 'the sign-in page was posted')
  const url = orgsChanged(w.posts).flat().find(status => status.signInUrl !== undefined)?.signInUrl
  return new URL(url ?? assert.fail('no sign-in page was posted'))
}

function redirectPort(page: URL): number {
  return Number(new URL(page.searchParams.get('redirect_uri') ?? '').port)
}

function postToRedirect(port: number, fields: Record<string, string>): Promise<number> {
  const body = new URLSearchParams(fields).toString()
  const headers = { host: `localhost:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers, agent: false }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a Microsoft sign-in completes through the real redirect listener', async () => {
  const entra = fakeEntra()
  entra.answer('authorization_code', tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh: 'rt-ada-1' }))
  await withFetch(microsoftFetch(entra), async () => {
    await withWorker(worker, { host: mockHost(MICROSOFT_HOST) }, async w => {
      const started = await w.request('orgs.connect', { orgInput: 'contoso', method: 'entra' })
      assert.equal(started.state, 'signing-in')
      assert.equal(started.method, 'entra')
      assert.deepEqual(started.tokenStore, { kind: 'orca-secrets' })

      const page = await signInPage(w)
      const port = redirectPort(page)
      assert.equal(await connectError('127.0.0.1', port), null)
      assert.equal(await postToRedirect(port, { code: 'c-ada-1', state: page.searchParams.get('state') ?? '' }), 200)
      assert.ok(await until(() => orgsChanged(w.posts).at(-1)?.[0].state === 'connected'), 'the org connects')

      const [status] = await w.request('orgs.list', {})
      assert.equal(status.state, 'connected')
      assert.equal(status.account?.uniqueName, 'ada@contoso.com')
      assert.equal(status.signInUrl, undefined)
      assert.equal(await connectError('127.0.0.1', port), 'ECONNREFUSED', 'the port closes with the redirect')
      assert.deepEqual(JSON.parse(String(w.host.data().secrets['entra:contoso'])), { v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-ada-1' })
      assert.equal(w.refusals.length, 0)

      const verifier = entra.calls[0].form.get('code_verifier') ?? assert.fail('no code verifier was sent')
      const seen = JSON.stringify([w.posts, w.logs, w.host.calls.filter(call => !call.method.startsWith('secrets.')), w.host.data().storage])
      for (const leak of ['rt-ada-1', ENTRA_TOKEN, 'c-ada-1', verifier]) assert.ok(!seen.includes(leak), 'a sign-in secret leaked outside orca.secrets')
    })
  })
})

test('deactivate during a Microsoft sign-in closes its port and the next start says it was interrupted', async () => {
  const host = mockHost(MICROSOFT_HOST)
  await withFetch(microsoftFetch(fakeEntra()), async () => {
    let port = 0
    await withWorker(worker, { host }, async w => {
      await w.request('orgs.connect', { orgInput: 'contoso', method: 'entra' })
      port = redirectPort(await signInPage(w))
      assert.equal(await connectError('127.0.0.1', port), null)
      const posted = orgsChanged(w.posts).length

      await w.deactivate()
      assert.equal(await connectError('127.0.0.1', port), 'ECONNREFUSED')
      await drain()
      assert.equal(orgsChanged(w.posts).length, posted, 'stopping concludes nothing')
      assert.deepEqual(host.data().storage['signing-in'], ['contoso'])
    })

    const leftover = JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-ada-1' })
    const next = mockHost({ ...MICROSOFT_HOST, storage: host.data().storage as Record<string, JsonValue>, secrets: { 'entra:contoso': leftover } })
    await withWorker(worker, { host: next }, async w => {
      const [status] = await w.request('orgs.list', {})
      assert.equal(status.state, 'disconnected')
      assert.equal(status.message, 'Sign-in was interrupted. Try again.')
      assert.equal(status.signInUrl, undefined)
      assert.equal(Object.keys(next.data().secrets).includes('entra:contoso'), false)
      assert.deepEqual(next.data().storage['signing-in'], [])
      assert.equal(await connectError('127.0.0.1', port), 'ECONNREFUSED')
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('activate resets an org left signing-in by the previous worker', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, storage: { orgs: [PAT_ORG], 'signing-in': ['contoso'] } })
  await withWorker(worker, { host }, async w => {
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
})

function withConnected(run: (w: TestWorker) => Promise<void>): Promise<void> {
  return withWorker(worker, {}, async w => {
    await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: PAT })
    await run(w)
  })
}

function storedOrg(w: TestWorker): OrgConfig {
  return (w.host.data().storage.orgs as OrgConfig[])[0]
}

test('ado.projects and ado.teams list sorted names through the connected org', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
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
})

test('ado.projects refuses an org that is not connected', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
      await assert.rejects(w.request('ado.projects', { org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
    })
  })
})

test('orgs.setBoards stores the project and team names and posts orgs.changed', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const status = await w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' })
      const boards = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
      assert.deepEqual(status.boards, boards)
      assert.deepEqual(storedOrg(w).boards, boards)
      assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].boards, boards)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('orgs.setBoards refuses an unknown project or team and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const posts = w.posts.length
      const gone = adoErrorWith('bad_request', 400, 'That project or team no longer exists.')
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-gone', teamId: 'team-ops' }), gone)
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-web' }), gone)
      assert.equal(storedOrg(w).boards, null)
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setBoards reports a project or team deleted mid-call as no longer existing and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const posts = w.posts.length
      const gone = adoErrorWith('bad_request', 400, 'That project or team no longer exists.')
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: LISTED_BUT_DELETED, teamId: 'team-ops' }), gone)
      outage.projects = true
      try {
        await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' }), gone)
      } finally {
        outage.projects = false
      }
      assert.equal(storedOrg(w).boards, null)
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setCodeProjects stores all, or the named projects resolved by id', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
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
})

test('orgs.setCodeProjects refuses an unknown project id and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
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
})

test('orgs.setCodeProjects refuses an empty list and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web'] })
      const posts = w.posts.length
      await assert.rejects(
        w.request('orgs.setCodeProjects', { org: 'contoso', projects: [] }),
        adoErrorWith('bad_request', 400, 'Pick at least one project, or choose all projects.')
      )
      assert.deepEqual(storedOrg(w).codeProjects, [{ id: 'proj-web', name: 'Web' }])
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setCodeProjects stores each project once, in first-seen order', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const status = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web', 'proj-infra', 'proj-web', 'proj-infra'] })
      const expected = [{ id: 'proj-web', name: 'Web' }, { id: 'proj-infra', name: 'infra' }]
      assert.deepEqual(status.codeProjects, expected)
      assert.deepEqual(storedOrg(w).codeProjects, expected)
    })
  })
})

const ADA = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: TENANT, objectId: null }

function signedIn(ado: FakeAdo): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
    return ado.fetch(input, init)
  }) as typeof fetch
}

async function withFetch(fetch: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = fetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

function boardsHost(boards: typeof BOARDS | null, results: Record<string, unknown> = {}) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
    storage: { orgs: [{ ...PAT_ORG, pinned: ADA, boards }] },
    secrets: { 'pat:contoso': PAT },
    results
  })
}

function workChanged(posts: readonly { event: string; payload?: unknown }[]) {
  return posts.filter(post => post.event === 'work.changed').map(post => post.payload as { mine: { id: number }[] })
}

test('work handlers serve the connected org through the boards service', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      const snapshot = await w.request('work.snapshot', { org: 'contoso' })
      assert.deepEqual(snapshot.mine.map(item => item.id), [1204])
      assert.deepEqual(snapshot.other.map(item => item.id), [1207, 1205])
      assert.equal((await w.request('work.refresh', { org: 'contoso' })).board?.boardId, STORIES)
      assert.ok(workChanged(w.posts).length > 0)

      assert.deepEqual(await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true }), { ok: true })
      assert.equal((await w.request('work.details', { org: 'contoso', id: 1204 })).item.id, 1204)
      assert.equal((await w.request('work.comment', { org: 'contoso', id: 1204, text: 'Ready' })).id, 77)
      const moved = await w.request('work.move', { org: 'contoso', id: 1204, rev: 9, to: { column: 'Resolved' } })
      assert.deepEqual([moved.column, moved.rev], ['Resolved', 10])
      const linked = await w.request('work.linkPr', { org: 'contoso', id: 1205, rev: 3, prUrl: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322` })
      assert.deepEqual(linked.prs.map(chip => chip.prId), [322])
      const board = await w.request('work.board', { org: 'contoso', projectId: PROJECT, teamId: TEAM, everyone: false })
      assert.equal(board.board.boardId, STORIES)
      assert.deepEqual(await w.request('ui.visibility', { surface: 'board', org: 'contoso', visible: false }), { ok: true })
      assert.deepEqual(await w.request('work.dismissNudge', { org: 'contoso', itemId: 1204, prId: 321 }), { ok: true })
      assert.deepEqual(w.host.data().storage['nudgeDismissed:contoso'], ['1204:321'])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('deactivate disposes the polling scheduler, aborting the "my work" load in flight', async () => {
  const ado = fakeAdo()
  const loading = ado.hang(isWiql)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true })
      assert.ok(await until(() => loading.length === 1), 'the "my work" job is loading')
      await w.deactivate()
      assert.equal(loading[0].signal?.aborted, true)
    })
  })
})

test('work.nudgeRules reads and saves the rules of the boards team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      assert.deepEqual(await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM }), { rules: [] })

      const rules = [{ branch: 'refs/heads/release/2026.11', column: 'Resolved' }]
      const saved = await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM, rules })
      assert.deepEqual(saved, { rules: [{ branch: 'release/2026.11', column: 'Resolved' }] })
      assert.deepEqual(w.host.data().storage[`nudgeRules:contoso:${TEAM}`], saved.rules)
      assert.deepEqual(await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM }), saved)
      assert.ok(await until(() => workChanged(w.posts).length > 0), 'saving refreshed the snapshot')

      await assert.rejects(
        w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM, rules: [{ branch: 'main', column: 'Shipped' }] }),
        adoErrorWith('bad_request', 400, "That column isn't on this board.")
      )
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('work.snapshot tells an org without a boards team to pick one', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(null) }, async w => {
      const snapshot = await w.request('work.snapshot', { org: 'contoso' })
      assert.equal(snapshot.board, null)
      assert.equal(snapshot.message, "Pick a boards project and team in this org's settings.")
      assert.equal(ado.calls.length, 0)
    })
  })
})

test('org changes reach the boards service: setting a boards team starts polling "my work"', async () => {
  const ado = fakeAdo()
  ado.on(call => call.path === '/contoso/_apis/projects', () => reply(200, { value: [{ id: PROJECT, name: BOARDS.projectName }] }))
  ado.on(call => call.path === `/contoso/_apis/projects/${PROJECT}/teams`, () => reply(200, { value: [{ id: TEAM, name: BOARDS.teamName }] }))
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(null) }, async w => {
      await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true })
      await w.request('orgs.setBoards', { org: 'contoso', projectId: PROJECT, teamId: TEAM })
      assert.ok(await until(() => workChanged(w.posts).length > 0), 'the new job loaded and posted a snapshot')
      assert.deepEqual(workChanged(w.posts)[0].mine.map(item => item.id), [1204])
      assert.equal(ado.calls.filter(isWiql).length, 1)

      await w.request('orgs.signOut', { org: 'contoso' })
    })
  })
})

test('work.boards lists the boards of a team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      const boards = await w.request('work.boards', { org: 'contoso', projectId: PROJECT, teamId: TEAM })
      assert.deepEqual(boards.map(board => board.name), ['Epics', 'Stories', 'Features'])
      assert.equal(boards[1].id, STORIES)
      assert.equal(w.refusals.length, 0)
    })
  })
})

const FOCUSED = { branch: 'feature/1204-search', displayName: 'web-app', terminals: [] }

function workspaceAt(path: string, hostId: string | null = null) {
  return { workspaces: [{ id: 'ws-web', kind: 'worktree', name: 'web-app', path, branch: 'feature/1204-search', hostId }], truncated: false }
}

test('work.openBoard writes the board file into the focused local workspace and opens it', async () => {
  const ado = fakeAdo()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      const host = boardsHost(BOARDS, {
        'workspace.readContext': () => FOCUSED,
        'workspace.list': () => workspaceAt(dir),
        'editor.open': { opened: true }
      })
      await withWorker(worker, { host }, async w => {
        assert.deepEqual(await w.request('work.openBoard', { org: 'contoso' }), { opened: true })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: `.orca-ado/contoso.${TEAM}.adoboard` }])
        const written = JSON.parse(await fs.readFile(path.join(dir, '.orca-ado', `contoso.${TEAM}.adoboard`), 'utf8'))
        assert.deepEqual(written, { org: 'contoso', projectId: PROJECT, teamId: TEAM, boardId: STORIES })
        assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n')
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('work.openBoard refuses without a focused local workspace or a boards team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    const noWorkspace = { opened: false, message: 'Open a local workspace first, or use + → Azure DevOps board.' }
    await withWorker(worker, { host: boardsHost(BOARDS, { 'workspace.readContext': () => null }) }, async unfocused => {
      assert.deepEqual(await unfocused.request('work.openBoard', { org: 'contoso' }), noWorkspace)
    })

    const remoteHost = boardsHost(BOARDS, { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt('/srv/web-app', 'ssh:build-box') })
    await withWorker(worker, { host: remoteHost }, async remote => {
      assert.deepEqual(await remote.request('work.openBoard', { org: 'contoso' }), noWorkspace)
      assert.deepEqual(remoteHost.callsOf('editor.open'), [])
    })

    const noBoardsHost = boardsHost(null, { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt('/repos/web-app') })
    await withWorker(worker, { host: noBoardsHost }, async noBoards => {
      assert.deepEqual(await noBoards.request('work.openBoard', { org: 'contoso' }), {
        opened: false,
        message: "Pick a boards project and team in this org's settings."
      })
    })
    assert.equal(ado.calls.length, 0)
  })
})

function prsHost(boards: typeof BOARDS | null = null, settings: Record<string, JsonValue> = {}) {
  return mockHost({
    capabilities: CAPABILITIES,
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME }, boards }] },
    secrets: { 'pat:contoso': PAT },
    settings
  })
}

function prsChanged(posts: readonly { event: string; payload?: unknown }[]): PrSnapshot[] {
  return posts.filter(post => post.event === 'prs.changed').map(post => post.payload as PrSnapshot)
}

test('prs.snapshot answers through the handler', async () => {
  const ado = fakePrs()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const snapshot = await w.request('prs.snapshot', { org: 'contoso' })
      assert.deepEqual(snapshot.sets.map(set => set.prs.map(pr => pr.prId)), [[4105], [4104], [4101, 4102, 4103]])
      assert.deepEqual([snapshot.me, snapshot.toReview.map(pr => pr.prId), snapshot.toReviewCount], [ME, [4110], 1])
      assert.deepEqual(snapshot.autoComplete, { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false })
      assert.deepEqual(prsChanged(w.posts).at(-1), snapshot)

      const refreshed = await w.request('prs.refresh', { org: 'contoso' })
      assert.deepEqual(refreshed.sets.map(set => set.key), snapshot.sets.map(set => set.key))
      await assert.rejects(w.request('prs.snapshot', { org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('prs.approve answers through the handler', async () => {
  const ado = fakePrs()
  ado.on(call => call.method === 'PUT' && call.path.includes('/reviewers/'), call => reply(200, call.body))
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const key = { projectId: PROJECT, repoId: REPO, prId: 4102 }
      assert.deepEqual(await w.request('prs.approve', { org: 'contoso', prs: [key] }), { results: [{ prId: 4102, ok: true, message: 'Approved.' }] })
      const [vote] = ado.calls.filter(call => call.method === 'PUT')
      assert.equal(vote.path, `/contoso/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4102/reviewers/${ME}`)
      assert.deepEqual(vote.body, { vote: 10, isRequired: false })
      await assert.rejects(w.request('prs.approve', { org: 'fabrikam', prs: [key] }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('prs.autoComplete answers through the handler with the saved options', async () => {
  const ado = fakePrs()
  ado.on(isPatch, call => reply(200, { pullRequestId: Number(call.path.split('/').pop()) }))
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const key = { projectId: PROJECT, repoId: REPO, prId: 4102 }
      assert.deepEqual(await w.request('prs.autoComplete', { org: 'contoso', prs: [key] }), { results: [{ prId: 4102, ok: true, message: 'Auto-complete set.' }] })
      const [patch] = ado.calls.filter(isPatch)
      assert.deepEqual(patch.body, {
        autoCompleteSetBy: { id: ME },
        completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false, bypassPolicy: false }
      })
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('the status command reports review counts', async () => {
  const ado = fakePrs()
  await withFetch(signedIn(ado), async () => {
    const host = prsHost(null, { notifyPrComments: false })
    await withWorker(worker, { host }, async w => {
      const shown = () => (host.callsOf('statusBar.update').at(-1) as { text?: string } | undefined)?.text
      assert.ok(await until(() => shown() === 'ADO · 1 to review'), 'the background run counted the pull requests to review')
      assert.equal(withoutMetrics(await w.command('status')), 'contoso — connected as ada@contoso.com\n1 pull request to review: contoso 1')
      assert.deepEqual(prsChanged(w.posts), [], 'a background run posts no snapshot')
      assert.equal(ado.count(isMineActive), 0)

      await w.request('orgs.signOut', { org: 'contoso' })
      assert.equal(shown(), 'ADO')
      assert.ok(!String(await w.command('status')).includes('to review'))
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('ui.visibility routes prs to the PRs service and work/board as before', async () => {
  const ado = fakePrs()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost(BOARDS, { notifyPrComments: false }) }, async w => {
      assert.ok(await until(() => ado.count(isReviewList) > 0), 'the PRs job runs in the background')
      assert.deepEqual(await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true }), { ok: true })
      assert.deepEqual(await w.request('ui.visibility', { surface: 'board', org: 'contoso', visible: false }), { ok: true })
      assert.equal(await until(() => ado.count(isMineActive) > 0, 200), false, 'work and board visibility leave the PRs job alone')

      assert.deepEqual(await w.request('ui.visibility', { surface: 'prs', org: 'contoso', visible: true }), { ok: true })
      assert.ok(await until(() => prsChanged(w.posts).length > 0), 'showing the PRs tab ran a full load')
      assert.deepEqual(prsChanged(w.posts)[0].sets.map(set => set.prs.map(pr => pr.prId)), [[4105], [4104], [4101, 4102, 4103]])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('deactivate aborts a pull request load in flight, and nothing is posted or counted after it', async () => {
  const ado = fakePrs()
  const hung = ado.hang(isPrList)
  await withFetch(signedIn(ado), async () => {
    const host = prsHost()
    await withWorker(worker, { host }, async w => {
      const answer = w.request('prs.snapshot', { org: 'contoso' }).then(() => null, (error: unknown) => error)
      assert.ok(await until(() => hung.length > 0), 'pull request lists are in flight')
      await w.deactivate()
      assert.ok(hung.every(call => call.signal?.aborted), 'every request is aborted')
      assert.ok(adoErrorWith('unauthorized', 401, 'Connect this organization first.')(await answer))
      assert.deepEqual(prsChanged(w.posts), [])
      const shown = host.callsOf('statusBar.update').map(call => (call as { text?: string }).text)
      assert.ok(shown.every(text => text === 'ADO'), JSON.stringify(shown))
    })
  })
})

function prNotifyHost(settings: Record<string, JsonValue>) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'notifications:show'],
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME } }] },
    secrets: { 'pat:contoso': PAT },
    settings,
    results: { 'notifications.show': { delivered: true } }
  })
}

test('a PRs poll that adds a review request shows one desktop notification, and the PR notification settings are wired', async () => {
  const listed = fixture<{ value: RawPullRequest[] }>('pull-requests-review').value
  const request = { ...structuredClone(listed[0]), pullRequestId: 4120, title: 'Tighten the redirect check', sourceRefName: 'refs/heads/feature/4120' }
  const ado = fakePrs()
  ado.on(isReviewList, call => reply(200, { value: projectOf(call) === PROJECT ? listed : [] }))
  await withFetch(signedIn(ado), async () => {
    const host = prNotifyHost({ notifyPrComments: false })
    await withWorker(worker, { host }, async w => {
      await w.request('prs.refresh', { org: 'contoso' })
      await drain()
      assert.deepEqual(host.callsOf('notifications.show'), [], 'the first load only notes what is already waiting')

      listed.push(request)
      await w.request('prs.refresh', { org: 'contoso' })
      assert.ok(await until(() => host.callsOf('notifications.show').length > 0), 'the poll that follows the load notifies')
      assert.deepEqual(host.callsOf('notifications.show'), [{ title: 'Review requested: Pull Request 4120', body: 'Tighten the redirect check\nGrace Hopper · web-app' }])
      await w.request('prs.refresh', { org: 'contoso' })
      await drain()
      assert.equal(host.callsOf('notifications.show').length, 1, 'each request notifies once')
      assert.equal(ado.count(isThreads), 0, 'notifyPrComments off reads no threads')
      assert.equal(w.refusals.length, 0)
    })

    listed.pop()
    const quiet = prNotifyHost({ notifyReviewRequests: false })
    await withWorker(worker, { host: quiet }, async w => {
      await w.request('prs.refresh', { org: 'contoso' })
      listed.push(request)
      await w.request('prs.refresh', { org: 'contoso' })
      assert.ok(await until(() => ado.count(isThreads) > 0), 'notifyPrComments on reads the threads of my pull requests')
      await drain()
      assert.deepEqual(quiet.callsOf('notifications.show'), [], 'notifyReviewRequests off shows nothing')
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('reviews.open and reviews.diff answer through the handlers', async () => {
  const ado = fakeReviews()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const key = { org: 'contoso', projectId: PROJECT, repoId: REPO, prId: 4110 }
      const review = await w.request('reviews.open', key)
      assert.deepEqual([review.pr.prId, review.myVote, review.threadCount, review.files.length], [4110, 0, 3, 5])
      assert.deepEqual(review.threads.map(thread => thread.id), [101, 103, 102])
      const diff = await w.request('reviews.diff', { ...key, path: '/src/auth/redirect.ts' })
      assert.deepEqual(diff.lines, { old: 60, new: 64 })
      assert.match(diff.text ?? '', /^@@ -37,10 \+37,14 @@\n/)
      await assert.rejects(
        w.request('reviews.diff', { ...key, path: '/src/auth/missing.ts' }),
        adoErrorWith('bad_request', 400, "That file isn't changed in this pull request any more.")
      )
      await assert.rejects(w.request('reviews.open', { ...key, org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))

      const hung = ado.hang(isThreads)
      const answer = w.request('reviews.open', key).then(() => null, (error: unknown) => error)
      assert.ok(await until(() => hung.length > 0), 'the threads read is in flight')
      await w.request('orgs.signOut', { org: 'contoso' })
      assert.ok(adoErrorWith('unauthorized', 401, 'Connect this organization first.')(await answer))
      assert.equal(hung[0].signal?.aborted, true)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('reviews.vote answers through the handler', async () => {
  const ado = fakeReviews()
  ado.on(call => call.method === 'PUT' && call.path.includes('/reviewers/'), call => reply(200, call.body))
  ado.on(call => ['POST', 'PATCH'].includes(call.method) && call.path.includes('/threads'), call => reply(200, call.body))
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const key = { org: 'contoso', projectId: PROJECT, repoId: REPO, prId: 4110 }
      const pr = `/contoso/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4110`
      assert.deepEqual(await w.request('reviews.vote', { ...key, vote: 'suggestions' }), { ok: true, message: 'Approved with suggestions.' })
      const [vote] = ado.calls.filter(call => call.method === 'PUT')
      assert.equal(vote.path, `${pr}/reviewers/${ME}`)
      assert.deepEqual(vote.body, { vote: 5, isRequired: true })
      assert.ok(await until(() => prsChanged(w.posts).length > 0), 'the vote reloaded the pull request list')

      assert.deepEqual(await w.request('reviews.reply', { ...key, threadId: 101, text: 'Thanks' }), { ok: true, message: 'Reply posted.' })
      assert.deepEqual(await w.request('reviews.setStatus', { ...key, threadId: 101, status: 'fixed' }), { ok: true, message: 'Resolved.' })
      const posted = await w.request('reviews.comment', { ...key, text: 'Why decode here?', path: '/src/auth/redirect.ts', line: 42 })
      assert.deepEqual(posted, { ok: true, message: 'Comment posted on /src/auth/redirect.ts, line 42.' })
      const writes = ado.calls.filter(call => call.method !== 'GET' && call.method !== 'PUT')
      assert.deepEqual(writes.map(call => [call.method, call.path]), [
        ['POST', `${pr}/threads/101/comments`],
        ['PATCH', `${pr}/threads/101`],
        ['POST', `${pr}/threads`]
      ])
      assert.deepEqual(await w.request('reviews.vote', { ...key, org: 'fabrikam', vote: 'approve' }), {
        ok: false,
        message: 'Connect this organization first.'
      })
      assert.equal(ado.count(call => call.method === 'PUT'), 1)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('wiki.list and wiki.page answer through the handlers', async () => {
  const ado = fakeWiki()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const gone = adoErrorWith('unauthorized', 401, 'Connect this organization first.')
      const wikis = await w.request('wiki.list', { org: 'contoso' })
      assert.deepEqual(wikis.map(item => [item.name, item.editable]), [['api-docs', false], ['Fabrikam Web.wiki', true]])
      const ref = { org: 'contoso', projectId: PROJECT, wikiId: wikis[1].id, path: '/Release process/Checklist' }
      const level = await w.request('wiki.pages', { ...ref, path: '/' })
      assert.deepEqual(level.pages.map(page => page.title), ['Home', 'Release process', 'Onboarding', 'Résumé'])
      const page = await w.request('wiki.page', ref)
      assert.deepEqual([page.title, page.editable, page.content.includes('[[_TOC_]]')], ['Checklist', true, false])
      assert.ok(
        page.content.includes('[Rollback](https://dev.azure.com/contoso/Fabrikam%20Web/_wiki/wikis/Fabrikam%20Web.wiki?pagePath=%2FRelease%20process%2FRollback)'),
        page.content
      )
      const found = await w.request('wiki.search', { org: 'contoso', projectId: PROJECT, wikiId: wikis[1].id, text: 'smoke' })
      assert.deepEqual(found.hits.map(hit => hit.path), ['/Release process/Checklist', '/FAQ: login'])
      assert.equal(ado.calls.filter(isSearch)[0].host, 'almsearch.dev.azure.com')
      await assert.rejects(
        w.request('wiki.search', { org: 'contoso', projectId: PROJECT, wikiId: wikis[1].id, text: 'a' }),
        adoErrorWith('bad_request', 400, 'Type at least 2 characters to search.')
      )
      await assert.rejects(
        w.request('wiki.page', { ...ref, path: '/Gone' }),
        adoErrorWith('not_found', 404, 'This page was moved or deleted in Azure DevOps.')
      )
      await assert.rejects(w.request('wiki.list', { org: 'fabrikam' }), gone)

      const hung = ado.hang(isPage)
      const answer = w.request('wiki.page', ref).then(() => null, (error: unknown) => error)
      assert.ok(await until(() => hung.length > 0), 'the page read is in flight')
      await w.request('orgs.signOut', { org: 'contoso' })
      assert.ok(gone(await answer))
      assert.equal(hung[0].signal?.aborted, true)
      await assert.rejects(w.request('wiki.list', { org: 'contoso' }), gone)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('wiki.edit and wiki.drafts answer through the handlers', async () => {
  const ado = fakeWiki()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      const host = mockHost({
        capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
        storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME } }] },
        secrets: { 'pat:contoso': PAT },
        results: { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt(dir), 'editor.open': { opened: true } }
      })
      await withWorker(worker, { host }, async w => {
        const wikiId = ado.wikis.find(wiki => wiki.name === 'Fabrikam Web.wiki')!.id
        const ref = { org: 'contoso', projectId: PROJECT, wikiId, path: '/Release process/Checklist' }
        const file = 'wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
        const key = `contoso:${wikiId}:/Release process/Checklist`
        assert.deepEqual(await w.request('wiki.edit', ref), {
          opened: true,
          message: 'Opened Checklist in Orca. Save your changes there, then press Publish here.'
        })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: `.orca-ado/${file}` }])
        assert.equal(await fs.readFile(path.join(dir, '.orca-ado', ...file.split('/')), 'utf8'), ado.pages.get(ref.path)?.content)
        assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n')
        assert.deepEqual(await w.request('wiki.drafts', { org: 'contoso' }), [
          { ...ref, key, wikiName: 'Fabrikam Web.wiki', title: 'Checklist', file, workspaceName: 'web-app', changed: false, publishedAt: null }
        ])
        assert.deepEqual(
          (w.host.data().storage['wiki:drafts'] as { key: string }[]).map(draft => draft.key),
          [key]
        )
        assert.deepEqual(await w.request('wiki.discard', { key }), { ok: true, message: 'Draft discarded.' })
        assert.deepEqual(await w.request('wiki.drafts', { org: 'contoso' }), [])
        await assert.rejects(w.request('wiki.discard', { key }), adoErrorWith('bad_request', 400, 'That draft no longer exists.'))
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('wiki.openInTab answers through the handler', async () => {
  const ado = fakeWiki()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      let focused: typeof FOCUSED | null = FOCUSED
      const host = mockHost({
        capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
        storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME } }] },
        secrets: { 'pat:contoso': PAT },
        results: { 'workspace.readContext': () => focused, 'workspace.list': () => workspaceAt(dir), 'editor.open': { opened: true } }
      })
      await withWorker(worker, { host }, async w => {
        const wikiId = ado.wikis.find(wiki => wiki.name === 'Fabrikam Web.wiki')!.id
        const ref = { org: 'contoso', projectId: PROJECT, wikiId, path: '/Release process/Checklist' }
        const copy = 'wiki-read/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
        const file = path.join(dir, '.orca-ado', ...copy.split('/'))
        assert.deepEqual(await w.request('wiki.openInTab', ref), { opened: true, message: 'Opened Checklist in a tab.' })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: `.orca-ado/${copy}` }])
        const text = await fs.readFile(file, 'utf8')
        assert.ok(text.startsWith('*A read-only copy of Checklist. To change it, use Edit in Orca in the Azure DevOps sidebar.*\n\n'), text)
        assert.deepEqual([text.includes('\n# Release checklist\n'), text.includes('[[_TOC_]]')], [true, false])
        assert.equal((await fs.stat(file)).mode & 0o777, 0o444)

        focused = null
        assert.deepEqual(await w.request('wiki.openInTab', ref), {
          opened: false,
          message: 'Open a local workspace first; wiki pages open in a tab there.'
        })
        assert.equal(host.callsOf('editor.open').length, 1)
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('wiki.publish answers through the handler', async () => {
  const ado = fakeWiki()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      const host = mockHost({
        capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
        storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME } }] },
        secrets: { 'pat:contoso': PAT },
        results: { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt(dir), 'editor.open': { opened: true } }
      })
      await withWorker(worker, { host }, async w => {
        const wikiId = ado.wikis.find(wiki => wiki.name === 'Fabrikam Web.wiki')!.id
        const ref = { org: 'contoso', projectId: PROJECT, wikiId, path: '/Release process/Checklist' }
        const draft = path.join(dir, '.orca-ado', 'wiki', 'contoso', 'Fabrikam Web.wiki', 'Release process', 'Checklist.md')
        const key = `contoso:${wikiId}:/Release process/Checklist`
        const page = ado.pages.get(ref.path)!
        const puts = () => ado.calls.filter(call => call.method === 'PUT').length
        await w.request('wiki.edit', ref)
        assert.deepEqual(await w.request('wiki.publish', { key }), {
          status: 'unchanged',
          message: 'Nothing to publish yet. Save your changes in the editor first.'
        })

        const mine = `${page.content}\nOne more step.\n`
        await fs.writeFile(draft, mine)
        assert.deepEqual(await w.request('wiki.publish', { key }), { status: 'published', message: 'Published.' })
        assert.deepEqual([page.content, puts()], [mine, 1])

        Object.assign(page, { content: 'Rewritten by someone else.\n', etag: '"c0ffee"' })
        await fs.writeFile(draft, 'Mine again.\n')
        const clash = await w.request('wiki.publish', { key })
        assert.deepEqual([clash.status, clash.message], ['conflict', 'Someone changed this page in Azure DevOps after you started editing.'])
        assert.deepEqual(await w.request('wiki.resolve', { key, choice: 'theirs' }), { status: 'updated', message: 'Your draft now holds their version.' })
        assert.deepEqual([await fs.readFile(draft, 'utf8'), puts()], ['Rewritten by someone else.\n', 1])
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

const SIG = 'wQ3vN8sXkP2mR7tY1uZ4aB6cD9eF0gH5iJ'
const WEBHOOK_HOST = 'default0f0e0d0c.environment.api.powerplatform.com'
const WEBHOOK = `https://${WEBHOOK_HOST}/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const ROTATED_SIG = 'Rk2pL9qWz4tY8uI0oP3aS6dF'
const ROTATED = `https://${WEBHOOK_HOST}/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sv=1.0&sig=${ROTATED_SIG}`

type WebhookAnswer = (url: string, init?: RequestInit) => Response | Promise<Response>

function withWebhook(ado: FakeAdo, answer: { respond: WebhookAnswer }): typeof fetch {
  const toAdo = signedIn(ado)
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).host === WEBHOOK_HOST ? answer.respond(String(input), init) : toAdo(input, init)) as typeof fetch
}

async function outcome<T>(request: Promise<T>): Promise<T | { thrown: string }> {
  return request.catch((error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }))
}

function exposed(w: TestWorker, answers: unknown[] = []): string {
  return JSON.stringify([answers, w.logs, w.posts, w.host.data().storage, w.host.calls.filter(call => !call.method.startsWith('secrets.'))])
}

test('share.addChannel never returns or logs the URL', async () => {
  const ado = fakePrs()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: prsHost() }, async w => {
      const channel = await w.request('share.addChannel', { name: 'Release train', url: WEBHOOK })
      assert.deepEqual(Object.keys(channel).sort(), ['addedAt', 'id', 'name', 'service'])
      assert.deepEqual([channel.name, channel.service], ['Release train', 'teams'])
      assert.equal(w.host.data().secrets[`teams-webhook:${channel.id}`], WEBHOOK)
      assert.deepEqual(await w.request('share.channels', {}), [channel])

      const prefs = await w.request('share.prefs', { org: 'contoso', kind: 'pr' })
      assert.deepEqual(prefs, {
        template: '[Pull Request {id}]({url}): {title}',
        channels: [channel],
        prefs: { destinations: [{ kind: 'copy' }] },
        tenantId: TENANT
      })

      const answers: unknown[] = [channel, prefs]
      answers.push(await outcome(w.request('share.addChannel', { name: 'Release train', url: ROTATED })))
      answers.push(await outcome(w.request('share.addChannel', { name: 'QA', url: ROTATED.replace('https:', 'http:') })))
      answers.push(await outcome(w.request('share.replaceChannel', { id: channel.id, url: ROTATED })))
      assert.deepEqual(answers.slice(2), [
        { thrown: 'You already have a channel with that name.' },
        { thrown: "That isn't a valid https webhook URL." },
        channel
      ])
      assert.equal(w.host.data().secrets[`teams-webhook:${channel.id}`], ROTATED)

      const seen = exposed(w, answers)
      for (const secret of [WEBHOOK, SIG, ROTATED, ROTATED_SIG]) assert.ok(!seen.includes(secret), 'a webhook URL leaked outside orca.secrets')

      assert.deepEqual(await w.request('share.removeChannel', { id: channel.id }), { ok: true })
      assert.deepEqual(await w.request('share.channels', {}), [])
      assert.equal(Object.keys(w.host.data().secrets).some(key => key.startsWith('teams-webhook:')), false)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('webhook failures never mention the URL', async () => {
  const ado = fakePrs()
  const leaky = (status: number): WebhookAnswer => url => new Response(JSON.stringify({ error: { code: 'WorkflowNotFound', message: `No workflow at ${url}` } }), { status })
  const failures: [string, WebhookAnswer, string][] = [
    ['404', leaky(404), "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL."],
    ['400', leaky(400), "Teams didn't accept the post (HTTP 400). If the workflow changed, replace its URL."],
    ['429', leaky(429), 'Teams is throttling posts. Try again in a minute.'],
    ['dns', url => Promise.reject(new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url}`, { cause: new Error(`connect ${url}`) })), "Couldn't reach Teams."],
    ['timeout', url => Promise.reject(new DOMException(`The operation was aborted due to timeout: ${url}`, 'TimeoutError')), "Couldn't reach Teams."]
  ]
  const answer: { respond: WebhookAnswer } = { respond: () => new Response(null, { status: 202 }) }
  const posted: string[] = []
  await withFetch(
    withWebhook(ado, {
      respond: (url, init) => {
        posted.push(url)
        return answer.respond(url, init)
      }
    }),
    async () => {
      await withWorker(worker, { host: prsHost() }, async w => {
        const channel = await w.request('share.addChannel', { name: 'Release train', url: WEBHOOK })
        const destination = `channel:${channel.id}`
        const share = { org: 'contoso', kind: 'pr' as const, keys: [`pr:${PROJECT}/${REPO}/4101`], intro: 'Ready for QA.', destinations: [{ kind: 'channel' as const, id: channel.id }] }
        const answers: unknown[] = []
        for (const [name, respond, message] of failures) {
          answer.respond = respond
          const tested = await outcome(w.request('share.testChannel', { id: channel.id }))
          const sent = await outcome(w.request('share.send', share))
          answers.push(tested, sent)
          assert.deepEqual(tested, { destination, ok: false, text: message }, name)
          assert.deepEqual(sent, { results: [{ destination, ok: false, text: message }] }, name)
        }
        assert.equal(posted.length, failures.length * 2, 'every attempt reached the webhook')

        answer.respond = () => new Response(null, { status: 202 })
        answers.push(await outcome(w.request('share.send', share)))
        assert.deepEqual(answers.at(-1), { results: [{ destination, ok: true, text: 'Sent to Release train (accepted).' }] })

        const seen = exposed(w, answers)
        for (const secret of [WEBHOOK, SIG]) assert.ok(!seen.includes(secret), 'the webhook URL leaked')
        assert.deepEqual(w.host.data().storage['share:prefs:contoso'], { destinations: [{ kind: 'channel', id: channel.id }] })
        assert.equal(w.refusals.length, 0)
      })
    }
  )
})

test('a stored webhook URL that is not https is never posted', async () => {
  const ado = fakePrs()
  const insecure = WEBHOOK.replace('https:', 'http:')
  const posted: string[] = []
  const host = mockHost({
    capabilities: CAPABILITIES,
    storage: {
      orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME } }],
      'share:channels': [{ id: 'channel-1', name: 'Release train', service: 'teams', addedAt: 0 }]
    },
    secrets: { 'pat:contoso': PAT, 'teams-webhook:channel-1': insecure }
  })
  const webhook = {
    respond: (url: string) => {
      posted.push(url)
      return new Response(null, { status: 202 })
    }
  }
  await withFetch(withWebhook(ado, webhook), async () => {
    await withWorker(worker, { host }, async w => {
      const refused = { destination: 'channel:channel-1', ok: false, text: "That isn't a valid https webhook URL." }
      const share = { org: 'contoso', kind: 'pr' as const, keys: [`pr:${PROJECT}/${REPO}/4101`], intro: '', destinations: [{ kind: 'channel' as const, id: 'channel-1' }] }
      const answers = [await outcome(w.request('share.testChannel', { id: 'channel-1' })), await outcome(w.request('share.send', share))]
      assert.deepEqual(answers, [refused, { results: [refused] }])
      assert.deepEqual(posted, [], 'nothing was sent to the stored URL')
      const seen = exposed(w, answers)
      for (const secret of [insecure, SIG]) assert.ok(!seen.includes(secret), 'the stored URL leaked')
      assert.equal(w.refusals.length, 0)
    })
  })
})

const FIXTURE_NOW = Date.parse('2026-11-05T10:00:00Z')

function pipelinesAt(now: number): FakePipelines {
  const ado = fakePipelines()
  const shift = (text: string | undefined) => (text === undefined ? undefined : new Date(Date.parse(text) + now - FIXTURE_NOW).toISOString())
  for (const raw of ado.runs.builds.values()) Object.assign(raw, { queueTime: shift(raw.queueTime), startTime: shift(raw.startTime), finishTime: shift(raw.finishTime) })
  for (const raw of ado.runs.approvals.values()) raw.createdOn = shift(raw.createdOn)
  return ado
}

function pipelinesHost() {
  return mockHost({
    capabilities: [...CAPABILITIES, 'notifications:show'],
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME }, boards: BOARDS }] },
    secrets: { 'pat:contoso': PAT },
    results: { 'notifications.show': { delivered: true } }
  })
}

function runsChanged(posts: readonly { event: string; payload?: unknown }[]): RunsSnapshot[] {
  return posts.filter(post => post.event === 'runs.changed').map(post => post.payload as RunsSnapshot)
}

function statusShown(host: ReturnType<typeof mockHost>): string | undefined {
  return (host.callsOf('statusBar.update').at(-1) as { text?: string } | undefined)?.text
}

test('runs.snapshot answers through the handler', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      const snapshot = await w.request('runs.snapshot', { org: 'contoso' })
      assert.deepEqual(snapshot.runs.map(run => run.buildId), [4531, 4520, 4512, 4505, 4498, 4490])
      assert.deepEqual([snapshot.me, snapshot.counts, snapshot.stale], [ME, { failedRuns: 1, approvals: 2 }, false])
      assert.deepEqual(runsChanged(w.posts).at(-1), snapshot)

      const watched = await w.request('runs.watch', { org: 'contoso', projectId: PROJECT, buildId: 4531, watched: true })
      assert.equal(watched.runs.find(run => run.buildId === 4531)?.watched, true)
      assert.deepEqual(w.host.data().storage['pipelines:watched:contoso'], [{ projectId: PROJECT, buildId: 4531 }])
      const refreshed = await w.request('runs.refresh', { org: 'contoso' })
      assert.deepEqual(refreshed.runs.map(run => [run.buildId, run.watched]).slice(0, 2), [[4531, true], [4520, false]])

      await assert.rejects(w.request('runs.snapshot', { org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      await assert.rejects(
        w.request('runs.watch', { org: 'contoso', projectId: PROJECT, buildId: 4512, watched: true }),
        adoErrorWith('bad_request', 400, 'This run has already finished.')
      )
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('the status command reports failed runs and approvals', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    const host = pipelinesHost()
    await withWorker(worker, { host }, async w => {
      assert.ok(await until(() => statusShown(host) === 'ADO · 1 failed · 2 approvals'), 'the background run counted failed runs and approvals')
      assert.equal(withoutMetrics(await w.command('status')), 'contoso — connected as ada@contoso.com\n1 failed pipeline run: contoso 1\n2 approvals waiting: contoso 2')
      assert.deepEqual(runsChanged(w.posts), [], 'a background run posts no snapshot')
      assert.equal(ado.count(isRunningRuns), 0)

      await w.request('orgs.signOut', { org: 'contoso' })
      assert.equal(statusShown(host), 'ADO')
      assert.ok(!String(await w.command('status')).includes('pipeline'))
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('ui.visibility routes pipelines to the pipelines service and the rest as before', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      assert.ok(await until(() => ado.count(isMineRuns) > 0), 'the runs job runs in the background')
      assert.deepEqual(await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true }), { ok: true })
      assert.deepEqual(await w.request('ui.visibility', { surface: 'board', org: 'contoso', visible: false }), { ok: true })
      assert.deepEqual(await w.request('ui.visibility', { surface: 'prs', org: 'contoso', visible: true }), { ok: true })
      assert.equal(await until(() => ado.count(isRunningRuns) > 0, 200), false, 'other surfaces leave the runs job alone')
      assert.ok(await until(() => workChanged(w.posts).length > 0), 'work visibility still reaches the boards service')

      assert.deepEqual(await w.request('ui.visibility', { surface: 'pipelines', org: 'contoso', visible: true }), { ok: true })
      assert.ok(await until(() => runsChanged(w.posts).length > 0), 'showing the Pipelines tab ran a full load')
      assert.deepEqual(runsChanged(w.posts)[0].runs.map(run => run.buildId), [4531, 4520, 4512, 4505, 4498, 4490])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('a rate-limit header on a pull request answer slows the Pipelines tab of that org too', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  ado.on(isReviewList, () => reply(200, { count: 0, value: [] }, { 'X-RateLimit-Delay': '2' }))
  await withMockTimers(async advance => {
    await withFetch(signedIn(ado), async () => {
      await withWorker(worker, { host: pipelinesHost() }, async w => {
        await advance(0)
        assert.ok(ado.count(isReviewList) > 0, 'the pull request load answered under pressure')
        assert.deepEqual(await w.request('ui.visibility', { surface: 'pipelines', org: 'contoso', visible: true }), { ok: true })
        await advance(0)
        assert.ok(runsChanged(w.posts).length > 0, 'showing the Pipelines tab ran a full load')
        const loads = ado.count(isRunningRuns)
        await advance(230_000)
        assert.equal(ado.count(isRunningRuns), loads, 'no 30 s visible load while the org is delayed')
        await advance(20_000)
        assert.ok(ado.count(isRunningRuns) > loads, 'the next one comes at eight times the interval')
        assert.equal(w.refusals.length, 0)
      })
    })
  })
})

test('a failed run after activation shows a desktop notification with no refusals', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    const host = pipelinesHost()
    await withWorker(worker, { host }, async w => {
      assert.ok(await until(() => statusShown(host) === 'ADO · 1 failed · 2 approvals'), 'the first load ran')
      assert.deepEqual(host.callsOf('notifications.show'), [], 'nothing that happened before activation notifies')

      Object.assign(ado.runs.builds.get(4520) ?? assert.fail('no build 4520'), { status: 'completed', result: 'failed', finishTime: new Date().toISOString() })
      await w.request('runs.refresh', { org: 'contoso' })
      assert.deepEqual(host.callsOf('notifications.show'), [{ title: 'web-app-cd failed', body: 'contoso · 20261105.3 on main' }])
      await w.request('runs.refresh', { org: 'contoso' })
      assert.equal(host.callsOf('notifications.show').length, 1, 'each finish notifies once')
      assert.equal(w.refusals.length, 0)
      assert.ok(!w.logs.includes("Couldn't show a desktop notification."))
    })
  })
})

test('runs.decide answers through the handler and refreshes the runs', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      const before = await w.request('runs.snapshot', { org: 'contoso' })
      assert.equal(before.counts.approvals, 2)
      assert.deepEqual(before.runs.find(run => run.buildId === 4531)?.approvals.map(approval => approval.approvalId), [APPROVAL_4531])
      const posted = runsChanged(w.posts).length

      const decision = { org: 'contoso', projectId: PROJECT, approvalId: APPROVAL_4531, decision: 'approved' as const, comment: 'Smoke tests are green.' }
      assert.deepEqual(await w.request('runs.decide', decision), { ok: true, message: 'Approved.' })
      assert.deepEqual(ado.calls.filter(isApprovalPatch).map(call => call.body), [[{ approvalId: APPROVAL_4531, status: 'approved', comment: 'Smoke tests are green.' }]])
      const wroteAt = ado.calls.findIndex(isApprovalPatch)
      assert.ok(await until(() => ado.calls.slice(wroteAt).some(isRunningRuns)), 'a full load read the runs after the write')
      assert.ok(await until(() => runsChanged(w.posts).length > posted), 'and the refreshed runs were posted')
      for (const refreshed of runsChanged(w.posts).slice(posted)) {
        assert.equal(refreshed.counts.approvals, 1)
        assert.ok(refreshed.runs.every(run => run.approvals.every(approval => approval.approvalId !== APPROVAL_4531)))
      }

      await assert.rejects(w.request('runs.decide', { ...decision, org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      await assert.rejects(w.request('runs.decide', { ...decision, comment: 'x'.repeat(1001) }), adoErrorWith('bad_request', 400, 'Keep the comment under 1,000 characters.'))
      assert.equal(ado.calls.filter(isApprovalPatch).length, 1, 'neither refusal reached Azure DevOps')
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('runs.retryStage and runs.cancel answer through the handlers', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      const retry = { org: 'contoso', projectId: PROJECT, buildId: 4512, stageId: '9a2b3c4d-6108-4b3c-8d4e-5f6a7b8c9e08' }
      assert.deepEqual(await w.request('runs.retryStage', retry), { ok: true, message: 'Rerunning Image.' })
      assert.deepEqual(ado.calls.filter(isStagePatch).map(call => [call.path, call.body]), [
        [`/contoso/${PROJECT}/_apis/build/builds/4512/stages/Image`, { state: 'retry', forceRetryAllJobs: false }]
      ])

      const cancel = { org: 'contoso', projectId: PROJECT, buildId: 4531 }
      assert.deepEqual(await w.request('runs.cancel', cancel), { ok: true, message: 'Cancelling the run.' })
      assert.deepEqual(await w.request('runs.cancel', cancel), { ok: false, message: 'The run is already cancelling.' })
      assert.deepEqual(ado.calls.filter(isBuildPatch).map(call => call.body), [{ status: 'cancelling' }])

      await assert.rejects(w.request('runs.retryStage', { ...retry, org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      await assert.rejects(w.request('runs.cancel', { ...cancel, org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('deactivate stops a run view reload that no scheduled poll started', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  const run = { projectId: PROJECT, buildId: 4512 }
  const reads = () => ado.count(call => isOneBuild(call) && buildIdOf(call) === 4512)
  const reload = ado.hang(call => isOneBuild(call) && buildIdOf(call) === 4512 && reads() >= 3)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      await w.request('ui.visibility', { surface: 'run', org: 'contoso', visible: true, run })
      assert.ok(await until(() => viewsChanged(w.posts).length === 1), 'the run view loaded')
      const retry = { org: 'contoso', ...run, stageId: '9a2b3c4d-6108-4b3c-8d4e-5f6a7b8c9e08' }
      assert.deepEqual(await w.request('runs.retryStage', retry), { ok: true, message: 'Rerunning Image.' })
      assert.ok(await until(() => reload.length === 1), 'the action reloads the open view')

      await w.deactivate()
      assert.equal(reload[0].signal?.aborted, true)
      assert.equal(viewsChanged(w.posts).length, 1, 'the tab is told nothing more')
    })
  })
})

function runTabHost(dir: string) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'notifications:show', 'workspace:read', 'workspace:write'],
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME }, boards: BOARDS }] },
    secrets: { 'pat:contoso': PAT },
    results: {
      'notifications.show': { delivered: true },
      'workspace.readContext': () => FOCUSED,
      'workspace.list': () => workspaceAt(dir),
      'editor.open': { opened: true }
    }
  })
}

function viewsChanged(posts: readonly { event: string; payload?: unknown }[]): { org: string; buildId: number }[] {
  return posts.filter(post => post.event === 'runs.viewChanged').map(post => post.payload as { org: string; buildId: number })
}

const RUN_4520 = { projectId: PROJECT, buildId: 4520 }

test('runs.open and runs.view answer through the handlers', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      const host = runTabHost(dir)
      await withWorker(worker, { host }, async w => {
        assert.deepEqual(await w.request('runs.open', { org: 'contoso', projectId: PROJECT, buildId: 4512 }), { opened: true })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: '.orca-ado/contoso.4512.adorun' }])
        const written = JSON.parse(await fs.readFile(path.join(dir, '.orca-ado', 'contoso.4512.adorun'), 'utf8'))
        assert.deepEqual(written, { org: 'contoso', projectId: PROJECT, buildId: 4512 })

        const view = await w.request('runs.view', { org: 'contoso', projectId: PROJECT, buildId: 4512 })
        assert.deepEqual([view.org, view.run.buildId, view.run.state, view.canCancel], ['contoso', 4512, 'failed', false])
        assert.deepEqual(view.failures.map(failure => [failure.path, failure.logId]), [['Image › Build image › Build and push image', 9]])
        const chunk = await w.request('runs.log', { org: 'contoso', projectId: PROJECT, buildId: 4512, logId: 9 })
        assert.deepEqual([chunk.logId, chunk.first, chunk.total], [9, 1, 240])
        assert.match(chunk.lines.at(-1) ?? '', /Finishing: Build and push image$/)

        await assert.rejects(w.request('runs.open', { org: '../x', projectId: PROJECT, buildId: 4512 }), adoErrorWith('bad_request', 400, "That run can't be opened."))
        await assert.rejects(
          w.request('runs.view', { org: 'contoso', projectId: PROJECT, buildId: 9999 }),
          adoErrorWith('not_found', 404, "That run no longer exists, or you can't see it.")
        )
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function openFileHost(entries: ReturnType<typeof workspaceAt>['workspaces']) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'notifications:show', 'workspace:read', 'workspace:write'],
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME }, boards: BOARDS }] },
    secrets: { 'pat:contoso': PAT },
    results: {
      'notifications.show': { delivered: true },
      'workspace.readContext': () => FOCUSED,
      'workspace.list': () => ({ workspaces: entries, truncated: false }),
      'editor.open': { opened: true }
    }
  })
}

async function repositoryAt(dir: string, remoteUrl: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'src', 'Api'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'Api', 'Program.cs'), 'class Program {}\n')
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', remoteUrl]]) {
    const result = spawnSync('git', ['-C', dir, ...args])
    assert.equal(result.status, 0, String(result.stderr))
  }
}

test('runs.openFile answers through the handler', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  const web = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await repositoryAt(web, 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/api')
    await repositoryAt(docs, 'https://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app')
    const entries = [
      { ...workspaceAt(web).workspaces[0] },
      { id: 'ws-docs', kind: 'worktree', name: 'docs', path: docs, branch: 'main', hostId: null }
    ]
    await withFetch(signedIn(ado), async () => {
      const host = openFileHost(entries)
      await withWorker(worker, { host }, async w => {
        const input = { org: 'contoso', projectId: PROJECT, buildId: 4512, path: '/home/vsts/work/1/s/src/Api/Program.cs', line: 42 }
        assert.deepEqual(await w.request('runs.openFile', input), { opened: true, path: 'src/Api/Program.cs', line: 42 })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-docs', path: 'src/Api/Program.cs' }], "the workspace of the run's repository, not the focused one")
        assert.equal(ado.count(isOneBuild), 1, 'a run no snapshot holds is read once')

        await w.request('runs.snapshot', { org: 'contoso' })
        assert.deepEqual(await w.request('runs.openFile', { ...input, buildId: 4520, line: null }), { opened: true, path: 'src/Api/Program.cs', line: null })
        assert.equal(ado.count(isOneBuild), 1, 'a run the snapshot holds is not read again')

        const refused = { opened: false, message: "That isn't a file path Orca can open." }
        assert.deepEqual(await w.request('runs.openFile', { ...input, path: '../../etc/passwd' }), refused)
        assert.deepEqual(await w.request('runs.openFile', { ...input, path: 'C:\\Windows\\win.ini' }), {
          opened: false,
          message: "Couldn't find win.ini in your local workspaces of web-app."
        })
        assert.equal(host.callsOf('editor.open').length, 2, 'nothing else was opened')

        await assert.rejects(w.request('runs.openFile', { ...input, org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
        await assert.rejects(w.request('runs.openFile', { ...input, buildId: 9999 }), adoErrorWith('not_found', 404, "That run no longer exists, or you can't see it."))
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(web, { recursive: true, force: true })
    await fs.rm(docs, { recursive: true, force: true })
  }
})

function checkoutHost(entries: ReturnType<typeof workspaceAt>['workspaces']) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
    storage: { orgs: [{ ...PAT_ORG, pinned: { ...ADA, adoId: ME }, boards: BOARDS }] },
    secrets: { 'pat:contoso': PAT },
    results: {
      'workspace.readContext': () => FOCUSED,
      'workspace.list': () => ({ workspaces: entries, truncated: false }),
      'workspace.open': { opened: true }
    }
  })
}

test('reviews.checkout and work.cancelWorkspace share one arm', async () => {
  const ado = fakeReviews()
  const web = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await repositoryAt(web, 'https://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app')
    await withFetch(signedIn(ado), async () => {
      const host = checkoutHost([{ id: 'ws-web', kind: 'worktree', name: 'web-app', path: web, branch: 'main', hostId: null }])
      await withWorker(worker, { host }, async w => {
        const key = { org: 'contoso', projectId: PROJECT, repoId: REPO, prId: 4110 }
        const source = 'hotfix/1211-login-redirect'
        const create = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2' } as const
        const passes = { kind: 'continue', event: create }
        const reviewing = { kind: 'continue', event: { ...create, branch: source, name: source, base: `origin/${source}` } }
        const before = Date.now()

        const armed = await w.request('reviews.checkout', key)
        assert.equal(armed.status, 'armed')
        assert.ok(armed.status === 'armed' && armed.armedUntil >= before + 600_000 && armed.armedUntil <= Date.now() + 600_000)
        assert.match(armed.message, /^Now create a new workspace in Orca from the web-app project\. /)
        assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws-web' }])
        assert.deepEqual(await w.hooks.fire('workspace.create.before', create), reviewing, "the workspace hooks take checkout's arm")

        await w.request('reviews.checkout', key)
        assert.deepEqual(await w.request('work.cancelWorkspace', {}), { ok: true })
        assert.deepEqual(await w.hooks.fire('workspace.create.before', create), passes, 'the cancel disarmed the pull request')

        const started = await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
        await w.request('reviews.checkout', key)
        assert.deepEqual(await w.hooks.fire('workspace.create.before', create), reviewing, 'checkout replaced the work item')
        assert.deepEqual(await w.hooks.fire('workspace.create.before', create), passes, 'one slot, used once')

        await w.request('reviews.checkout', key)
        await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
        const item = { kind: 'continue', event: { ...create, branch: started.branch, name: started.branch } }
        assert.deepEqual(await w.hooks.fire('workspace.create.before', create), item, 'the work item replaced the checkout')
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(web, { recursive: true, force: true })
  }
})

test('each Cancel disarms only its own arm, and every arm change is posted', async () => {
  const ado = fakeReviews()
  const web = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await repositoryAt(web, 'https://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app')
    await withFetch(signedIn(ado), async () => {
      const host = checkoutHost([{ id: 'ws-web', kind: 'worktree', name: 'web-app', path: web, branch: 'main', hostId: null }])
      await withWorker(worker, { host }, async w => {
        const key = { org: 'contoso', projectId: PROJECT, repoId: REPO, prId: 4110 }
        const source = 'hotfix/1211-login-redirect'
        const create = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2' } as const
        const pr = { org: 'contoso', prId: 4110 }
        const item = { org: 'contoso', itemId: 1204 }

        await w.request('reviews.checkout', key)
        const started = await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
        assert.deepEqual(await w.request('work.cancelWorkspace', pr), { ok: true })
        assert.deepEqual(
          await w.hooks.fire('workspace.create.before', create),
          { kind: 'continue', event: { ...create, branch: started.branch, name: started.branch } },
          "the pull request's Cancel left the later work item armed"
        )

        await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
        await w.request('reviews.checkout', key)
        assert.deepEqual(await w.request('work.cancelWorkspace', item), { ok: true })
        assert.deepEqual(
          await w.hooks.fire('workspace.create.before', create),
          { kind: 'continue', event: { ...create, branch: source, name: source, base: `origin/${source}` } },
          "the work item's Cancel left the later pull request armed"
        )

        assert.deepEqual(
          w.posts.filter(post => post.event === 'workspace.armChanged').map(post => post.payload),
          [pr, item, null, item, pr, null]
        )
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(web, { recursive: true, force: true })
  }
})

test('ui.visibility routes run to the run views', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      assert.deepEqual(await w.request('ui.visibility', { surface: 'run', org: 'contoso', visible: true, run: RUN_4520 }), { ok: true })
      assert.ok(await until(() => viewsChanged(w.posts).length > 0), 'the run view loaded and told its tab')
      assert.deepEqual(viewsChanged(w.posts), [{ org: 'contoso', buildId: 4520 }])
      assert.ok(ado.calls.some(call => isOneBuild(call) && buildIdOf(call) === 4520))
      assert.equal(ado.count(isRunningRuns), 0, 'the Pipelines tab stays in the background')
      assert.deepEqual(await w.request('ui.visibility', { surface: 'run', org: 'contoso', visible: false, run: RUN_4520 }), { ok: true })
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('a run action reloads the open run view at once', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: pipelinesHost() }, async w => {
      await w.request('ui.visibility', { surface: 'run', org: 'contoso', visible: true, run: RUN_4520 })
      assert.ok(await until(() => viewsChanged(w.posts).length === 1), 'the run view loaded')
      assert.equal((await w.request('runs.view', { org: 'contoso', ...RUN_4520 })).canCancel, true)

      assert.deepEqual(await w.request('runs.cancel', { org: 'contoso', ...RUN_4520 }), { ok: true, message: 'Cancelling the run.' })
      assert.ok(await until(() => viewsChanged(w.posts).length === 2), 'the cancel reloaded the view and told its tab')
      const view = await w.request('runs.view', { org: 'contoso', ...RUN_4520 })
      assert.deepEqual([view.run.state, view.canCancel], ['cancelling', false])
      assert.equal(w.refusals.length, 0)
    })
  })
})

async function withFakeClipboard(run: (written: () => Promise<string>) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-clipboard-'))
  const sink = path.join(dir, 'clipboard.html')
  for (const tool of ['xclip', 'wl-copy']) await fs.writeFile(path.join(dir, tool), '#!/bin/sh\ncat > "$FAKE_CLIPBOARD"\n', { mode: 0o755 })
  const names = ['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'FAKE_CLIPBOARD']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    assert.equal(process.platform, 'linux', 'the real clipboard tool would run')
    process.env.PATH = `${dir}${path.delimiter}${saved.PATH ?? ''}`
    process.env.DISPLAY = ':99'
    process.env.XDG_RUNTIME_DIR = dir
    process.env.FAKE_CLIPBOARD = sink
    delete process.env.WAYLAND_DISPLAY
    await run(() => fs.readFile(sink, 'utf8'))
  } finally {
    Object.defineProperty(process, 'platform', platform)
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('share.send with kind approval copies the approval line', async () => {
  const ado = pipelinesAt(Date.now() - 60_000)
  const GRACE = { id: 'u-grace', displayName: 'Grace Hopper', uniqueName: 'grace@contoso.com', kind: 'user' as const }
  const URL_4520 = `${ORG_URL}/${PROJECT}/_build/results?buildId=4520`
  await withFetch(signedIn(ado), async () => {
    await withFakeClipboard(async written => {
      await withWorker(worker, { host: pipelinesHost() }, async w => {
        await w.request('runs.snapshot', { org: 'contoso' })
        assert.deepEqual(await w.request('share.prefs', { org: 'contoso', kind: 'approval' }), {
          template: 'Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}',
          channels: [],
          prefs: { destinations: [{ kind: 'copy' }] },
          tenantId: TENANT
        })

        const key = `approval:${PROJECT}/${APPROVAL_4520}`
        const request = { org: 'contoso', kind: 'approval' as const, keys: [key, `approval:${PROJECT}/gone-approval`], intro: 'Please approve.' }
        const sent = await w.request('share.send', { ...request, destinations: [{ kind: 'copy' }, { kind: 'email', people: [GRACE] }] })
        assert.deepEqual(sent, { results: [{ destination: 'copy', ok: true, text: 'Copied as rich text (HTML only).' }] })
        assert.equal(await written(), `<div>Please approve.</div><div>Approval needed for production: <a href="${URL_4520}">web-app-cd 20261105.3</a> on main</div>`)
        assert.deepEqual(w.host.data().storage['share:prefs:contoso:approval'], { destinations: [{ kind: 'copy' }, { kind: 'email', people: [GRACE] }] })
        assert.equal(ado.calls.filter(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method)).length, 0, 'sharing writes nothing to Azure DevOps')

        await assert.rejects(w.request('share.send', { ...request, keys: [`approval:${PROJECT}/gone-approval`], destinations: [{ kind: 'copy' }] }), error => {
          assert.equal((error as Error).message, 'Choose at least one item to share.')
          return true
        })
        assert.equal(w.refusals.length, 0)
      })
    })
  })
})
