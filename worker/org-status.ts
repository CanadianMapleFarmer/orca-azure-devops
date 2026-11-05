import type { OrgStatus, PinnedAccount } from '../src/shared/types'
import { AdoError } from './ado/http'
import { NOT_CONNECTED } from './messages'

export type SignedInStatus = OrgStatus & { account: PinnedAccount }

export function isSignedIn(status: OrgStatus): status is SignedInStatus {
  return status.state === 'connected' && status.account !== null
}

export function notConnected(): AdoError {
  return new AdoError('unauthorized', 401, NOT_CONNECTED)
}

export function loadFailure(error: unknown, fallback: string): AdoError {
  return error instanceof AdoError ? error : new AdoError('server', 500, fallback)
}
