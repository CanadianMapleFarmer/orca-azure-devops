import type { PinnedAccount } from '../../src/shared/types'
import type { ConnectionData } from '../ado/core'

export interface TokenClaims { oid?: string; tid?: string; upn?: string; preferredUsername?: string; exp?: number }

const ANONYMOUS = 'Anonymous'
const BASE64URL = /^[A-Za-z0-9_-]+$/

export function decodeTokenClaims(token: string): TokenClaims | null {
  try {
    const segments = token.split('.')
    if (segments.length !== 3) return null
    const payload: unknown = JSON.parse(decodeBase64Url(segments[1]))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    return pickClaims(payload as Record<string, unknown>)
  } catch {
    return null
  }
}

export function accountFromConnectionData(cd: ConnectionData, tenantId: string | null): PinnedAccount | null {
  const user = cd?.authenticatedUser
  const uniqueName = user?.properties?.Account?.$value?.trim()
  if (!user?.id || !uniqueName || user.providerDisplayName === ANONYMOUS) return null
  return { adoId: user.id, uniqueName, displayName: user.providerDisplayName || uniqueName, tenantId }
}

export function samePinnedAccount(a: PinnedAccount, b: PinnedAccount): boolean {
  return a.adoId === b.adoId
}

function decodeBase64Url(segment: string): string {
  if (!BASE64URL.test(segment)) throw new Error('not base64url')
  const binary = atob(segment.replaceAll('-', '+').replaceAll('_', '/'))
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

function pickClaims(payload: Record<string, unknown>): TokenClaims {
  const claims: TokenClaims = {}
  if (typeof payload.oid === 'string') claims.oid = payload.oid
  if (typeof payload.tid === 'string') claims.tid = payload.tid
  if (typeof payload.upn === 'string') claims.upn = payload.upn
  if (typeof payload.preferred_username === 'string') claims.preferredUsername = payload.preferred_username
  if (typeof payload.exp === 'number') claims.exp = payload.exp
  return claims
}
