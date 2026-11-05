import type { OrcaWorkerApi } from 'orca/worker'
import type { RunActions } from './actions'
import type { RunViews } from './run-views'
import type { PipelinesService } from './service'

export interface PipelineHandlerDeps {
  pipelines: PipelinesService
  actions: RunActions
  views: RunViews
  openRun: (input: { org: string; projectId: string; buildId: number }) => Promise<{ opened: boolean; message?: string }>
}

export function registerPipelineHandlers(orca: OrcaWorkerApi, { pipelines, actions, views, openRun }: PipelineHandlerDeps): void {
  orca.panels.handle('runs.snapshot', input => pipelines.snapshot(input.org))
  orca.panels.handle('runs.refresh', input => pipelines.refresh(input.org))
  orca.panels.handle('runs.watch', input => pipelines.watch(input))
  orca.panels.handle('runs.decide', input => actions.decide(input))
  orca.panels.handle('runs.retryStage', input => actions.retryStage(input))
  orca.panels.handle('runs.cancel', input => actions.cancel(input))
  orca.panels.handle('runs.open', input => openRun(input))
  orca.panels.handle('runs.view', input => views.view(input))
  orca.panels.handle('runs.log', input => views.log(input))
}
