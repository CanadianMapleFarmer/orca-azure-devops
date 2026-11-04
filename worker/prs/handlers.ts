import type { OrcaWorkerApi } from 'orca/worker'
import type { PrsService } from './service'

export interface PrHandlerDeps { prs: PrsService }

export function registerPrHandlers(orca: OrcaWorkerApi, { prs }: PrHandlerDeps): void {
  orca.panels.handle('prs.snapshot', input => prs.snapshot(input.org))
  orca.panels.handle('prs.refresh', input => prs.refresh(input.org))
}
