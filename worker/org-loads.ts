import type { OrgStatus } from '../src/shared/types'
import { linkedAbort } from './abort'
import { AdoError, withSignal, type AdoHttp } from './ado/http'
import { loadFailure, notConnected, signedInStatus, type SignedInStatus } from './org-status'

export interface OrgLoad {
  http: AdoHttp
  signal: AbortSignal
  status: SignedInStatus
}

export interface OrgLoads {
  load<T>(org: string, work: (load: OrgLoad) => Promise<T>): Promise<T>
  forget(org: string): void
  orgs(): string[]
}

export interface OrgLoadsDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  fallback: string
  forbidden: string
}

export function createOrgLoads(deps: OrgLoadsDeps): OrgLoads {
  const scopes = new Map<string, AbortController>()

  function scopeOf(org: string): AbortController {
    const existing = scopes.get(org)
    if (existing) return existing
    const controller = new AbortController()
    scopes.set(org, controller)
    return controller
  }

  async function load<T>(org: string, work: (load: OrgLoad) => Promise<T>): Promise<T> {
    const link = linkedAbort(scopeOf(org).signal)
    try {
      if (link.signal.aborted) throw notConnected()
      const status = await signedInStatus(deps.orgs, org, deps.fallback, () => false)
      const result = await work({ http: withSignal(deps.http, link.signal), signal: link.signal, status })
      link.signal.throwIfAborted()
      return result
    } catch (error) {
      if (link.signal.aborted) throw notConnected()
      if (error instanceof AdoError && error.code === 'forbidden') throw new AdoError('forbidden', 403, deps.forbidden)
      throw loadFailure(error, deps.fallback)
    } finally {
      link.release()
    }
  }

  function forget(org: string): void {
    scopes.get(org)?.abort()
    scopes.delete(org)
  }

  return { load, forget, orgs: () => [...scopes.keys()] }
}
