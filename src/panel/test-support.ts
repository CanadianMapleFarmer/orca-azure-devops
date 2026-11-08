import { assert, mockHost, mount, type MockRequests, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { APPROVAL_TEMPLATE } from '../shared/share/approval-items'
import { PR_TEMPLATE } from '../shared/share/template'
import type { OrgStatus } from '../shared/types'
import * as panelModule from './panel'
import { runsSnapshotOf } from './pipelines/fixtures'
import { snapshotOf } from './prs/fixtures'
import { reviewOf } from './prs/review/fixtures'

export const SETTINGS = { label: 'Organization settings' }

export const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' }
]

export type TestHost = ReturnType<typeof mockHost>

export interface MountOptions {
  visible?: boolean
  persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }
  module?: Parameters<typeof mount>[0]
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
      'prs.snapshot': input => snapshotOf({ org: input.org, updatedAt: 0 }),
      'reviews.open': input => reviewOf({ key: input }),
      'runs.snapshot': input => runsSnapshotOf({ org: input.org, updatedAt: 0 }),
      'wiki.list': [],
      'wiki.drafts': [],
      'share.prefs': input => ({
        template: input.kind === 'approval' ? APPROVAL_TEMPLATE : PR_TEMPLATE,
        channels: [],
        prefs: { destinations: [{ kind: 'copy' }] },
        tenantId: null
      }),
      ...requests
    }
  })
  const panel = await mount(options.module ?? panelModule, { host, visible: options.visible, persisted: options.persisted })
  return { host, panel }
}

export async function closeCleanly(panel: TestPanel): Promise<void> {
  const issues = { errors: panel.errors, warnings: panel.warnings, refusals: panel.refusals }
  await panel.unmount()
  assert.deepEqual(issues, { errors: [], warnings: [], refusals: [] })
}

export async function reloadPanel(
  previous: TestPanel,
  orgs: OrgStatus[],
  requests: MockRequests = {},
  options: Pick<MountOptions, 'module' | 'visible'> = {}
): Promise<{ host: TestHost; panel: TestPanel }> {
  const persisted = { plugin: { ...previous.persisted.plugin }, workspace: { ...previous.persisted.workspace } }
  await closeCleanly(previous)
  return mountPanel(orgs, requests, { ...options, persisted })
}

export const requestsTo = (host: TestHost, name: string) =>
  (host.callsOf('plugin.request') as { name: string; input: unknown; timeoutMs?: number }[]).filter(call => call.name === name)

export const optionValuesOf = (panel: TestPanel, label: string) =>
  ((panel.find({ label })?.props as { options: { value: string }[] }).options ?? []).map(option => option.value)

export const countNodes = (node: TreeSnapshot | string | null): number =>
  node === null ? 0 : typeof node === 'string' ? 1 : 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0)
