import type { ApprovalSummary, RunSummary } from '../pipelines'
import type { ShareItem } from './types'

export const APPROVAL_TEMPLATE = 'Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}'
export const APPROVAL_VARS = ['pipeline', 'run', 'url', 'environment', 'stage', 'branch', 'requestedBy', 'project'] as const

const ITEM_KEY = /^approval:([^/]+)\/([^/]+)$/

interface ApprovalKey {
  projectId: string
  approvalId: string
}

export function approvalItemKey(key: ApprovalKey): string {
  return `approval:${key.projectId}/${key.approvalId}`
}

export function parseApprovalItemKey(key: string): ApprovalKey | null {
  const match = ITEM_KEY.exec(key)
  return match ? { projectId: match[1], approvalId: match[2] } : null
}

export function approvalShareItem(run: RunSummary, approval: ApprovalSummary): ShareItem {
  const vars: Record<(typeof APPROVAL_VARS)[number], string> = {
    pipeline: run.pipeline.name,
    run: run.runNumber,
    url: run.url,
    environment: approval.environment ?? approval.stage ?? '',
    stage: approval.stage ?? '',
    branch: run.branch,
    requestedBy: run.requestedFor.name,
    project: run.projectName
  }
  return { key: approvalItemKey(approval), vars }
}
