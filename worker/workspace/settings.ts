import type { OrcaWorkerApi } from 'orca/worker'
import { DEFAULT_BRANCH_TEMPLATE } from './arm'

const DEFAULT_AGENT = 'claude'
const READ_FAILED = "Couldn't read settings; keeping the previous values."

export interface WorkspaceSettings {
  agentContext(): boolean
  defaultAgent(): string
  branchTemplate(): string
}

export async function watchWorkspaceSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<WorkspaceSettings> {
  let values: Record<string, unknown> = {}
  const refresh = async () => {
    values = await settings.get().catch(() => {
      log(READ_FAILED)
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
