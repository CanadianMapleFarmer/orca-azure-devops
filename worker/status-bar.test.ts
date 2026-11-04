import { assert, test } from 'orca/testing'
import type { OrgState, OrgStatus } from '../src/shared/types'
import { statusBarFor, statusText } from './status-bar'

function org(name: string, state: OrgState, message?: string): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'pat',
    state,
    account: state === 'disconnected' ? null : { adoId: 'u1', uniqueName: `ada@${name}.com`, displayName: 'Ada', tenantId: null, objectId: null },
    ...(message ? { message } : {}),
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

test('statusBarFor shows a neutral item when no org is connected', () => {
  assert.deepEqual(statusBarFor([]), { text: 'ADO', tone: 'neutral', tooltip: 'Azure DevOps: not connected' })
})

test('statusBarFor is success when every org is connected', () => {
  assert.deepEqual(statusBarFor([org('contoso', 'connected')]), {
    text: 'ADO',
    tone: 'success',
    tooltip: 'Azure DevOps: contoso (ada@contoso.com)'
  })
  const both = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'connected')])
  assert.equal(both.tone, 'success')
  assert.equal(both.tooltip, 'Azure DevOps: contoso (ada@contoso.com)\nfabrikam (ada@fabrikam.com)')
})

test('statusBarFor warns when an org expired', () => {
  const item = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.')])
  assert.equal(item.tone, 'warning')
  assert.equal(item.tooltip, 'Azure DevOps: contoso (ada@contoso.com)\nfabrikam: Your sign-in expired. Reconnect to continue.')
})

test('statusBarFor is danger on a mismatch or error and names the org and its message', () => {
  const mismatch = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
  const item = statusBarFor([org('contoso', 'mismatch', mismatch), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.')])
  assert.equal(item.tone, 'danger')
  assert.ok(item.tooltip.includes(`contoso: ${mismatch}`))

  const error = statusBarFor([org('fabrikam', 'error', "Azure DevOps didn't accept that sign-in.")])
  assert.equal(error.tone, 'danger')
  assert.equal(error.tooltip, "Azure DevOps: fabrikam: Azure DevOps didn't accept that sign-in.")
})

test('statusBarFor stays neutral while an org is signing in or signed out', () => {
  assert.equal(statusBarFor([org('contoso', 'connected'), org('fabrikam', 'signing-in')]).tone, 'neutral')
  const item = statusBarFor([org('contoso', 'disconnected')])
  assert.equal(item.tone, 'neutral')
  assert.equal(item.tooltip, 'Azure DevOps: contoso: not connected')
})

test('statusText lists each org on its own line', () => {
  assert.equal(
    statusText([org('contoso', 'connected'), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.'), org('adatum', 'signing-in')]),
    'contoso — connected as ada@contoso.com\nfabrikam — Your sign-in expired. Reconnect to continue.\nadatum — signing in'
  )
})

test('statusText tells the user how to connect when there are no orgs', () => {
  assert.equal(statusText([]), 'Not connected. Open the Azure DevOps panel to connect.')
})
