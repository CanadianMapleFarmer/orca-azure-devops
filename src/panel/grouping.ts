export interface Place {
  projectId: string
  projectName: string
  repoId: string | null
  repoName: string | null
}
export interface RepoGroup<T> {
  key: string
  repoName: string | null
  items: T[]
}
export interface ProjectGroup<T> {
  key: string
  projectId: string
  projectName: string
  repoName: string | null
  repoCount: number
  loose: T[]
  repos: RepoGroup<T>[]
  count: number
}
export interface Grouped<T> {
  across: T[]
  projects: ProjectGroup<T>[]
}
export type PlaceChip = 'repo' | 'project' | null
export interface Scope {
  project: string | null
  repo: string | null
}
export interface Choices {
  projects: { id: string; name: string }[]
  repos: { id: string; name: string }[]
  scope: Scope
}

export const ACROSS_PROJECTS_KEY = 'across-projects'

interface Named {
  id: string
  name: string
}
interface Placed<T> {
  item: T
  repos: Named[]
}

const byName = (a: Named, b: Named): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)

function uniqueById(named: readonly Named[]): Named[] {
  const seen = new Map<string, Named>()
  for (const each of named) if (!seen.has(each.id)) seen.set(each.id, each)
  return [...seen.values()]
}

const projectsOf = (places: readonly Place[]): Named[] => uniqueById(places.map(place => ({ id: place.projectId, name: place.projectName })))

const reposOf = (places: readonly Place[]): Named[] =>
  uniqueById(places.flatMap(place => (place.repoId === null ? [] : [{ id: place.repoId, name: place.repoName ?? place.repoId }])))

function projectGroup<T>(project: Named, placed: readonly Placed<T>[]): ProjectGroup<T> {
  const key = `project:${project.id}`
  const repos = uniqueById(placed.flatMap(entry => entry.repos))
  const base = { key, projectId: project.id, projectName: project.name, repoCount: repos.length, count: placed.length }
  if (repos.length <= 1) return { ...base, repoName: repos[0]?.name ?? null, loose: placed.map(entry => entry.item), repos: [] }

  const loose: T[] = []
  const acrossRepos: T[] = []
  const byRepo = new Map<string, T[]>()
  for (const { item, repos: own } of placed) {
    if (own.length === 0) loose.push(item)
    else if (own.length > 1) acrossRepos.push(item)
    else byRepo.set(own[0].id, [...(byRepo.get(own[0].id) ?? []), item])
  }
  const groups: RepoGroup<T>[] = acrossRepos.length > 0 ? [{ key: `${key}/across-repos`, repoName: null, items: acrossRepos }] : []
  for (const repo of repos.filter(each => byRepo.has(each.id)).sort(byName)) {
    groups.push({ key: `${key}/repo:${repo.id}`, repoName: repo.name, items: byRepo.get(repo.id) ?? [] })
  }
  return { ...base, repoName: null, loose, repos: groups }
}

export function groupByPlace<T>(items: readonly T[], places: (item: T) => readonly Place[]): Grouped<T> {
  const across: T[] = []
  const byProject = new Map<string, { project: Named; placed: Placed<T>[] }>()
  for (const item of items) {
    const own = places(item)
    const projects = projectsOf(own)
    if (projects.length !== 1) {
      across.push(item)
      continue
    }
    const entry = byProject.get(projects[0].id) ?? { project: projects[0], placed: [] }
    entry.placed.push({ item, repos: reposOf(own) })
    byProject.set(entry.project.id, entry)
  }
  const projects = [...byProject.values()].sort((a, b) => byName(a.project, b.project))
  return { across, projects: projects.map(({ project, placed }) => projectGroup(project, placed)) }
}

export function choicesOf<T>(items: readonly T[], places: (item: T) => readonly Place[], stored: Scope): Choices {
  const all = items.flatMap(item => places(item))
  const projects = projectsOf(all).sort(byName)
  const project = projects.some(each => each.id === stored.project) ? stored.project : null
  const named = reposOf(all.filter(place => place.projectId === project))
  const repos = named.length > 1 ? named.sort(byName) : []
  const repo = repos.some(each => each.id === stored.repo) ? stored.repo : null
  return { projects, repos, scope: { project, repo } }
}

export function inScope<T>(items: readonly T[], places: (item: T) => readonly Place[], scope: Scope): T[] {
  if (scope.project === null) return [...items]
  return items.filter(item =>
    places(item).some(place => place.projectId === scope.project && (scope.repo === null || place.repoId === scope.repo))
  )
}
