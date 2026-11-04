import type { OrcaWorkerApi } from 'orca/worker'
import type { BoardsService } from './boards/service'
import type { PrsService } from './prs/service'

export function registerVisibilityHandler(orca: OrcaWorkerApi, { boards, prs }: { boards: BoardsService; prs: PrsService }): void {
  orca.panels.handle('ui.visibility', ({ surface, ...input }) => (surface === 'prs' ? prs.visibility(input) : boards.visibility({ ...input, surface })))
}
