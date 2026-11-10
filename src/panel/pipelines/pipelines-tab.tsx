import { Callout, read, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { RunFilter, RunsSnapshot, RunSummary } from '../../shared/pipelines'
import { failedRuns, isActive, needsMe, runCounts, runsFor } from '../../shared/runs'
import type { OrgStatus } from '../../shared/types'
import { counted, needYouHint } from '../copy'
import { Groups, ScopedEmpty, type Layout } from '../group'
import { choicesOf, groupByPlace, inScope, type Choices } from '../grouping'
import { runsPrefs, scopeIn } from '../prefs'
import { Channels, openChannels } from '../share/channels'
import { Composer } from '../share/composer'
import { shareView } from '../share/state'
import { LoadFailure } from '../snapshot-parts'
import { foldActions, ScopePickers, Segmented, TabToolbar, type ToolAction } from '../toolbar'
import { RunCard } from './run-card'
import { load, notice, refresh, refreshing, retryLoad, runFilter, runPlaces, selectFilter, snapshot } from './state'

const MAX_RUNS = 30

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

function Filters({ filter, current, now }: { filter: RunFilter; current: RunsSnapshot; now: number }): OrcaNode {
  const counts = runCounts(current.runs, now)
  const numbers: Partial<Record<RunFilter, number>> = { needsMe: counts.approvals, failed: counts.failedRuns }
  return (
    <Segmented<RunFilter>
      label="Runs filter"
      value={filter}
      options={FILTERS.map(({ id, label }) => ({ value: id, label: (numbers[id] ?? 0) > 0 ? `${label} · ${numbers[id]}` : label }))}
      onChange={selectFilter}
    />
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
          <ScopePickers org={org} choices={choices} prefs={runsPrefs} />
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

function Runs({ view, current, choices, now }: { view: View; current: RunsSnapshot; choices: Choices; now: number }): OrcaNode {
  const runs = inScope(runsFor(view.filter, current.runs, now), runPlaces, choices.scope)
  if (runs.length === 0) return <ScopedEmpty choices={choices} title={EMPTY[view.filter].title} description={EMPTY[view.filter].description} />
  const shown = runs.slice(0, MAX_RUNS)
  const layout: Layout<RunSummary> = {
    count: items => counted(items.length, 'run', 'runs'),
    hint: items => hintOf(items, view.failed),
    draw: items => <Cards view={view} runs={items} />
  }
  return (
    <Stack gap="sm">
      <Groups org={view.org} tab="pipelines" grouped={groupByPlace(shown, runPlaces)} layout={layout} />
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
