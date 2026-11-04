import { assert, mockHost, mount, type MockRequests, type TestPanel } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import * as panelModule from './panel'

export const SETTINGS = { label: 'Organization settings' }

export const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' }
]

export type TestHost = ReturnType<typeof mockHost>

export interface MountOptions {
  visible?: boolean
  persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }
}

export function org(name: string, over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'azure-cli',
    state: 'connected',
    account: { adoId: `u-${name}`, uniqueName: `ada@${name}.com`, displayName: 'Ada Lovelace', tenantId: null, objectId: null },
    tokenStore: { kind: 'az-profile', path: `/Users/ada/.orca-azure-devops/az/${name}` },
    boards: null,
    codeProjects: 'all',
    ...over
  }
}

export async function mountPanel(orgs: OrgStatus[], requests: MockRequests = {}, options: MountOptions = {}) {
  const host = mockHost({
    requests: {
      'orgs.list': orgs,
      'ui.visibility': { ok: true },
      'work.snapshot': input => ({ org: input.org, board: null, mine: [], other: [], nudges: [], updatedAt: 0, stale: false }),
      ...requests
    }
  })
  const panel = await mount(panelModule, { host, visible: options.visible, persisted: options.persisted })
  return { host, panel }
}

export async function closeCleanly(panel: TestPanel): Promise<void> {
  const issues = { errors: panel.errors, warnings: panel.warnings, refusals: panel.refusals }
  await panel.unmount()
  assert.deepEqual(issues, { errors: [], warnings: [], refusals: [] })
}

export const requestsTo = (host: TestHost, name: string) =>
  (host.callsOf('plugin.request') as { name: string; input: unknown; timeoutMs?: number }[]).filter(call => call.name === name)

export const optionValuesOf = (panel: TestPanel, label: string) =>
  ((panel.find({ label })?.props as { options: { value: string }[] }).options ?? []).map(option => option.value)
