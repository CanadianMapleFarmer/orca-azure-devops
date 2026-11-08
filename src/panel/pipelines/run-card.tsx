import { Badge, Button, Callout, Card, IconButton, Link, RelativeTime, Row, Text, type OrcaNode, type Tone } from 'orca'
import { MAX_STAGE_CHIPS, type RunSummary, type StageChip, type StepState } from '../../shared/pipelines'
import { isActive, RUN_STATE_TEXT, RUN_STATE_TONE, STEP_GLYPH } from '../../shared/runs'
import { Chips, type Chip } from '../chips'
import { ApprovalBlock, OutcomeCallout } from './approval'
import { isBusy, noteOf, openRun, orphanOutcomes, toggleWatch } from './state'

export const STAGE_TONE: Record<StepState, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  waiting: 'warning',
  warning: 'warning',
  running: 'accent',
  pending: 'neutral',
  skipped: 'neutral',
  canceled: 'neutral'
}

export function stageChips(stages: readonly StageChip[]): Chip[] {
  return stages.slice(0, MAX_STAGE_CHIPS).map(stage => ({ tone: STAGE_TONE[stage.state], text: `${stage.name} ${STEP_GLYPH[stage.state]}` }))
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

export function StageChips({ stages }: { stages: readonly StageChip[] | null }): OrcaNode {
  return stages && stages.length > 0 ? <Chips chips={stageChips(stages)} /> : null
}

export function RunCard({ org, me, run }: { org: string; me: string | null; run: RunSummary }): OrcaNode {
  const note = noteOf(run.buildId)
  const leftovers = orphanOutcomes(run)
  return (
    <Card title={run.pipeline.name} description={describe(run)}>
      <Row gap="sm" align="center" wrap>
        <Badge tone={RUN_STATE_TONE[run.state]}>{RUN_STATE_TEXT[run.state]}</Badge>
        <When run={run} />
      </Row>
      <StageChips stages={run.stages} />
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
