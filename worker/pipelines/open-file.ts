import * as path from 'node:path'
import { pathCandidates } from '../../src/shared/file-ref'
import type { RunSummary } from '../../src/shared/pipelines'
import { fileNotFound, NO_LOCAL_WORKSPACE_FILE, noRepoWorkspace, NOT_A_FILE_PATH } from '../messages'
import type { RunCommand } from '../sys/run'
import { focusedWorkspace, isLocalWorkspace, listWorkspaces, type HostCall, type WorkspaceEntry } from '../workspace/focused'
import { remotesOf, type AdoRemote } from '../workspace/remotes'
import { workspacesOfRepo } from '../workspace/repo-workspaces'

export interface OpenFileDeps {
  call: HostCall
  gitAvailable: boolean
  remotes: (workspacePath: string) => Promise<AdoRemote[]>
  log: (message: string) => void
  isFileInside: (root: string, relative: string) => Promise<boolean>
}

export interface OpenFileInput {
  run: RunSummary
  path: string
  line: number | null
}

export interface OpenFileResult {
  opened: boolean
  path?: string
  line?: number | null
  message?: string
}

const MAX_PATH_CHARS = 1_000
const GIT_TIMEOUT_MS = 5_000
const REMOTES_TTL_MS = 10 * 60_000
const SEPARATOR = /[\\/]/

export async function openRunFile(deps: OpenFileDeps, input: OpenFileInput): Promise<OpenFileResult> {
  const { run } = input
  const candidates = typeof input.path === 'string' && input.path.length <= MAX_PATH_CHARS ? pathCandidates(input.path) : []
  if (candidates.length === 0) return { opened: false, message: NOT_A_FILE_PATH }

  const listed = await listWorkspaces(deps.call)
  const focused = await focusedWorkspace(deps.call, listed)
  const local = listed.filter(isLocalWorkspace)
  const focusedLocal = local.find(entry => entry.id === focused?.id) ?? null
  const repo = run.repository?.name ?? focusedLocal?.name ?? ''
  const pool = run.repository ? await repositoryWorkspaces(deps, run, local, focusedLocal) : focusedLocal ? [focusedLocal] : []
  if (pool.length === 0) return { opened: false, message: run.repository ? noRepoWorkspace(repo) : NO_LOCAL_WORKSPACE_FILE }

  for (const candidate of candidates) {
    for (const workspace of pool) {
      if (!(await deps.isFileInside(workspace.path, candidate))) continue
      await deps.call('editor.open', { workspaceId: workspace.id, path: candidate })
      return { opened: true, path: candidate, line: input.line }
    }
  }
  return { opened: false, message: fileNotFound(input.path.split(SEPARATOR).pop() ?? input.path, repo) }
}

export function gitRemotes(run: RunCommand, gitPath: string | null, now: () => number): (workspacePath: string) => Promise<AdoRemote[]> {
  const cache = new Map<string, { at: number; remotes: AdoRemote[] }>()
  return async workspacePath => {
    if (!gitPath) return []
    const cached = cache.get(workspacePath)
    if (cached && now() - cached.at < REMOTES_TTL_MS) return cached.remotes
    const result = await run(gitPath, ['-C', workspacePath, 'remote', '-v'], { timeoutMs: GIT_TIMEOUT_MS })
    const remotes = result.code === 0 ? remotesOf(result.stdout) : []
    const at = now()
    for (const [key, entry] of cache) if (at - entry.at >= REMOTES_TTL_MS) cache.delete(key)
    cache.set(workspacePath, { at, remotes })
    return remotes
  }
}

export function fileInside(fs: Pick<typeof import('node:fs/promises'), 'realpath' | 'stat'>): (root: string, relative: string) => Promise<boolean> {
  return async (root, relative) => {
    try {
      const base = await fs.realpath(root)
      const target = await fs.realpath(path.join(root, relative))
      const prefix = base.endsWith(path.sep) ? base : base + path.sep
      return target.startsWith(prefix) && (await fs.stat(target)).isFile()
    } catch {
      return false
    }
  }
}

async function repositoryWorkspaces(
  deps: OpenFileDeps,
  run: RunSummary,
  local: WorkspaceEntry[],
  focusedLocal: WorkspaceEntry | null
): Promise<WorkspaceEntry[]> {
  if (!deps.gitAvailable) return focusedLocal ? [focusedLocal] : []
  const target = { org: run.org, project: run.projectName, repo: run.repository?.name ?? '' }
  return (await workspacesOfRepo(deps, local, target))
    .map(({ workspace }) => workspace)
    .sort((a, b) => rank(a, run, focusedLocal) - rank(b, run, focusedLocal))
}

function rank(workspace: WorkspaceEntry, run: RunSummary, focusedLocal: WorkspaceEntry | null): number {
  return (workspace.branch === run.branch ? 0 : 2) + (workspace.id === focusedLocal?.id ? 0 : 1)
}
