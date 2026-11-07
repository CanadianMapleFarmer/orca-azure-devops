import type { OrcaWorkerApi } from 'orca/worker'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type MergeStrategy } from '../../src/shared/prs'
import { PR_TEMPLATE } from '../../src/shared/share/template'
import { watchSettings } from '../settings-watcher'

const MERGE_STRATEGIES = Object.keys(MERGE_STRATEGY_LABELS) as MergeStrategy[]

export interface PrNotifyPrefs {
  reviews: boolean
  comments: boolean
}

export interface PrSettings {
  autoComplete(): AutoCompleteOptions
  shareTemplate(): string
  notify(): PrNotifyPrefs
}

export async function watchPrSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PrSettings> {
  const values = await watchSettings(settings, log)
  const toggle = (key: string) => {
    const value = values()[key]
    return typeof value === 'boolean' ? value : true
  }
  return {
    autoComplete: () => ({
      mergeStrategy: MERGE_STRATEGIES.find(strategy => strategy === values().autoCompleteMergeStrategy) ?? 'noFastForward',
      deleteSourceBranch: values().autoCompleteDeleteSourceBranch === true,
      transitionWorkItems: values().autoCompleteTransitionWorkItems === true
    }),
    shareTemplate: () => {
      const template = values().shareTemplate
      return typeof template === 'string' && template.trim() !== '' ? template : PR_TEMPLATE
    },
    notify: () => ({ reviews: toggle('notifyReviewRequests'), comments: toggle('notifyPrComments') })
  }
}
