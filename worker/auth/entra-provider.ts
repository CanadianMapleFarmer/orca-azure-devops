import { isGuid, isValidOrgName } from '../ado/org'
import { ENTRA, INVALID_ORG_NAME } from '../messages'
import { authorizeUrl, createPkce, EntraError, type EntraTokens, newState, type Random, redeemCode, redirectError, refreshTokens, type Timeout } from './entra'
import type { Listen, Listener } from './loopback'
import type { SecretsPort } from './pat'

export const ENTRA_SIGN_IN_TIMEOUT_MS = 5 * 60_000

const DEFAULT_AUTHORITY = 'organizations'
const MAX_TENANT_LENGTH = 253
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export class EntraTimeout extends Error {}
export class NoEntraSession extends Error {}

export interface EntraSignedIn extends EntraTokens {
  clientId: string
  authority: string
}

export interface EntraSession {
  url: string
  tokens: Promise<EntraSignedIn>
}

export interface EntraProvider {
  configProblem(): string | null
  begin(org: string, orgTenant: string | null, opts: { loginHint: string | null; signal: AbortSignal }): Promise<EntraSession>
  save(org: string, signedIn: EntraSignedIn): Promise<void>
  getToken(org: string): Promise<EntraTokens>
  hasSession(org: string): Promise<boolean>
  forget(org: string): Promise<void>
}

interface StoredSession {
  clientId: string
  authority: string
  refreshToken: string
}

type App = { clientId: string; tenant: string | null }

export function entraKey(org: string): string {
  if (!isValidOrgName(org)) throw new Error(INVALID_ORG_NAME)
  return `entra:${org}`
}

export function readEntraSettings(values: Record<string, unknown>): { clientId: string | null; tenant: string | null; problem: string | null } {
  const clientId = trimmed(values.entraClientId)
  const tenant = trimmed(values.entraTenant)?.toLowerCase() ?? null
  const clientIdValid = clientId === null || isGuid(clientId)
  const tenantValid = tenant === null || isTenant(tenant)
  return {
    clientId: clientIdValid ? clientId : null,
    tenant: tenantValid ? tenant : null,
    problem: !clientIdValid ? ENTRA.badClientId : !tenantValid ? ENTRA.badTenant : null
  }
}

export function authorityFor(orgTenant: string | null, settingTenant: string | null): string {
  return orgTenant || settingTenant || DEFAULT_AUTHORITY
}

export function createEntraProvider(deps: {
  secrets: SecretsPort
  fetch: typeof fetch
  settings: () => Record<string, unknown>
  listen: Listen
  random: Random
  timeout: Timeout
  now: () => number
  log: (message: string) => void
}): EntraProvider {
  const { secrets, timeout } = deps

  function appOrProblem(): App | string {
    const { clientId, tenant, problem } = readEntraSettings(deps.settings())
    if (problem) return problem
    return clientId ? { clientId, tenant } : ENTRA.noClientId
  }

  function write(key: string, session: StoredSession): Promise<void> {
    return secrets.set(key, JSON.stringify({ v: 1, clientId: session.clientId, authority: session.authority, refreshToken: session.refreshToken }))
  }

  return {
    configProblem() {
      const app = appOrProblem()
      return typeof app === 'string' ? app : null
    },

    async begin(org, orgTenant, opts) {
      entraKey(org)
      const app = appOrProblem()
      if (typeof app === 'string') throw new EntraError('config', app)
      const { clientId } = app
      const authority = authorityFor(orgTenant, app.tenant)
      const pkce = createPkce(deps.random)
      const state = newState(deps.random)
      const local = new AbortController()
      const deadline = timeout(ENTRA_SIGN_IN_TIMEOUT_MS)
      const signal = AbortSignal.any([opts.signal, deadline, local.signal])
      const ended = (error: unknown) => (deadline.aborted && error === deadline.reason ? new EntraTimeout() : error)
      const listenerFailed = (error: unknown) => (aborted(signal, error) ? ended(error) : new Error(ENTRA.listenFailed))

      const redeem = async ({ redirectUri, result }: Listener): Promise<EntraSignedIn> => {
        const redirect = await result.catch((error: unknown) => {
          throw listenerFailed(error)
        })
        if ('error' in redirect) throw redirectError(redirect.error, redirect.errorCode)
        const issued = await redeemCode(deps.fetch, timeout, {
          authority,
          clientId,
          redirectUri,
          code: redirect.code,
          verifier: pkce.verifier,
          now: deps.now(),
          signal
        }).catch((error: unknown) => {
          throw ended(error)
        })
        return { ...issued, clientId, authority }
      }

      const listener = await deps.listen({ state, signal }).catch((error: unknown) => {
        throw listenerFailed(error)
      })
      const tokens = redeem(listener)
      void tokens.catch(() => {})
      try {
        const url = authorizeUrl({ authority, clientId, redirectUri: listener.redirectUri, challenge: pkce.challenge, state, loginHint: opts.loginHint })
        return { url, tokens }
      } catch (error) {
        local.abort()
        throw error
      }
    },

    async save(org, signedIn) {
      const key = entraKey(org)
      const authority = signedIn.tenant && isGuid(signedIn.tenant) ? signedIn.tenant : signedIn.authority
      await write(key, { clientId: signedIn.clientId, authority, refreshToken: signedIn.refreshToken }).catch(() => {
        throw new Error(ENTRA.notSaved)
      })
    },

    async getToken(org) {
      const key = entraKey(org)
      const session = parseSession(await secrets.get(key))
      if (!session) throw new NoEntraSession()
      const tokens = await refreshTokens(deps.fetch, timeout, {
        authority: session.authority,
        clientId: session.clientId,
        refreshToken: session.refreshToken,
        now: deps.now()
      })
      if (tokens.refreshToken !== session.refreshToken) {
        await write(key, { ...session, refreshToken: tokens.refreshToken }).catch(() => deps.log(ENTRA.rotateNotSaved))
      }
      return tokens
    },

    async hasSession(org) {
      return parseSession(await secrets.get(entraKey(org))) !== null
    },

    async forget(org) {
      await secrets.delete(entraKey(org))
    }
  }
}

function aborted(signal: AbortSignal, error: unknown): boolean {
  return (signal.aborted && error === signal.reason) || (error instanceof DOMException && error.name === 'AbortError')
}

function trimmed(value: unknown): string | null {
  return (typeof value === 'string' ? value.trim() : '') || null
}

function isTenant(value: string): boolean {
  return isGuid(value) || (value.length <= MAX_TENANT_LENGTH && DNS_NAME.test(value))
}

function parseSession(text: string | null): StoredSession | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { v, clientId, authority, refreshToken } = value as Record<string, unknown>
  if (v !== 1 || !filled(clientId) || !filled(authority) || !filled(refreshToken)) return null
  return { clientId, authority, refreshToken }
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
