import { Button, Callout, RelativeTime, Row, Text, Textarea, type OrcaNode } from 'orca'
import { MAX_COMMENT, type ApprovalSummary, type RunSummary } from '../../shared/pipelines'
import { approverNames, isActive } from '../../shared/runs'
import { APPROVAL_TEMPLATE, APPROVAL_VARS, approvalShareItem } from '../../shared/share/approval-items'
import type { Identity } from '../../shared/types'
import { openComposer } from '../share/state'
import { askToDecide, cancelDecision, confirmOf, decide, isBusy, typeComment, type Confirm, type Outcome } from './state'

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

function shareForApproval(org: string, me: string | null, run: RunSummary): void {
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

function Confirmation({ org, approval, confirm }: { org: string; approval: ApprovalSummary; confirm: Confirm }): OrcaNode {
  const { approvalId } = approval
  const approving = confirm.decision === 'approved'
  const sending = isBusy(`decide:${approvalId}`)
  return (
    <>
      <Textarea label="Comment (optional)" value={confirm.comment} maxLength={MAX_COMMENT} disabled={sending} onChange={value => typeComment(approvalId, value)} />
      <Row gap="xs" wrap>
        <Button size="xs" tone={approving ? 'success' : 'danger'} disabled={sending} onPress={() => decide(org, approval)}>
          {approving ? 'Approve' : 'Reject'}
        </Button>
        <Button size="xs" variant="ghost" disabled={sending} onPress={() => cancelDecision(approvalId)}>
          Cancel
        </Button>
      </Row>
    </>
  )
}

function ShareButton({ org, me, run }: { org: string; me: string | null; run: RunSummary }): OrcaNode {
  const canDecide = run.approvals.some(approval => approval.canApprove)
  return (
    <Button size="xs" variant={canDecide ? 'outline' : 'solid'} tone={canDecide ? undefined : 'accent'} onPress={() => shareForApproval(org, me, run)}>
      Share for approval
    </Button>
  )
}

function ApprovalBlock({ org, approval, share }: { org: string; approval: ApprovalSummary; share: OrcaNode }): OrcaNode {
  const { approvalId, canApprove } = approval
  const confirm = canApprove ? confirmOf(approvalId) : undefined
  const deciding = canApprove && !confirm
  return (
    <>
      <Text size="sm" tone="warning">
        {approvalLine(approval)} · waiting <RelativeTime at={approval.createdAt} format="duration" />
      </Text>
      {canApprove && approval.instructions ? (
        <Text size="xs" muted>
          {clip(approval.instructions)}
        </Text>
      ) : null}
      {confirm ? <Confirmation org={org} approval={approval} confirm={confirm} /> : null}
      {deciding || share ? (
        <Row gap="xs" wrap>
          {deciding ? (
            <Button size="xs" variant="solid" tone="accent" onPress={() => askToDecide(approvalId, 'approved')}>
              Approve…
            </Button>
          ) : null}
          {deciding ? (
            <Button size="xs" variant="outline" tone="danger" onPress={() => askToDecide(approvalId, 'rejected')}>
              Reject…
            </Button>
          ) : null}
          {share}
        </Row>
      ) : null}
    </>
  )
}

export function Approvals({ org, me, run }: { org: string; me: string | null; run: RunSummary }): OrcaNode {
  const share = isActive(run) ? <ShareButton org={org} me={me} run={run} /> : null
  const last = run.approvals.length - 1
  return (
    <>
      {run.approvals.map((approval, index) => (
        <ApprovalBlock key={approval.approvalId} org={org} approval={approval} share={index === last ? share : null} />
      ))}
    </>
  )
}
