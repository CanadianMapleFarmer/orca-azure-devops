import type { OrcaWorkerApi } from 'orca/worker'
import type { PrActions } from './actions'
import type { PrsService } from './service'

export interface PrHandlerDeps { prs: PrsService; actions: PrActions }

export function registerPrHandlers(orca: OrcaWorkerApi, { prs, actions }: PrHandlerDeps): void {
  orca.panels.handle('prs.snapshot', input => prs.snapshot(input.org))
  orca.panels.handle('prs.refresh', input => prs.refresh(input.org))
  orca.panels.handle('prs.approve', input => actions.approveAll(input))
  orca.panels.handle('prs.autoComplete', input => actions.autoCompleteAll(input))
}
