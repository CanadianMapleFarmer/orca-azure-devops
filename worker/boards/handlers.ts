import * as fs from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import { listTeamBoards } from '../ado/board-config'
import type { AdoHttp } from '../ado/http'
import type { HostCall } from '../workspace/focused'
import { openBoard } from './board-file'
import type { BoardsService } from './service'

export interface WorkHandlerDeps { boards: BoardsService; http: AdoHttp; call: HostCall }

export function registerWorkHandlers(orca: OrcaWorkerApi, { boards, http, call }: WorkHandlerDeps): void {
  orca.panels.handle('work.snapshot', input => boards.snapshot(input.org))
  orca.panels.handle('work.refresh', input => boards.refresh(input.org))
  orca.panels.handle('work.details', input => boards.details(input.org, input.id))
  orca.panels.handle('work.move', input => boards.move(input))
  orca.panels.handle('work.comment', input => boards.comment(input.org, input.id, input.text))
  orca.panels.handle('work.linkPr', input => boards.linkPr(input))
  orca.panels.handle('work.board', input => boards.board(input))
  orca.panels.handle('work.boards', input => listTeamBoards(http, input))
  orca.panels.handle('work.openBoard', input => openBoard({ call, fs, boardOf: org => boards.defaultBoard(org) }, input.org))
  orca.panels.handle('work.dismissNudge', input => boards.dismissNudge(input))
  orca.panels.handle('work.nudgeRules', input => boards.nudgeRules(input))
}
