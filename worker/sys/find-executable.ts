import * as fs from 'node:fs'
import * as path from 'node:path'

export const DEFAULT_EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

export function findExecutable(
  name: string,
  opts: { override?: string; pathEnv?: string; extraDirs?: string[]; isExecutable?: (p: string) => boolean }
): string | null {
  const isExecutable = opts.isExecutable ?? isExecutableFile
  const override = opts.override?.trim()
  if (override && isExecutable(override)) return override

  const pathDirs = (opts.pathEnv ?? process.env.PATH ?? '').split(path.delimiter)
  for (const dir of [...pathDirs, ...(opts.extraDirs ?? DEFAULT_EXTRA_DIRS)]) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}
