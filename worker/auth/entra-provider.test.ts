import { createHash } from 'node:crypto'
import { assert, test } from 'orca/testing'
import { entraAuthorizeUrl, entraTokenUrl } from '../ado/org'
import { ENTRA, INVALID_ORG_NAME } from '../messages'
import { connectError, drain, memorySecrets } from '../test-support'
import { base64Url, ENTRA_REQUEST_TIMEOUT_MS, EntraError, type Timeout } from './entra'
import {
  authorityFor,
  createEntraProvider,
  ENTRA_SIGN_IN_TIMEOUT_MS,
  type EntraSession,
  type EntraSignedIn,
  EntraTimeout,
  entraKey,
  NoEntraSession,
  readEntraSettings
} from './entra-provider'
import { accessToken, CLIENT_ID, entraErrorAnswer, fakeEntra, OID_ADA, TENANT, tokenAnswer } from './fake-entra'
import { type Listen, listenForRedirect, type Redirect } from './loopback'

const ORG = 'contoso'
const ADA = 'ada@contoso.com'
const OTHER_CLIENT_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const OTHER_TENANT = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'
const TENANT_DOMAIN = 'contoso.onmicrosoft.com'
const REDIRECT_URI = 'http://localhost:53682'
const T0 = 1_800_000_000_000
const HOUR = 3_600_000
const ADA_TOKEN = accessToken({ oid: OID_ADA, upn: ADA })
const STORED_ADA = JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-ada-1' })

function bytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, at) => (size * 3 + at * 11) % 256)
}

function s256(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function fakeListen(bindError?: Error) {
  const calls: { state: string; signal: AbortSignal }[] = []
  const pending: { resolve: (redirect: Redirect) => void; reject: (reason: unknown) => void }[] = []
  const listen: Listen = async ({ state, signal }) => {
    calls.push({ state, signal })
    if (bindError) throw bindError
    const result = new Promise<Redirect>((resolve, reject) => {
      pending.push({ resolve, reject })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return { redirectUri: REDIRECT_URI, result }
  }
  return {
    listen,
    calls,
    deliver: (redirect: Redirect) => pending.at(-1)?.resolve(redirect),
    fail: (reason: unknown) => pending.at(-1)?.reject(reason)
  }
}

function fakeTimeouts() {
  const armed: { ms: number; controller: AbortController }[] = []
  const timeout: Timeout = ms => {
    const controller = new AbortController()
    armed.push({ ms, controller })
    return controller.signal
  }
  const fire = (ms: number) => {
    for (const entry of armed) {
      if (entry.ms === ms) entry.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }
  }
  return { timeout, armed, fire }
}

function setup(seed: { settings?: Record<string, unknown>; secrets?: Record<string, string>; listen?: Listen } = {}) {
  const entra = fakeEntra()
  const vault = memorySecrets(seed.secrets)
  const listener = fakeListen()
  const clock = fakeTimeouts()
  const logs: string[] = []
  const sizes: number[] = []
  const state = { settings: seed.settings ?? { entraClientId: CLIENT_ID }, failWrites: false }
  const provider = createEntraProvider({
    secrets: {
      ...vault.secrets,
      async set(key, value) {
        if (state.failWrites) throw new Error('The keychain is locked.')
        await vault.secrets.set(key, value)
      }
    },
    fetch: entra.fetch,
    settings: () => state.settings,
    listen: seed.listen ?? listener.listen,
    random: size => {
      sizes.push(size)
      return bytes(size)
    },
    timeout: clock.timeout,
    now: () => T0,
    log: message => void logs.push(message)
  })
  return { provider, entra, secrets: vault.data, listener, clock, logs, sizes, state }
}

type Harness = ReturnType<typeof setup>

function begin(h: Harness, orgTenant: string | null = TENANT, signal = new AbortController().signal): Promise<EntraSession> {
  return h.provider.begin(ORG, orgTenant, { loginHint: null, signal })
}

async function signedInAs(h: Harness, answer: Response, orgTenant: string | null = TENANT): Promise<EntraSignedIn> {
  const session = await begin(h, orgTenant)
  h.entra.answer('authorization_code', answer)
  h.listener.deliver({ code: 'c-ada-1' })
  return session.tokens
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return assert.fail('expected a rejection')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function portOf(session: EntraSession): number {
  return Number(new URL(new URL(session.url).searchParams.get('redirect_uri') ?? '').port)
}

function endpoint(url: string): string {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

test('readEntraSettings trims both settings, lower-cases the tenant and names the first bad one', () => {
  assert.deepEqual(readEntraSettings({}), { clientId: null, tenant: null, problem: null })
  assert.deepEqual(readEntraSettings({ entraClientId: '  ', entraTenant: '' }), { clientId: null, tenant: null, problem: null })
  assert.deepEqual(readEntraSettings({ entraClientId: 42, entraTenant: true }), { clientId: null, tenant: null, problem: null })
  assert.deepEqual(readEntraSettings({ entraClientId: ` ${CLIENT_ID}\n`, entraTenant: ' Contoso.OnMicrosoft.com ' }), {
    clientId: CLIENT_ID,
    tenant: TENANT_DOMAIN,
    problem: null
  })
  assert.deepEqual(readEntraSettings({ entraClientId: CLIENT_ID, entraTenant: TENANT.toUpperCase() }), { clientId: CLIENT_ID, tenant: TENANT, problem: null })
  const longest = [63, 63, 63, 61].map(size => 'a'.repeat(size)).join('.')
  assert.equal(longest.length, 253)
  assert.deepEqual(readEntraSettings({ entraTenant: longest }), { clientId: null, tenant: longest, problem: null })
  const badTenants = ['foo', 'organizations', 'evil/../x', `${longest}a`, 'contoso.', '.contoso.com', '-contoso.com', 'contoso..com', 'con toso.com', `${'a'.repeat(64)}.com`]
  for (const tenant of badTenants) {
    assert.deepEqual(readEntraSettings({ entraClientId: CLIENT_ID, entraTenant: tenant }), { clientId: CLIENT_ID, tenant: null, problem: ENTRA.badTenant }, tenant)
  }
  for (const clientId of ['not-a-guid', `${CLIENT_ID}0`, `{${CLIENT_ID}}`]) {
    assert.deepEqual(readEntraSettings({ entraClientId: clientId }), { clientId: null, tenant: null, problem: ENTRA.badClientId }, clientId)
  }
  assert.equal(readEntraSettings({ entraClientId: 'not-a-guid', entraTenant: 'foo' }).problem, ENTRA.badClientId)
})

test('begin refuses without a valid app ID or tenant and opens no listener', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{}, ENTRA.noClientId],
    [{ entraClientId: ' ', entraTenant: TENANT_DOMAIN }, ENTRA.noClientId],
    [{ entraClientId: 'not-a-guid' }, ENTRA.badClientId],
    [{ entraClientId: CLIENT_ID, entraTenant: 'foo' }, ENTRA.badTenant]
  ]
  for (const [settings, message] of cases) {
    const h = setup({ settings })
    assert.equal(h.provider.configProblem(), message)
    const error = await failure(begin(h))
    assert.ok(error instanceof EntraError)
    assert.equal(error.kind, 'config')
    assert.equal(error.message, message)
    assert.equal(h.listener.calls.length, 0)
    assert.deepEqual(h.sizes, [])
    assert.deepEqual(h.clock.armed, [])
  }
  assert.equal(setup().provider.configProblem(), null)
})

test("begin listens, builds the sign-in URL for the org's tenant and redeems the code with the verifier", async () => {
  const h = setup()
  const session = await begin(h)
  assert.deepEqual(h.sizes, [32, 16])
  assert.deepEqual(h.clock.armed.map(entry => entry.ms), [ENTRA_SIGN_IN_TIMEOUT_MS])
  const [listened] = h.listener.calls
  assert.equal(listened.state, base64Url(bytes(16)))
  const query = new URL(session.url).searchParams
  assert.equal(endpoint(session.url), entraAuthorizeUrl(TENANT))
  assert.equal(query.get('state'), listened.state)
  assert.equal(query.get('redirect_uri'), REDIRECT_URI)
  assert.equal(query.get('client_id'), CLIENT_ID)
  assert.equal(query.has('login_hint'), false)
  assert.equal(h.entra.calls.length, 0)

  h.entra.answer('authorization_code', tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-1' }))
  h.listener.deliver({ code: 'c-ada-1' })
  const signedIn = await session.tokens
  assert.equal(h.entra.calls.length, 1)
  const [{ url, form }] = h.entra.calls
  assert.equal(url, entraTokenUrl(TENANT))
  assert.equal(form.get('code'), 'c-ada-1')
  assert.equal(form.get('client_id'), CLIENT_ID)
  assert.equal(form.get('redirect_uri'), REDIRECT_URI)
  const verifier = form.get('code_verifier') ?? ''
  assert.equal(verifier, base64Url(bytes(32)))
  assert.equal(s256(verifier), query.get('code_challenge'))
  assert.equal(session.url.includes(verifier), false)
  assert.deepEqual(signedIn, {
    accessToken: ADA_TOKEN,
    refreshToken: 'rt-ada-1',
    expiresAt: T0 + HOUR,
    tenant: TENANT,
    objectId: OID_ADA,
    username: ADA,
    clientId: CLIENT_ID,
    authority: TENANT
  })
  assert.equal(h.secrets.size, 0)
})

test('the authority is the org\'s tenant, then the tenant setting, then organizations', async () => {
  assert.equal(authorityFor(TENANT, TENANT_DOMAIN), TENANT)
  assert.equal(authorityFor(null, TENANT_DOMAIN), TENANT_DOMAIN)
  assert.equal(authorityFor(null, null), 'organizations')

  const cases: [string | null, Record<string, unknown>, string][] = [
    [TENANT, { entraClientId: CLIENT_ID, entraTenant: TENANT_DOMAIN }, TENANT],
    [null, { entraClientId: CLIENT_ID, entraTenant: ' Contoso.onmicrosoft.com' }, TENANT_DOMAIN],
    [null, { entraClientId: CLIENT_ID }, 'organizations']
  ]
  for (const [orgTenant, settings, authority] of cases) {
    const h = setup({ settings })
    const session = await h.provider.begin(ORG, orgTenant, { loginHint: ADA, signal: new AbortController().signal })
    assert.equal(endpoint(session.url), entraAuthorizeUrl(authority))
    assert.equal(new URL(session.url).searchParams.get('login_hint'), ADA)
    h.entra.answer('authorization_code', tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-1' }))
    h.listener.deliver({ code: 'c-ada-1' })
    assert.equal((await session.tokens).authority, authority)
    assert.equal(h.entra.calls[0].url, entraTokenUrl(authority))
  }
})

test('a cancelled or timed-out sign-in closes its port and keeps nothing', async () => {
  const cancelled = setup({ listen: listenForRedirect })
  const caller = new AbortController()
  const reason = new DOMException('Sign-in was cancelled.', 'AbortError')
  const session = await begin(cancelled, TENANT, caller.signal)
  const port = portOf(session)
  assert.equal(await connectError('127.0.0.1', port), null)
  caller.abort(reason)
  assert.equal(await failure(session.tokens), reason)
  await drain()
  assert.equal(await connectError('127.0.0.1', port), 'ECONNREFUSED')
  assert.equal(cancelled.entra.calls.length, 0)
  assert.equal(cancelled.secrets.size, 0)

  const timedOut = setup({ listen: listenForRedirect })
  const late = await begin(timedOut)
  assert.equal(await connectError('127.0.0.1', portOf(late)), null)
  timedOut.clock.fire(ENTRA_SIGN_IN_TIMEOUT_MS)
  assert.ok((await failure(late.tokens)) instanceof EntraTimeout)
  await drain()
  assert.equal(await connectError('127.0.0.1', portOf(late)), 'ECONNREFUSED')
  assert.equal(timedOut.entra.calls.length, 0)
  assert.equal(timedOut.secrets.size, 0)
})

test('a timeout or cancel while the code is redeemed rejects the same way, and a slow token request is unreachable', async () => {
  const timedOut = setup()
  const late = await begin(timedOut)
  timedOut.listener.deliver({ code: 'c-ada-1' })
  await drain()
  assert.equal(timedOut.entra.calls.length, 1)
  timedOut.clock.fire(ENTRA_SIGN_IN_TIMEOUT_MS)
  assert.ok((await failure(late.tokens)) instanceof EntraTimeout)

  const cancelled = setup()
  const caller = new AbortController()
  const reason = new Error('the caller stopped')
  const session = await begin(cancelled, TENANT, caller.signal)
  cancelled.listener.deliver({ code: 'c-ada-1' })
  await drain()
  caller.abort(reason)
  assert.equal(await failure(session.tokens), reason)

  const slow = setup()
  const waiting = await begin(slow)
  slow.listener.deliver({ code: 'c-ada-1' })
  await drain()
  slow.clock.fire(ENTRA_REQUEST_TIMEOUT_MS)
  const error = await failure(waiting.tokens)
  assert.ok(error instanceof EntraError)
  assert.equal(error.message, ENTRA.unreachable)
  for (const h of [timedOut, cancelled, slow]) assert.equal(h.secrets.size, 0)
})

test('aborting right after begin raises no unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', record)
  try {
    const cancelled = setup({ listen: listenForRedirect })
    const caller = new AbortController()
    const session = await begin(cancelled, TENANT, caller.signal)
    caller.abort()
    await drain()

    const timedOut = setup({ listen: listenForRedirect })
    const late = await begin(timedOut)
    timedOut.clock.fire(ENTRA_SIGN_IN_TIMEOUT_MS)
    await drain()

    assert.deepEqual(unhandled.map(messageOf), [])
    assert.equal(await failure(session.tokens), caller.signal.reason)
    assert.ok((await failure(late.tokens)) instanceof EntraTimeout)
  } finally {
    process.off('unhandledRejection', record)
  }
})

test('a redirect that reports an error rejects with its plain message and redeems nothing', async () => {
  const cases: [Redirect, string][] = [
    [{ error: 'access_denied', errorCode: null }, ENTRA.browserCancelled],
    [{ error: 'invalid_request', errorCode: 'AADSTS50011' }, ENTRA.redirect]
  ]
  for (const [redirect, message] of cases) {
    const h = setup()
    const session = await begin(h)
    h.listener.deliver(redirect)
    const error = await failure(session.tokens)
    assert.ok(error instanceof EntraError)
    assert.equal(error.message, message)
    assert.equal(h.entra.calls.length, 0)
    assert.equal(h.secrets.size, 0)
  }
})

test("a listener that can't start or stops with an error says the sign-in couldn't start, and other aborts pass through", async () => {
  const bindError = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1'), { code: 'EADDRINUSE' })
  const unbound = setup({ listen: fakeListen(bindError).listen })
  assert.equal(messageOf(await failure(begin(unbound))), ENTRA.listenFailed)

  const broken = setup()
  const session = await begin(broken)
  broken.listener.fail(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  assert.equal(messageOf(await failure(session.tokens)), ENTRA.listenFailed)

  const closed = setup()
  const closing = await begin(closed)
  const shutdown = new DOMException('This operation was aborted', 'AbortError')
  closed.listener.fail(shutdown)
  assert.equal(await failure(closing.tokens), shutdown)

  const caller = new AbortController()
  const reason = new Error('the caller stopped first')
  caller.abort(reason)
  const early = setup({ listen: listenForRedirect })
  assert.equal(await failure(begin(early, TENANT, caller.signal)), reason)
})

test('a begin that fails after listening closes the port it opened', async () => {
  const opened: string[] = []
  const h = setup({
    listen: async opts => {
      const listener = await listenForRedirect(opts)
      opened.push(listener.redirectUri)
      return listener
    }
  })
  assert.ok((await failure(begin(h, '\uD800'))) instanceof URIError)
  await drain()
  assert.equal(opened.length, 1)
  assert.equal(await connectError('127.0.0.1', Number(new URL(opened[0]).port)), 'ECONNREFUSED')
})

test('save keeps only the refresh token, app ID and tenant under entra:<org>', async () => {
  const h = setup()
  const signedIn = await signedInAs(h, tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-1' }), null)
  assert.equal(signedIn.authority, 'organizations')
  await h.provider.save(ORG, signedIn)
  assert.deepEqual([...h.secrets], [['entra:contoso', STORED_ADA]])
  assert.equal(STORED_ADA.includes(signedIn.accessToken), false)

  const odd = setup()
  const oddSignedIn = await signedInAs(odd, tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-1', tid: 'evil/../x' }), null)
  assert.equal(oddSignedIn.tenant, 'evil/../x')
  await odd.provider.save(ORG, oddSignedIn)
  assert.deepEqual([...odd.secrets], [['entra:contoso', JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: 'organizations', refreshToken: 'rt-ada-1' })]])

  const locked = setup()
  locked.state.failWrites = true
  const error = await failure(locked.provider.save(ORG, signedIn))
  assert.equal(messageOf(error), ENTRA.notSaved)
  assert.equal(locked.secrets.size, 0)
})

test('getToken stores the rotated refresh token and reports invalid_grant as needs sign-in', async () => {
  const h = setup({ settings: { entraClientId: OTHER_CLIENT_ID, entraTenant: OTHER_TENANT }, secrets: { 'entra:contoso': STORED_ADA } })
  h.entra.answer('refresh_token', tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-2' }))
  const tokens = await h.provider.getToken(ORG)
  assert.equal(h.entra.calls.length, 1)
  const [{ url, form }] = h.entra.calls
  assert.equal(url, entraTokenUrl(TENANT))
  assert.equal(form.get('client_id'), CLIENT_ID)
  assert.equal(form.get('refresh_token'), 'rt-ada-1')
  assert.equal(tokens.accessToken, ADA_TOKEN)
  assert.equal(tokens.expiresAt, T0 + HOUR)
  const rotated = JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-ada-2' })
  assert.deepEqual([...h.secrets], [['entra:contoso', rotated]])

  h.entra.answer('refresh_token', entraErrorAnswer({ error: 'invalid_grant', codes: [700082] }))
  const error = await failure(h.provider.getToken(ORG))
  assert.ok(error instanceof EntraError)
  assert.equal(error.kind, 'needs_sign_in')
  assert.equal(h.entra.calls[1].form.get('refresh_token'), 'rt-ada-2')
  assert.deepEqual([...h.secrets], [['entra:contoso', rotated]])
  assert.equal(h.listener.calls.length, 0)
  assert.deepEqual(h.logs, [])
})

test("a rotated token that can't be saved keeps the old one and is still used", async () => {
  const h = setup({ secrets: { 'entra:contoso': STORED_ADA } })
  h.state.failWrites = true
  h.entra.answer('refresh_token', tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-2' }), tokenAnswer({ oid: OID_ADA, upn: ADA }))
  const tokens = await h.provider.getToken(ORG)
  assert.equal(tokens.accessToken, ADA_TOKEN)
  assert.deepEqual(h.logs, [ENTRA.rotateNotSaved])
  assert.deepEqual([...h.secrets], [['entra:contoso', STORED_ADA]])

  const again = await h.provider.getToken(ORG)
  assert.equal(again.accessToken, ADA_TOKEN)
  assert.equal(h.entra.calls[1].form.get('refresh_token'), 'rt-ada-1')
  assert.deepEqual(h.logs, [ENTRA.rotateNotSaved])
})

test('hasSession is false for a missing or unreadable secret and forget deletes it', async () => {
  const unreadable = [
    '',
    'not json',
    'null',
    '[]',
    '"rt-ada-1"',
    JSON.stringify({ v: 2, clientId: CLIENT_ID, authority: TENANT, refreshToken: 'rt-ada-1' }),
    JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT }),
    JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: '', refreshToken: 'rt-ada-1' }),
    JSON.stringify({ v: 1, clientId: 7, authority: TENANT, refreshToken: 'rt-ada-1' })
  ]
  for (const secrets of [{}, ...unreadable.map(stored => ({ 'entra:contoso': stored }))]) {
    const h = setup({ secrets })
    const label = JSON.stringify(secrets)
    assert.equal(await h.provider.hasSession(ORG), false, label)
    assert.ok((await failure(h.provider.getToken(ORG))) instanceof NoEntraSession, label)
    assert.equal(h.entra.calls.length, 0, label)
  }

  const h = setup({ secrets: { 'entra:contoso': STORED_ADA, 'entra:fabrikam': STORED_ADA, 'pat:contoso': 'pat-ada-7f3c9e2b41' } })
  assert.equal(await h.provider.hasSession(ORG), true)
  await h.provider.forget(ORG)
  assert.equal(await h.provider.hasSession(ORG), false)
  assert.deepEqual([...h.secrets.keys()], ['entra:fabrikam', 'pat:contoso'])
})

test("entraKey refuses names that aren't org names", async () => {
  const invalidOrg = (error: unknown) => messageOf(error) === INVALID_ORG_NAME
  assert.equal(entraKey('contoso'), 'entra:contoso')
  assert.equal(entraKey('my-org-2'), 'entra:my-org-2')
  for (const org of ['', 'Contoso', '../evil', 'a/b', 'entra:contoso', '-contoso', 'a'.repeat(51)]) {
    assert.throws(() => entraKey(org), invalidOrg)
  }
  const h = setup({ secrets: { 'entra:contoso': STORED_ADA } })
  await assert.rejects(h.provider.begin('../evil', TENANT, { loginHint: null, signal: new AbortController().signal }), invalidOrg)
  await assert.rejects(h.provider.getToken('../evil'), invalidOrg)
  await assert.rejects(h.provider.hasSession('../evil'), invalidOrg)
  await assert.rejects(h.provider.forget('../evil'), invalidOrg)
  assert.equal(h.listener.calls.length, 0)
  assert.equal(h.entra.calls.length, 0)
  assert.deepEqual([...h.secrets], [['entra:contoso', STORED_ADA]])
})

test("settings changed mid sign-in don't change the app being redeemed", async () => {
  const h = setup({ settings: { entraClientId: CLIENT_ID, entraTenant: TENANT_DOMAIN } })
  const session = await begin(h, null)
  h.state.settings = { entraClientId: OTHER_CLIENT_ID, entraTenant: OTHER_TENANT }
  h.entra.answer('authorization_code', tokenAnswer({ oid: OID_ADA, upn: ADA, refresh: 'rt-ada-1', tid: 'not-a-guid' }))
  h.listener.deliver({ code: 'c-ada-1' })
  const signedIn = await session.tokens
  assert.equal(h.entra.calls[0].url, entraTokenUrl(TENANT_DOMAIN))
  assert.equal(h.entra.calls[0].form.get('client_id'), CLIENT_ID)
  assert.equal(signedIn.clientId, CLIENT_ID)
  assert.equal(signedIn.authority, TENANT_DOMAIN)

  h.state.settings = {}
  await h.provider.save(ORG, signedIn)
  assert.deepEqual([...h.secrets], [['entra:contoso', JSON.stringify({ v: 1, clientId: CLIENT_ID, authority: TENANT_DOMAIN, refreshToken: 'rt-ada-1' })]])
})
