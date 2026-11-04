import type { ConnectionMethod, OrgStatus } from './shared/types'
declare module 'orca' {
  interface PluginRequests {
    'plugin.ping': { input: {}; output: { version: string } }
    'orgs.list': { input: {}; output: OrgStatus[] }
    'orgs.connect': { input: { orgInput: string; method: ConnectionMethod; pat?: string }; output: OrgStatus }
    'orgs.cancel': { input: { org: string }; output: OrgStatus }
    'orgs.signOut': { input: { org: string }; output: OrgStatus }
    'orgs.remove': { input: { org: string }; output: { ok: true } }
    'ado.projects': { input: { org: string }; output: { id: string; name: string }[] }
    'ado.teams': { input: { org: string; projectId: string }; output: { id: string; name: string }[] }
    'orgs.setBoards': { input: { org: string; projectId: string; teamId: string }; output: OrgStatus }
    'orgs.setCodeProjects': { input: { org: string; projects: 'all' | string[] }; output: OrgStatus }
  }
  interface PluginPanelEvents { 'orgs.changed': { orgs: OrgStatus[] } }
}
