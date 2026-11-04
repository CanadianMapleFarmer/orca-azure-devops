import { assert, test } from 'orca/testing'
import type { PinnedAccount } from '../../src/shared/types'
import type { ConnectionData } from '../ado/core'
import { accountFromConnectionData, decodeTokenClaims, samePinnedAccount } from './identity'

function base64url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function jwt(payload: unknown, header: unknown = { alg: 'none', typ: 'JWT' }): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.c2ln`
}

const ADA: ConnectionData = {
  authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: 'ada@contoso.com' } } }
}

const PINNED: PinnedAccount = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: 't1' }

test('decodeTokenClaims reads oid, tid, upn and exp from an unsigned JWT', () => {
  const token = jwt({ oid: 'o1', tid: 't1', upn: 'ada@contoso.com', exp: 1_900_000_000, aud: 'ignored' })
  assert.deepEqual(decodeTokenClaims(token), { oid: 'o1', tid: 't1', upn: 'ada@contoso.com', exp: 1_900_000_000 })
})

test('decodeTokenClaims maps preferred_username to preferredUsername', () => {
  assert.deepEqual(decodeTokenClaims(jwt({ preferred_username: 'ada@contoso.com' })), { preferredUsername: 'ada@contoso.com' })
})

test('decodeTokenClaims decodes base64url alphabet and UTF-8', () => {
  const upn = 'ünïcode??>>@contoso.com'
  const payload = base64url(JSON.stringify({ upn }))
  assert(/[-_]/.test(payload), 'fixture should exercise the url-safe alphabet')
  assert.deepEqual(decodeTokenClaims(`e30.${payload}.sig`), { upn })
})

test('decodeTokenClaims drops claims of the wrong type', () => {
  assert.deepEqual(decodeTokenClaims(jwt({ oid: 7, tid: null, upn: ['x'], preferred_username: {}, exp: '1' })), {})
})

test('decodeTokenClaims returns null for anything that is not a JWT with an object payload', () => {
  const notObjects = [jwt([1, 2]), jwt(null), jwt('text'), jwt(42), jwt(true)]
  const malformed = [
    'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrst',
    '',
    '..',
    'a.b',
    'a.b.c.d',
    `${base64url('{}')}..sig`,
    `${base64url('{}')}.%%%.sig`,
    `${base64url('{}')}.${base64url('not json')}.sig`,
    `${base64url('{}')}.${base64url('{"oid":')}.sig`,
    `${base64url('{}')}.a.sig`,
    `${base64url('{}')}.${base64url('{}')}=.sig`
  ]
  for (const token of [...notObjects, ...malformed]) assert.equal(decodeTokenClaims(token), null, token)
})

test('decodeTokenClaims never throws, even on invalid UTF-8 or a non-string', () => {
  const invalidUtf8 = btoa(String.fromCharCode(0x7b, 0xff, 0xfe, 0x7d)).replaceAll('=', '')
  assert.equal(decodeTokenClaims(`e30.${invalidUtf8}.sig`), null)
  assert.equal(decodeTokenClaims(undefined as unknown as string), null)
  assert.equal(decodeTokenClaims(null as unknown as string), null)
})

test('accountFromConnectionData maps the authenticated user', () => {
  assert.deepEqual(accountFromConnectionData(ADA, 't1'), PINNED)
})

test('accountFromConnectionData keeps a null tenant', () => {
  assert.equal(accountFromConnectionData(ADA, null)?.tenantId, null)
})

test('accountFromConnectionData falls back to the account name when there is no display name', () => {
  const cd: ConnectionData = { authenticatedUser: { id: 'u1', properties: { Account: { $value: 'ada@contoso.com' } } } }
  assert.equal(accountFromConnectionData(cd, 't1')?.displayName, 'ada@contoso.com')
})

test('accountFromConnectionData returns null for an anonymous or invalid credential', () => {
  const anonymous: ConnectionData = {
    authenticatedUser: { id: 'u0', providerDisplayName: 'Anonymous', properties: { Account: { $value: 'ada@contoso.com' } } }
  }
  const noAccount: ConnectionData = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace' } }
  const emptyProperties: ConnectionData = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace', properties: {} } }
  const blankAccount: ConnectionData = {
    authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: '  ' } } }
  }
  const noId: ConnectionData = {
    authenticatedUser: { id: '', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: 'ada@contoso.com' } } }
  }
  for (const cd of [anonymous, noAccount, emptyProperties, blankAccount, noId]) assert.equal(accountFromConnectionData(cd, 't1'), null)
  assert.equal(accountFromConnectionData({} as ConnectionData, 't1'), null)
  assert.equal(accountFromConnectionData(undefined as unknown as ConnectionData, 't1'), null)
})

test('samePinnedAccount compares by adoId only', () => {
  const renamed: PinnedAccount = { adoId: 'u1', uniqueName: 'ada@fabrikam.com', displayName: 'A. Lovelace', tenantId: null }
  const other: PinnedAccount = { ...PINNED, adoId: 'u2' }
  assert.equal(samePinnedAccount(PINNED, renamed), true)
  assert.equal(samePinnedAccount(PINNED, other), false)
})
