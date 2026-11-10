import { Badge, Box, Button, Callout, IconButton, RelativeTime, Row, Text, type OrcaNode, type Tone } from 'orca'
import { MAX_STAGE_CHIPS, type RunFilter, type RunState, type RunSummary, type StageChip, type StepState } from '../../shared/pipelines'
import { isActive, RUN_STATE_TONE, STEP_GLYPH } from '../../shared/runs'
import { Chips, type Chip } from '../chips'
import { Approvals, OutcomeCallout } from './approval'
import { isBusy, noteOf, openInAzureDevOps, openRun, outcomesOf, toggleWatch } from './state'

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

const STATE_BADGE: Record<RunState, string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  cancelling: 'cancelling',
  succeeded: '✓ succeeded',
  warning: '! partial',
  failed: '✕ failed',
  canceled: 'canceled'
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
    <Box border radius="md" background="card" padding="sm" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Box direction="row" gap="xs" align="center" grow minWidth={0}>
          <Box shrink={false}>
            <Badge tone={RUN_STATE_TONE[run.state]}>{STATE_BADGE[run.state]}</Badge>
          </Box>
          <Box grow minWidth={0}>
            <Text weight="semibold" size="sm" truncate>
              {run.pipeline.name}
            </Text>
          </Box>
        </Box>
        <Box shrink={false}>
          <Text size="xs" muted>
            <RelativeTime at={run.finishedAt ?? run.startedAt ?? run.queuedAt} format="short" />
          </Text>
        </Box>
      </Row>
      <Text size="xs" muted>
        {describe(run, filter)}
      </Text>
      <StageChips stages={run.stages} />
      <Approvals org={org} me={me} run={run} />
      <Row gap="xs" align="center" wrap>
        <Button size="xs" variant="outline" disabled={isBusy(`open:${run.buildId}`)} onPress={() => openRun(org, run)}>
          Open run
        </Button>
        <IconButton
          icon="bell"
          label={run.watched ? 'Stop watching' : 'Watch'}
          size="xs"
          variant={run.watched ? 'solid' : 'ghost'}
          disabled={isBusy(`watch:${run.buildId}`) || (!run.watched && !isActive(run))}
          onPress={() => toggleWatch(org, run)}
        />
        <IconButton icon="open-external" label="Open in Azure DevOps" size="xs" variant="ghost" onPress={() => openInAzureDevOps(org, run)} />
      </Row>
      {note ? <Callout tone="danger">{note}</Callout> : null}
      {outcomesOf(run).map(outcome => (
        <OutcomeCallout key={outcome.approvalId} outcome={outcome} />
      ))}
    </Box>
  )
}
