import type { RepoSource, StartRepo } from '../../src/shared/work'
import { CODE_REPOS_KEY } from '../ado/code-projects'
import { mapLimit } from '../ado/limit'
import type { PrRef } from '../ado/workitems'
import type { OrgEntities } from '../data/entities'
import { prKey, type RepoRecord } from '../data/records'
import { GIT_REMOTES_FAILED } from '../messages'
import { isLocalWorkspace, type WorkspaceEntry } from './focused'
import { repoOfPullRequestUrl, sameRepo, type AdoRemote, type AdoRepo, type RemoteSet, type RemoteSets } from './remotes'

export interface LocalRepo { key: string; name: string; detail: string; ado: AdoRemote[]; workspaces: WorkspaceEntry[] }

type Group = Omit<LocalRepo, 'name'> & { name: string | null }

const REMOTE_LOOKUPS = 4
const ORIGIN = 'origin'
const LOCAL_DETAIL = 'local'
const SEPARATOR = /[\\/]/

export async function localRepos(deps: { remoteSets: RemoteSets; log: (message: string) => void }, listed: WorkspaceEntry[]): Promise<LocalRepo[]> {
  const worktrees = listed.filter(entry => isLocalWorkspace(entry) && entry.kind === 'worktree')
  const sets = await mapLimit(worktrees, REMOTE_LOOKUPS, workspace =>
    deps.remoteSets(workspace.path).catch(() => {
      deps.log(GIT_REMOTES_FAILED)
      return null
    })
  )
  const groups = new Map<string, Group>()
  worktrees.forEach((workspace, index) => {
    const set = sets[index]
    if (!set) return
    const identity = identityOf(workspace, set)
    const group = groups.get(identity.key) ?? { ...identity, ado: [], workspaces: [] }
    group.ado = withRemotes(group.ado, set.ado)
    group.workspaces.push(workspace)
    groups.set(identity.key, group)
  })
  return [...groups.values()].map(({ name, ...group }) => ({ ...group, name: name ?? folderName(shortestPath(group.workspaces)) }))
}

export function prRepos(org: string, refs: readonly PrRef[], tables: Pick<OrgEntities, 'codeRepos' | 'prs'>): AdoRepo[] {
  const listed = new Map((tables.codeRepos.get(CODE_REPOS_KEY)?.value ?? []).map(repo => [repo.id.toLowerCase(), repo]))
  const named = [...refs].sort((a, b) => b.prId - a.prId).flatMap(ref => repoOfRef(org, ref, listed, tables.prs) ?? [])
  return named.filter((repo, index) => named.findIndex(other => adoKey(other) === adoKey(repo)) === index)
}

export function rankRepos({ org, local, prs, remembered }: { org: string; local: LocalRepo[]; prs: AdoRepo[]; remembered: string[] }): StartRepo[] {
  const placed = new Set<LocalRepo>()
  const rows: StartRepo[] = []
  const place = (repos: LocalRepo[], source: RepoSource) => {
    for (const repo of repos) {
      if (placed.has(repo)) continue
      placed.add(repo)
      rows.push({ key: repo.key, name: repo.name, detail: shownDetail(repo, org), source })
    }
  }
  const byName = (repos: LocalRepo[]) => [...repos].sort((a, b) => a.name.localeCompare(b.name) || shownDetail(a, org).localeCompare(shownDetail(b, org)))
  const last = remembered.map(key => local.find(repo => repo.key === key)).find(repo => repo !== undefined)
  place(prs.flatMap(pr => byName(local.filter(repo => repo.ado.some(remote => sameRepo(remote, pr))))), 'pr')
  place(last ? [last] : [], 'last')
  place(byName(local.filter(repo => repo.ado.some(remote => sameName(remote.org, org)))), 'org')
  place(byName(local), 'other')
  return rows
}

export function defaultRepo(ranked: StartRepo[]): string | null {
  const first = ranked[0]
  return first && (first.source === 'pr' || first.source === 'last') ? first.key : null
}

function identityOf(workspace: WorkspaceEntry, set: RemoteSet): Omit<Group, 'ado' | 'workspaces'> {
  const ado = mainRemote(set.ado)
  if (ado) return { key: adoKey(ado), name: ado.repo, detail: ado.project || ado.repo }
  if (set.other) return { key: set.other.key, name: set.other.name, detail: set.other.host }
  return { key: workspace.project ? `project:${workspace.project}` : `path:${workspace.path}`, name: null, detail: LOCAL_DETAIL }
}

function mainRemote(remotes: AdoRemote[]): AdoRemote | undefined {
  return remotes.find(remote => remote.remote === ORIGIN) ?? remotes[0]
}

function withRemotes(known: AdoRemote[], more: AdoRemote[]): AdoRemote[] {
  const main = mainRemote(more)
  const merged = [...known]
  for (const remote of main ? [main, ...more] : more) if (!merged.some(each => adoKey(each) === adoKey(remote))) merged.push(remote)
  return merged
}

function repoOfRef(org: string, ref: PrRef, listed: Map<string, RepoRecord>, prs: OrgEntities['prs']): AdoRepo | null {
  const record = listed.get(ref.repoId.toLowerCase())
  if (record) return { org, project: record.projectName, repo: record.name }
  const url = prs.get(prKey(ref))?.value.url
  return url ? repoOfPullRequestUrl(url) : null
}

function shownDetail(repo: LocalRepo, org: string): string {
  const main = repo.ado[0]
  return main && !sameName(main.org, org) ? `${main.org}/${repo.detail}` : repo.detail
}

export function adoKey(remote: AdoRepo): string {
  return `${remote.org}/${remote.project || remote.repo}/${remote.repo}`.toLowerCase()
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function shortestPath(workspaces: WorkspaceEntry[]): string {
  return workspaces.map(entry => entry.path).reduce((shortest, path) => (path.length < shortest.length ? path : shortest))
}

function folderName(path: string): string {
  return path.split(SEPARATOR).filter(Boolean).at(-1) ?? path
}
