export type ConnectionMethod = 'azure-cli' | 'pat' | 'entra'
export interface PinnedAccount { adoId: string; uniqueName: string; displayName: string; tenantId: string | null; objectId: string | null }
export interface BoardsTarget { projectId: string; projectName: string; teamId: string; teamName: string }
export interface OrgConfig {
  org: string                      // canonical, lower-case: "contoso"
  url: string                      // "https://dev.azure.com/contoso"
  tenantId: string | null
  method: ConnectionMethod
  pinned: PinnedAccount | null
  boards: BoardsTarget | null
  codeProjects: 'all' | { id: string; name: string }[]
}
export type OrgState = 'disconnected' | 'signing-in' | 'connected' | 'expired' | 'mismatch' | 'error'
export interface OrgStatus {
  org: string; url: string; method: ConnectionMethod; state: OrgState
  account: PinnedAccount | null
  message?: string                 // user-facing, never contains secrets
  signInUrl?: string
  tokenStore: { kind: 'orca-secrets' } | { kind: 'az-profile'; path: string }
  boards: BoardsTarget | null; codeProjects: OrgConfig['codeProjects']
}
export interface ConnectFailure { org: string; url: string; method: ConnectionMethod; message: string }
export interface Identity { id: string; displayName: string; uniqueName: string; kind: 'user' | 'group' }
