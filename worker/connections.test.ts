import { assert, test } from 'orca/testing'
import type { BoardsTarget, OrgConfig, OrgState, OrgStatus, PinnedAccount } from '../src/shared/types'
import type { ConnectionData } from './ado/core'
import { AdoError, type AdoRequest } from './ado/http'
import type { AzCliProvider } from './auth/azcli'
import { basicAuth, type SecretsPort } from './auth/pat'
import { createConnections, type Connections, type StorePort } from './connections'

const HOME = '/home/ada'
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const PROFILE = `${HOME}/.orca-azure-devops/az/contoso`
const PROJECTS: AdoRequest = { org: 'contoso', path: '/_apis/projects' }

const PAT_ADA = 'pat-ada-7f3c9e2b41'
const PAT_GRACE = 'pat-grace-41d8a0c6'
const TOKEN_ADA = 'az-token-ada-5b1e77'
const TOKEN_GRACE = 'az-token-grace-9c2f'
const TOKEN_ANON = 'az-token-anon-3d7a1'
const TOKEN_UNKNOWN = 'az-token-unknown-e4'
const SECRETS = [PAT_ADA, PAT_GRACE, TOKEN_ADA, TOKEN_GRACE, TOKEN_ANON, TOKEN_UNKNOWN, basicAuth(PAT_ADA).slice(6), basicAuth(PAT_GRACE).slice(6)]

const EXPIRED = 'Your sign-in expired. Reconnect to continue.'
const BAD_PAT = "That token can't be used. Paste it again."

const ADA: PinnedAccount = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: TENANT }
const GRACE: PinnedAccount = { adoId: 'u2', uniqueName: 'grace@contoso.com', displayName: 'Grace Hopper', tenantId: TENANT }
const BOARDS: BoardsTarget = { projectId: 'p1', projectName: 'Web', teamId: 't1', teamName: 'Web Team' }
const CODE_PROJECTS = [{ id: 'p1', name: 'Web' }]

function connectionData(account: { adoId: string; uniqueName: string; displayName: string }): ConnectionData {
  return {
    authenticatedUser: { id: account.adoId, providerDisplayName: account.displayName, properties: { Account: { $value: account.uniqueName } } }
  }
}

const IDENTITIES = new Map<string, { who: string; data: ConnectionData }>([
  [`Bearer ${TOKEN_ADA}`, { who: 'ada', data: connectionData(ADA) }],
  [`Bearer ${TOKEN_GRACE}`, { who: 'grace', data: connectionData(GRACE) }],
  [`Bearer ${TOKEN_ANON}`, { who: 'anonymous', data: connectionData({ adoId: 'anon', uniqueName: 'Anonymous', displayName: 'Anonymous' }) }],
  [basicAuth(PAT_ADA), { who: 'ada', data: connectionData(ADA) }],
  [basicAuth(PAT_GRACE), { who: 'grace', data: connectionData(GRACE) }]
])

const observed: unknown[] = []

function record<T>(value: T): T {
  observed.push(value)
  return value
}

function config(overrides: Partial<OrgConfig> = {}): OrgConfig {
  const org = overrides.org ?? 'contoso'
  return {
    org,
    url: `https://dev.azure.com/${org}`,
    tenantId: TENANT,
    method: 'azure-cli',
    pinned: null,
    boards: null,
    codeProjects: 'all',
    ...overrides
  }
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))
  return { promise, resolve }
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeAdo() {
  const ado = {
    requests: [] as { path: string; who: string }[],
    reject: 0,
    rejectAll: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
      const identity = IDENTITIES.get(request.headers.get('authorization') ?? '')
      ado.requests.push({ path: url.pathname, who: identity?.who ?? 'unknown' })
      if (!identity || ado.rejectAll) return new Response('', { status: 401 })
      if (url.pathname.endsWith('/_apis/connectionData')) return json(identity.data)
      if (ado.reject > 0) {
        ado.reject -= 1
        return new Response('', { status: 401 })
      }
      return json({ value: [] })
    }) as typeof fetch
  }
  return ado
}

interface FakeAz {
  calls: string[]
  tokens: string[]
  loginGate: Deferred | null
  tokenGate: Deferred | null
  loginError: Error | null
  tokenError: Error | null
  loginAborted: boolean
  profiles: Set<string>
  provider: AzCliProvider
}

function fakeAz(clock: { now: number }, profiles: string[]): FakeAz {
  const az: FakeAz = {
    calls: [],
    tokens: [TOKEN_ADA],
    loginGate: null,
    tokenGate: null,
    loginError: null,
    tokenError: null,
    loginAborted: false,
    profiles: new Set(profiles),
    provider: {
      profileDir: (org: string) => `${HOME}/.orca-azure-devops/az/${org}`,
      async hasProfile(org: string) {
        return az.profiles.has(org)
      },
      async login(org: string, tenantId: string | null, signal?: AbortSignal) {
        az.calls.push(`login ${org} ${tenantId}`)
        az.profiles.add(org)
        const gate = az.loginGate
        if (gate) {
          await new Promise<void>((resolve, reject) => {
            gate.promise.then(resolve)
            signal?.addEventListener('abort', () => {
              az.loginAborted = true
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            })
          })
        }
        if (az.loginError) throw az.loginError
      },
      async getToken(org: string) {
        az.calls.push(`getToken ${org}`)
        if (!az.profiles.has(org)) throw new Error('Not signed in.')
        if (az.tokenGate) await az.tokenGate.promise
        if (az.tokenError) throw az.tokenError
        const token = az.tokens.length > 1 ? az.tokens.shift()! : az.tokens[0]
        return { token, expiresAt: clock.now + HOUR }
      },
      async signOut(org: string) {
        az.calls.push(`signOut ${org}`)
        az.profiles.delete(org)
      }
    }
  }
  return az
}

function harness(seed: { orgs?: OrgConfig[]; signingIn?: string[]; secrets?: Record<string, string>; profiles?: string[] } = {}) {
  const clock = { now: T0 }
  const storage = new Map<string, unknown>()
  if (seed.orgs) storage.set('orgs', seed.orgs)
  if (seed.signingIn) storage.set('signing-in', seed.signingIn)
  const store: StorePort = {
    async get<T>(key: string) {
      return storage.has(key) ? (structuredClone(storage.get(key)) as T) : null
    },
    async set(key, value) {
      storage.set(key, structuredClone(record(value)))
    }
  }
  const secretStore = new Map(Object.entries(seed.secrets ?? {}))
  const secretReads: string[] = []
  const secrets: SecretsPort = {
    async get(key) {
      secretReads.push(key)
      return secretStore.get(key) ?? null
    },
    async set(key, value) {
      secretStore.set(key, value)
    },
    async delete(key) {
      secretStore.delete(key)
    }
  }
  const pinnedAzOrgs = (seed.orgs ?? []).filter(cfg => cfg.method === 'azure-cli' && cfg.pinned).map(cfg => cfg.org)
  const az = fakeAz(clock, seed.profiles ?? pinnedAzOrgs)
  const ado = fakeAdo()
  const posts: OrgStatus[][] = []
  const waiters: { org: string; state: OrgState; resolve(): void }[] = []
  let azInstalled = true
  const stateIn = (orgs: OrgStatus[] | undefined, org: string) => orgs?.find(status => status.org === org)?.state

  const start = (): Connections => createConnections({
    store,
    secrets,
    az: async () => (azInstalled ? az.provider : null),
    azProfiles: az.provider,
    fetch: ado.fetch,
    post: orgs => {
      posts.push(record(structuredClone(orgs)))
      for (const waiter of [...waiters]) {
        if (stateIn(orgs, waiter.org) !== waiter.state) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    },
    now: () => clock.now
  })

  const h = {
    connections: start(),
    restart() {
      h.connections = start()
    },
    storage,
    secretStore,
    secretReads,
    az,
    ado,
    posts,
    clock,
    setAzInstalled(installed: boolean) {
      azInstalled = installed
    },
    stored: () => storage.get('orgs') as OrgConfig[] | undefined,
    last: (org = 'contoso') => posts.at(-1)?.find(status => status.org === org),
    async connect(input: Parameters<Connections['connect']>[0]) {
      return record(await h.connections.connect(input))
    },
    until(state: OrgState, org = 'contoso') {
      if (stateIn(posts.at(-1), org) === state) return Promise.resolve()
      return new Promise<void>(resolve => waiters.push({ org, state, resolve }))
    },
    async failure(promise: Promise<unknown>): Promise<AdoError> {
      try {
        await promise
      } catch (error) {
        assert.ok(error instanceof AdoError, 'expected an AdoError')
        return record(error)
      }
      return assert.fail('expected the request to fail')
    }
  }
  return h
}

test('connect via PAT pins the identity', async () => {
  const h = harness()
  const status = await h.connect({ orgInput: 'https://dev.azure.com/contoso', method: 'pat', pat: `  ${PAT_ADA}\n` })
  assert.equal(status.state, 'connected')
  assert.equal(status.account?.uniqueName, 'ada@contoso.com')
  assert.deepEqual(status.tokenStore, { kind: 'orca-secrets' })
  assert.equal(h.stored()?.[0].pinned?.adoId, 'u1')
  assert.equal(h.stored()?.[0].tenantId, TENANT)
  assert.ok(h.secretStore.get('pat:contoso') === PAT_ADA, 'the trimmed PAT is saved under pat:contoso')
  assert.deepEqual(h.posts.map(orgs => orgs[0].state), ['signing-in', 'connected'])
  assert.deepEqual(h.storage.get('signing-in'), [])

  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada', 'ada'])
})

test('connect via azure-cli returns signing-in then posts connected', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  const first = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(first.state, 'signing-in')
  assert.deepEqual(first.tokenStore, { kind: 'az-profile', path: PROFILE })
  assert.equal(h.last()?.state, 'signing-in')
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.equal(h.stored()?.[0].pinned, null)

  h.az.loginGate.resolve()
  await h.until('connected')
  assert.equal(h.last()?.account?.uniqueName, 'ada@contoso.com')
  assert.equal(h.stored()?.[0].pinned?.adoId, 'u1')
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.deepEqual(h.az.calls, [`login contoso ${TENANT}`, 'getToken contoso'])

  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.az.calls, [`login contoso ${TENANT}`, 'getToken contoso'], 'the sign-in token is reused')
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada', 'ada'])
})

test('connect refuses when the az account differs from the pinned account', async () => {
  const h = harness({ orgs: [config({ pinned: ADA, boards: BOARDS })] })
  h.az.tokens = [TOKEN_GRACE]
  const first = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(first.state, 'signing-in')
  await h.until('mismatch')

  const status = record(h.last())
  assert.equal(status?.message, 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.')
  assert.equal(status?.account?.uniqueName, 'ada@contoso.com')
  assert.deepEqual(h.stored()?.[0].pinned, ADA)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.deepEqual(h.az.calls, [`login contoso ${TENANT}`, 'getToken contoso', 'signOut contoso'])
  assert.deepEqual(h.storage.get('signing-in'), [])

  const sent = h.ado.requests.length
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.status, 401)
  assert.equal(error.message, 'This org is signed in as a different account.')
  assert.equal(h.ado.requests.length, sent)
  assert.equal(h.az.calls.length, 3)
})

test('connect refuses a PAT for a different account and keeps the pinned one', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': PAT_ADA } })
  const status = await h.connect({ orgInput: 'contoso', method: 'pat', pat: PAT_GRACE })
  assert.equal(status.state, 'mismatch')
  assert.equal(status.message, 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.')
  assert.deepEqual(h.stored()?.[0].pinned, ADA)
  assert.ok(h.secretStore.get('pat:contoso') === PAT_ADA, 'the other account’s PAT is never saved')

  const sent = h.ado.requests.length
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, 'This org is signed in as a different account.')
  assert.equal(h.ado.requests.length, sent)
})

test('401 triggers one refresh then marks the org expired', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.ado.rejectAll = true
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.message, EXPIRED)
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso'])
  assert.deepEqual(h.ado.requests.map(request => request.path), [
    '/contoso/_apis/projects',
    '/contoso/_apis/projects',
    '/contoso/_apis/connectionData'
  ])
  assert.equal(h.last()?.state, 'expired')
  assert.equal(h.last()?.message, EXPIRED)
  assert.equal((await h.connections.list())[0].state, 'expired')

  const again = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(again.message, EXPIRED)
  assert.equal(h.az.calls.length, 2, 'an expired org does not ask az again')
  assert.equal(h.ado.requests.length, 3, 'an expired org sends nothing')
})

test('a 401 the pinned identity still passes is missing access, not an expiry', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.ado.reject = 2
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'forbidden')
  assert.equal(error.status, 403)
  assert.equal(error.message, "Your account can't access this in Azure DevOps.")
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso'])
  assert.deepEqual(h.ado.requests.map(request => `${request.path} ${request.who}`), [
    '/contoso/_apis/projects ada',
    '/contoso/_apis/projects ada',
    '/contoso/_apis/connectionData ada'
  ])
  assert.equal(h.posts.length, 0)
  assert.equal((await h.connections.list())[0].state, 'connected')

  await h.connections.http.json(PROJECTS)
  assert.equal(h.az.calls.length, 2, 'the refreshed token is kept')
})

test('a PAT missing one scope does not lock the org', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': PAT_ADA } })
  h.ado.reject = 2
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'forbidden')
  assert.equal((await h.connections.list())[0].state, 'connected')
  await h.connections.http.json(PROJECTS)
})

test('a refreshed token for a different account is refused as a mismatch', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokens = [TOKEN_ADA, TOKEN_GRACE]
  h.ado.reject = 2
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.message, 'This org is signed in as a different account.')
  assert.equal(h.last()?.state, 'mismatch')
  assert.equal(h.last()?.message, 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.')
  assert.deepEqual(h.stored()?.[0].pinned, ADA)
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso', 'signOut contoso'])

  const sent = h.ado.requests.length
  await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(h.ado.requests.length, sent)
})

test('a 401 that a refreshed token fixes keeps the org connected', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.ado.reject = 1
  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso'])
  assert.equal(h.posts.length, 0)
  assert.equal((await h.connections.list())[0].state, 'connected')
})

test('a rejected PAT is re-read once before the org expires', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': PAT_ADA } })
  h.ado.rejectAll = true
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, EXPIRED)
  assert.equal(h.secretReads.length, 3, 'read for the request, re-read for the refresh, then read once for the posted status')
  assert.equal(h.last()?.state, 'expired')
})

test('a refresh that fails marks the org expired', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.ado.reject = 1
  await h.connections.http.json({ org: 'contoso', path: '/_apis/teams' }).catch(() => {})
  h.ado.reject = 0
  h.az.tokenError = new Error('Azure CLI could not get an access token')
  h.clock.now += HOUR
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, 'Azure CLI could not get an access token')
  assert.equal(h.last()?.state, 'error')

  h.az.tokenError = null
  await h.connections.http.json(PROJECTS)
  assert.equal(h.last()?.state, 'connected', 'a token error clears once az works again')

  h.ado.reject = 1
  h.az.tokenError = new Error('Azure CLI could not get an access token')
  const expired = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(expired.message, EXPIRED)
  assert.equal(h.last()?.state, 'expired')
})

test('tokens are cached until five minutes before they expire', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.http.json(PROJECTS)
  h.clock.now = T0 + HOUR - 5 * 60_000 - 1
  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.az.calls, ['getToken contoso'])
  h.clock.now += 1
  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso'])
})

test('concurrent requests share one token request', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await Promise.all([h.connections.http.json(PROJECTS), h.connections.http.json(PROJECTS)])
  assert.deepEqual(h.az.calls, ['getToken contoso'])
})

test('activate resets orgs left signing-in', async () => {
  const h = harness({
    orgs: [config(), config({ org: 'fabrikam', method: 'pat', pinned: ADA })],
    signingIn: ['contoso', 'fabrikam'],
    secrets: { 'pat:fabrikam': PAT_ADA }
  })
  await h.connections.resetInterrupted()
  const orgs = record(await h.connections.list())
  for (const status of orgs) {
    assert.equal(status.state, 'disconnected', status.org)
    assert.equal(status.message, 'Sign-in was interrupted. Try again.', status.org)
  }
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.deepEqual(h.az.calls, ['signOut contoso'], 'a half-finished az login is deleted')
  assert.ok(h.secretStore.get('pat:fabrikam') === PAT_ADA, 'a PAT is only ever saved after it was verified')
  assert.deepEqual(h.posts.at(-1)?.map(status => status.state), ['disconnected', 'disconnected'])

  const error = await h.failure(h.connections.http.json({ org: 'fabrikam', path: '/_apis/projects' }))
  assert.equal(error.message, 'Connect this organization first.')
})

test('resetInterrupted leaves a sign-in started by this worker alone', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.connections.resetInterrupted()
  assert.equal((await h.connections.list())[0].state, 'signing-in')
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  h.az.loginGate.resolve()
  await h.until('connected')
})

test('resetInterrupted does nothing when no sign-in was interrupted', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.resetInterrupted()
  assert.equal(h.posts.length, 0)
  assert.deepEqual(h.az.calls, [])
})

test('signOut forgets credentials but keeps settings', async () => {
  const h = harness({
    orgs: [
      config({ pinned: ADA, boards: BOARDS, codeProjects: CODE_PROJECTS }),
      config({ org: 'fabrikam', method: 'pat', pinned: ADA, boards: BOARDS, codeProjects: CODE_PROJECTS })
    ],
    secrets: { 'pat:fabrikam': PAT_ADA }
  })
  await h.connections.http.json(PROJECTS)
  const az = record(await h.connections.signOut('contoso'))
  const pat = record(await h.connections.signOut('fabrikam'))
  for (const status of [az, pat]) {
    assert.equal(status.state, 'disconnected', status.org)
    assert.equal(status.account, null, status.org)
    assert.equal(status.message, undefined, status.org)
    assert.deepEqual(status.boards, BOARDS, status.org)
    assert.deepEqual(status.codeProjects, CODE_PROJECTS, status.org)
  }
  assert.deepEqual(h.az.calls, ['getToken contoso', 'signOut contoso'])
  assert.equal(h.secretStore.has('pat:fabrikam'), false)
  for (const stored of h.stored() ?? []) {
    assert.equal(stored.pinned, null, stored.org)
    assert.deepEqual(stored.boards, BOARDS, stored.org)
    assert.deepEqual(stored.codeProjects, CODE_PROJECTS, stored.org)
  }
  assert.deepEqual(h.posts.at(-1)?.map(status => status.state), ['disconnected', 'disconnected'])

  const sent = h.ado.requests.length
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, 'Connect this organization first.')
  assert.equal(h.ado.requests.length, sent, 'the cached token is dropped')
})

test('signOut waits for an in-flight token request, then deletes the profile', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokenGate = deferred()
  const request = h.failure(h.connections.http.json(PROJECTS))
  await flush()
  assert.deepEqual(h.az.calls, ['getToken contoso'])

  const signingOut = h.connections.signOut('contoso')
  await flush()
  assert.deepEqual(h.az.calls, ['getToken contoso'], 'the profile stays until az is done with it')

  h.az.tokenGate.resolve()
  const status = record(await signingOut)
  assert.deepEqual(h.az.calls, ['getToken contoso', 'signOut contoso'])
  assert.equal(status.state, 'disconnected')
  const error = await request
  assert.equal(error.message, 'Connect this organization first.')
  assert.equal(h.ado.requests.length, 0, 'the token az returned after sign-out is never used')
})

test('signing out during az sign-in cancels it', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  const status = record(await h.connections.signOut('contoso'))
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Sign-in was cancelled.')
  assert.equal(h.az.loginAborted, true)
  assert.deepEqual(h.az.calls, [`login contoso ${TENANT}`, 'signOut contoso'])
  assert.deepEqual(h.storage.get('signing-in'), [])

  h.az.loginGate.resolve()
  await flush()
  assert.equal(h.last()?.state, 'disconnected')
  assert.equal(h.last()?.message, 'Sign-in was cancelled.')
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.stored()?.[0].pinned, null)
})

test('a failed first az connect reports the reason and deletes the profile', async () => {
  const cases: { name: string; arrange(h: ReturnType<typeof harness>): void; message: string }[] = [
    { name: 'login', arrange: h => (h.az.loginError = new Error('Azure CLI sign-in failed: ERROR: AADSTS50020')), message: 'Azure CLI sign-in failed: ERROR: AADSTS50020' },
    { name: 'getToken', arrange: h => (h.az.tokenError = new Error('Azure CLI returned an unreadable token response')), message: 'Azure CLI returned an unreadable token response' },
    { name: 'rejected token', arrange: h => (h.az.tokens = [TOKEN_UNKNOWN]), message: 'Azure DevOps rejected the credentials.' },
    { name: 'anonymous', arrange: h => (h.az.tokens = [TOKEN_ANON]), message: "Azure DevOps didn't accept that sign-in." }
  ]
  for (const { name, arrange, message } of cases) {
    const h = harness()
    arrange(h)
    await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
    await h.until('error')
    assert.equal(h.last()?.message, message, name)
    assert.equal(h.az.calls.at(-1), 'signOut contoso', name)
    assert.equal(h.stored()?.[0].pinned, null, name)
    assert.deepEqual(h.storage.get('signing-in'), [], name)
  }
})

test('connect via azure-cli without az installed explains how to fix it', async () => {
  const h = harness()
  h.setAzInstalled(false)
  const status = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'Azure CLI not found. Install it, or set its path in Settings → Azure DevOps.')
  assert.equal(h.stored(), undefined)
  assert.equal(h.posts.length, 0)
})

test('a missing az at request time is an error that clears once az is back', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.setAzInstalled(false)
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, 'Azure CLI not found. Install it, or set its path in Settings → Azure DevOps.')
  assert.equal(h.last()?.state, 'error')
  assert.equal(h.ado.requests.length, 0)

  h.setAzInstalled(true)
  await h.connections.http.json(PROJECTS)
  assert.equal(h.last()?.state, 'connected')
  assert.equal(h.last()?.message, undefined)
})

test('connect refuses a PAT that is empty or not printable ASCII and saves nothing', async () => {
  const cases: [string | undefined, string][] = [
    [undefined, 'Paste a personal access token.'],
    ['   ', 'Paste a personal access token.'],
    ['tök€n-value', BAD_PAT],
    ['abc\u0007def', BAD_PAT]
  ]
  for (const [pat, message] of cases) {
    const h = harness()
    const status = await h.connect({ orgInput: 'contoso', method: 'pat', pat })
    assert.equal(status.state, 'error')
    assert.equal(status.message, message)
    assert.equal(h.stored(), undefined)
    assert.equal(h.secretStore.size, 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.ado.requests.length, 0)
  }
})

test('a stored PAT that cannot be sent becomes an error', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': 'tök€n-value' } })
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.message, BAD_PAT)
  assert.equal(h.last()?.state, 'error')
  assert.equal(h.last()?.message, BAD_PAT)
  assert.equal(h.ado.requests.length, 0)
})

test('a rejected PAT on first connect is an error and is not saved', async () => {
  const h = harness()
  const status = await h.connect({ orgInput: 'contoso', method: 'pat', pat: 'pat-nobody-knows' })
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'Azure DevOps rejected the credentials.')
  assert.equal(h.stored()?.[0].pinned, null)
  assert.equal(h.secretStore.size, 0)
})

test('connect refuses input that is not an org', async () => {
  const h = harness()
  const status = await h.connect({ orgInput: 'https://github.com/contoso', method: 'pat', pat: PAT_ADA })
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'Enter an organization name or URL, like https://dev.azure.com/your-org.')
  assert.equal(h.stored(), undefined)
  assert.equal(h.posts.length, 0)
  assert.equal(h.ado.requests.length, 0)
})

test('reconnecting an expired org with the pinned account connects it again', async () => {
  const h = harness({ orgs: [config({ pinned: ADA, codeProjects: CODE_PROJECTS })] })
  h.ado.rejectAll = true
  await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(h.last()?.state, 'expired')

  h.ado.rejectAll = false
  await h.connect({ orgInput: 'https://dev.azure.com/contoso/', method: 'azure-cli' })
  await h.until('connected')
  assert.deepEqual(h.stored()?.[0].codeProjects, CODE_PROJECTS)
  await h.connections.http.json(PROJECTS)
})

test('a pinned org without credentials reports signed out and keeps its pin', async () => {
  const h = harness({ orgs: [config({ pinned: ADA }), config({ org: 'fabrikam', method: 'pat', pinned: ADA })], profiles: [] })
  const orgs = record(await h.connections.list())
  for (const status of orgs) {
    assert.equal(status.state, 'disconnected', status.org)
    assert.equal(status.message, 'Signed out.', status.org)
    assert.equal(status.account?.uniqueName, 'ada@contoso.com', status.org)
  }
  for (const org of ['contoso', 'fabrikam']) {
    const error = await h.failure(h.connections.http.json({ org, path: '/_apis/projects' }))
    assert.equal(error.message, 'Connect this organization first.', org)
  }
  assert.deepEqual(h.az.calls, [])
  assert.equal(h.ado.requests.length, 0)

  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
  const refused = await h.connect({ orgInput: 'fabrikam', method: 'pat', pat: PAT_GRACE })
  assert.equal(refused.state, 'mismatch', 'the kept pin still refuses another account')
  const accepted = await h.connect({ orgInput: 'fabrikam', method: 'pat', pat: PAT_ADA })
  assert.equal(accepted.state, 'connected')
})

test('an az org whose profile was deleted reports signed out after a restart', async () => {
  const h = harness({ orgs: [config({ pinned: ADA, boards: BOARDS })] })
  h.az.tokens = [TOKEN_GRACE]
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('mismatch')
  assert.equal(h.az.profiles.has('contoso'), false)

  h.restart()
  const [status] = record(await h.connections.list())
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Signed out.')
  assert.deepEqual(status.account, ADA)
  assert.deepEqual(status.boards, BOARDS)

  h.az.tokens = [TOKEN_ADA]
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
  h.restart()
  assert.equal((await h.connections.list())[0].state, 'connected')
})

test('a PAT org whose secret is gone reports signed out, live and after a restart', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': PAT_ADA } })
  assert.equal((await h.connections.list())[0].state, 'connected')
  h.secretStore.delete('pat:contoso')
  assert.equal((await h.connections.list())[0].message, 'Signed out.')

  h.restart()
  const [status] = record(await h.connections.list())
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Signed out.')
  assert.deepEqual(status.account, ADA)
  await h.connections.update('contoso', { boards: BOARDS })
  assert.equal(h.last()?.state, 'disconnected', 'posts derive it too')
  assert.equal(h.last()?.message, 'Signed out.')
})

test('switching an org to another method forgets the old credential', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })], secrets: { 'pat:contoso': PAT_ADA } })
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
  assert.equal(h.secretStore.has('pat:contoso'), false)
  assert.equal(h.stored()?.[0].method, 'azure-cli')
})

test('remove deletes the org and its credentials', async () => {
  const h = harness({
    orgs: [config({ pinned: ADA }), config({ org: 'fabrikam', method: 'pat', pinned: ADA })],
    secrets: { 'pat:fabrikam': PAT_ADA }
  })
  await h.connections.remove('fabrikam')
  assert.equal(h.secretStore.has('pat:fabrikam'), false)
  assert.deepEqual(h.posts.at(-1)?.map(status => status.org), ['contoso'])
  await h.connections.remove('contoso')
  assert.deepEqual(h.az.calls, ['signOut contoso'])
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.posts.at(-1), [])
})

test('update saves boards and code projects and posts', async () => {
  const h = harness({ orgs: [config({ method: 'pat', pinned: ADA })] })
  const status = record(await h.connections.update('contoso', { boards: BOARDS }))
  assert.deepEqual(status.boards, BOARDS)
  assert.equal(status.codeProjects, 'all')
  const next = record(await h.connections.update('contoso', { codeProjects: CODE_PROJECTS }))
  assert.deepEqual(next.boards, BOARDS)
  assert.deepEqual(h.stored()?.[0].codeProjects, CODE_PROJECTS)
  assert.deepEqual(h.posts.at(-1)?.[0].codeProjects, CODE_PROJECTS)
})

test('signOut and update refuse an unknown org', async () => {
  const h = harness()
  await assert.rejects(h.connections.signOut('contoso'), /not connected/)
  await assert.rejects(h.connections.update('contoso', { boards: BOARDS }), /not connected/)
})

test('no secrets in posts or logs', () => {
  assert.ok(observed.length > 50, 'the tests above recorded what the service posted, stored, returned and threw')
  const text = JSON.stringify(observed, (_key, value) => (value instanceof Error ? { message: value.message } : value))
  SECRETS.forEach((secret, index) => assert.ok(!text.includes(secret), `secret #${index} leaked`))
  assert.ok(!text.includes('Bearer') && !text.includes('Basic '), 'an Authorization header leaked')
})
