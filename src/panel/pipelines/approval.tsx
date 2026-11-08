import { Button, Callout, RelativeTime, Row, Stack, Text, Textarea, type OrcaNode } from 'orca'
import { MAX_COMMENT, type ApprovalSummary, type RunSummary } from '../../shared/pipelines'
import { approverNames } from '../../shared/runs'
import { APPROVAL_TEMPLATE, APPROVAL_VARS, approvalShareItem } from '../../shared/share/approval-items'
import type { Identity } from '../../shared/types'
import { openComposer } from '../share/state'
import { askToDecide, cancelDecision, confirmOf, decide, isBusy, typeComment, type Outcome } from './state'

const MAX_INSTRUCTIONS = 500

function clip(text: string): string {
  const letters = Array.from(text)
  return letters.length > MAX_INSTRUCTIONS ? `${letters.slice(0, MAX_INSTRUCTIONS - 1).join('')}…` : text
}

const placeOf = (approval: ApprovalSummary): string => approval.environment ?? approval.stage ?? 'A stage'

function suggestedApprovers(run: RunSummary, me: string | null): Identity[] {
  const seen = new Set<string>()
  const people: Identity[] = []
  for (const approver of run.approvals.flatMap(approval => approval.approvers)) {
    if (approver.isGroup || approver.uniqueName === '' || approver.id.toLowerCase() === me?.toLowerCase() || seen.has(approver.id)) continue
    seen.add(approver.id)
    people.push({ id: approver.id, displayName: approver.name, uniqueName: approver.uniqueName, kind: 'user' })
  }
  return people
}

export function shareForApproval(org: string, me: string | null, run: RunSummary): void {
  const runName = `${run.pipeline.name} ${run.runNumber}`
  openComposer({
    org,
    kind: 'approval',
    host: 'pipelines',
    title: 'Share for approval',
    items: run.approvals.map(approval => {
      const item = approvalShareItem(run, approval)
      return { key: item.key, label: `${runName} → ${placeOf(approval)}`, item, checked: true }
    }),
    suggestions: suggestedApprovers(run, me),
    reviewers: false,
    email: true,
    subject: `Approval needed: ${runName}`,
    fallback: APPROVAL_TEMPLATE,
    vars: APPROVAL_VARS
  })
}

export function approvalLine(approval: ApprovalSummary): string {
  if (approval.approvers.length === 0) return placeOf(approval)
  const count = approval.minRequired > 1 ? `${approval.minRequired} of ` : ''
  return `${placeOf(approval)} needs ${count}${approverNames(approval)}`
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

export function ApprovalBlock({ org, approval }: { org: string; approval: ApprovalSummary }): OrcaNode {
  const line = (
    <Text size="sm" tone="warning">
      {approvalLine(approval)} · waiting <RelativeTime at={approval.createdAt} format="duration" />
    </Text>
  )
  if (!approval.canApprove) return line
  return (
    <Stack gap="xs">
      {line}
      {approval.instructions ? (
        <Text size="sm" muted>
          {clip(approval.instructions)}
        </Text>
      ) : null}
      <Decide org={org} approval={approval} />
    </Stack>
  )
}
