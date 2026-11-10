import { Collapsible, EmptyState, Stack, type OrcaNode } from 'orca'
import { ACROSS_PROJECTS, ACROSS_REPOS, CHOOSE_ALL, nothingIn, repoCount } from './copy'
import { isFoldOpen, setFoldOpen, type FoldTab } from './folds'
import { ACROSS_PROJECTS_KEY, type Choices, type Grouped, type PlaceChip, type ProjectGroup } from './grouping'
import { cutLabel } from './label'

export function projectTitle(project: Pick<ProjectGroup<unknown>, 'projectName' | 'repoName' | 'repoCount'>): string {
  if (project.repoCount > 1) return `${project.projectName} · ${repoCount(project.repoCount)}`
  return project.repoName === null ? project.projectName : `${project.projectName} · ${project.repoName}`
}

interface GroupProps {
  org: string
  tab: FoldTab
  foldKey: string
  title: string
  count: string
  hint?: string
  natural?: boolean
  children?: OrcaNode
}

export function Group({ org, tab, foldKey, title, count, hint, natural = true, children }: GroupProps): OrcaNode {
  const open = isFoldOpen(org, tab, foldKey, natural)
  return (
    <Collapsible
      title={cutLabel(`${title} · ${count}`)}
      description={hint ? cutLabel(hint) : undefined}
      open={open}
      onChange={next => setFoldOpen(org, tab, foldKey, next)}
    >
      {open ? children : null}
    </Collapsible>
  )
}

export interface Layout<T> {
  prefix?: string
  count: (items: readonly T[]) => string
  hint: (items: readonly T[]) => string | undefined
  draw: (items: readonly T[], place: PlaceChip) => OrcaNode
}

export function Groups<T>({ org, tab, grouped, layout }: { org: string; tab: FoldTab; grouped: Grouped<T>; layout: Layout<T> }): OrcaNode {
  const group = (key: string, title: string, items: readonly T[], children: OrcaNode): OrcaNode => (
    <Group
      key={key}
      org={org}
      tab={tab}
      foldKey={layout.prefix ? `${layout.prefix}/${key}` : key}
      title={title}
      count={layout.count(items)}
      hint={layout.hint(items)}
    >
      {children}
    </Group>
  )
  return (
    <>
      {grouped.across.length > 0 ? group(ACROSS_PROJECTS_KEY, ACROSS_PROJECTS, grouped.across, layout.draw(grouped.across, 'project')) : null}
      {grouped.projects.map(project =>
        group(
          project.key,
          projectTitle(project),
          [...project.loose, ...project.repos.flatMap(repo => repo.items)],
          project.repos.length === 0 ? (
            layout.draw(project.loose, null)
          ) : (
            <Stack gap="sm">
              {project.loose.length > 0 ? layout.draw(project.loose, null) : null}
              {project.repos.map(repo => group(repo.key, repo.repoName ?? ACROSS_REPOS, repo.items, layout.draw(repo.items, repo.repoName === null ? 'repo' : null)))}
            </Stack>
          )
        )
      )}
    </>
  )
}

export function ScopedEmpty({ choices, title, description }: { choices: Choices; title: string; description: string }): OrcaNode {
  const project = choices.projects.find(each => each.id === choices.scope.project)
  if (project) return <EmptyState title={cutLabel(nothingIn(project.name))} description={CHOOSE_ALL} />
  return <EmptyState title={title} description={description} />
}
