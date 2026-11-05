import { Box, Callout, Collapsible, EmptyState, IconButton, List, ListItem, read, RelativeTime, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type PrSnapshot, type ReleaseSet } from '../../shared/prs'
import type { OrgStatus } from '../../shared/types'
import { LoadFailure, SnapshotMessage } from '../snapshot-parts'
import { ReleaseSetCard } from './release-set'
import { load, notice, openPr, refresh, refreshing, retryLoad, reviewNotice, setToReviewOpen, snapshot, toReviewOpen } from './state'

const MAX_SETS = 30
const MAX_ROWS = 150
const MAX_TO_REVIEW = 50

const optionsLine = (options: AutoCompleteOptions): string =>
  `Auto-complete uses ${MERGE_STRATEGY_LABELS[options.mergeStrategy]}, ${options.deleteSourceBranch ? 'deletes' : 'keeps'} the source branch, ${options.transitionWorkItems ? 'completes linked work items' : 'leaves work items alone'}. Change this in Settings → Azure DevOps.`

function Header({ org, current }: { org: string; current: PrSnapshot }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Box grow shrink minWidth={0}>
          <Text muted size="sm">
            Updated <RelativeTime at={current.updatedAt} />
          </Text>
        </Box>
        <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={read(refreshing)} onPress={() => refresh(org)} />
      </Row>
      <SnapshotMessage message={current.message} stale={current.stale} />
    </Stack>
  )
}

interface Shown {
  set: ReleaseSet
  limit: number
}

function setsToShow(sets: readonly ReleaseSet[]): Shown[] {
  const shown: Shown[] = []
  let room = MAX_ROWS
  for (const set of sets.slice(0, MAX_SETS)) {
    if (shown.length > 0 && set.prs.length > room) break
    const limit = Math.min(set.prs.length, room)
    shown.push({ set, limit })
    room -= limit
  }
  return shown
}

function Sets({ org, current }: { org: string; current: PrSnapshot }): OrcaNode {
  if (current.sets.length === 0) {
    return <EmptyState title="No open pull requests of yours" description="Pull requests you create in this organization's code projects show up here." />
  }
  const shown = setsToShow(current.sets)
  return (
    <Stack gap="sm">
      <Text size="sm" muted>
        {optionsLine(current.autoComplete)}
      </Text>
      {shown.map(({ set, limit }) => (
        <ReleaseSetCard key={set.key} org={org} set={set} limit={limit} />
      ))}
      {shown.length < current.sets.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${current.sets.length} sets.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function ToReview({ current }: { current: PrSnapshot }): OrcaNode {
  if (current.toReviewCount === 0 && current.toReview.length === 0) return null
  const shown = current.toReview.slice(0, MAX_TO_REVIEW)
  const failure = read(reviewNotice)
  return (
    <Collapsible title={`To review (${current.toReviewCount})`} open={read(toReviewOpen)} onChange={setToReviewOpen}>
      <Stack gap="sm">
        {failure ? <Callout tone="danger">{failure}</Callout> : null}
        <List label="To review">
          {shown.map(pr => (
            <ListItem key={pr.prId} title={pr.title} description={`Pull Request ${pr.prId} · ${pr.repoName} · ${pr.createdBy.name}`} onPress={() => openPr(pr.url)} />
          ))}
        </List>
        {current.toReviewCount > shown.length ? (
          <Text size="sm" muted>
            {`Showing ${shown.length} of ${current.toReviewCount} pull requests.`}
          </Text>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

export function PrsTab({ org }: { org: OrgStatus }): OrcaNode {
  const stored = read(snapshot)
  const current = stored?.org === org.org ? stored : null
  const status = read(load)
  if (!current) {
    if (status.status !== 'failed') return <Skeleton lines={3} label="Loading pull requests" />
    return <LoadFailure message={status.message} onRetry={retryLoad} />
  }
  const failure = read(notice)
  return (
    <Stack gap="md">
      <Header org={org.org} current={current} />
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      <Sets org={org.org} current={current} />
      <ToReview current={current} />
    </Stack>
  )
}
