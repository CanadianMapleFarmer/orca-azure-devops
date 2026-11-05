import type { OrcaWorkerApi } from 'orca/worker'
import type { PipelinesService } from './service'

export interface PipelineHandlerDeps { pipelines: PipelinesService }

export function registerPipelineHandlers(orca: OrcaWorkerApi, { pipelines }: PipelineHandlerDeps): void {
  orca.panels.handle('runs.snapshot', input => pipelines.snapshot(input.org))
  orca.panels.handle('runs.refresh', input => pipelines.refresh(input.org))
  orca.panels.handle('runs.watch', input => pipelines.watch(input))
}
