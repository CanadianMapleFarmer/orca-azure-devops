import { Badge, Box, Button, Callout, Card, IconButton, Link, RelativeTime, Row, Text, type OrcaNode, type Tone } from 'orca'
import { MAX_STAGE_CHIPS, type RunFilter, type RunSummary, type StageChip, type StepState } from '../../shared/pipelines'
import { isActive, RUN_STATE_TEXT, RUN_STATE_TONE, STEP_GLYPH } from '../../shared/runs'
import { Chips, type Chip } from '../chips'
import { ApprovalBlock, OutcomeCallout, shareForApproval } from './approval'
import { isBusy, noteOf, openRun, outcomesOf, toggleWatch } from './state'

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

function describe(run: RunSummary, filter: RunFilter): string {
  const where = run.prId === null ? run.branch : `PR !${run.prId}`
  return [run.runNumber, where, filter === 'mine' ? '' : run.requestedFor.name].filter(part => part !== '').join(' · ')
}

export function StageChips({ stages }: { stages: readonly StageChip[] | null }): OrcaNode {
  return stages && stages.length > 0 ? <Chips chips={stageChips(stages)} /> : null
}

export function RunCard({ org, me, filter, run }: { org: string; me: string | null; filter: RunFilter; run: RunSummary }): OrcaNode {
  const note = noteOf(run.buildId)
  return (
    <Card>
      <Row gap="sm" align="center">
        <Badge tone={RUN_STATE_TONE[run.state]}>{RUN_STATE_TEXT[run.state]}</Badge>
        <Box grow shrink minWidth={0}>
          <Text weight="semibold" truncate>
            {run.pipeline.name}
          </Text>
        </Box>
        <RelativeTime at={run.finishedAt ?? run.startedAt ?? run.queuedAt} format="short" muted />
      </Row>
      <Text size="sm" muted>
        {describe(run, filter)}
      </Text>
      <StageChips stages={run.stages} />
      {run.approvals.map(approval => (
        <ApprovalBlock key={approval.approvalId} org={org} approval={approval} />
      ))}
      <Row gap="sm" align="center" wrap>
        {isActive(run) && run.approvals.length > 0 ? (
          <Button size="sm" variant="outline" onPress={() => shareForApproval(org, me, run)}>
            Share for approval
          </Button>
        ) : null}
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
      {outcomesOf(run).map(outcome => (
        <OutcomeCallout key={outcome.approvalId} outcome={outcome} />
      ))}
    </Card>
  )
}
