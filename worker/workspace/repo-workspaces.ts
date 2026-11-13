import { mapLimit } from '../ado/limit'
import { GIT_REMOTES_FAILED } from '../messages'
import type { WorkspaceEntry } from './focused'
import { sameRepo, type AdoRemote } from './remotes'

export interface RepoWorkspacesDeps {
  remotes: (workspacePath: string) => Promise<AdoRemote[]>
  log: (message: string) => void
}

export interface RepoWorkspace {
  workspace: WorkspaceEntry
  remote: AdoRemote
}

const REMOTE_LOOKUPS = 4

export function workspacesOfRepo(
  deps: RepoWorkspacesDeps,
  local: WorkspaceEntry[],
  target: { org: string; project: string; repo: string }
): Promise<RepoWorkspace[]> {
  return workspacesWithRemote(deps, local, remote => sameRepo(remote, target))
}

export async function workspacesWithRemote(deps: RepoWorkspacesDeps, local: WorkspaceEntry[], matches: (remote: AdoRemote) => boolean): Promise<RepoWorkspace[]> {
  const known = await mapLimit(local, REMOTE_LOOKUPS, async workspace => ({
    workspace,
    remote: (await remotesOrNone(deps, workspace.path)).find(matches)
  }))
  return known.filter((entry): entry is RepoWorkspace => entry.remote !== undefined)
}

function remotesOrNone(deps: RepoWorkspacesDeps, workspacePath: string): Promise<AdoRemote[]> {
  return deps.remotes(workspacePath).catch(() => {
    deps.log(GIT_REMOTES_FAILED)
    return []
  })
}
