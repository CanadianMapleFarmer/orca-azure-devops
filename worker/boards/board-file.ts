import * as path from 'node:path'
import { NO_BOARDS } from './service'

export type HostCall = (method: string, params?: unknown) => Promise<any>
export type BoardFileFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>
export interface BoardFileContent { org: string; projectId: string; teamId: string; boardId: string }

interface WorkspaceEntry { id: string; name: string; path: string; branch: string | null; hostId: string | null }

const FOLDER = '.orca-ado'
const NO_WORKSPACE = 'Open a local workspace first, or use + → Azure DevOps board.'

function fileName(org: string, teamId: string): string {
  return `${org}.${teamId}.adoboard`
}

export function boardFilePath(workspacePath: string, org: string, teamId: string): string {
  return path.join(workspacePath, FOLDER, fileName(org, teamId))
}

export async function writeBoardFile(fs: BoardFileFs, workspacePath: string, content: BoardFileContent): Promise<string> {
  const folder = path.join(workspacePath, FOLDER)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => {
    if (error?.code !== 'EEXIST') throw error
  })
  const file = boardFilePath(workspacePath, content.org, content.teamId)
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

async function focusedWorkspace(call: HostCall): Promise<WorkspaceEntry | null> {
  const context: { branch: string; displayName: string } | null = await call('workspace.readContext')
  if (!context) return null
  const { workspaces }: { workspaces: WorkspaceEntry[] } = await call('workspace.list')
  const matches = workspaces.filter(entry => entry.name === context.displayName && (entry.branch === null || entry.branch === context.branch))
  return matches.length === 1 ? matches[0] : null
}
