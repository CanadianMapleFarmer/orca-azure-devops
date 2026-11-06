import { Box, Button, Callout, EmptyState, IconButton, read, RelativeTime, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { RunFilter, RunsSnapshot } from '../../shared/pipelines'
import { runCounts, runsFor } from '../../shared/runs'
import type { OrgStatus } from '../../shared/types'
import { Channels, openChannels } from '../share/channels'
import { Composer } from '../share/composer'
import { shareView } from '../share/state'
import { LoadFailure, SnapshotMessage } from '../snapshot-parts'
import { RunCard } from './run-card'
import { load, notice, refresh, refreshing, retryLoad, runFilter, selectFilter, snapshot } from './state'

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

function Header({ org, current }: { org: string; current: RunsSnapshot }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Box grow shrink minWidth={0}>
          <Text muted size="sm">
            Updated <RelativeTime at={current.updatedAt} />
          </Text>
        </Box>
        <Row gap="xs" align="center">
          <IconButton icon="settings" label="Teams channels" variant="ghost" size="sm" onPress={() => openChannels('pipelines')} />
          <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={read(refreshing)} onPress={() => refresh(org)} />
        </Row>
      </Row>
      <SnapshotMessage message={current.message} stale={current.stale} />
    </Stack>
  )
}

function Filters({ filter, current, now }: { filter: RunFilter; current: RunsSnapshot; now: number }): OrcaNode {
  const counts = runCounts(current.runs, now)
  const counted: Partial<Record<RunFilter, number>> = { needsMe: counts.approvals, failed: counts.failedRuns }
  return (
    <Row gap="xs" wrap>
      {FILTERS.map(({ id, label }) => (
        <Button key={id} size="sm" variant={id === filter ? 'solid' : 'ghost'} onPress={() => selectFilter(id)}>
          {(counted[id] ?? 0) > 0 ? `${label} · ${counted[id]}` : label}
        </Button>
      ))}
    </Row>
  )
}

function Runs({ org, filter, current, now }: { org: string; filter: RunFilter; current: RunsSnapshot; now: number }): OrcaNode {
  const runs = runsFor(filter, current.runs, now)
  if (runs.length === 0) return <EmptyState title={EMPTY[filter].title} description={EMPTY[filter].description} />
  const shown = runs.slice(0, MAX_RUNS)
  return (
    <Stack gap="sm">
      {shown.map(run => (
        <RunCard key={run.buildId} org={org} me={current.me} run={run} />
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
  return (
    <Stack gap="md">
      <Header org={org.org} current={current} />
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      <Filters filter={filter} current={current} now={now} />
      <Runs org={org.org} filter={filter} current={current} now={now} />
    </Stack>
  )
}
