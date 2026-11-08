import { Collapsible, EmptyState, type OrcaNode } from 'orca'
import { CHOOSE_ALL, nothingIn, repoCount } from './copy'
import { isFoldOpen, setFoldOpen, type FoldTab } from './folds'
import type { Choices, ProjectGroup } from './grouping'
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
      title={cutLabel(title)}
      description={cutLabel(hint ? `${count} · ${hint}` : count)}
      open={open}
      onChange={next => setFoldOpen(org, tab, foldKey, next)}
    >
      {open ? children : null}
    </Collapsible>
  )
}

export function ScopedEmpty({ choices, title, description }: { choices: Choices; title: string; description: string }): OrcaNode {
  const project = choices.projects.find(each => each.id === choices.scope.project)
  if (project) return <EmptyState title={cutLabel(nothingIn(project.name))} description={CHOOSE_ALL} />
  return <EmptyState title={title} description={description} />
}
