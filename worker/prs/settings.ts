import type { OrcaWorkerApi } from 'orca/worker'
import type { AutoCompleteOptions, MergeStrategy } from '../../src/shared/prs'
import { SETTINGS_READ_FAILED } from '../messages'

const MERGE_STRATEGIES: readonly MergeStrategy[] = ['noFastForward', 'squash', 'rebase', 'rebaseMerge']

export interface PrSettings {
  autoComplete(): AutoCompleteOptions
}

export async function watchPrSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PrSettings> {
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
    autoComplete: () => ({
      mergeStrategy: MERGE_STRATEGIES.find(strategy => strategy === values.autoCompleteMergeStrategy) ?? 'noFastForward',
      deleteSourceBranch: values.autoCompleteDeleteSourceBranch === true,
      transitionWorkItems: values.autoCompleteTransitionWorkItems === true
    })
  }
}
