import { Button, Callout, RelativeTime, Row, Stack, Text, Textarea, type OrcaNode } from 'orca'
import { MAX_COMMENT, type ApprovalSummary, type RunSummary } from '../../shared/pipelines'
import { approverNames } from '../../shared/runs'
import { APPROVAL_TEMPLATE, APPROVAL_VARS, approvalShareItem } from '../../shared/share/approval-items'
import type { Identity } from '../../shared/types'
import { openComposer } from '../share/state'
import { askToDecide, cancelDecision, confirmOf, decide, isBusy, outcomeOf, typeComment, type Outcome } from './state'

const MAX_INSTRUCTIONS = 500

function clip(text: string): string {
  const letters = Array.from(text)
  return letters.length > MAX_INSTRUCTIONS ? `${letters.slice(0, MAX_INSTRUCTIONS - 1).join('')}…` : text
}

const placeOf = (approval: ApprovalSummary): string => approval.environment ?? approval.stage ?? 'A stage'

function shareApproval(org: string, me: string | null, run: RunSummary, approval: ApprovalSummary): void {
  const item = approvalShareItem(run, approval)
  const runName = `${run.pipeline.name} ${run.runNumber}`
  const approvers: Identity[] = approval.approvers
    .filter(approver => !approver.isGroup && approver.uniqueName !== '' && approver.id.toLowerCase() !== me?.toLowerCase())
    .map(({ id, name, uniqueName }) => ({ id, displayName: name, uniqueName, kind: 'user' }))
  openComposer({
    org,
    kind: 'approval',
    host: 'pipelines',
    title: 'Share for approval',
    items: [{ key: item.key, label: `${runName} → ${placeOf(approval)}`, item, checked: true }],
    suggestions: approvers,
    reviewers: false,
    email: true,
    subject: `Approval needed: ${runName}`,
    fallback: APPROVAL_TEMPLATE,
    vars: APPROVAL_VARS
  })
}

function approversLine(approval: ApprovalSummary): string | null {
  if (approval.approvers.length === 0) return null
  return `Approvers: ${approverNames(approval)}${approval.minRequired > 1 ? ` · needs ${approval.minRequired}` : ''}`
}

export function OutcomeCallout({ outcome }: { outcome: Outcome }): OrcaNode {
  const { ok, warn, message } = outcome.result
  return <Callout tone={!ok ? 'danger' : warn ? 'warning' : 'success'}>{message}</Callout>
}

function Decide({ org, approval }: { org: string; approval: ApprovalSummary }): OrcaNode {
  const { approvalId } = approval
  const confirm = confirmOf(approvalId)
  if (!confirm) {
    return (
      <Row gap="sm" wrap>
        <Button size="sm" onPress={() => askToDecide(approvalId, 'approved')}>
          Approve…
        </Button>
        <Button size="sm" variant="outline" onPress={() => askToDecide(approvalId, 'rejected')}>
          Reject…
        </Button>
      </Row>
    )
  }
  const approving = confirm.decision === 'approved'
  const sending = isBusy(`decide:${approvalId}`)
  return (
    <Stack gap="xs">
      <Textarea label="Comment (optional)" value={confirm.comment} maxLength={MAX_COMMENT} disabled={sending} onChange={value => typeComment(approvalId, value)} />
      <Row gap="sm" wrap>
        <Button size="sm" tone={approving ? 'success' : 'danger'} disabled={sending} onPress={() => decide(org, approval)}>
          {approving ? 'Approve' : 'Reject'}
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onPress={() => cancelDecision(approvalId)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

export function ApprovalBlock({ org, me, run, approval }: { org: string; me: string | null; run: RunSummary; approval: ApprovalSummary }): OrcaNode {
  const approvers = approversLine(approval)
  const outcome = outcomeOf(approval.approvalId)
  return (
    <Stack gap="xs">
      <Callout tone="warning" title="Waiting for approval">
        <Stack gap="xs">
          <Text size="sm">
            {placeOf(approval)} · waiting <RelativeTime at={approval.createdAt} format="duration" />
          </Text>
          {approvers ? <Text size="sm">{approvers}</Text> : null}
          {approval.instructions ? (
            <Text size="sm" muted>
              {clip(approval.instructions)}
            </Text>
          ) : null}
          {approval.canApprove ? <Decide org={org} approval={approval} /> : null}
          <Row gap="sm" wrap>
            <Button size="sm" variant="outline" onPress={() => shareApproval(org, me, run, approval)}>
              Share for approval
            </Button>
          </Row>
        </Stack>
      </Callout>
      {outcome ? <OutcomeCallout outcome={outcome} /> : null}
    </Stack>
  )
}
