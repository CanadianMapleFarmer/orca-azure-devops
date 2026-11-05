import type { RunSummary } from '../../src/shared/pipelines'
import { runCounts } from '../../src/shared/runs'
import type { StatusBar } from '../status-bar'
import type { Notifier } from './notify'

export interface RunSignals {
  update(org: string, runs: readonly RunSummary[] | null): void
}

export function createRunSignals(deps: { bar: Pick<StatusBar, 'setCount'>; notifier: Notifier; now: () => number }): RunSignals {
  return {
    update(org, runs) {
      if (runs === null) {
        deps.bar.setCount(org, 'failedRuns', null)
        deps.bar.setCount(org, 'approvals', null)
        return
      }
      const counts = runCounts(runs, deps.now())
      deps.bar.setCount(org, 'failedRuns', counts.failedRuns)
      deps.bar.setCount(org, 'approvals', counts.approvals)
      deps.notifier.observe(org, runs)
    }
  }
}
