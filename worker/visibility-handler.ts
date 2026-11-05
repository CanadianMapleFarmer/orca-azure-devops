import type { OrcaWorkerApi } from 'orca/worker'
import type { BoardsService } from './boards/service'
import type { PipelinesService } from './pipelines/service'
import type { PrsService } from './prs/service'

export function registerVisibilityHandler(
  orca: OrcaWorkerApi,
  { boards, prs, pipelines }: { boards: BoardsService; prs: PrsService; pipelines: PipelinesService }
): void {
  orca.panels.handle('ui.visibility', ({ surface, ...input }) => {
    if (surface === 'prs') return prs.visibility(input)
    if (surface === 'pipelines') return pipelines.visibility(input)
    return boards.visibility({ ...input, surface })
  })
}
