import { assert, test } from 'orca/testing'
import { ENTRA, entraFailed } from '../messages'
import {
  authorizeUrl,
  base64Url,
  createPkce,
  ENTRA_REQUEST_TIMEOUT_MS,
  ENTRA_SCOPE,
  EntraError,
  type EntraErrorKind,
  newState,
  redeemCode,
  redirectError,
  refreshTokens,
  type Timeout
} from './entra'
import { accessToken, CLIENT_ID, entraErrorAnswer, fakeEntra, jwt, OID_ADA, TENANT, tokenAnswer } from './fake-entra'

const RFC_7636_BYTES = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
  22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121
]
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const REDIRECT = 'http://localhost:53682'
const T0 = 1_800_000_000_000
const ADA_TOKEN = accessToken({ oid: OID_ADA, upn: 'ada@contoso.com' })
const NOISE = ['ada@contoso.com', 'Trace ID', '5f0c', '<b>x</b>', '<b>', 'Microsoft couldn', 'The request was refused', 'Nothing to see']
const DESCRIPTION_NOISE = "for ada@contoso.com. <b>x</b>\r\nTrace ID: 5f0c4e1a-2b3c-4d5e-8f90-a1b2c3d4e5f6"

const neverFires: Timeout = () => new AbortController().signal

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function timeoutReason(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

function redeem(fetchFn: typeof fetch, timeout: Timeout = neverFires, signal?: AbortSignal) {
  return redeemCode(fetchFn, timeout, { authority: TENANT, clientId: CLIENT_ID, redirectUri: REDIRECT, code: 'c-ada-1', verifier: VERIFIER, now: T0, signal })
}

function refresh(fetchFn: typeof fetch, timeout: Timeout = neverFires) {
  return refreshTokens(fetchFn, timeout, { authority: TENANT, clientId: CLIENT_ID, refreshToken: 'rt-ada-1', now: T0 })
}

async function entraFailure(promise: Promise<unknown>): Promise<EntraError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EntraError) return error
    throw error
  }
  return assert.fail('expected an EntraError')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recording(fetchFn: typeof fetch): { fetch: typeof fetch; inits: RequestInit[] } {
  const inits: RequestInit[] = []
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    inits.push(init ?? {})
    return fetchFn(input, init)
  }
  return { fetch: wrapped as typeof fetch, inits }
}

test('createPkce matches RFC 7636\'s example', () => {
  const sizes: number[] = []
  const pkce = createPkce(size => {
    sizes.push(size)
    return Uint8Array.from(RFC_7636_BYTES)
  })
  assert.deepEqual(pkce, { verifier: VERIFIER, challenge: CHALLENGE })
  assert.deepEqual(sizes, [32])

  const state = newState(size => {
    sizes.push(size)
    return new Uint8Array(size).fill(0xfb)
  })
  assert.match(state, /^[A-Za-z0-9_-]{22}$/)
  assert.deepEqual(sizes, [32, 16])
  assert.equal(base64Url(Uint8Array.from([0xfb, 0xff, 0xbf])), '-_-_')
  assert.equal(base64Url(Uint8Array.from([0xff])), '_w')
})

test('authorizeUrl asks for the account picker, form_post and the ADO scope', () => {
  const params = { authority: TENANT, clientId: CLIENT_ID, redirectUri: REDIRECT, challenge: CHALLENGE, state: 'state-1' }
  const expected = [
    ['client_id', CLIENT_ID],
    ['response_type', 'code'],
    ['redirect_uri', REDIRECT],
    ['response_mode', 'form_post'],
    ['scope', '499b84ac-1321-427f-aa17-267ca6975798/.default openid profile offline_access'],
    ['state', 'state-1'],
    ['code_challenge', CHALLENGE],
    ['code_challenge_method', 'S256'],
    ['prompt', 'select_account']
  ]

  const url = new URL(authorizeUrl({ ...params, loginHint: null }))
  assert.equal(`${url.origin}${url.pathname}`, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`)
  assert.deepEqual([...url.searchParams], expected)
  assert.equal(url.hash, '')

  const hinted = new URL(authorizeUrl({ ...params, loginHint: 'ada@contoso.com' }))
  assert.deepEqual([...hinted.searchParams], [...expected, ['login_hint', 'ada@contoso.com']])

  for (const name of ['code_verifier', 'client_secret', 'nonce']) {
    assert.equal(url.searchParams.has(name), false, name)
    assert.equal(hinted.searchParams.has(name), false, name)
  }
  assert.ok(!hinted.href.includes(VERIFIER))
})

test('redeemCode sends one form post and reads the id token', async () => {
  const entra = fakeEntra()
  entra.answer(
    'authorization_code',
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh: 'rt-ada-1' }),
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh: 'rt-ada-1', expiresIn: '3600' })
  )
  const { fetch: fetchFn, inits } = recording(entra.fetch)
  const deadlines: number[] = []
  const timeoutSignal = new AbortController().signal
  const timeout: Timeout = ms => {
    deadlines.push(ms)
    return timeoutSignal
  }

  const tokens = await redeem(fetchFn, timeout)

  assert.equal(entra.calls.length, 1)
  const [call] = entra.calls
  assert.equal(call.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
  assert.deepEqual([...call.form], [
    ['client_id', CLIENT_ID],
    ['grant_type', 'authorization_code'],
    ['code', 'c-ada-1'],
    ['redirect_uri', REDIRECT],
    ['code_verifier', VERIFIER],
    ['scope', ENTRA_SCOPE]
  ])
  assert.deepEqual([...call.headers], [['accept', 'application/json'], ['content-type', 'application/x-www-form-urlencoded']])
  assert.equal(inits[0].method, 'POST')
  assert.equal(inits[0].redirect, 'manual')
  assert.equal(inits[0].signal, timeoutSignal)
  assert.equal(ENTRA_REQUEST_TIMEOUT_MS, 30_000)
  assert.deepEqual(deadlines, [ENTRA_REQUEST_TIMEOUT_MS])
  assert.deepEqual(tokens, {
    accessToken: ADA_TOKEN,
    refreshToken: 'rt-ada-1',
    expiresAt: T0 + 3_600_000,
    tenant: TENANT,
    objectId: OID_ADA,
    username: 'ada@contoso.com'
  })

  assert.equal((await redeem(fetchFn, timeout)).expiresAt, T0 + 3_600_000)
  assert.equal(entra.calls.length, 2)
})

test('the username falls back to upn when the id token has no preferred_username', async () => {
  const entra = fakeEntra()
  const idToken = jwt({ oid: OID_ADA, tid: TENANT, upn: 'ada@contoso.com' })
  entra.answer('authorization_code', json({ access_token: ADA_TOKEN, refresh_token: 'rt-ada-1', expires_in: 3600, id_token: idToken }))
  assert.equal((await redeem(entra.fetch)).username, 'ada@contoso.com')
})

test('refreshTokens keeps the old refresh token when none comes back', async () => {
  const entra = fakeEntra()
  entra.answer(
    'refresh_token',
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com' }),
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh: 'rt-ada-2', expiresIn: 1800, idToken: false })
  )

  const kept = await refresh(entra.fetch)
  assert.deepEqual(kept, {
    accessToken: ADA_TOKEN,
    refreshToken: 'rt-ada-1',
    expiresAt: T0 + 3_600_000,
    tenant: TENANT,
    objectId: OID_ADA,
    username: 'ada@contoso.com'
  })
  assert.equal(entra.calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
  assert.deepEqual([...entra.calls[0].form], [
    ['client_id', CLIENT_ID],
    ['grant_type', 'refresh_token'],
    ['refresh_token', 'rt-ada-1'],
    ['scope', ENTRA_SCOPE]
  ])
  assert.deepEqual([...entra.calls[0].headers], [['accept', 'application/json'], ['content-type', 'application/x-www-form-urlencoded']])

  const rotated = await refresh(entra.fetch)
  assert.deepEqual(rotated, {
    accessToken: ADA_TOKEN,
    refreshToken: 'rt-ada-2',
    expiresAt: T0 + 1_800_000,
    tenant: null,
    objectId: null,
    username: null
  })
  assert.equal(entra.calls.length, 2)
})

interface ErrorCase {
  error: string
  codes?: number[]
  kind: EntraErrorKind
  message: string
}

const ERROR_CASES: ErrorCase[] = [
  { error: 'invalid_grant', codes: [65001], kind: 'refused', message: ENTRA.consent },
  { error: 'invalid_request', codes: [90094], kind: 'refused', message: ENTRA.consent },
  { error: 'invalid_request', codes: [90095], kind: 'refused', message: ENTRA.consent },
  { error: 'consent_required', kind: 'refused', message: ENTRA.consent },
  { error: 'access_denied', kind: 'refused', message: ENTRA.browserCancelled },
  { error: 'access_denied', codes: [65004], kind: 'refused', message: ENTRA.browserCancelled },
  { error: 'invalid_request', codes: [65004], kind: 'refused', message: ENTRA.browserCancelled },
  { error: 'unauthorized_client', codes: [700016], kind: 'config', message: ENTRA.appNotFound },
  { error: 'invalid_request', codes: [50011], kind: 'config', message: ENTRA.redirect },
  { error: 'invalid_client', codes: [7000218], kind: 'config', message: ENTRA.publicClient },
  { error: 'invalid_request', codes: [9002326], kind: 'config', message: ENTRA.publicClient },
  { error: 'invalid_request', codes: [9002327], kind: 'config', message: ENTRA.publicClient },
  { error: 'invalid_client', codes: [650057], kind: 'config', message: ENTRA.apiPermission },
  { error: 'invalid_request', codes: [50020], kind: 'refused', message: ENTRA.wrongDirectory },
  { error: 'invalid_grant', kind: 'needs_sign_in', message: entraFailed('invalid_grant') },
  { error: 'interaction_required', kind: 'needs_sign_in', message: entraFailed('interaction_required') },
  { error: 'invalid_grant', codes: [50076], kind: 'needs_sign_in', message: entraFailed('AADSTS50076') },
  { error: 'invalid_grant', codes: [50079], kind: 'needs_sign_in', message: entraFailed('AADSTS50079') },
  { error: 'invalid_grant', codes: [50173], kind: 'needs_sign_in', message: entraFailed('AADSTS50173') },
  { error: 'invalid_grant', codes: [70008], kind: 'needs_sign_in', message: entraFailed('AADSTS70008') },
  { error: 'invalid_grant', codes: [700082], kind: 'needs_sign_in', message: entraFailed('AADSTS700082') },
  { error: 'invalid_grant', codes: [700084], kind: 'needs_sign_in', message: entraFailed('AADSTS700084') },
  { error: 'server_error', kind: 'unreachable', message: ENTRA.unreachable },
  { error: 'temporarily_unavailable', kind: 'unreachable', message: ENTRA.unreachable },
  { error: 'temporarily_unavailable', codes: [50196], kind: 'unreachable', message: ENTRA.unreachable },
  { error: 'invalid_request', codes: [50105], kind: 'refused', message: entraFailed('AADSTS50105') },
  { error: 'access_denied', codes: [65001], kind: 'refused', message: ENTRA.consent },
  { error: 'access_denied', codes: [50105], kind: 'refused', message: entraFailed('AADSTS50105') }
]

function expectedCode(c: ErrorCase): string {
  return c.codes ? `AADSTS${c.codes[0]}` : c.error
}

function assertPlain(error: EntraError, c: ErrorCase, route: string): void {
  const label = `${route}: ${c.error} ${c.codes ?? ''}`
  assert.deepEqual({ kind: error.kind, message: error.message, code: error.code }, { kind: c.kind, message: c.message, code: expectedCode(c) }, label)
  for (const noise of NOISE) assert.ok(!error.message.includes(noise), `${label} quoted ${noise}`)
}

test('Entra errors map to plain messages that never quote Microsoft\'s text', async () => {
  for (const c of ERROR_CASES) {
    const prefix = c.codes ? `AADSTS${c.codes[0]}: ` : ''
    const description = `${prefix}The request was refused ${DESCRIPTION_NOISE}`
    const entra = fakeEntra()
    entra.answer(
      'authorization_code',
      entraErrorAnswer({ error: c.error, codes: c.codes, description }),
      entraErrorAnswer({ error: c.error, description })
    )
    entra.answer('refresh_token', entraErrorAnswer({ error: c.error, codes: c.codes, description, status: 401 }))

    assertPlain(await entraFailure(redeem(entra.fetch)), c, 'error_codes')
    assertPlain(await entraFailure(redeem(entra.fetch)), c, 'error_description')
    assertPlain(await entraFailure(refresh(entra.fetch)), c, 'refresh')
    assertPlain(redirectError(c.error, c.codes ? `AADSTS${c.codes[0]}` : null), c, 'redirect')
    assertPlain(redirectError(c.error, c.codes ? description : null), c, 'redirect description')
  }
})

test('the code comes from Entra\'s error only when it looks like an OAuth error code', async () => {
  const hostile = ['<b>x</b>', 'Invalid Grant', 'invalid-grant', 'a'.repeat(41), 'ada@contoso.com', '']
  for (const error of hostile) {
    const fromRedirect = redirectError(error, null)
    assert.deepEqual({ kind: fromRedirect.kind, message: fromRedirect.message, code: fromRedirect.code }, { kind: 'refused', message: 'Microsoft sign-in failed.', code: null }, error)

    const entra = fakeEntra()
    entra.answer('authorization_code', entraErrorAnswer({ error, description: `Nothing to see ${DESCRIPTION_NOISE}` }))
    const fromToken = await entraFailure(redeem(entra.fetch))
    assert.deepEqual({ kind: fromToken.kind, message: fromToken.message, code: fromToken.code }, { kind: 'refused', message: 'Microsoft sign-in failed.', code: null }, error)
  }
  assert.equal(entraFailed(null), 'Microsoft sign-in failed.')
  assert.equal(entraFailed('AADSTS50105'), 'Microsoft sign-in failed (AADSTS50105).')

  const odd = fakeEntra()
  odd.answer(
    'authorization_code',
    json({ error: 'invalid_grant', error_codes: ['65001'], error_description: `AADSTS50076: MFA ${DESCRIPTION_NOISE}` }, 400),
    json({ error: 'invalid_grant', error_codes: [-1, 65001] }, 400),
    json({ error: 'invalid_grant', error_codes: [], error_description: 42 }, 400)
  )
  assert.equal((await entraFailure(redeem(odd.fetch))).code, 'AADSTS50076')
  assert.equal((await entraFailure(redeem(odd.fetch))).code, 'invalid_grant')
  assert.equal((await entraFailure(redeem(odd.fetch))).code, 'invalid_grant')
})

test('an answer without tokens or an id token is malformed, a redirect is malformed, and a failed or timed-out fetch is unreachable', async () => {
  const complete = { access_token: ADA_TOKEN, refresh_token: 'rt-ada-1', expires_in: 3600, id_token: jwt({ oid: OID_ADA, tid: TENANT, preferred_username: 'ada@contoso.com' }) }
  const without = (field: keyof typeof complete) => Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field))
  const malformedRedemptions: Response[] = [
    json(without('access_token')),
    json({ ...complete, access_token: '' }),
    json(without('refresh_token')),
    json(without('expires_in')),
    json({ ...complete, expires_in: 'soon' }),
    json({ ...complete, expires_in: '36.5' }),
    json({ ...complete, expires_in: -5 }),
    json(without('id_token')),
    json({ ...complete, id_token: jwt({ tid: TENANT, preferred_username: 'ada@contoso.com' }) }),
    json({ ...complete, id_token: 'not-a-jwt' }),
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com' }),
    tokenAnswer({ oid: OID_ADA, upn: 'ada@contoso.com', refresh: 'rt-ada-1', idToken: false }),
    json([complete]),
    json({ ...complete }, 400),
    json({ ...complete, expires_in: '9'.repeat(309) }),
    new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }),
    new Response(JSON.stringify(complete), { status: 307, headers: { location: 'https://example.invalid/' } })
  ]
  const entra = fakeEntra()
  entra.answer('authorization_code', ...malformedRedemptions)
  for (const [index] of malformedRedemptions.entries()) {
    const error = await entraFailure(redeem(entra.fetch))
    assert.deepEqual({ kind: error.kind, message: error.message, code: error.code }, { kind: 'malformed', message: ENTRA.malformed, code: null }, `answer #${index}`)
  }
  assert.equal(entra.calls.length, malformedRedemptions.length)

  entra.answer('refresh_token', json({ ...complete, id_token: 'not-a-jwt' }), json(without('access_token')))
  for (let index = 0; index < 2; index++) assert.equal((await entraFailure(refresh(entra.fetch))).kind, 'malformed')

  entra.answer('authorization_code', new TypeError('fetch failed'))
  entra.answer('refresh_token', new TypeError('fetch failed'))
  for (const failed of [await entraFailure(redeem(entra.fetch)), await entraFailure(refresh(entra.fetch))])
    assert.deepEqual({ kind: failed.kind, message: failed.message, code: failed.code }, { kind: 'unreachable', message: ENTRA.unreachable, code: null })

  const deadline = new AbortController()
  const before = entra.calls.length
  const pending = redeem(entra.fetch, () => deadline.signal)
  await flush()
  assert.equal(entra.calls.length, before + 1, 'the request is waiting for an answer')
  deadline.abort(timeoutReason())
  const timedOut = await entraFailure(pending)
  assert.deepEqual({ kind: timedOut.kind, message: timedOut.message, code: timedOut.code }, { kind: 'unreachable', message: ENTRA.unreachable, code: null })

  const refreshDeadline = new AbortController()
  const pendingRefresh = refresh(entra.fetch, () => refreshDeadline.signal)
  await flush()
  refreshDeadline.abort(timeoutReason())
  assert.equal((await entraFailure(pendingRefresh)).kind, 'unreachable')
  assert.equal(entra.calls.length, before + 2)
})

test('an overloaded Microsoft answer is unreachable unless a specific row applies', async () => {
  const unknown = { error: 'invalid_request', error_description: `AADSTS50105: ${DESCRIPTION_NOISE}` }
  const overloaded: [string, Response][] = [
    ['503 with an unknown error', json(unknown, 503)],
    ['429 with an unknown error', json(unknown, 429)],
    ['500 with an unknown error', json(unknown, 500)],
    ['502 with an HTML body', new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['503 with no body', new Response(null, { status: 503 })],
    ['429 with a token-shaped body', json({ access_token: ADA_TOKEN, refresh_token: 'rt-ada-1', expires_in: 3600 }, 429)]
  ]
  const entra = fakeEntra()
  entra.answer('authorization_code', ...overloaded.map(([, reply]) => reply.clone()))
  entra.answer('refresh_token', ...overloaded.map(([, reply]) => reply.clone()))
  for (const [label] of overloaded) {
    for (const failed of [await entraFailure(redeem(entra.fetch)), await entraFailure(refresh(entra.fetch))])
      assert.equal(failed.kind, 'unreachable', label)
  }

  const specific = fakeEntra()
  specific.answer(
    'refresh_token',
    json({ error: 'invalid_grant', error_codes: [70008] }, 503),
    json({ error: 'invalid_request', error_codes: [65001] }, 500),
    json(unknown, 400),
    new Response('<html>Bad request</html>', { status: 400, headers: { 'content-type': 'text/html' } })
  )
  assert.equal((await entraFailure(refresh(specific.fetch))).kind, 'needs_sign_in')
  assert.equal((await entraFailure(refresh(specific.fetch))).message, ENTRA.consent)
  const refused = await entraFailure(refresh(specific.fetch))
  assert.deepEqual({ kind: refused.kind, message: refused.message, code: refused.code }, { kind: 'refused', message: entraFailed('AADSTS50105'), code: 'AADSTS50105' })
  assert.equal((await entraFailure(refresh(specific.fetch))).kind, 'malformed')
})

test('a token request follows the caller\'s signal as well as its own timeout, and a caller abort is not reported', async () => {
  const entra = fakeEntra()
  const { fetch: fetchFn, inits } = recording(entra.fetch)
  const deadline = new AbortController()
  const caller = new AbortController()

  const pending = redeem(fetchFn, () => deadline.signal, caller.signal)
  await flush()
  const signal = inits[0].signal
  assert.ok(signal && signal !== deadline.signal && signal !== caller.signal)
  assert.equal(signal.aborted, false)
  const reason = new DOMException('Cancelled', 'AbortError')
  caller.abort(reason)
  assert.equal(signal.aborted, true)
  await assert.rejects(pending, error => error === reason)

  const second = recording(entra.fetch)
  const secondDeadline = new AbortController()
  const quiet = new AbortController()
  const timedOut = redeem(second.fetch, () => secondDeadline.signal, quiet.signal)
  await flush()
  secondDeadline.abort(timeoutReason())
  assert.equal(second.inits[0].signal?.aborted, true)
  assert.equal((await entraFailure(timedOut)).kind, 'unreachable')

  const early = new AbortController()
  early.abort(reason)
  await assert.rejects(redeem(entra.fetch, neverFires, early.signal), error => error === reason)
})
