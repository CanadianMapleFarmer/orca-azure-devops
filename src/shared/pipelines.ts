export type StepState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'canceled' | 'skipped'
export type RunState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'succeeded' | 'warning' | 'failed' | 'canceled'
export type RunFilter = 'mine' | 'running' | 'needsMe' | 'failed'

export interface RunKey {
  projectId: string
  buildId: number
}

export interface StageChip {
  id: string
  name: string
  state: StepState
}

export interface Approver {
  id: string
  name: string
  uniqueName: string
  isGroup: boolean
}

export interface ApprovalSummary extends RunKey {
  approvalId: string
  stage: string | null
  environment: string | null
  approvers: Approver[]
  minRequired: number
  instructions: string
  createdAt: number
  canApprove: boolean
}

export interface RunSummary extends RunKey {
  org: string
  projectName: string
  pipeline: { id: number; name: string }
  runNumber: string
  url: string
  branch: string
  prId: number | null
  reason: string
  repository: { id: string; name: string } | null
  requestedFor: { id: string; name: string }
  state: RunState
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  stages: StageChip[] | null
  approvals: ApprovalSummary[]
  mine: boolean
  watched: boolean
}

export interface RunCounts {
  failedRuns: number
  approvals: number
}

export interface RunsSnapshot {
  org: string
  me: string | null
  runs: RunSummary[]
  counts: RunCounts
  updatedAt: number
  stale: boolean
  message?: string
}

export interface FileRef {
  path: string
  line: number | null
  column: number | null
}

export interface Issue {
  type: 'error' | 'warning'
  message: string
  file: FileRef | null
}

export interface StepView {
  id: string
  name: string
  state: StepState
  startedAt: number | null
  finishedAt: number | null
  logId: number | null
  logLines: number | null
  errorCount: number
  warningCount: number
  issues: Issue[]
}

export interface JobView {
  id: string
  name: string
  state: StepState
  startedAt: number | null
  finishedAt: number | null
  logId: number | null
  issues: Issue[]
  steps: StepView[]
}

export interface StageView {
  id: string
  identifier: string | null
  name: string
  state: StepState
  startedAt: number | null
  finishedAt: number | null
  attempt: number
  jobs: JobView[]
  canRetry: boolean
  approvalId: string | null
}

export interface Failure {
  stageId: string
  jobId: string
  stepId: string
  path: string
  issues: Issue[]
  logId: number | null
}

export interface RunView {
  org: string
  run: RunSummary
  stages: StageView[]
  failures: Failure[]
  canCancel: boolean
  updatedAt: number
  stale: boolean
  message?: string
}

export interface LogChunk {
  logId: number
  first: number
  lines: string[]
  total: number
}

export interface RunActionResult {
  ok: boolean
  message: string
  warn?: true
}

export const LOG_FIRST_LINE = 1
export const MAX_LOG_LINES = 1000
export const MAX_LINE_CHARS = 2000
export const MAX_BUFFER_LINES = 50_000
export const MAX_COMMENT = 1000
