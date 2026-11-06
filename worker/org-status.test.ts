import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../src/shared/types'
import { AdoError } from './ado/http'
import { NOT_CONNECTED } from './messages'
import { isSignedIn, loadFailure, notConnected, signedInStatus } from './org-status'

const FALLBACK = "Couldn't load things."

function status(overrides: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: 'contoso',
    url: 'https://dev.azure.com/contoso',
    method: 'pat',
    state: 'connected',
    account: { adoId: 'ada', uniqueName: 'ada@contoso.com', displayName: 'Ada', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all',
    ...overrides
  }
}

test('an org is signed in when it is connected and has a pinned account', () => {
  assert.equal(isSignedIn(status()), true)
  assert.equal(isSignedIn(status({ account: null })), false)
  assert.equal(isSignedIn(status({ state: 'expired' })), false)
})

test('not connected is the fixed unauthorized error', () => {
  assert.deepEqual(notConnected(), new AdoError('unauthorized', 401, NOT_CONNECTED))
})

test('a load failure keeps an Azure DevOps error and wraps anything else with the fallback', () => {
  const known = new AdoError('forbidden', 403, 'nope')
  assert.equal(loadFailure(known, FALLBACK), known)
  assert.deepEqual(loadFailure(new Error('boom'), FALLBACK), new AdoError('server', 500, FALLBACK))
  assert.deepEqual(loadFailure(null, FALLBACK), new AdoError('server', 500, FALLBACK))
})

test('signedInStatus answers the signed-in status of the org', async () => {
  const contoso = status()
  const orgs = async () => [status({ org: 'fabrikam' }), contoso]
  assert.deepEqual(await signedInStatus(orgs, 'contoso', FALLBACK, () => false), contoso)
})

test('signedInStatus refuses an unknown, signed-out or disposed org as not connected', async () => {
  const orgs = async () => [status(), status({ org: 'fabrikam', state: 'expired' }), status({ org: 'northwind', account: null })]
  for (const org of ['tailspin', 'fabrikam', 'northwind']) {
    await assert.rejects(signedInStatus(orgs, org, FALLBACK, () => false), (error: unknown) => {
      assert.deepEqual(error, notConnected(), org)
      return true
    })
  }
  let disposed = false
  const late = async () => {
    disposed = true
    return [status()]
  }
  await assert.rejects(signedInStatus(late, 'contoso', FALLBACK, () => disposed), (error: unknown) => {
    assert.deepEqual(error, notConnected(), 'disposed while the orgs were read')
    return true
  })
})

test('signedInStatus turns a failed org read into a load failure with the fallback', async () => {
  const known = new AdoError('forbidden', 403, 'nope')
  await assert.rejects(signedInStatus(async () => Promise.reject(known), 'contoso', FALLBACK, () => false), (error: unknown) => error === known)
  await assert.rejects(signedInStatus(async () => Promise.reject(new Error('disk')), 'contoso', FALLBACK, () => false), (error: unknown) => {
    assert.deepEqual(error, new AdoError('server', 500, FALLBACK))
    return true
  })
})
