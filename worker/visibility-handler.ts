import type { OrcaWorkerApi } from 'orca/worker'
import type { BoardsService } from './boards/service'
import type { RunViews } from './pipelines/run-views'
import type { PipelinesService } from './pipelines/service'
import type { PrsService } from './prs/service'

export function registerVisibilityHandler(
  orca: OrcaWorkerApi,
  { boards, prs, pipelines, runViews }: { boards: BoardsService; prs: PrsService; pipelines: PipelinesService; runViews: RunViews }
): void {
  orca.panels.handle('ui.visibility', ({ surface, ...input }) => {
    if (surface === 'prs') return prs.visibility(input)
    if (surface === 'pipelines') return pipelines.visibility(input)
    if (surface === 'run') return runViews.setVisible(input)
    return boards.visibility({ ...input, surface })
  })
}
