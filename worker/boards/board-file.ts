import * as path from 'node:path'
import { NO_BOARDS } from '../../src/shared/messages'
import { AdoError } from '../ado/http'
import { isValidOrgName } from '../ado/org'
import { focusedWorkspace, type HostCall } from '../workspace/focused'

export type BoardFileFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>
export interface BoardFileContent { org: string; projectId: string; teamId: string; boardId: string }

const FOLDER = '.orca-ado'
const NO_WORKSPACE = 'Open a local workspace first, or use + → Azure DevOps board.'
const BAD_BOARD = "That board can't be opened."
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/

function fileName(org: string, teamId: string): string {
  if (!isValidOrgName(org) || !TEAM_ID.test(teamId)) throw new AdoError('bad_request', 400, BAD_BOARD)
  return `${org}.${teamId}.adoboard`
}

export function boardFilePath(workspacePath: string, org: string, teamId: string): string {
  return path.join(workspacePath, FOLDER, fileName(org, teamId))
}

export async function writeBoardFile(fs: BoardFileFs, workspacePath: string, content: BoardFileContent): Promise<string> {
  const file = boardFilePath(workspacePath, content.org, content.teamId)
  const folder = path.dirname(file)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => {
    if (error?.code !== 'EEXIST') throw error
  })
  const text = `${JSON.stringify({ org: content.org, projectId: content.projectId, teamId: content.teamId, boardId: content.boardId }, null, 2)}\n`
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current !== text) await fs.writeFile(file, text)
  return file
}

export async function openBoard(
  deps: { call: HostCall; fs: BoardFileFs; boardOf: (org: string) => Promise<{ projectId: string; teamId: string; boardId: string } | null> },
  org: string
): Promise<{ opened: boolean; message?: string }> {
  const workspace = await focusedWorkspace(deps.call)
  if (!workspace || workspace.hostId !== null) return { opened: false, message: NO_WORKSPACE }
  const board = await deps.boardOf(org)
  if (!board) return { opened: false, message: NO_BOARDS }
  await writeBoardFile(deps.fs, workspace.path, { org, ...board })
  await deps.call('editor.open', { workspaceId: workspace.id, path: `${FOLDER}/${fileName(org, board.teamId)}` })
  return { opened: true }
}
