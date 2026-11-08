import { Button, Callout, EmptyState, read, Row, Select, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { RunFilter, RunsSnapshot, RunSummary } from '../../shared/pipelines'
import { failedRuns, isActive, needsMe, runCounts, runsFor } from '../../shared/runs'
import type { OrgStatus } from '../../shared/types'
import { ACROSS_PROJECTS, ACROSS_REPOS, ALL_PROJECTS, ALL_REPOS, CHOOSE_ALL, counted, needYouHint, nothingIn, repoCount } from '../copy'
import { Group } from '../group'
import { ACROSS_PROJECTS_KEY, choicesOf, groupByPlace, inScope, type Choices, type ProjectGroup } from '../grouping'
import { cutLabel } from '../label'
import { chooseProject, chooseRepo, runsPrefs, scopeIn } from '../prefs'
import { Channels, openChannels } from '../share/channels'
import { Composer } from '../share/composer'
import { shareView } from '../share/state'
import { LoadFailure } from '../snapshot-parts'
import { foldActions, TabToolbar, type ToolAction } from '../toolbar'
import { RunCard } from './run-card'
import { load, notice, refresh, refreshing, retryLoad, runFilter, runPlaces, selectFilter, snapshot } from './state'

const MAX_RUNS = 30
const ALL = '*'

const FILTERS: { id: RunFilter; label: string }[] = [
  { id: 'mine', label: 'Mine' },
  { id: 'running', label: 'Running' },
  { id: 'needsMe', label: 'Needs me' },
  { id: 'failed', label: 'Failed' }
]

const EMPTY: Record<RunFilter, { title: string; description: string }> = {
  mine: { title: 'No runs of yours in the last 7 days', description: "Runs you queue or trigger in this organization's code projects show up here." },
  running: { title: 'Nothing is running', description: 'Runs in progress in your code projects show up here.' },
  needsMe: { title: 'Nothing needs you', description: "Approvals you can give, and your runs waiting for someone else's, show up here." },
  failed: { title: 'No failed runs', description: 'Your runs that failed in the last 24 hours show up here until a newer run replaces them.' }
}

const filterOf = (stored: string): RunFilter => FILTERS.find(item => item.id === stored)?.id ?? 'mine'

interface View {
  org: string
  me: string | null
  filter: RunFilter
  failed: ReadonlySet<number>
}

function Pickers({ org, choices }: { org: string; choices: Choices }): OrcaNode {
  return (
    <>
      <Select
        label="Project"
        labelHidden
        value={choices.scope.project ?? ALL}
        options={[{ value: ALL, label: ALL_PROJECTS }, ...choices.projects.map(project => ({ value: project.id, label: cutLabel(project.name) }))]}
        onChange={value => chooseProject(runsPrefs, org, value === ALL ? null : value)}
      />
      {choices.repos.length > 0 ? (
        <Select
          label="Repository"
          labelHidden
          value={choices.scope.repo ?? ALL}
          options={[{ value: ALL, label: ALL_REPOS }, ...choices.repos.map(repo => ({ value: repo.id, label: cutLabel(repo.name) }))]}
          onChange={value => chooseRepo(runsPrefs, org, value === ALL ? null : value)}
        />
      ) : null}
    </>
  )
}

function Filters({ filter, current, now }: { filter: RunFilter; current: RunsSnapshot; now: number }): OrcaNode {
  const counts = runCounts(current.runs, now)
  const numbers: Partial<Record<RunFilter, number>> = { needsMe: counts.approvals, failed: counts.failedRuns }
  return (
    <Row gap="xs" wrap>
      {FILTERS.map(({ id, label }) => (
        <Button key={id} size="sm" variant={id === filter ? 'solid' : 'ghost'} onPress={() => selectFilter(id)}>
          {(numbers[id] ?? 0) > 0 ? `${label} · ${numbers[id]}` : label}
        </Button>
      ))}
    </Row>
  )
}

function Toolbar({ org, filter, current, choices, now }: { org: string; filter: RunFilter; current: RunsSnapshot; choices: Choices; now: number }): OrcaNode {
  const actions: ToolAction[] = [
    ...foldActions(org, 'pipelines'),
    { icon: 'refresh', label: 'Refresh', disabled: read(refreshing), onPress: () => refresh(org) },
    { icon: 'settings', label: 'Teams channels', onPress: () => openChannels('pipelines') }
  ]
  return (
    <TabToolbar
      left={
        <>
          <Pickers org={org} choices={choices} />
          <Filters filter={filter} current={current} now={now} />
        </>
      }
      actions={actions}
      updatedAt={current.updatedAt}
      message={current.message}
      stale={current.stale}
    />
  )
}

function Cards({ view, runs }: { view: View; runs: readonly RunSummary[] }): OrcaNode {
  return (
    <Stack gap="sm">
      {runs.map(run => (
        <RunCard key={run.buildId} org={view.org} me={view.me} filter={view.filter} run={run} />
      ))}
    </Stack>
  )
}

function hintOf(runs: readonly RunSummary[], failed: ReadonlySet<number>): string | undefined {
  const needing = runs.filter(needsMe).length
  if (needing > 0) return needYouHint(needing)
  const broken = runs.filter(run => failed.has(run.buildId)).length
  if (broken > 0) return `${broken} failed`
  const active = runs.filter(isActive).length
  return active > 0 ? `${active} running` : undefined
}

interface RunGroupProps {
  view: View
  foldKey: string
  title: string
  runs: readonly RunSummary[]
  children: OrcaNode
}

function RunGroup({ view, foldKey, title, runs, children }: RunGroupProps): OrcaNode {
  return (
    <Group org={view.org} tab="pipelines" foldKey={foldKey} title={title} count={counted(runs.length, 'run', 'runs')} hint={hintOf(runs, view.failed)}>
      {children}
    </Group>
  )
}

function projectTitle(project: ProjectGroup<RunSummary>): string {
  if (project.repoCount > 1) return `${project.projectName} · ${repoCount(project.repoCount)}`
  return project.repoName === null ? project.projectName : `${project.projectName} · ${project.repoName}`
}

function ProjectRuns({ view, project }: { view: View; project: ProjectGroup<RunSummary> }): OrcaNode {
  const runs = [...project.loose, ...project.repos.flatMap(repo => repo.items)]
  return (
    <RunGroup view={view} foldKey={project.key} title={projectTitle(project)} runs={runs}>
      {project.repos.length === 0 ? (
        <Cards view={view} runs={project.loose} />
      ) : (
        <Stack gap="sm">
          {project.loose.length > 0 ? <Cards view={view} runs={project.loose} /> : null}
          {project.repos.map(repo => (
            <RunGroup key={repo.key} view={view} foldKey={repo.key} title={repo.repoName ?? ACROSS_REPOS} runs={repo.items}>
              <Cards view={view} runs={repo.items} />
            </RunGroup>
          ))}
        </Stack>
      )}
    </RunGroup>
  )
}

function Runs({ view, current, choices, now }: { view: View; current: RunsSnapshot; choices: Choices; now: number }): OrcaNode {
  const runs = inScope(runsFor(view.filter, current.runs, now), runPlaces, choices.scope)
  if (runs.length === 0) {
    const project = choices.projects.find(each => each.id === choices.scope.project)
    if (project) return <EmptyState title={cutLabel(nothingIn(project.name))} description={CHOOSE_ALL} />
    return <EmptyState title={EMPTY[view.filter].title} description={EMPTY[view.filter].description} />
  }
  const shown = runs.slice(0, MAX_RUNS)
  const grouped = groupByPlace(shown, runPlaces)
  return (
    <Stack gap="sm">
      {grouped.across.length > 0 ? (
        <RunGroup view={view} foldKey={ACROSS_PROJECTS_KEY} title={ACROSS_PROJECTS} runs={grouped.across}>
          <Cards view={view} runs={grouped.across} />
        </RunGroup>
      ) : null}
      {grouped.projects.map(project => (
        <ProjectRuns key={project.key} view={view} project={project} />
      ))}
      {shown.length < runs.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${runs.length} runs.`}
        </Text>
      ) : null}
    </Stack>
  )
}

export function PipelinesTab({ org }: { org: OrgStatus }): OrcaNode {
  const shown = shareView('pipelines')
  if (shown === 'composer') return <Composer />
  if (shown === 'channels') return <Channels />
  const stored = read(snapshot)
  const current = stored?.org === org.org ? stored : null
  const status = read(load)
  if (!current) {
    if (status.status !== 'failed') return <Skeleton lines={3} label="Loading pipeline runs" />
    return <LoadFailure message={status.message} onRetry={retryLoad} />
  }
  const failure = read(notice)
  const filter = filterOf(read(runFilter))
  const now = Date.now()
  const choices = choicesOf(current.runs, runPlaces, scopeIn(read(runsPrefs) ?? {}, org.org))
  const failed = new Set(failedRuns(current.runs, now).map(run => run.buildId))
  return (
    <Stack gap="md">
      <Toolbar org={org.org} filter={filter} current={current} choices={choices} now={now} />
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      <Runs view={{ org: org.org, me: current.me, filter, failed }} current={current} choices={choices} now={now} />
    </Stack>
  )
}
