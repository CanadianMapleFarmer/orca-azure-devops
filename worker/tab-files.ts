import * as path from 'node:path'
import { BAD_TAB_FILE, badRequest } from './messages'
import { focusedWorkspace, type HostCall } from './workspace/focused'

export const TAB_FOLDER = '.orca-ado'

export type TabFileFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>
export type TabFileOpened = { opened: true; file: string } | { opened: false; message: string }

const SEPARATOR = /[\\/]/

export async function writeTabFile(fs: TabFileFs, workspacePath: string, name: string, text: string): Promise<string> {
  if (path.isAbsolute(name) || name.split(SEPARATOR).some(segment => segment === '' || segment === '..')) throw badRequest(BAD_TAB_FILE)
  const folder = path.join(workspacePath, TAB_FOLDER)
  const file = path.join(folder, name)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => {
    if (error?.code !== 'EEXIST') throw error
  })
  await fs.mkdir(path.dirname(file), { recursive: true })
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current !== text) await fs.writeFile(file, text)
  return file
}

export async function openTabFile(deps: { call: HostCall; fs: TabFileFs }, name: string, text: string, noWorkspace: string): Promise<TabFileOpened> {
  const workspace = await focusedWorkspace(deps.call)
  if (!workspace || workspace.hostId !== null) return { opened: false, message: noWorkspace }
  const file = await writeTabFile(deps.fs, workspace.path, name, text)
  await deps.call('editor.open', { workspaceId: workspace.id, path: `${TAB_FOLDER}/${name}` })
  return { opened: true, file }
}
