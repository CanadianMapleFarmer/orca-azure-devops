import {
  Badge,
  Button,
  Callout,
  Heading,
  IconButton,
  Link,
  List,
  ListItem,
  Markdown,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  type OrcaNode
} from 'orca'
import { MAX_REVIEW_COMMENT, VOTE_BUTTON, VOTE_VALUE, votePhrase, type PrReview, type VoteChoice } from '../../../shared/reviews'
import type { OrgStatus } from '../../../shared/types'
import { cutLabel } from '../../label'
import { LoadFailure, SnapshotMessage } from '../../snapshot-parts'
import { openPr, reviewNotice } from '../state'
import {
  armedMessage,
  cancelCheckout,
  checkout,
  closeReview,
  comment,
  commentDraft,
  isRunning,
  loadedReview,
  loadReviewWhenIdle,
  openReview,
  reloadReview,
  resultOf,
  reviewLoad,
  reviewSection,
  vote,
  type ReviewSection
} from './state'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const MAX_REVIEWERS = 100
const CHOICES: readonly VoteChoice[] = ['approve', 'suggestions', 'waitForAuthor', 'reject']
const VOTE_TONE: Record<VoteChoice, Tone> = { approve: 'success', suggestions: 'success', waitForAuthor: 'warning', reject: 'danger' }
const APPROVING_VOTE = 5
const REJECTED_VOTE = -10

const isSection = (value: string): value is ReviewSection => value === 'overview' || value === 'files' || value === 'comments'

const voteTone = (vote: number): Tone => (vote >= APPROVING_VOTE ? 'success' : vote > REJECTED_VOTE ? 'warning' : 'danger')

function ResultCallout({ slot }: { slot: string }): OrcaNode {
  const result = resultOf(slot)
  if (!result) return null
  return <Callout tone={!result.ok ? 'danger' : result.warn ? 'warning' : 'success'}>{result.message}</Callout>
}

function Header({ review }: { review: PrReview }): OrcaNode {
  const { pr } = review
  const notice = read(reviewNotice)
  const reload = read(reviewLoad)
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <IconButton icon="close" label="Back" variant="ghost" size="sm" onPress={() => closeReview()} />
        <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={reload.status === 'loading'} onPress={() => reloadReview()} />
      </Row>
      <Heading level={3}>{pr.title}</Heading>
      <Text muted size="sm">
        {`Pull Request ${pr.prId} · ${pr.repoName} · ${pr.source} → ${pr.target}`}
      </Text>
      <Text muted size="sm">
        {`${pr.createdBy.name} · opened `}
        <RelativeTime at={pr.createdAt} />
        {' · loaded '}
        <RelativeTime at={review.loadedAt} />
      </Text>
      {pr.isDraft || pr.mergeStatus === 'conflicts' || review.myVote !== 0 ? (
        <Row gap="xs" wrap>
          {pr.isDraft ? <Badge tone="neutral">draft</Badge> : null}
          {pr.mergeStatus === 'conflicts' ? <Badge tone="danger">conflicts</Badge> : null}
          {review.myVote !== 0 ? <Badge tone={voteTone(review.myVote)}>{`You: ${votePhrase(review.myVote)}`}</Badge> : null}
        </Row>
      ) : null}
      <Link onPress={() => openPr(pr.url)}>Open in Azure DevOps</Link>
      {notice ? <Callout tone="danger">{notice}</Callout> : null}
      <SnapshotMessage message={review.message} stale={false} />
      {reload.status === 'failed' ? <Callout tone="danger">{reload.message}</Callout> : null}
    </Stack>
  )
}

function Votes({ review }: { review: PrReview }): OrcaNode {
  const busy = isRunning('vote')
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {CHOICES.map(choice => (
          <Button
            key={choice}
            size="sm"
            tone={VOTE_TONE[choice]}
            variant={review.myVote === VOTE_VALUE[choice] ? 'solid' : 'outline'}
            disabled={busy}
            onPress={() => vote(choice)}
          >
            {VOTE_BUTTON[choice]}
          </Button>
        ))}
      </Row>
      <ResultCallout slot="vote" />
    </Stack>
  )
}

function Checkout(): OrcaNode {
  const instructions = armedMessage()
  const busy = isRunning('checkout')
  return (
    <Stack gap="xs">
      <Row gap="sm">
        <Button size="sm" variant="outline" icon="branch" disabled={busy} onPress={() => checkout()}>
          Check out in Orca
        </Button>
      </Row>
      {instructions !== null ? (
        <Callout tone="accent" title="Create the workspace in Orca">
          <Stack gap="xs">
            <Text size="sm">{instructions}</Text>
            <Text size="sm" muted>
              This applies to the next workspace you create in the next 10 minutes.
            </Text>
            <Row gap="sm">
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => cancelCheckout()}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      <ResultCallout slot="checkout" />
    </Stack>
  )
}

function Reviewers({ review }: { review: PrReview }): OrcaNode {
  const { reviewers } = review.pr
  return (
    <Stack gap="xs">
      <Text weight="semibold">Reviewers</Text>
      <List label="Reviewers">
        {reviewers.slice(0, MAX_REVIEWERS).map(reviewer => (
          <ListItem key={reviewer.id} title={cutLabel(`${reviewer.name}${reviewer.isRequired ? ' (required)' : ''}`)} description={votePhrase(reviewer.vote)} />
        ))}
      </List>
      {reviewers.length > MAX_REVIEWERS ? (
        <Text size="sm" muted>
          {`Showing ${MAX_REVIEWERS} of ${reviewers.length} reviewers.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function Overview({ review }: { review: PrReview }): OrcaNode {
  return (
    <Stack gap="md">
      {review.description.trim() === '' ? (
        <Text muted>No description.</Text>
      ) : (
        <Markdown content={review.description} />
      )}
      <Reviewers review={review} />
      <Stack gap="xs">
        <Textarea label="Add a comment" rows={3} maxLength={MAX_REVIEW_COMMENT} value={read(commentDraft)} onChange={text => set(commentDraft, text)} />
        <Row gap="sm">
          <Button disabled={isRunning('comment')} onPress={() => comment({ text: read(commentDraft) })}>
            Comment
          </Button>
        </Row>
        <ResultCallout slot="comment" />
      </Stack>
    </Stack>
  )
}

function Sections({ review }: { review: PrReview }): OrcaNode {
  const shown = read(reviewSection)
  return (
    <Tabs
      label="Pull request"
      value={shown}
      onChange={value => {
        if (isSection(value)) set(reviewSection, value)
      }}
    >
      <Tab value="overview" label="Overview">
        {shown === 'overview' ? <Overview review={review} /> : null}
      </Tab>
      <Tab value="files" label={`Files (${review.files.length}${review.moreFiles ? '+' : ''})`} />
      <Tab value="comments" label={`Comments (${review.threadCount})`} />
    </Tabs>
  )
}

export function ReviewView({ org }: { org: OrgStatus }): OrcaNode {
  const open = read(openReview)
  if (!open || open.org !== org.org) return null
  loadReviewWhenIdle()
  const loaded = read(loadedReview)
  if (!loaded) {
    const status = read(reviewLoad)
    return (
      <Stack gap="md">
        <Row>
          <IconButton icon="close" label="Back" variant="ghost" size="sm" onPress={() => closeReview()} />
        </Row>
        <Heading level={3}>{open.title}</Heading>
        {status.status === 'failed' ? <LoadFailure message={status.message} onRetry={reloadReview} /> : <Skeleton lines={4} label="Loading the pull request" />}
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <Header review={loaded} />
      <Votes review={loaded} />
      <Checkout />
      <Sections review={loaded} />
    </Stack>
  )
}
