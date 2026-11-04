import type { OrcaWorkerApi } from 'orca/worker'
import { SETTINGS_READ_FAILED } from '../messages'
import { DEFAULT_BRANCH_TEMPLATE } from './arm'

const DEFAULT_AGENT = 'claude'

export interface WorkspaceSettings {
  agentContext(): boolean
  defaultAgent(): string
  branchTemplate(): string
}

export async function watchWorkspaceSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<WorkspaceSettings> {
  let values: Record<string, unknown> = {}
  const refresh = async () => {
    values = await settings.get().catch(() => {
      log(SETTINGS_READ_FAILED)
      return values
    })
  }
  await refresh()
  settings.onDidChange(() => void refresh())
  return {
    agentContext: () => values.agentContext === true,
    defaultAgent: () => (typeof values.defaultAgent === 'string' && values.defaultAgent.trim()) || DEFAULT_AGENT,
    branchTemplate: () => (typeof values.branchTemplate === 'string' ? values.branchTemplate : DEFAULT_BRANCH_TEMPLATE)
  }
}
