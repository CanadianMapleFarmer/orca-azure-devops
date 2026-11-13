import * as path from 'node:path'
import { boardFileText } from '../../src/board/ref'
import { NO_BOARDS } from '../../src/shared/messages'
import { isValidOrgName } from '../ado/org'
import { BAD_BOARD, badRequest, NO_LOCAL_WORKSPACE } from '../messages'
import { TAB_FOLDER, writeTabFile, type TabFileFs } from '../tab-files'
import { focusedWorkspace, isLocalWorkspace, type HostCall } from '../workspace/focused'

export type BoardFileFs = TabFileFs
export interface BoardFileContent { org: string; projectId: string; teamId: string; boardId: string }

const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/

function fileName(org: string, teamId: string): string {
  if (!isValidOrgName(org) || !TEAM_ID.test(teamId)) throw badRequest(BAD_BOARD)
  return `${org}.${teamId}.adoboard`
}

export function boardFilePath(workspacePath: string, org: string, teamId: string): string {
  return path.join(workspacePath, TAB_FOLDER, fileName(org, teamId))
}

export async function writeBoardFile(fs: BoardFileFs, workspacePath: string, content: BoardFileContent): Promise<string> {
  return writeTabFile(fs, workspacePath, fileName(content.org, content.teamId), boardFileText(content))
}

export async function openBoard(
  deps: { call: HostCall; fs: BoardFileFs; boardOf: (org: string) => Promise<{ projectId: string; teamId: string; boardId: string } | null> },
  org: string
): Promise<{ opened: boolean; message?: string }> {
  const workspace = await focusedWorkspace(deps.call)
  if (!workspace || !isLocalWorkspace(workspace)) return { opened: false, message: NO_LOCAL_WORKSPACE }
  const board = await deps.boardOf(org)
  if (!board) return { opened: false, message: NO_BOARDS }
  await writeBoardFile(deps.fs, workspace.path, { org, ...board })
  await deps.call('editor.open', { workspaceId: workspace.id, path: `${TAB_FOLDER}/${fileName(org, board.teamId)}` })
  return { opened: true }
}
