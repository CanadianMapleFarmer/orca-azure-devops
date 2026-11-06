import { Box, Callout, Collapsible, EmptyState, IconButton, List, ListItem, read, RelativeTime, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type PrSnapshot, type PrSummary, type ReleaseSet } from '../../shared/prs'
import { votePhrase } from '../../shared/reviews'
import type { OrgStatus } from '../../shared/types'
import { cutLabel } from '../label'
import { Channels, openChannels } from '../share/channels'
import { Composer } from '../share/composer'
import { shareView } from '../share/state'
import { LoadFailure, SnapshotMessage } from '../snapshot-parts'
import { ReleaseSetCard } from './release-set'
import { ReviewView } from './review/review-view'
import { openReview, showReview } from './review/state'
import { load, notice, refresh, refreshing, retryLoad, setToReviewOpen, snapshot, toReviewOpen } from './state'

const MAX_SETS = 30
const MAX_ROWS = 150
const MAX_TO_REVIEW = 50
const MAX_REVIEWED = 50

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
        <Row gap="xs" align="center">
          <IconButton icon="settings" label="Teams channels" variant="ghost" size="sm" onPress={() => openChannels('prs')} />
          <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={read(refreshing)} onPress={() => refresh(org)} />
        </Row>
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
        <ReleaseSetCard key={set.key} org={org} me={current.me} set={set} limit={limit} />
      ))}
      {shown.length < current.sets.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${current.sets.length} sets.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function myVoteOn(pr: PrSummary, me: string | null): number {
  return pr.reviewers.find(reviewer => me !== null && reviewer.id.toLowerCase() === me.toLowerCase())?.vote ?? 0
}

function ReviewInbox({ current }: { current: PrSnapshot }): OrcaNode {
  if (current.toReviewCount === 0 && current.toReview.length === 0 && current.reviewed.length === 0) return null
  const shown = current.toReview.slice(0, MAX_TO_REVIEW)
  const reviewed = current.reviewed.slice(0, MAX_REVIEWED)
  return (
    <Collapsible title={`To review (${current.toReviewCount})`} open={read(toReviewOpen)} onChange={setToReviewOpen}>
      <Stack gap="sm">
        {shown.length > 0 ? (
          <List label="To review">
            {shown.map(pr => (
              <ListItem
                key={pr.prId}
                title={cutLabel(pr.title)}
                description={cutLabel(`Pull Request ${pr.prId} · ${pr.repoName} · ${pr.createdBy.name}`)}
                onPress={() => showReview(current.org, pr)}
              />
            ))}
          </List>
        ) : null}
        {current.toReviewCount > shown.length ? (
          <Text size="sm" muted>
            {`Showing ${shown.length} of ${current.toReviewCount} pull requests.`}
          </Text>
        ) : null}
        {reviewed.length > 0 ? (
          <Stack gap="xs">
            <Text size="sm" weight="semibold">
              Reviewed by you
            </Text>
            <List label="Reviewed by you">
              {reviewed.map(pr => (
                <ListItem
                  key={pr.prId}
                  title={cutLabel(pr.title)}
                  description={cutLabel(`Pull Request ${pr.prId} · ${pr.repoName} · ${pr.createdBy.name} · you: ${votePhrase(myVoteOn(pr, current.me))}`)}
                  onPress={() => showReview(current.org, pr)}
                />
              ))}
            </List>
          </Stack>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

export function PrsTab({ org }: { org: OrgStatus }): OrcaNode {
  const shown = shareView('prs')
  if (shown === 'composer') return <Composer />
  if (shown === 'channels') return <Channels />
  const opened = read(openReview)
  if (opened && opened.org === org.org) return <ReviewView org={org} />
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
      <ReviewInbox current={current} />
    </Stack>
  )
}
