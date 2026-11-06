import { createHash } from 'node:crypto'
import { ADO_RESOURCE, entraAuthorizeUrl, entraTokenUrl } from '../ado/org'
import { ENTRA, entraFailed } from '../messages'
import { decodeTokenClaims, type TokenClaims } from './identity'

export const ENTRA_SCOPE = `${ADO_RESOURCE}/.default openid profile offline_access`
export const ENTRA_REQUEST_TIMEOUT_MS = 30_000

export type EntraErrorKind = 'config' | 'refused' | 'needs_sign_in' | 'unreachable' | 'malformed'

export class EntraError extends Error {
  readonly kind: EntraErrorKind
  readonly code: string | null

  constructor(kind: EntraErrorKind, message: string, code: string | null = null) {
    super(message)
    this.name = 'EntraError'
    this.kind = kind
    this.code = code
  }
}

export interface EntraTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tenant: string | null
  objectId: string | null
  username: string | null
}

export type Random = (size: number) => Uint8Array
export type Timeout = (ms: number) => AbortSignal

type Body = Record<string, unknown>
type Match = (error: string, aadsts: string | null) => boolean

const VERIFIER_BYTES = 32
const STATE_BYTES = 16
const AADSTS = /AADSTS\d+/
const OAUTH_ERROR = /^[a-z_]{1,40}$/
const DIGITS = /^\d+$/
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }

function anyOf(...values: string[]): Match {
  return (error, aadsts) => values.includes(error) || (aadsts !== null && values.includes(aadsts))
}

const declinedConsent = anyOf('AADSTS65004')

const RULES: readonly { match: Match; kind: EntraErrorKind; message: string | null }[] = [
  { match: anyOf('AADSTS65001', 'AADSTS90094', 'AADSTS90095', 'consent_required'), kind: 'refused', message: ENTRA.consent },
  {
    match: (error, aadsts) => (error === 'access_denied' && aadsts === null) || declinedConsent(error, aadsts),
    kind: 'refused',
    message: ENTRA.browserCancelled
  },
  { match: anyOf('AADSTS700016'), kind: 'config', message: ENTRA.appNotFound },
  { match: anyOf('AADSTS50011'), kind: 'config', message: ENTRA.redirect },
  { match: anyOf('AADSTS7000218', 'AADSTS9002326', 'AADSTS9002327'), kind: 'config', message: ENTRA.publicClient },
  { match: anyOf('AADSTS650057'), kind: 'config', message: ENTRA.apiPermission },
  { match: anyOf('AADSTS50020'), kind: 'refused', message: ENTRA.wrongDirectory },
  {
    match: anyOf('invalid_grant', 'interaction_required', 'AADSTS50076', 'AADSTS50079', 'AADSTS50173', 'AADSTS70008', 'AADSTS700082', 'AADSTS700084'),
    kind: 'needs_sign_in',
    message: null
  }
]

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function createPkce(random: Random): { verifier: string; challenge: string } {
  const verifier = base64Url(random(VERIFIER_BYTES))
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) }
}

export function newState(random: Random): string {
  return base64Url(random(STATE_BYTES))
}

export function authorizeUrl(p: {
  authority: string
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  loginHint: string | null
}): string {
  const query = new URLSearchParams([
    ['client_id', p.clientId],
    ['response_type', 'code'],
    ['redirect_uri', p.redirectUri],
    ['response_mode', 'form_post'],
    ['scope', ENTRA_SCOPE],
    ['state', p.state],
    ['code_challenge', p.challenge],
    ['code_challenge_method', 'S256'],
    ['prompt', 'select_account']
  ])
  if (p.loginHint) query.append('login_hint', p.loginHint)
  return `${entraAuthorizeUrl(p.authority)}?${query}`
}

export function redirectError(error: string, code: string | null): EntraError {
  return classify(error, code?.match(AADSTS)?.[0] ?? null)
}

export async function redeemCode(
  fetchFn: typeof fetch,
  timeout: Timeout,
  p: { authority: string; clientId: string; redirectUri: string; code: string; verifier: string; now: number; signal?: AbortSignal }
): Promise<EntraTokens> {
  const body = await tokenRequest(fetchFn, timeout, p.authority, p.signal, [
    ['client_id', p.clientId],
    ['grant_type', 'authorization_code'],
    ['code', p.code],
    ['redirect_uri', p.redirectUri],
    ['code_verifier', p.verifier],
    ['scope', ENTRA_SCOPE]
  ])
  const tokens = tokensFrom(body, p.now, null)
  if (tokens.objectId === null) throw malformed()
  return tokens
}

export async function refreshTokens(
  fetchFn: typeof fetch,
  timeout: Timeout,
  p: { authority: string; clientId: string; refreshToken: string; now: number; signal?: AbortSignal }
): Promise<EntraTokens> {
  const body = await tokenRequest(fetchFn, timeout, p.authority, p.signal, [
    ['client_id', p.clientId],
    ['grant_type', 'refresh_token'],
    ['refresh_token', p.refreshToken],
    ['scope', ENTRA_SCOPE]
  ])
  return tokensFrom(body, p.now, p.refreshToken)
}

async function tokenRequest(
  fetchFn: typeof fetch,
  timeout: Timeout,
  authority: string,
  signal: AbortSignal | undefined,
  form: [string, string][]
): Promise<Body> {
  const deadline = timeout(ENTRA_REQUEST_TIMEOUT_MS)
  const res = await reach(signal, () =>
    fetchFn(entraTokenUrl(authority), {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
  )
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw malformed()
  const body = parseObject(await reach(signal, () => res.text()))
  if (!body) throw malformed()
  if (typeof body.error === 'string') throw classify(body.error, aadstsOf(body))
  if (!res.ok) throw malformed()
  return body
}

async function reach<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch {
    if (signal?.aborted) throw signal.reason
    throw new EntraError('unreachable', ENTRA.unreachable)
  }
}

function tokensFrom(body: Body, now: number, sentRefreshToken: string | null): EntraTokens {
  const accessToken = nonEmpty(body.access_token)
  const refreshToken = nonEmpty(body.refresh_token) ?? sentRefreshToken
  const expiresIn = seconds(body.expires_in)
  if (!accessToken || !refreshToken || expiresIn === null) throw malformed()
  const claims = idTokenClaims(body.id_token)
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    tenant: claims?.tid ?? null,
    objectId: claims?.oid ?? null,
    username: claims?.preferredUsername ?? claims?.upn ?? null
  }
}

function idTokenClaims(idToken: unknown): TokenClaims | null {
  if (idToken === undefined || idToken === null) return null
  const claims = typeof idToken === 'string' ? decodeTokenClaims(idToken) : null
  if (!claims) throw malformed()
  return claims
}

function classify(error: string, aadsts: string | null): EntraError {
  const code = aadsts ?? (OAUTH_ERROR.test(error) ? error : null)
  const rule = RULES.find(({ match }) => match(error, aadsts))
  return new EntraError(rule?.kind ?? 'refused', rule?.message ?? entraFailed(code), code)
}

function aadstsOf(body: Body): string | null {
  const first: unknown = Array.isArray(body.error_codes) ? body.error_codes[0] : undefined
  if (typeof first === 'number' && Number.isSafeInteger(first) && first >= 0) return `AADSTS${first}`
  return typeof body.error_description === 'string' ? (body.error_description.match(AADSTS)?.[0] ?? null) : null
}

function parseObject(text: string): Body | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Body) : null
  } catch {
    return null
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function seconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  return typeof value === 'string' && DIGITS.test(value) ? Number(value) : null
}

function malformed(): EntraError {
  return new EntraError('malformed', ENTRA.malformed)
}
