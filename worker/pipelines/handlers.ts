import type { OrcaWorkerApi } from 'orca/worker'
import type { RunActions } from './actions'
import type { PipelinesService } from './service'

export interface PipelineHandlerDeps { pipelines: PipelinesService; actions: RunActions }

export function registerPipelineHandlers(orca: OrcaWorkerApi, { pipelines, actions }: PipelineHandlerDeps): void {
  orca.panels.handle('runs.snapshot', input => pipelines.snapshot(input.org))
  orca.panels.handle('runs.refresh', input => pipelines.refresh(input.org))
  orca.panels.handle('runs.watch', input => pipelines.watch(input))
  orca.panels.handle('runs.decide', input => actions.decide(input))
  orca.panels.handle('runs.retryStage', input => actions.retryStage(input))
  orca.panels.handle('runs.cancel', input => actions.cancel(input))
}
