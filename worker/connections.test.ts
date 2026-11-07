import { assert, test } from 'orca/testing'
import type { BoardsTarget, ConnectFailure, ConnectionMethod, OrgConfig, OrgState, OrgStatus, PinnedAccount } from '../src/shared/types'
import type { ConnectionData } from './ado/core'
import { AdoError, type AdoRequest } from './ado/http'
import { entraAuthorizeUrl } from './ado/org'
import type { AzCliProvider } from './auth/azcli'
import { createPkce } from './auth/entra'
import { createEntraProvider, ENTRA_SIGN_IN_TIMEOUT_MS } from './auth/entra-provider'
import { accessToken, CLIENT_ID, entraErrorAnswer, fakeEntra, tokenAnswer } from './auth/fake-entra'
import type { Redirect } from './auth/loopback'
import { basicAuth } from './auth/pat'
import { createConnections, type Connections, type StorePort } from './connections'
import { ENTRA } from './messages'
import { CommandTimeoutError } from './sys/run'
import { drain, fakeListen, fakeTimeouts, memorySecrets } from './test-support'

const HOME = '/home/ada'
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const OTHER_TENANT = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'
const OID_ADA = '6f1c2e2a-0ada-4c3e-9a1b-0d4e8c7b6a51'
const OID_GRACE = '2b7d9f10-9ace-4e21-8d3c-71a0b5e4c9f2'
const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const REDIRECT_URI = 'http://localhost:53682'
const PROFILE = `${HOME}/.orca-azure-devops/az/contoso`
const PROJECTS: AdoRequest = { org: 'contoso', path: '/_apis/projects' }

function jwt(claims: Record<string, string>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.c2ln`
}

const PAT_ADA = 'pat-ada-7f3c9e2b41'
const PAT_GRACE = 'pat-grace-41d8a0c6'
const TOKEN_ADA = 'az-token-ada-5b1e77'
const TOKEN_GRACE = 'az-token-grace-9c2f'
const TOKEN_ANON = 'az-token-anon-3d7a1'
const TOKEN_UNKNOWN = 'az-token-unknown-e4'
const JWT_ADA = jwt({ oid: OID_ADA, tid: TENANT, upn: 'ada@contoso.com' })
const JWT_GRACE = jwt({ oid: OID_GRACE, tid: TENANT, upn: 'grace@contoso.com' })
const JWT_ADA_ELSEWHERE = jwt({ oid: OID_ADA, tid: OTHER_TENANT, upn: 'ada@fabrikam.com' })
const ENTRA_ADA = accessToken({ oid: OID_ADA, upn: 'ada@contoso.com' })
const ENTRA_GRACE = accessToken({ oid: OID_GRACE, upn: 'grace@contoso.com' })
const ENTRA_ADA_RENEWED = jwt({ oid: OID_ADA, tid: TENANT, upn: 'ada@contoso.com', jti: 'renewed' })
const REFRESH_ADA_1 = 'rt-ada-1'
const REFRESH_ADA_2 = 'rt-ada-2'
const CODE_ADA = 'c-ada-1'
const bytes = (size: number) => Uint8Array.from({ length: size }, (_, at) => (size * 3 + at * 11) % 256)
const VERIFIER = createPkce(bytes).verifier
const SECRETS = [
  PAT_ADA, PAT_GRACE, TOKEN_ADA, TOKEN_GRACE, TOKEN_ANON, TOKEN_UNKNOWN, JWT_ADA, JWT_GRACE, JWT_ADA_ELSEWHERE, ENTRA_ADA, ENTRA_GRACE,
  ENTRA_ADA_RENEWED, REFRESH_ADA_1, REFRESH_ADA_2, 'rt-grace-1', CODE_ADA, 'c-grace-1', VERIFIER,
  basicAuth(PAT_ADA).slice(6), basicAuth(PAT_GRACE).slice(6)
]

const EXPIRED = 'Your sign-in expired. Reconnect to continue.'
const WIPE_FAILED = "Couldn't delete this org's saved sign-in. Sign out to try again."
const INTERRUPTED = 'Sign-in was interrupted. Try again.'
const NOT_CONNECTED = 'Connect this organization first.'
const OTHER_ACCOUNT = 'This org is signed in as a different account.'
const BAD_PAT = "That token can't be used. Paste it again."
const TOKEN_FAILED = 'Azure CLI could not get an access token'
const SIGNED_IN_AS_GRACE = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
const CANCELLED = 'Sign-in was cancelled.'
const FINISH_FAILED = 'Finishing a sign-in failed; the organization keeps its last status.'
const TIMED_OUT = 'Sign-in timed out. Try again.'
const STORED_ADA = JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: REFRESH_ADA_1 })
const STORED_FABRIKAM = JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-fabrikam-1' })

const ADA: PinnedAccount = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: TENANT, objectId: null }
const ADA_OID: PinnedAccount = { ...ADA, objectId: OID_ADA }
const ADA_BEFORE_OIDS = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: TENANT } as PinnedAccount
const GRACE: PinnedAccount = { adoId: 'u2', uniqueName: 'grace@contoso.com', displayName: 'Grace Hopper', tenantId: TENANT, objectId: null }
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
  [`Bearer ${JWT_ADA}`, { who: 'ada', data: connectionData(ADA) }],
  [`Bearer ${JWT_GRACE}`, { who: 'grace', data: connectionData(GRACE) }],
  [`Bearer ${JWT_ADA_ELSEWHERE}`, { who: 'ada elsewhere', data: connectionData(ADA) }],
  [`Bearer ${ENTRA_ADA}`, { who: 'ada', data: connectionData(ADA) }],
  [`Bearer ${ENTRA_GRACE}`, { who: 'grace', data: connectionData(GRACE) }],
  [`Bearer ${ENTRA_ADA_RENEWED}`, { who: 'ada renewed', data: connectionData(ADA) }],
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

const MAX_TURNS = 200

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false
  const tracked = promise.finally(() => {
    done = true
  })
  tracked.catch(() => {})
  for (let turn = 0; turn < MAX_TURNS && !done; turn++) await flush()
  if (!done) assert.fail('the call never settled')
  return tracked
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
  loginSawProfile: boolean[]
  signOutError: Error | null
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
    loginSawProfile: [],
    signOutError: null,
    profiles: new Set(profiles),
    provider: {
      profileDir: (org: string) => `${HOME}/.orca-azure-devops/az/${org}`,
      async hasProfile(org: string) {
        return az.profiles.has(org)
      },
      async login(org: string, tenantId: string | null, signal?: AbortSignal) {
        az.calls.push(`login ${org} ${tenantId}`)
        az.loginSawProfile.push(az.profiles.has(org))
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
        if (az.signOutError) throw az.signOutError
        az.profiles.delete(org)
      }
    }
  }
  return az
}

function adaTokens(refresh = REFRESH_ADA_1): Response {
  return tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh })
}

function renewal(access: string, refresh: string): Response {
  return json({ token_type: 'Bearer', expires_in: 3600, access_token: access, refresh_token: refresh })
}

function harness(
  seed: {
    orgs?: OrgConfig[]
    signingIn?: string[]
    secrets?: Record<string, string>
    profiles?: string[]
    settings?: Record<string, unknown>
    bindError?: Error
  } = {}
) {
  const clock = { now: T0 }
  const storage = new Map<string, unknown>()
  if (seed.orgs) storage.set('orgs', seed.orgs)
  if (seed.signingIn) storage.set('signing-in', seed.signingIn)
  let storeError: Error | null = null
  const store: StorePort = {
    async get<T>(key: string) {
      return storage.has(key) ? (structuredClone(storage.get(key)) as T) : null
    },
    async set(key, value) {
      if (storeError) throw storeError
      storage.set(key, structuredClone(record(value)))
    }
  }
  const { data: secretStore, reads: secretReads, secrets } = memorySecrets(seed.secrets)
  const pinnedAzOrgs = (seed.orgs ?? []).filter(cfg => cfg.method === 'azure-cli' && cfg.pinned).map(cfg => cfg.org)
  const az = fakeAz(clock, seed.profiles ?? pinnedAzOrgs)
  const ado = fakeAdo()
  const entra = fakeEntra()
  const listener = fakeListen(REDIRECT_URI, seed.bindError)
  const timeouts = fakeTimeouts()
  const logs: string[] = []
  const log = (message: string) => {
    logs.push(record(message))
  }
  const provider = createEntraProvider({
    secrets,
    fetch: entra.fetch,
    settings: () => seed.settings ?? { entraClientId: CLIENT_ID },
    listen: listener.listen,
    random: bytes,
    timeout: timeouts.timeout,
    now: () => clock.now,
    log
  })
  const posts: OrgStatus[][] = []
  const failures: ConnectFailure[] = []
  let azInstalled = true
  const stateIn = (orgs: OrgStatus[] | undefined, org: string) => orgs?.find(status => status.org === org)?.state

  const start = (): Connections => createConnections({
    store,
    secrets,
    az: async () => (azInstalled ? az.provider : null),
    azProfiles: az.provider,
    entra: provider,
    fetch: ado.fetch,
    post: orgs => {
      posts.push(record(structuredClone(orgs)))
    },
    connectFailed: failure => {
      failures.push(record(structuredClone(failure)))
    },
    now: () => clock.now,
    log
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
    entra,
    listener,
    timeouts,
    posts,
    failures,
    logs,
    clock,
    failStore(error: Error | null) {
      storeError = error
    },
    async logged(): Promise<void> {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (logs.length > 0) return
        await flush()
      }
      assert.fail('nothing was logged')
    },
    refreshGrants: () => entra.calls.filter(call => call.form.get('grant_type') === 'refresh_token'),
    async signInUrl(org = 'contoso'): Promise<string> {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const url = posts.at(-1)?.find(status => status.org === org)?.signInUrl
        if (url) return url
        await flush()
      }
      return assert.fail(`${org} never posted a sign-in page; last posted ${stateIn(posts.at(-1), org)}`)
    },
    async signInWith(answer: Response, redirect: Redirect = { code: CODE_ADA }, org = 'contoso'): Promise<string> {
      await h.connect({ orgInput: org, method: 'entra' })
      const url = await h.signInUrl(org)
      entra.answer('authorization_code', answer)
      listener.deliver(redirect)
      return url
    },
    async unregistered(org = 'contoso') {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (failures.some(failure => failure.org === org)) return
        await flush()
      }
      assert.fail(`${org} never reported a failed connect; last posted ${stateIn(posts.at(-1), org)}`)
    },
    setAzInstalled(installed: boolean) {
      azInstalled = installed
    },
    stored: () => storage.get('orgs') as OrgConfig[] | undefined,
    last: (org = 'contoso') => posts.at(-1)?.find(status => status.org === org),
    async connect(input: Parameters<Connections['connect']>[0]) {
      return record(await h.connections.connect(input))
    },
    async until(state: OrgState, org = 'contoso') {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (stateIn(posts.at(-1), org) === state) return
        await flush()
      }
      assert.fail(`${org} never reached ${state}; last posted ${stateIn(posts.at(-1), org)}`)
    },
    async refusedWithoutCalls(message: string, org = 'contoso') {
      const calls = az.calls.length
      const sent = ado.requests.length
      const error = await h.failure(h.connections.http.json({ org, path: '/_apis/projects' }))
      assert.equal(error.message, message)
      assert.equal(az.calls.length, calls, 'no az call')
      assert.equal(ado.requests.length, sent, 'no ADO request')
    },
    async failure(promise: Promise<unknown>): Promise<AdoError> {
      try {
        await settled(promise)
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
  assert.deepEqual(h.az.calls, ['signOut contoso', `login contoso ${TENANT}`, 'getToken contoso'])

  await h.connections.http.json(PROJECTS)
  assert.equal(h.az.calls.length, 3, 'the sign-in token is reused')
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
  assert.deepEqual(h.az.calls, ['signOut contoso', `login contoso ${TENANT}`, 'getToken contoso', 'signOut contoso'])
  assert.deepEqual(h.storage.get('signing-in'), [])

  const sent = h.ado.requests.length
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.status, 401)
  assert.equal(error.message, 'This org is signed in as a different account.')
  assert.equal(h.ado.requests.length, sent)
  assert.equal(h.az.calls.length, 4)
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

test('an az token for another object id is never sent and the org becomes a mismatch', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID, boards: BOARDS })] })
  h.az.tokens = [JWT_GRACE]
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'unauthorized')
  assert.equal(error.message, OTHER_ACCOUNT)
  assert.equal(h.ado.requests.length, 0, 'the token is never sent')
  assert.equal(h.last()?.state, 'mismatch')
  assert.equal(h.last()?.message, 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.')
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.equal(h.az.profiles.has('contoso'), false, 'the profile that issued it is deleted')
  await h.refusedWithoutCalls(OTHER_ACCOUNT)
})

test('an az token from another tenant is refused like another account', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID })] })
  h.az.tokens = [JWT_ADA_ELSEWHERE]
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, OTHER_ACCOUNT)
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.last()?.state, 'mismatch')
  assert.equal(h.last()?.message, 'Signed in as ada@fabrikam.com, but this org is pinned to ada@contoso.com.')
})

test('an az token whose claims cannot be read is refused for a pin with an object id', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID })] })
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, OTHER_ACCOUNT)
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.last()?.message, 'Signed in as another account, but this org is pinned to ada@contoso.com.')
})

test('a refreshed az token for another object id is never sent and the org becomes a mismatch', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID })] })
  h.az.tokens = [JWT_ADA, JWT_GRACE]
  h.ado.reject = 1
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, OTHER_ACCOUNT)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada'])
  assert.equal(h.last()?.state, 'mismatch')
  assert.deepEqual(h.az.calls, ['getToken contoso', 'getToken contoso', 'signOut contoso'])
})

test('a reconnect refuses an az token for another object id before asking Azure DevOps who it is', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID })] })
  h.az.tokens = [JWT_GRACE]
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('mismatch')
  assert.equal(h.last()?.message, 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.')
  assert.equal(h.ado.requests.length, 0)
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.equal(h.az.profiles.has('contoso'), false)
})

test('an az sign-in pins the token object id, a PAT pins none, and a PAT keeps one already pinned', async () => {
  const az = harness()
  az.az.tokens = [JWT_ADA]
  await az.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await az.until('connected')
  assert.deepEqual(az.stored()?.[0].pinned, ADA_OID)

  const fresh = harness()
  await fresh.connect({ orgInput: 'contoso', method: 'pat', pat: PAT_ADA })
  assert.deepEqual(fresh.stored()?.[0].pinned, ADA)

  const switched = harness({ orgs: [config({ pinned: ADA_OID })] })
  await switched.connect({ orgInput: 'contoso', method: 'pat', pat: PAT_ADA })
  assert.deepEqual(switched.stored()?.[0].pinned, ADA_OID)
})

test('a pin made before object ids adopts one on its next verified reconnect', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_BEFORE_OIDS })] })
  h.az.tokens = [JWT_ADA]
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
})

test('a pin made before object ids adopts one when a 401 probe verifies the pinned identity', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_BEFORE_OIDS })] })
  h.az.tokens = [JWT_ADA]
  h.ado.reject = 2
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.code, 'forbidden')
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.last()?.account, ADA_OID)

  h.az.tokens = [JWT_GRACE]
  h.clock.now += HOUR
  const refused = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(refused.message, OTHER_ACCOUNT, 'the adopted object id is enforced')
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

test('an az token that needs a new sign-in marks the org expired and stops asking az', async () => {
  const reasons = [
    `${TOKEN_FAILED}: ERROR: AADSTS70043: The refresh token has expired due to sign-in frequency checks by conditional access.`,
    `${TOKEN_FAILED}: ERROR: invalid_grant`,
    `${TOKEN_FAILED}: ERROR: interaction_required`,
    'Not signed in.'
  ]
  for (const reason of reasons) {
    const h = harness({ orgs: [config({ pinned: ADA })] })
    await h.connections.http.json(PROJECTS)
    h.az.tokenError = new Error(reason)
    h.clock.now += HOUR
    const error = await h.failure(h.connections.http.json(PROJECTS))
    assert.equal(error.message, EXPIRED, reason)
    assert.equal(h.last()?.state, 'expired', reason)
    assert.equal(h.last()?.message, EXPIRED, reason)
    await h.refusedWithoutCalls(EXPIRED)
  }
})

test('any other az token failure is an error that waits a minute before asking az again', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.http.json(PROJECTS)
  h.az.tokenError = new Error(TOKEN_FAILED)
  h.clock.now += HOUR
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, TOKEN_FAILED)
  assert.equal(h.last()?.state, 'error')
  assert.equal(h.last()?.message, TOKEN_FAILED)

  h.az.tokenError = null
  h.clock.now += 60_000 - 1
  await h.refusedWithoutCalls(TOKEN_FAILED)

  h.clock.now += 1
  await h.connections.http.json(PROJECTS)
  assert.equal(h.last()?.state, 'connected', 'a token error clears once az works again')
  assert.equal(h.last()?.message, undefined)
})

test('a refresh after a 401 that fails marks the org expired', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.http.json(PROJECTS)
  h.ado.reject = 1
  h.az.tokenError = new Error(TOKEN_FAILED)
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
  assert.equal(h.secretStore.has('pat:fabrikam'), false, 'an interrupted sign-in keeps no credential it cannot vouch for')
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
  assert.deepEqual(h.az.calls, ['signOut contoso', `login contoso ${TENANT}`, 'signOut contoso'])
  assert.deepEqual(h.storage.get('signing-in'), [])

  h.az.loginGate.resolve()
  await flush()
  assert.equal(h.last()?.state, 'disconnected')
  assert.equal(h.last()?.message, 'Sign-in was cancelled.')
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.stored()?.[0].pinned, null)
})

test('an az sign-in that times out is signed out with a hint, keeps the pin and deletes the profile', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID, boards: BOARDS })] })
  h.az.loginError = new CommandTimeoutError('az timed out after 300000ms')
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('disconnected')
  assert.equal(h.last()?.message, 'Sign-in timed out. Try again.')
  assert.deepEqual(h.last()?.account, ADA_OID)
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.storage.get('signing-in'), [])
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('cancel stops an az sign-in, keeps the pin and says it was cancelled', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID, boards: BOARDS })] })
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  const status = record(await h.connections.cancel('contoso'))
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Sign-in was cancelled.')
  assert.deepEqual(status.account, ADA_OID)
  assert.equal(h.az.loginAborted, true)
  assert.deepEqual(h.az.calls, ['signOut contoso', `login contoso ${TENANT}`, 'signOut contoso'])
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.equal(h.last()?.message, 'Sign-in was cancelled.')

  h.az.loginGate.resolve()
  await flush()
  assert.equal(h.last()?.state, 'disconnected')
  assert.equal(h.ado.requests.length, 0)
  await h.refusedWithoutCalls(NOT_CONNECTED)

  h.az.tokens = [JWT_ADA]
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
})

test('cancel with no sign-in in flight changes nothing', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  const status = await h.connections.cancel('contoso')
  assert.equal(status.state, 'connected')
  assert.equal(status.message, undefined)
  assert.deepEqual(h.az.calls, [])
  assert.equal(h.posts.length, 0)
})

test('cancel refuses an unknown org', async () => {
  const h = harness()
  await assert.rejects(h.connections.cancel('contoso'), /not connected/)
})

test('a failed first az connect reports the reason, deletes the profile and unregisters the org', async () => {
  const cases: { name: string; arrange(h: ReturnType<typeof harness>): void; message: string }[] = [
    { name: 'login', arrange: h => (h.az.loginError = new Error('Azure CLI sign-in failed: ERROR: AADSTS50020')), message: 'Azure CLI sign-in failed: ERROR: AADSTS50020' },
    { name: 'getToken', arrange: h => (h.az.tokenError = new Error('Azure CLI returned an unreadable token response')), message: 'Azure CLI returned an unreadable token response' },
    { name: 'rejected token', arrange: h => (h.az.tokens = [TOKEN_UNKNOWN]), message: 'Azure DevOps rejected the credentials.' },
    { name: 'anonymous', arrange: h => (h.az.tokens = [TOKEN_ANON]), message: "Azure DevOps didn't accept that sign-in." }
  ]
  for (const { name, arrange, message } of cases) {
    const h = harness({ orgs: [config({ org: 'fabrikam', method: 'pat', pinned: ADA })], secrets: { 'pat:fabrikam': PAT_ADA } })
    arrange(h)
    await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
    await h.unregistered()
    assert.deepEqual(h.failures, [{ org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'azure-cli', message }], name)
    assert.equal(h.az.calls.at(-1), 'signOut contoso', name)
    assert.equal(h.az.profiles.has('contoso'), false, name)
    assert.deepEqual(h.stored()?.map(cfg => cfg.org), ['fabrikam'], name)
    assert.deepEqual(h.posts.at(-1)?.map(status => status.org), ['fabrikam'], name)
    assert.deepEqual(h.storage.get('signing-in'), [], name)
    assert.deepEqual((await h.connections.list()).map(status => status.org), ['fabrikam'], name)
  }
})

test('a failed reconnect keeps the org, whether it is pinned or was signed out with its settings', async () => {
  for (const pinned of [ADA, null]) {
    const h = harness({ orgs: [config({ pinned, boards: BOARDS })] })
    h.az.loginError = new Error('Azure CLI sign-in failed: ERROR: AADSTS50020')
    await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
    await h.until('error')
    assert.equal(h.last()?.message, 'Azure CLI sign-in failed: ERROR: AADSTS50020')
    assert.deepEqual(h.stored()?.[0].pinned, pinned)
    assert.deepEqual(h.stored()?.[0].boards, BOARDS)
    assert.deepEqual(h.failures, [])
  }
})

test('a first az connect that times out stays registered as signed out', async () => {
  const h = harness()
  h.az.loginError = new CommandTimeoutError('az timed out after 300000ms')
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('disconnected')
  assert.equal(h.last()?.message, 'Sign-in timed out. Try again.')
  assert.deepEqual(h.stored()?.map(cfg => cfg.org), ['contoso'])
  assert.deepEqual(h.failures, [])
})

test('a failed first connect whose profile cannot be deleted stays registered and blocked', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  h.az.signOutError = new Error('EPERM: operation not permitted')
  h.az.loginError = new Error('Azure CLI sign-in failed')
  h.az.loginGate.resolve()
  await h.until('error')
  assert.equal(h.last()?.message, WIPE_FAILED)
  assert.deepEqual(h.stored()?.map(cfg => cfg.org), ['contoso'])
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.deepEqual(h.failures, [])
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

test('a rejected PAT on first connect is an error, saves nothing and unregisters the org', async () => {
  const h = harness()
  const status = await h.connect({ orgInput: 'contoso', method: 'pat', pat: 'pat-nobody-knows' })
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'Azure DevOps rejected the credentials.')
  assert.equal(status.org, 'contoso')
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.posts.at(-1), [])
  assert.equal(h.secretStore.size, 0)
  assert.deepEqual(h.failures, [{ org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'pat', message: 'Azure DevOps rejected the credentials.' }])
})

test('connect refuses a sign-in method it does not know without running az', async () => {
  const h = harness()
  const unknown = 'device-code' as ConnectionMethod
  await assert.rejects(h.connections.connect({ orgInput: 'contoso', method: unknown }), /^Error: Unknown sign-in method\.$/)
  assert.deepEqual(h.az.calls, [])
  assert.equal(h.stored(), undefined)
  assert.equal(h.posts.length, 0)
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

test('a remove whose credentials cannot be deleted says they will be retried when the plugin next starts', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.signOutError = new Error('EPERM: operation not permitted')
  await assert.rejects(
    h.connections.remove('contoso'),
    /^Error: Couldn't delete this org's saved sign-in\. It will be retried the next time Orca starts the plugin\.$/
  )
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.posts.at(-1), [])
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])

  h.az.signOutError = null
  h.restart()
  await h.connections.resetInterrupted()
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.storage.get('signing-in'), [])
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

test('an az connect wipes the previous profile before az login runs', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  assert.equal(h.az.profiles.has('contoso'), true)
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('connected')
  assert.deepEqual(h.az.loginSawProfile, [false])
  assert.deepEqual(h.az.calls.slice(0, 2), ['signOut contoso', `login contoso ${TENANT}`])
})

test('requests are refused while a pinned org signs in again', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.http.json(PROJECTS)
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  await h.refusedWithoutCalls(NOT_CONNECTED)
  h.az.loginGate.resolve()
  await h.until('connected')
})

test('a failed reconnect leaves no cached token behind', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  await h.connections.http.json(PROJECTS)
  h.az.loginError = new Error('Azure CLI sign-in failed')
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await h.until('error')
  assert.equal(h.az.profiles.has('contoso'), false)
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('an org left signing-in is refused before resetInterrupted runs', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })], signingIn: ['contoso'] })
  const [status] = await h.connections.list()
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, INTERRUPTED)
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('a mismatch whose profile cannot be deleted stays blocked until the wipe succeeds', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokens = [TOKEN_GRACE]
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  assert.equal(h.az.calls.at(-1), `login contoso ${TENANT}`)
  h.az.signOutError = new Error('EPERM: operation not permitted')
  h.az.loginGate.resolve()
  await h.until('error')
  assert.equal(h.last()?.message, WIPE_FAILED)
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  await h.refusedWithoutCalls(WIPE_FAILED)

  h.restart()
  assert.equal((await h.connections.list())[0].message, INTERRUPTED)
  await h.refusedWithoutCalls(NOT_CONNECTED)
  await h.connections.resetInterrupted()
  assert.equal(h.last()?.message, WIPE_FAILED)
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])

  h.az.signOutError = null
  await h.connections.resetInterrupted()
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.equal(h.last()?.message, INTERRUPTED)
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('a failed reconnect whose profile cannot be deleted never uses that profile', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  h.az.signOutError = new Error('EPERM: operation not permitted')
  h.az.loginError = new Error('Azure CLI sign-in failed')
  h.az.loginGate.resolve()
  await h.until('error')
  assert.equal(h.last()?.message, WIPE_FAILED)
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  await h.refusedWithoutCalls(WIPE_FAILED)

  h.restart()
  assert.equal((await h.connections.list())[0].state, 'disconnected')
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('a probed mismatch whose credential cannot be deleted stays blocked across a restart', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokens = [TOKEN_ADA, TOKEN_GRACE]
  h.ado.reject = 2
  h.az.signOutError = new Error('EPERM: operation not permitted')
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, 'This org is signed in as a different account.')
  assert.equal(h.last()?.state, 'error')
  assert.equal(h.last()?.message, WIPE_FAILED)
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  await h.refusedWithoutCalls(WIPE_FAILED)

  h.restart()
  assert.equal((await h.connections.list())[0].state, 'disconnected')
  await h.refusedWithoutCalls(NOT_CONNECTED)
})

test('a connect that starts while remove waits for az keeps its org', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokenGate = deferred()
  const request = h.failure(h.connections.http.json(PROJECTS))
  await flush()
  const removing = h.connections.remove('contoso')
  await flush()
  const status = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(status.state, 'signing-in')

  h.az.tokenGate.resolve()
  await settled(removing)
  assert.equal((await request).message, NOT_CONNECTED)
  await h.until('connected')
  assert.equal(h.stored()?.[0]?.pinned?.adoId, 'u1')
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.deepEqual(h.az.calls, ['getToken contoso', 'signOut contoso', 'signOut contoso', `login contoso ${TENANT}`, 'getToken contoso'])
})

test('a reconnect that starts while signOut waits for az is not undone by it', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokenGate = deferred()
  const request = h.failure(h.connections.http.json(PROJECTS))
  await flush()
  const signingOut = h.connections.signOut('contoso')
  await flush()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })

  h.az.tokenGate.resolve()
  const signedOut = record(await settled(signingOut))
  assert.equal(signedOut.state, 'signing-in')
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.equal((await request).message, NOT_CONNECTED)
  await h.refusedWithoutCalls(NOT_CONNECTED)

  h.az.loginGate.resolve()
  await h.until('connected')
  assert.deepEqual(h.storage.get('signing-in'), [])
})

test('switching to a PAT during an az sign-in cancels the login instead of waiting for it', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  const status = record(await settled(h.connections.connect({ orgInput: 'contoso', method: 'pat', pat: PAT_ADA })))
  assert.equal(status.state, 'connected')
  assert.equal(h.az.loginAborted, true)
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.storage.get('signing-in'), [])
})

test('remove during an az sign-in cancels it and leaves nothing behind', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  await h.connections.remove('contoso')
  assert.equal(h.az.loginAborted, true)
  h.az.loginGate.resolve()
  await flush()
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.posts.at(-1), [])
  assert.equal(h.ado.requests.length, 0)
})

function entraOrg(overrides: Partial<OrgConfig> = {}): OrgConfig {
  return config({ method: 'entra', pinned: ADA_OID, ...overrides })
}

function hasSignInUrl(status: OrgStatus | undefined): boolean {
  return status !== undefined && 'signInUrl' in status
}

test('connect via Microsoft posts the sign-in page while it waits, then posts connected', async () => {
  const h = harness()
  const first = await h.connect({ orgInput: 'https://dev.azure.com/contoso', method: 'entra' })
  assert.equal(first.state, 'signing-in')
  assert.equal(first.method, 'entra')
  assert.deepEqual(first.tokenStore, { kind: 'orca-secrets' })

  const url = new URL(await h.signInUrl())
  assert.equal(`${url.origin}${url.pathname}`, entraAuthorizeUrl(TENANT))
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('login_hint'), null)
  assert.equal(url.searchParams.get('state'), h.listener.calls[0].state)
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.equal(h.stored()?.[0].pinned, null)

  h.entra.answer('authorization_code', adaTokens())
  h.listener.deliver({ code: CODE_ADA })
  await h.until('connected')

  const contoso = h.posts.map(orgs => orgs.find(status => status.org === 'contoso'))
  assert.deepEqual(contoso.map(status => status?.state), ['signing-in', 'signing-in', 'signing-in', 'connected'])
  assert.deepEqual(contoso.map(hasSignInUrl), [false, true, false, false])
  for (const status of contoso) {
    assert.equal(status?.method, 'entra')
    assert.deepEqual(status?.tokenStore, { kind: 'orca-secrets' })
  }
  assert.equal(h.last()?.account?.uniqueName, 'ada@contoso.com')
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.deepEqual(JSON.parse(h.secretStore.get('entra:contoso') ?? 'null'), { v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: REFRESH_ADA_1 })

  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada', 'ada'])
  assert.equal(h.entra.calls.length, 1, 'the sign-in token is reused')
  assert.equal(h.listener.calls.length, 1)
})

test('an Entra sign-in for another account is refused before anything is saved', async () => {
  const h = harness({ orgs: [entraOrg({ boards: BOARDS })], secrets: { 'entra:contoso': STORED_ADA } })
  await h.signInWith(tokenAnswer({ oid: OID_GRACE, upn: 'grace@contoso.com', refresh: 'rt-grace-1' }), { code: 'c-grace-1' })
  await h.until('mismatch')
  assert.equal(h.last()?.message, SIGNED_IN_AS_GRACE)
  assert.equal(hasSignInUrl(h.last()), false)
  assert.equal(h.ado.requests.length, 0, 'Azure DevOps is never asked who it is')
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.deepEqual(h.storage.get('signing-in'), [])
  await h.refusedWithoutCalls(OTHER_ACCOUNT)
})

test('an Entra id token for another account is named even when the access token cannot be read', async () => {
  const h = harness({ orgs: [entraOrg()] })
  const idToken = jwt({ oid: OID_GRACE, tid: TENANT, preferred_username: 'grace@contoso.com' })
  await h.signInWith(json({ token_type: 'Bearer', expires_in: 3600, access_token: 'opaque', refresh_token: 'rt-grace-1', id_token: idToken }), { code: 'c-grace-1' })
  await h.until('mismatch')
  assert.equal(h.last()?.message, SIGNED_IN_AS_GRACE)
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.secretStore.size, 0)
})

test('a pin without an object id refuses another Entra account once Azure DevOps names it', async () => {
  const h = harness({ orgs: [entraOrg({ pinned: ADA })] })
  await h.signInWith(tokenAnswer({ oid: OID_GRACE, upn: 'grace@contoso.com', refresh: 'rt-grace-1' }), { code: 'c-grace-1' })
  await h.until('mismatch')
  assert.equal(h.last()?.message, SIGNED_IN_AS_GRACE)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['grace'])
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.deepEqual(h.stored()?.[0].pinned, ADA)
})

test('a reconnect asks for the pinned account and still shows the picker', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  const url = new URL(await h.signInWith(adaTokens('rt-ada-2')))
  assert.equal(url.searchParams.get('login_hint'), 'ada@contoso.com')
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  await h.until('connected')
  assert.equal(JSON.parse(h.secretStore.get('entra:contoso') ?? 'null').refreshToken, REFRESH_ADA_2)
})

test('a cancelled or timed-out Entra sign-in leaves no listener and no state', async () => {
  const cancelled = harness()
  await cancelled.connect({ orgInput: 'contoso', method: 'entra' })
  await cancelled.signInUrl()
  const status = record(await cancelled.connections.cancel('contoso'))
  assert.equal(cancelled.listener.calls[0].signal.aborted, true, 'the listener is told to close')
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, CANCELLED)
  assert.equal(hasSignInUrl(status), false)
  assert.equal(hasSignInUrl(cancelled.last()), false)
  assert.equal(cancelled.secretStore.size, 0)
  assert.deepEqual(cancelled.storage.get('signing-in'), [])
  await drain()
  assert.equal(cancelled.last()?.state, 'disconnected')
  assert.equal(cancelled.last()?.message, CANCELLED)
  assert.deepEqual(cancelled.failures, [])
  assert.equal(cancelled.entra.calls.length, 0)

  const timedOut = harness()
  await timedOut.connect({ orgInput: 'contoso', method: 'entra' })
  await timedOut.signInUrl()
  timedOut.timeouts.fire(ENTRA_SIGN_IN_TIMEOUT_MS)
  await timedOut.until('disconnected')
  assert.equal(timedOut.last()?.message, TIMED_OUT)
  assert.equal(hasSignInUrl(timedOut.last()), false)
  assert.equal(timedOut.secretStore.size, 0)
  assert.deepEqual(timedOut.storage.get('signing-in'), [])
  assert.deepEqual(timedOut.stored()?.map(cfg => cfg.org), ['contoso'], 'a first connect stays registered as signed out')
  assert.deepEqual(timedOut.failures, [])
  await timedOut.refusedWithoutCalls(NOT_CONNECTED)
})

test('cancel and signOut of a Microsoft org settle', async () => {
  const seeded = { orgs: [entraOrg({ boards: BOARDS })], secrets: { 'entra:contoso': STORED_ADA } }

  const connected = harness(seeded)
  const unchanged = record(await settled(connected.connections.cancel('contoso')))
  assert.equal(unchanged.state, 'connected')
  const signedOut = record(await settled(connected.connections.signOut('contoso')))
  assert.equal(signedOut.state, 'disconnected')
  assert.equal(connected.secretStore.has('entra:contoso'), false)

  const cancelling = harness(seeded)
  await cancelling.connect({ orgInput: 'contoso', method: 'entra' })
  await cancelling.signInUrl()
  const cancelled = record(await settled(cancelling.connections.cancel('contoso')))
  assert.equal(cancelled.message, CANCELLED)
  assert.equal(cancelling.secretStore.has('entra:contoso'), false)
  assert.deepEqual(cancelling.storage.get('signing-in'), [])

  const signingOut = harness(seeded)
  await signingOut.connect({ orgInput: 'contoso', method: 'entra' })
  await signingOut.signInUrl()
  const out = record(await settled(signingOut.connections.signOut('contoso')))
  assert.equal(out.state, 'disconnected')
  assert.equal(out.message, CANCELLED)
  assert.equal(signingOut.secretStore.has('entra:contoso'), false)
  assert.deepEqual(signingOut.stored()?.[0].boards, BOARDS)
  assert.equal(signingOut.stored()?.[0].pinned, null)
})

test('abandon leaves the signing-in marker and posts nothing', async () => {
  const h = harness()
  await h.connect({ orgInput: 'contoso', method: 'entra' })
  await h.signInUrl()
  const posted = h.posts.length

  h.connections.abandon()
  h.listener.fail(new DOMException('This operation was aborted', 'AbortError'))
  await drain()

  assert.equal(h.posts.length, posted, 'nothing is posted')
  assert.deepEqual(h.failures, [])
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.deepEqual(h.stored()?.map(cfg => cfg.org), ['contoso'])
  assert.equal(hasSignInUrl((await h.connections.list())[0]), false)

  h.restart()
  const [status] = record(await h.connections.list())
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, INTERRUPTED)
})

test('abandon leaves an az sign-in marker for the next start too', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  await flush()
  const posted = h.posts.length

  h.connections.abandon()
  h.az.loginGate.resolve()
  await drain()

  assert.equal(h.posts.length, posted)
  assert.deepEqual(h.failures, [])
  assert.deepEqual(h.storage.get('signing-in'), ['contoso'])
  assert.deepEqual(h.stored()?.map(cfg => cfg.org), ['contoso'])
})

test('connect via Microsoft without an app ID explains where to set it and registers nothing', async () => {
  const h = harness({ settings: {} })
  const status = await h.connect({ orgInput: 'contoso', method: 'entra' })
  assert.equal(status.state, 'error')
  assert.equal(status.message, ENTRA.noClientId)
  assert.equal(status.method, 'entra')
  assert.deepEqual(await h.connections.list(), [])
  assert.equal(h.stored(), undefined)
  assert.equal(h.posts.length, 0)
  assert.equal(h.listener.calls.length, 0)
  assert.equal(h.secretStore.size, 0)
})

test('a first Microsoft connect that Entra refuses explains why and registers nothing', async () => {
  const h = harness()
  await h.signInWith(adaTokens(), { error: 'consent_required', errorCode: null })
  await h.unregistered()
  assert.deepEqual(h.failures, [{ org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'entra', message: ENTRA.consent }])
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.posts.at(-1), [])
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.equal(h.secretStore.size, 0)
  assert.equal(h.entra.calls.length, 0, 'no code is redeemed')
  assert.equal(h.ado.requests.length, 0)
})

test('a Microsoft sign-in that cannot start a listener says so and registers nothing', async () => {
  const h = harness({ bindError: new Error('EADDRINUSE') })
  await h.connect({ orgInput: 'contoso', method: 'entra' })
  await h.unregistered()
  assert.deepEqual(h.failures, [{ org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'entra', message: ENTRA.listenFailed }])
  assert.deepEqual(h.stored(), [])
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.equal(h.secretStore.size, 0)
})

test('an expired access token is renewed silently from the stored refresh token, also after a restart', async () => {
  const h = harness()
  await h.signInWith(adaTokens())
  await h.until('connected')
  await h.connections.http.json(PROJECTS)
  assert.equal(h.refreshGrants().length, 0)

  h.clock.now = T0 + HOUR - 5 * 60_000 - 1
  await h.connections.http.json(PROJECTS)
  assert.equal(h.refreshGrants().length, 0, 'the token is kept until five minutes before it expires')

  h.clock.now += 1
  h.entra.answer('refresh_token', renewal(ENTRA_ADA_RENEWED, REFRESH_ADA_2))
  await h.connections.http.json(PROJECTS)
  assert.equal(h.refreshGrants().length, 1)
  assert.equal(h.refreshGrants()[0].form.get('refresh_token'), REFRESH_ADA_1)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada', 'ada', 'ada', 'ada renewed'])
  assert.equal(h.listener.calls.length, 1, 'no new browser sign-in')
  assert.equal(h.last()?.state, 'connected')
  assert.equal(JSON.parse(h.secretStore.get('entra:contoso') ?? 'null').refreshToken, REFRESH_ADA_2, 'the rotated token is kept')

  h.restart()
  h.clock.now += HOUR
  h.entra.answer('refresh_token', adaTokens('rt-ada-3'))
  await h.connections.http.json(PROJECTS)
  assert.equal(h.refreshGrants().length, 2)
  assert.equal(h.refreshGrants()[1].form.get('refresh_token'), REFRESH_ADA_2)
  assert.equal(h.ado.requests.at(-1)?.who, 'ada')
  assert.equal(h.listener.calls.length, 1, 'a restart never opens a listener')
})

test('concurrent requests share one Entra refresh and invalid_grant expires the org once', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  h.entra.answer('refresh_token', adaTokens(REFRESH_ADA_2))
  await Promise.all([1, 2, 3].map(() => h.connections.http.json(PROJECTS)))
  assert.equal(h.refreshGrants().length, 1)

  h.clock.now += HOUR
  h.entra.answer('refresh_token', entraErrorAnswer({ error: 'invalid_grant', codes: [700082] }))
  const errors = await Promise.all([1, 2, 3].map(() => h.failure(h.connections.http.json(PROJECTS))))
  for (const error of errors) assert.equal(error.message, EXPIRED)
  assert.equal(h.refreshGrants().length, 2)
  assert.equal(h.last()?.state, 'expired')
  assert.equal(h.last()?.message, EXPIRED)
  assert.equal(h.posts.filter(orgs => orgs[0].state === 'expired').length, 1)

  await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(h.refreshGrants().length, 2, 'an expired org does not ask Entra again')
})

test('a refresh refused for consent expires the org once and makes no further token calls', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  h.entra.answer('refresh_token', entraErrorAnswer({ error: 'invalid_grant', codes: [65001] }))
  const error = await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(error.message, EXPIRED)
  assert.equal(h.last()?.state, 'expired')
  assert.equal(h.last()?.message, EXPIRED)
  assert.equal(h.posts.filter(orgs => orgs[0].state === 'expired').length, 1)

  const sent = h.entra.calls.length
  for (let request = 0; request < 2; request++) {
    assert.equal((await h.failure(h.connections.http.json(PROJECTS))).message, EXPIRED)
  }
  assert.equal(h.entra.calls.length, sent, 'no further token calls')
  assert.equal(h.ado.requests.length, 0)
  assert.equal(h.posts.filter(orgs => orgs[0].state === 'expired').length, 1)
})

test('an unreachable or malformed Entra refresh is an error that waits a minute before asking again', async () => {
  const cases: [Error | Response, string][] = [[new Error('network down'), ENTRA.unreachable], [json({ nothing: 'useful' }), ENTRA.malformed]]
  for (const [reply, message] of cases) {
    const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
    h.entra.answer('refresh_token', reply)
    const error = await h.failure(h.connections.http.json(PROJECTS))
    assert.equal(error.message, message)
    assert.equal(h.last()?.state, 'error')
    assert.equal(h.last()?.message, message)

    const sent = h.entra.calls.length
    h.clock.now += 60_000 - 1
    await h.failure(h.connections.http.json(PROJECTS))
    assert.equal(h.entra.calls.length, sent, 'the cool-down holds')

    h.clock.now += 1
    h.entra.answer('refresh_token', adaTokens(REFRESH_ADA_2))
    await h.connections.http.json(PROJECTS)
    assert.equal(h.last()?.state, 'connected', 'Entra answering again clears the error')
  }
})

test('a refreshed Entra token for another object id is refused as a mismatch and its secret deleted', async () => {
  for (const idToken of [true, false]) {
    const h = harness({ orgs: [entraOrg({ boards: BOARDS })], secrets: { 'entra:contoso': STORED_ADA } })
    h.entra.answer('refresh_token', tokenAnswer({ oid: OID_GRACE, upn: 'grace@contoso.com', refresh: 'rt-grace-1', idToken }))
    const error = await h.failure(h.connections.http.json(PROJECTS))
    assert.equal(error.message, OTHER_ACCOUNT, `id token ${idToken}`)
    assert.equal(h.ado.requests.length, 0, 'the token is never sent')
    assert.equal(h.last()?.state, 'mismatch')
    assert.equal(h.last()?.message, SIGNED_IN_AS_GRACE)
    assert.equal(h.secretStore.has('entra:contoso'), false, 'the secret that issued it is deleted')
    assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
    assert.deepEqual(h.stored()?.[0].boards, BOARDS)
    await h.refusedWithoutCalls(OTHER_ACCOUNT)
  }
})

test('a refresh without an id token is checked by the access token alone and stays connected', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  h.entra.answer('refresh_token', tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', idToken: false }))
  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.ado.requests.map(request => request.who), ['ada'])
  assert.equal((await h.connections.list())[0].state, 'connected')
  assert.equal(h.secretStore.has('entra:contoso'), true)
  assert.equal(JSON.parse(h.secretStore.get('entra:contoso') ?? 'null').refreshToken, REFRESH_ADA_1, 'the unrotated token stays')
  assert.equal(h.posts.length, 0)
})

test('signOut deletes only that org\'s Entra secret and keeps its settings', async () => {
  const h = harness({
    orgs: [
      entraOrg({ boards: BOARDS, codeProjects: CODE_PROJECTS }),
      entraOrg({ org: 'fabrikam', boards: BOARDS, codeProjects: CODE_PROJECTS })
    ],
    secrets: { 'entra:contoso': STORED_ADA, 'entra:fabrikam': STORED_FABRIKAM }
  })
  const status = record(await h.connections.signOut('contoso'))
  assert.equal(status.state, 'disconnected')
  assert.equal(status.account, null)
  assert.deepEqual(status.boards, BOARDS)
  assert.deepEqual(status.codeProjects, CODE_PROJECTS)
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.equal(h.secretStore.get('entra:fabrikam'), STORED_FABRIKAM)
  assert.deepEqual(h.stored()?.map(cfg => [cfg.org, cfg.method, cfg.pinned?.adoId ?? null]), [['contoso', 'entra', null], ['fabrikam', 'entra', 'u1']])
  assert.deepEqual(h.stored()?.map(cfg => cfg.boards), [BOARDS, BOARDS])
  assert.deepEqual(h.stored()?.map(cfg => cfg.codeProjects), [CODE_PROJECTS, CODE_PROJECTS])
  assert.deepEqual(h.posts.at(-1)?.map(item => item.state), ['disconnected', 'connected'])
  assert.deepEqual(h.az.calls, [])
})

test('remove deletes a Microsoft org and its secret only', async () => {
  const h = harness({
    orgs: [entraOrg(), entraOrg({ org: 'fabrikam' })],
    secrets: { 'entra:contoso': STORED_ADA, 'entra:fabrikam': STORED_FABRIKAM }
  })
  await h.connections.remove('contoso')
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.equal(h.secretStore.has('entra:fabrikam'), true)
  assert.deepEqual(h.posts.at(-1)?.map(status => status.org), ['fabrikam'])
})

test('an Entra org whose secret is gone reports signed out', async () => {
  const h = harness({ orgs: [entraOrg({ boards: BOARDS })], secrets: { 'entra:contoso': STORED_ADA } })
  assert.equal((await h.connections.list())[0].state, 'connected')
  h.secretStore.delete('entra:contoso')
  const [live] = record(await h.connections.list())
  assert.equal(live.state, 'disconnected')
  assert.equal(live.message, 'Signed out.')
  await h.refusedWithoutCalls(NOT_CONNECTED)
  assert.equal(h.entra.calls.length, 0)

  h.restart()
  const [status] = record(await h.connections.list())
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Signed out.')
  assert.deepEqual(status.account, ADA_OID)
  assert.deepEqual(status.boards, BOARDS)
  assert.deepEqual(status.tokenStore, { kind: 'orca-secrets' })
})

test('an Entra org with an unreadable secret reports signed out', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': '{"v":2}' } })
  const [status] = await h.connections.list()
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, 'Signed out.')
})

test('an Entra renewal reads its secret once', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  h.entra.answer('refresh_token', adaTokens(REFRESH_ADA_2))
  const reads = h.secretReads.length
  await h.connections.http.json(PROJECTS)
  assert.deepEqual(h.secretReads.slice(reads), ['entra:contoso'])
})

test('an Entra secret the keychain refuses to read is an error that waits a minute before asking again', async () => {
  const locked = 'The keychain is locked.'
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  const read = h.secretStore.get.bind(h.secretStore)
  h.secretStore.get = () => {
    throw new Error(locked)
  }
  assert.equal((await h.failure(h.connections.http.json(PROJECTS))).message, locked)
  assert.equal(h.last()?.state, 'error')

  const reads = h.secretReads.length
  h.clock.now += 60_000 - 1
  await h.failure(h.connections.http.json(PROJECTS))
  assert.equal(h.secretReads.length, reads, 'the cool-down holds')

  h.secretStore.get = read
  h.clock.now += 1
  h.entra.answer('refresh_token', adaTokens(REFRESH_ADA_2))
  await h.connections.http.json(PROJECTS)
  assert.equal(h.last()?.state, 'connected')
})

test('switching an org from Azure CLI to Microsoft wipes the profile and keeps the pin', async () => {
  const h = harness({ orgs: [config({ pinned: ADA_OID, boards: BOARDS })] })
  assert.equal(h.az.profiles.has('contoso'), true)
  const url = new URL(await h.signInWith(adaTokens()))
  assert.deepEqual(h.az.calls, ['signOut contoso'])
  assert.equal(h.az.profiles.has('contoso'), false)
  assert.deepEqual(h.last()?.account, ADA_OID, 'the pin survives the switch')
  assert.equal(url.searchParams.get('login_hint'), 'ada@contoso.com')

  await h.until('connected')
  assert.equal(h.stored()?.[0].method, 'entra')
  assert.deepEqual(h.stored()?.[0].pinned, ADA_OID)
  assert.deepEqual(h.stored()?.[0].boards, BOARDS)
  assert.deepEqual(h.az.calls, ['signOut contoso'], 'az is never used again')
})

test('switching an org from Microsoft to a PAT forgets the Entra secret', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  await h.connect({ orgInput: 'contoso', method: 'pat', pat: PAT_ADA })
  assert.equal(h.secretStore.has('entra:contoso'), false)
  assert.equal(h.secretStore.get('pat:contoso'), PAT_ADA)
  assert.equal(h.stored()?.[0].method, 'pat')
})

test('resetInterrupted wipes an Entra sign-in left by a previous worker', async () => {
  const h = harness({
    orgs: [entraOrg()],
    signingIn: ['contoso', 'ghost'],
    secrets: { 'entra:contoso': STORED_ADA, 'entra:ghost': STORED_FABRIKAM, 'entra:fabrikam': STORED_FABRIKAM }
  })
  await h.connections.resetInterrupted()
  const [status] = record(await h.connections.list())
  assert.equal(status.state, 'disconnected')
  assert.equal(status.message, INTERRUPTED)
  assert.equal(h.secretStore.has('entra:contoso'), false, 'the half-finished sign-in keeps nothing')
  assert.equal(h.secretStore.has('entra:ghost'), false, 'an org that no longer exists is wiped for every method')
  assert.equal(h.secretStore.has('entra:fabrikam'), true)
  assert.deepEqual(h.storage.get('signing-in'), [])
  assert.deepEqual(h.az.calls, ['signOut ghost'])
})

test('an Azure CLI sign-in that cannot be finished logs one fixed line and the org keeps its last status', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.tokens = [TOKEN_GRACE]
  h.az.loginGate = deferred()
  const first = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(first.state, 'signing-in')

  h.failStore(new Error(`The disk is full, so ${TOKEN_GRACE} was not saved.`))
  h.az.loginGate.resolve()
  await h.logged()
  await drain()
  assert.deepEqual(h.logs, [FINISH_FAILED])
  assert.equal(h.last()?.state, 'signing-in', 'nothing newer was posted')
})

test('a Microsoft sign-in that cannot be finished logs one fixed line and the org keeps its last status', async () => {
  const h = harness({ orgs: [entraOrg()], secrets: { 'entra:contoso': STORED_ADA } })
  const first = await h.connect({ orgInput: 'contoso', method: 'entra' })
  assert.equal(first.state, 'signing-in')
  await h.signInUrl()

  h.failStore(new Error('The disk is full, so rt-grace-1 was not saved.'))
  h.entra.answer('authorization_code', tokenAnswer({ oid: OID_GRACE, upn: 'grace@contoso.com', refresh: 'rt-grace-1' }))
  h.listener.deliver({ code: 'c-grace-1' })
  await h.logged()
  await drain()
  assert.deepEqual(h.logs, [FINISH_FAILED])
  assert.equal(h.last()?.state, 'signing-in', 'nothing newer was posted')
})

test('an Azure CLI sign-in that succeeds but cannot be saved logs one fixed line and the org keeps its last status', async () => {
  const h = harness({ orgs: [config({ pinned: ADA })] })
  h.az.loginGate = deferred()
  const first = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(first.state, 'signing-in')

  h.failStore(new Error(`The disk is full, so ${TOKEN_ADA} was not saved.`))
  h.az.loginGate.resolve()
  await h.logged()
  await drain()
  assert.deepEqual(h.logs, [FINISH_FAILED])
  assert.equal(h.last()?.state, 'signing-in', 'nothing newer was posted')
})

test('a Microsoft sign-in that succeeds but cannot be saved logs one fixed line and the org keeps its last status', async () => {
  const h = harness({ orgs: [entraOrg()] })
  const first = await h.connect({ orgInput: 'contoso', method: 'entra' })
  assert.equal(first.state, 'signing-in')
  await h.signInUrl()

  h.failStore(new Error(`The disk is full, so ${REFRESH_ADA_1} was not saved.`))
  h.entra.answer('authorization_code', adaTokens())
  h.listener.deliver({ code: CODE_ADA })
  await h.logged()
  await drain()
  assert.deepEqual(h.logs, [FINISH_FAILED])
  assert.equal(h.last()?.state, 'signing-in', 'nothing newer was posted')
})

test('a first connect that fails and cannot be unregistered logs one fixed line', async () => {
  const h = harness()
  h.az.loginGate = deferred()
  h.az.loginError = new Error(`az login failed for ${TOKEN_ADA}`)
  const first = await h.connect({ orgInput: 'contoso', method: 'azure-cli' })
  assert.equal(first.state, 'signing-in')
  h.failStore(new Error(`The disk is full, so ${TOKEN_ADA} was not saved.`))
  h.az.loginGate.resolve()
  await h.logged()
  await drain()
  assert.deepEqual(h.logs, [FINISH_FAILED])
  assert.deepEqual(h.failures, [], 'the failed connect was not reported because it was never unregistered')
})

test('no secrets in posts or logs', () => {
  assert.ok(observed.length > 50, 'the tests above recorded what the service posted, stored, returned and threw')
  const text = JSON.stringify(observed, (_key, value) => (value instanceof Error ? { message: value.message } : value))
  SECRETS.forEach((secret, index) => assert.ok(!text.includes(secret), `secret #${index} leaked`))
  assert.ok(text.includes('/oauth2/v2.0/authorize?'), 'the sign-in pages were recorded')
  assert.ok(!text.includes('Bearer') && !text.includes('Basic '), 'an Authorization header leaked')
})
