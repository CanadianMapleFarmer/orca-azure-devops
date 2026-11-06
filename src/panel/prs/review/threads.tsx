import { Button, Callout, Card, EmptyState, Markdown, RelativeTime, Row, Stack, Text, Textarea, type OrcaNode } from 'orca'
import { isResolved, MAX_REVIEW_COMMENT, THREAD_STATUS_LABEL, type PrReview, type ReviewThread } from '../../../shared/reviews'
import { cutLabel } from '../../label'
import { anchorTitle, fitThreads } from './fit'
import { draftOf, isRunning, markThread, reply, resultOf, setDraft } from './state'

const hiddenNote = (count: number): string =>
  count === 1 ? '1 more reply is in Azure DevOps.' : `${count} more replies are in Azure DevOps.`

export function ResultCallout({ slot }: { slot: string }): OrcaNode {
  const result = resultOf(slot)
  if (!result) return null
  return <Callout tone={!result.ok ? 'danger' : result.warn ? 'warning' : 'success'}>{result.message}</Callout>
}

export function ThreadCard({ thread }: { thread: ReviewThread }): OrcaNode {
  const slot = `thread:${thread.id}`
  const busy = isRunning(slot)
  const resolved = isResolved(thread.status)
  return (
    <Card title={cutLabel(anchorTitle(thread.anchor))} description={THREAD_STATUS_LABEL[thread.status]}>
      <Stack gap="sm">
        {thread.comments.map(comment => (
          <Stack key={comment.id} gap="xs">
            <Text size="sm" weight="medium">
              {`${comment.author} · `}
              <RelativeTime at={comment.at} />
            </Text>
            <Markdown content={comment.content} />
          </Stack>
        ))}
        {thread.hidden > 0 ? (
          <Text size="sm" muted>
            {hiddenNote(thread.hidden)}
          </Text>
        ) : null}
        <Textarea label="Reply" rows={2} maxLength={MAX_REVIEW_COMMENT} value={draftOf(slot)} disabled={busy} onChange={text => setDraft(slot, text)} />
        <Row gap="sm">
          <Button size="sm" disabled={busy} onPress={() => reply(thread.id, draftOf(slot))}>
            Reply
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => markThread(thread.id, resolved ? 'active' : 'fixed')}>
            {resolved ? 'Reactivate' : 'Resolve'}
          </Button>
        </Row>
        <ResultCallout slot={slot} />
      </Stack>
    </Card>
  )
}

export function ThreadsLeftOut({ shown, total }: { shown: number; total: number }): OrcaNode {
  if (shown >= total) return null
  return (
    <Text size="sm" muted>
      {`Showing ${shown} of ${total} comment threads. Open the pull request in Azure DevOps for the rest.`}
    </Text>
  )
}

export function CommentsSection({ review }: { review: PrReview }): OrcaNode {
  const { shown } = fitThreads(review.threads)
  if (shown.length === 0 && review.threadCount === 0) {
    return <EmptyState title="No comments yet" description="Comments on this pull request show up here." />
  }
  return (
    <Stack gap="md">
      {shown.map(thread => (
        <ThreadCard key={thread.id} thread={thread} />
      ))}
      <ThreadsLeftOut shown={shown.length} total={review.threadCount} />
    </Stack>
  )
}
