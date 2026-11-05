import { Box, Button, Callout, Collapsible, EmptyState, IconButton, List, ListItem, read, RelativeTime, Row, shell, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { AutoCompleteOptions, MergeStrategy, PrSnapshot, ReleaseSet } from '../../shared/prs'
import type { OrgStatus } from '../../shared/types'
import { ReleaseSetCard } from './release-set'
import { load, notice, refresh, refreshing, retryLoad, snapshot } from './state'

const MAX_SETS = 30
const MAX_ROWS = 150
const MAX_TO_REVIEW = 50

const MERGE_LABELS: Record<MergeStrategy, string> = {
  noFastForward: 'Merge (no fast-forward)',
  squash: 'Squash commit',
  rebase: 'Rebase and fast-forward',
  rebaseMerge: 'Semi-linear merge'
}

const optionsLine = (options: AutoCompleteOptions): string =>
  `Auto-complete uses ${MERGE_LABELS[options.mergeStrategy]}, ${options.deleteSourceBranch ? 'deletes' : 'keeps'} the source branch, ${options.transitionWorkItems ? 'completes linked work items' : 'leaves work items alone'}. Change this in Settings → Azure DevOps.`

const openPr = (url: string): void => {
  shell.openExternal(url).catch(() => {})
}

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
      {current.message && current.stale ? (
        <Text size="sm" tone="warning">
          {current.message}
        </Text>
      ) : null}
      {current.message && !current.stale ? (
        <Text size="sm" muted>
          {current.message}
        </Text>
      ) : null}
    </Stack>
  )
}

function setsToShow(sets: readonly ReleaseSet[]): ReleaseSet[] {
  const shown: ReleaseSet[] = []
  let rows = 0
  for (const set of sets.slice(0, MAX_SETS)) {
    if (shown.length > 0 && rows + set.prs.length > MAX_ROWS) break
    shown.push(set)
    rows += set.prs.length
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
      {shown.map(set => (
        <ReleaseSetCard key={set.key} org={org} set={set} />
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
  return (
    <Collapsible title={`To review (${current.toReviewCount})`}>
      <Stack gap="sm">
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
    return (
      <Stack gap="sm">
        <Callout tone="danger">{status.message}</Callout>
        <Row gap="sm">
          <Button onPress={retryLoad}>Try again</Button>
        </Row>
      </Stack>
    )
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
