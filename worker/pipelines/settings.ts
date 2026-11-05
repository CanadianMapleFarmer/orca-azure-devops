import type { OrcaWorkerApi } from 'orca/worker'
import { watchSettings } from '../settings-watcher'

export interface NotifyPrefs {
  failures: boolean
  approvals: boolean
  watched: boolean
}

export interface PipelineSettings {
  notify(): NotifyPrefs
}

export async function watchPipelineSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PipelineSettings> {
  const values = await watchSettings(settings, log)
  const toggle = (key: string) => {
    const value = values()[key]
    return typeof value === 'boolean' ? value : true
  }
  return {
    notify: () => ({ failures: toggle('notifyRunFailures'), approvals: toggle('notifyApprovals'), watched: toggle('notifyWatchedRuns') })
  }
}
