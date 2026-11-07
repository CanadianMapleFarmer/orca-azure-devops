import type { OrcaWorkerApi } from 'orca/worker'
import { APPROVAL_TEMPLATE } from '../../src/shared/share/approval-items'
import { settingOn, watchSettings } from '../settings-watcher'

export interface NotifyPrefs {
  failures: boolean
  approvals: boolean
  watched: boolean
}

export interface PipelineSettings {
  notify(): NotifyPrefs
  approvalTemplate(): string
}

export async function watchPipelineSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PipelineSettings> {
  const values = await watchSettings(settings, log)
  return {
    notify: () => ({
      failures: settingOn(values, 'notifyRunFailures'),
      approvals: settingOn(values, 'notifyApprovals'),
      watched: settingOn(values, 'notifyWatchedRuns')
    }),
    approvalTemplate: () => {
      const template = values().approvalShareTemplate
      return typeof template === 'string' && template.trim() !== '' ? template : APPROVAL_TEMPLATE
    }
  }
}
