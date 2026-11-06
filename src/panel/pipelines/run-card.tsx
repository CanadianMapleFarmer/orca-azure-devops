import { Badge, Box, Button, Callout, Card, IconButton, Link, RelativeTime, Row, Stack, Text, type OrcaNode, type Tone } from 'orca'
import type { RunState, RunSummary, StageChip, StepState } from '../../shared/pipelines'
import { isActive, RUN_STATE_TEXT, STEP_GLYPH } from '../../shared/runs'
import { ApprovalBlock, OutcomeCallout } from './approval'
import { isBusy, noteOf, openRun, orphanOutcomes, toggleWatch } from './state'

const MAX_STAGES = 12

const BADGE_TONE: Record<RunState, Tone> = {
  queued: 'neutral',
  running: 'accent',
  waiting: 'warning',
  cancelling: 'neutral',
  succeeded: 'success',
  warning: 'warning',
  failed: 'danger',
  canceled: 'neutral'
}

const SEGMENT: Record<StepState, 'success' | 'danger' | 'warning' | 'accent' | 'muted'> = {
  succeeded: 'success',
  failed: 'danger',
  waiting: 'warning',
  warning: 'warning',
  running: 'accent',
  pending: 'muted',
  skipped: 'muted',
  canceled: 'muted'
}

export function stageLine(stages: readonly StageChip[]): string {
  const parts = stages.slice(0, MAX_STAGES).map(stage => `${stage.name} ${STEP_GLYPH[stage.state]}`)
  if (stages.length > MAX_STAGES) parts.push(`+${stages.length - MAX_STAGES} more`)
  return parts.join(' · ')
}

function describe(run: RunSummary): string {
  return [run.runNumber, run.branch, run.prId === null ? '' : `PR ${run.prId}`, run.requestedFor.name].filter(part => part !== '').join(' · ')
}

function When({ run }: { run: RunSummary }): OrcaNode {
  const [label, at] = run.finishedAt !== null ? ['finished', run.finishedAt] : run.startedAt !== null ? ['started', run.startedAt] : ['queued', run.queuedAt]
  return (
    <Text size="sm" muted>
      {label} <RelativeTime at={at} />
    </Text>
  )
}

function StageBar({ stages }: { stages: readonly StageChip[] }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row gap="xs">
        {stages.slice(0, MAX_STAGES).map(stage => (
          <Box key={stage.id} width={14} height={6} radius="full" background={SEGMENT[stage.state]} />
        ))}
      </Row>
      <Text size="xs" muted truncate>
        {stageLine(stages)}
      </Text>
    </Stack>
  )
}

export function RunCard({ org, me, run }: { org: string; me: string | null; run: RunSummary }): OrcaNode {
  const note = noteOf(run.buildId)
  const leftovers = orphanOutcomes(run)
  return (
    <Card title={run.pipeline.name} description={describe(run)}>
      <Row gap="sm" align="center" wrap>
        <Badge tone={BADGE_TONE[run.state]}>{RUN_STATE_TEXT[run.state]}</Badge>
        <When run={run} />
      </Row>
      {run.stages && run.stages.length > 0 ? <StageBar stages={run.stages} /> : null}
      <Row gap="sm" align="center" wrap>
        <Button size="sm" disabled={isBusy(`open:${run.buildId}`)} onPress={() => openRun(org, run)}>
          Open run
        </Button>
        <IconButton
          icon="bell"
          label={run.watched ? 'Stop watching' : 'Watch'}
          size="sm"
          variant={run.watched ? 'solid' : 'ghost'}
          disabled={isBusy(`watch:${run.buildId}`) || (!run.watched && !isActive(run))}
          onPress={() => toggleWatch(org, run)}
        />
        <Link href={run.url}>Open in Azure DevOps</Link>
      </Row>
      {note ? <Callout tone="danger">{note}</Callout> : null}
      {run.approvals.map(approval => (
        <ApprovalBlock key={approval.approvalId} org={org} me={me} run={run} approval={approval} />
      ))}
      {leftovers.map(outcome => (
        <OutcomeCallout key={outcome.approvalId} outcome={outcome} />
      ))}
    </Card>
  )
}
