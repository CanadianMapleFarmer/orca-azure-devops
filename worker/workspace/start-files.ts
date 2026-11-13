import { randomBytes } from 'node:crypto'
import * as path from 'node:path'
import { START_FILES_FOLDER } from './command'

export const START_FILE_MS = 120_000

const FOLDER_MODE = 0o700
const FILE_MODE = 0o600
const FILE_NAME = /^[0-9a-f]{24}\.(?:prompt|worktree|branch|agent|url|folder|repo)$/

type StartFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'chmod' | 'lstat' | 'writeFile' | 'rm' | 'readdir'>

export interface StartFiles {
  id(): string
  write(files: Record<string, string>): Promise<void>
  remove(names: string[]): Promise<void>
  sweep(): Promise<number>
}

export function createStartFiles({ home, fs, now, uid }: { home: string; fs: StartFs; now: () => number; uid: number }): StartFiles {
  const folder = path.join(home, ...START_FILES_FOLDER.split('/'))

  function pathOf(name: string): string {
    if (!FILE_NAME.test(name)) throw new Error(`Not a start file: ${JSON.stringify(name)}`)
    return path.join(folder, name)
  }

  async function ownFolder(): Promise<boolean> {
    const stat = await fs.lstat(folder).catch(() => null)
    return stat !== null && stat.isDirectory() && stat.uid === uid
  }

  async function privateFolder(): Promise<void> {
    await fs.mkdir(folder, { recursive: true, mode: FOLDER_MODE })
    if (!(await ownFolder())) throw new Error(`${START_FILES_FOLDER} is not a folder of yours`)
    await fs.chmod(folder, FOLDER_MODE)
  }

  return {
    id: () => randomBytes(12).toString('hex'),

    async write(files) {
      const targets = Object.entries(files).map(([name, text]) => [pathOf(name), text] as const)
      await privateFolder()
      for (const [target, text] of targets) await fs.writeFile(target, text, { mode: FILE_MODE, flag: 'wx' })
    },

    async remove(names) {
      const targets = names.map(pathOf)
      if (!(await ownFolder())) throw new Error(`${START_FILES_FOLDER} is not a folder of yours`)
      await Promise.all(targets.map(target => fs.rm(target, { force: true })))
    },

    async sweep() {
      if (!(await ownFolder())) return 0
      let kept = 0
      for (const name of (await fs.readdir(folder)).filter(each => FILE_NAME.test(each))) {
        const target = path.join(folder, name)
        const stat = await fs.lstat(target)
        if (!stat.isFile()) continue
        if (now() - stat.mtimeMs > START_FILE_MS) await fs.rm(target, { force: true })
        else kept += 1
      }
      return kept
    }
  }
}
