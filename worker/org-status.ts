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

export async function signedInStatus(
  orgs: () => Promise<OrgStatus[]>,
  org: string,
  fallback: string,
  disposed: () => boolean
): Promise<SignedInStatus> {
  const listed = await orgs().catch(error => {
    throw loadFailure(error, fallback)
  })
  const status = listed.find(item => item.org === org)
  if (disposed() || !status || !isSignedIn(status)) throw notConnected()
  return status
}
