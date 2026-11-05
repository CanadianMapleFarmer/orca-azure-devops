import { Badge, Button, Callout, Card, Link, Row, Stack, Text, type OrcaNode } from 'orca'
import type { PrReviewer, PrSummary, ReleaseSet, RowResult } from '../../shared/prs'
import { act, isActing, outcomeOf, type Outcome } from './state'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
interface Chip {
  tone: Tone
  text: string
}

const APPROVING_VOTE = 5
const REJECTED_VOTE = -10

const isWaitedFor = (reviewer: PrReviewer): boolean =>
  reviewer.isRequired && !reviewer.hasDeclined && reviewer.vote > REJECTED_VOTE && reviewer.vote < APPROVING_VOTE

function statusChips(pr: PrSummary): Chip[] {
  if (pr.status === 'completed') return [{ tone: 'success', text: 'merged ✓' }]
  const chips: Chip[] = []
  if (pr.isDraft) chips.push({ tone: 'neutral', text: 'draft' })
  if (pr.mergeStatus === 'conflicts') chips.push({ tone: 'danger', text: 'conflicts' })
  return chips
}

function checkChips(pr: PrSummary): Chip[] {
  const chips: Chip[] = []
  if (pr.checks?.build === 'running') chips.push({ tone: 'warning', text: '● build' })
  if (pr.checks?.build === 'failed') chips.push({ tone: 'danger', text: '✗ build' })
  if (pr.checks?.build === 'succeeded') chips.push({ tone: 'success', text: '✓ build' })
  if (pr.checks?.policies === 'rejected') chips.push({ tone: 'danger', text: '✗ policies' })
  if (pr.checks?.policies === 'pending') chips.push({ tone: 'neutral', text: '· policies' })
  return chips
}

function voteChips(pr: PrSummary): Chip[] {
  const approved = pr.reviewers.filter(reviewer => reviewer.vote >= APPROVING_VOTE).length
  const rejected = pr.reviewers.filter(reviewer => reviewer.vote === REJECTED_VOTE).length
  const chips: Chip[] = []
  if (approved > 0) chips.push({ tone: 'success', text: `${approved} approved` })
  if (rejected > 0) chips.push({ tone: 'danger', text: `${rejected} rejected` })
  const waiting = pr.reviewers.filter(isWaitedFor).map(reviewer => reviewer.name)
  if (waiting.length > 0) chips.push({ tone: 'warning', text: `waiting for ${waiting.join(', ')}` })
  return chips
}

const chipsOf = (pr: PrSummary): Chip[] => [
  ...statusChips(pr),
  ...checkChips(pr),
  ...voteChips(pr),
  ...(pr.autoComplete ? [{ tone: 'accent' as const, text: 'auto-complete' }] : [])
]

function PrRow({ pr }: { pr: PrSummary }): OrcaNode {
  return (
    <Row gap="sm" align="center" wrap>
      <Link href={pr.url}>{`Pull Request ${pr.prId}`}</Link>
      <Text>{`→ ${pr.target}`}</Text>
      {chipsOf(pr).map((chip, index) => (
        <Badge key={index} tone={chip.tone}>
          {chip.text}
        </Badge>
      ))}
    </Row>
  )
}

const resultTone = (result: RowResult): Tone => (!result.ok ? 'danger' : result.warn ? 'warning' : 'success')

function Result({ outcome }: { outcome: Outcome }): OrcaNode {
  if ('error' in outcome) return <Callout tone="danger">{outcome.error}</Callout>
  return (
    <Callout tone={outcome.results.every(result => resultTone(result) === 'success') ? 'success' : 'warning'}>
      <Stack gap="xs">
        {outcome.results.map(result => (
          <Text key={result.prId} size="sm" tone={resultTone(result)}>
            {`Pull Request ${result.prId}: ${result.message}`}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

function describe(set: ReleaseSet): string {
  const repos = [...new Set(set.prs.map(pr => pr.repoName))].join(', ')
  return [set.sources.join(', '), repos].filter(part => part !== '').join(' · ')
}

export function ReleaseSetCard({ org, set, limit = set.prs.length }: { org: string; set: ReleaseSet; limit?: number }): OrcaNode {
  const shown = set.prs.slice(0, limit)
  const active = set.prs.filter(pr => pr.status === 'active')
  const ids = set.prs.map(pr => pr.prId)
  const idle = active.length > 0 && !isActing(ids)
  const outcome = outcomeOf(ids)
  return (
    <Card title={set.title} description={describe(set)}>
      {shown.map(pr => (
        <PrRow key={pr.prId} pr={pr} />
      ))}
      {shown.length < set.prs.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${set.prs.length} pull requests in this set.`}
        </Text>
      ) : null}
      <Row gap="sm" wrap>
        <Button size="sm" disabled={!idle} onPress={() => act('prs.approve', org, active)}>
          Approve all
        </Button>
        <Button size="sm" variant="outline" disabled={!idle} onPress={() => act('prs.autoComplete', org, active)}>
          Auto-complete all
        </Button>
      </Row>
      {outcome ? <Result outcome={outcome} /> : null}
    </Card>
  )
}
