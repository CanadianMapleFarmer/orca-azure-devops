import type { OrcaWorkerApi } from 'orca/worker'
import { watchSettings } from '../settings-watcher'
import { DEFAULT_BRANCH_TEMPLATE } from './arm'
import { DEFAULT_CLONE_FOLDER } from './clone'

const DEFAULT_AGENT = 'claude'

export interface WorkspaceSettings {
  agentContext(): boolean
  defaultAgent(): string
  branchTemplate(): string
  cloneFolder(): string
}

export async function watchWorkspaceSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<WorkspaceSettings> {
  const values = await watchSettings(settings, log)
  return {
    agentContext: () => values().agentContext === true,
    defaultAgent: () => {
      const agent = values().defaultAgent
      return (typeof agent === 'string' && agent.trim()) || DEFAULT_AGENT
    },
    branchTemplate: () => {
      const template = values().branchTemplate
      return typeof template === 'string' ? template : DEFAULT_BRANCH_TEMPLATE
    },
    cloneFolder: () => {
      const folder = values().cloneFolder
      return typeof folder === 'string' && folder.trim() ? folder : DEFAULT_CLONE_FOLDER
    }
  }
}
