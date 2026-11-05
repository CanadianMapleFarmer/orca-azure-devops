import * as path from 'node:path'
import { isBuildId } from '../../src/shared/runs'
import { isValidOrgName } from '../ado/org'
import { BAD_RUN, badRequest, NO_LOCAL_WORKSPACE_RUN } from '../messages'
import { openTabFile, type TabFileFs } from '../tab-files'
import type { HostCall } from '../workspace/focused'

export const RUN_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export type RunFileFs = TabFileFs & Pick<typeof import('node:fs/promises'), 'readdir' | 'stat' | 'unlink' | 'utimes'>

const RUN_FILE_EXTENSION = '.adorun'
const MAX_PRUNED = 50

export function runFileName(org: string, buildId: number): string {
  if (!isValidOrgName(org) || !isBuildId(buildId)) throw badRequest(BAD_RUN)
  return `${org}.${buildId}${RUN_FILE_EXTENSION}`
}

export async function openRun(
  deps: { call: HostCall; fs: RunFileFs; now: () => number },
  input: { org: string; projectId: string; buildId: number }
): Promise<{ opened: boolean; message?: string }> {
  const name = runFileName(input.org, input.buildId)
  const text = `${JSON.stringify({ org: input.org, projectId: input.projectId, buildId: input.buildId }, null, 2)}\n`
  const opened = await openTabFile(deps, name, text, NO_LOCAL_WORKSPACE_RUN)
  if (!opened.opened) return opened
  const openedAt = new Date(deps.now())
  await deps.fs.utimes(opened.file, openedAt, openedAt).catch(() => {})
  await prune(deps.fs, path.dirname(opened.file), name, deps.now() - RUN_FILE_MAX_AGE_MS)
  return { opened: true }
}

async function prune(fs: RunFileFs, folder: string, kept: string, writtenBefore: number): Promise<void> {
  const names = await fs.readdir(folder).catch(() => [])
  let deletes = 0
  for (const name of names.sort()) {
    if (deletes === MAX_PRUNED) return
    if (name === kept || !name.endsWith(RUN_FILE_EXTENSION)) continue
    const file = path.join(folder, name)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat || stat.mtimeMs >= writtenBefore) continue
    deletes += 1
    await fs.unlink(file).catch(() => {})
  }
}
