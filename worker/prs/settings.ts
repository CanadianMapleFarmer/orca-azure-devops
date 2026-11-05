import type { OrcaWorkerApi } from 'orca/worker'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type MergeStrategy } from '../../src/shared/prs'
import { PR_TEMPLATE } from '../../src/shared/share/template'
import { watchSettings } from '../settings-watcher'

const MERGE_STRATEGIES = Object.keys(MERGE_STRATEGY_LABELS) as MergeStrategy[]

export interface PrSettings {
  autoComplete(): AutoCompleteOptions
  shareTemplate(): string
}

export async function watchPrSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PrSettings> {
  const values = await watchSettings(settings, log)
  return {
    autoComplete: () => ({
      mergeStrategy: MERGE_STRATEGIES.find(strategy => strategy === values().autoCompleteMergeStrategy) ?? 'noFastForward',
      deleteSourceBranch: values().autoCompleteDeleteSourceBranch === true,
      transitionWorkItems: values().autoCompleteTransitionWorkItems === true
    }),
    shareTemplate: () => {
      const template = values().shareTemplate
      return typeof template === 'string' && template.trim() !== '' ? template : PR_TEMPLATE
    }
  }
}
