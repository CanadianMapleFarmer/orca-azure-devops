import { defineCheck } from 'orca/testing'
import type { OrgStatus } from '../shared/types'

function org(name: string, over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'azure-cli',
    state: 'connected',
    account: { adoId: `u-${name}`, uniqueName: `ada@${name}.com`, displayName: 'Ada Lovelace', tenantId: null },
    tokenStore: { kind: 'az-profile', path: `/Users/ada/.orca-azure-devops/az/${name}` },
    boards: null,
    codeProjects: 'all',
    ...over
  }
}

export default defineCheck({
  empty: { requests: { 'orgs.list': [] } },
  'signing-in': { requests: { 'orgs.list': [org('contoso', { state: 'signing-in', account: null })] } },
  connected: { requests: { 'orgs.list': [org('contoso'), org('fabrikam')] } },
  mismatch: {
    requests: {
      'orgs.list': [
        org('contoso', {
          state: 'mismatch',
          message: 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
        })
      ]
    }
  }
})
