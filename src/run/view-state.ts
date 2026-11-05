import { fileRefOf } from '../shared/file-ref'
import { messageOf } from '../shared/messages'
import type { ApprovalSummary, FileRef, Issue, JobView, RunState, RunView, StageView, StepView } from '../shared/pipelines'

export interface Selection {
  stageId: string | null
  stepId: string | null
}

export interface WatchToggle {
  value: boolean
  at: number
}

export const RUN_STATE_TEXT: Record<RunState, string> = {
  queued: 'queued',
  running: '● running',
  waiting: '⏸ waiting for approval',
  cancelling: 'cancelling',
  succeeded: '✓ succeeded',
  warning: '! partially succeeded',
  failed: '✗ failed',
  canceled: 'canceled'
}

const SELECT_STEP = 'Select a step to see its log.'
const NOT_STARTED = "This step hasn't started."
const SKIPPED = 'This step was skipped.'
const NOT_PUBLISHED = "Azure DevOps hasn't published this step's log yet. It shows here as soon as it does."

export function defaultSelection(view: RunView): Selection {
  const failed = view.stages.find(stage => stage.state === 'failed')
  if (failed) {
    const record = stepsOf(failed).find(step => step.state === 'failed') ?? failed.jobs.find(job => job.state === 'failed')
    return { stageId: failed.id, stepId: record?.id ?? null }
  }
  const active = view.stages.find(stage => stage.state === 'waiting' || stage.state === 'running')
  if (active) return { stageId: active.id, stepId: stepsOf(active).find(step => step.state === 'running')?.id ?? null }
  const last = view.stages[view.stages.length - 1]
  if (!last) return { stageId: null, stepId: null }
  return { stageId: last.id, stepId: stepsOf(last).pop()?.id ?? null }
}

export function nextSelection(view: RunView, current: Selection | null, pinned: boolean): Selection {
  const held = current !== null && exists(view, current)
  if (pinned && held) return current
  const chosen = defaultSelection(view)
  if (held && chosen.stepId === null && current.stageId === chosen.stageId) return current
  return chosen
}

export function selectedRecord(view: RunView, selection: Selection | null): StepView | JobView | null {
  const stage = view.stages.find(entry => entry.id === selection?.stageId)
  if (!stage || !selection?.stepId) return null
  for (const job of stage.jobs) {
    if (job.id === selection.stepId) return job
    const step = job.steps.find(entry => entry.id === selection.stepId)
    if (step) return step
  }
  return null
}

export function logNotice(record: StepView | JobView | null): string | null {
  if (!record) return SELECT_STEP
  if (record.logId !== null) return null
  if (record.state === 'pending') return NOT_STARTED
  if (record.state === 'skipped') return SKIPPED
  return NOT_PUBLISHED
}

export function durationText(startedAt: number | null, finishedAt: number | null, now: number): string {
  if (startedAt === null) return ''
  const seconds = Math.floor(Math.max(0, (finishedAt ?? now) - startedAt) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function rerunTarget(view: RunView, stageId: string | null): StageView | null {
  const selected = view.stages.find(stage => stage.id === stageId)
  return selected?.canRetry ? selected : (view.stages.find(stage => stage.canRetry) ?? null)
}

export function approvalText(approval: ApprovalSummary, stages: readonly StageView[], now: number): string {
  const wanted = approval.approvalId.toLowerCase()
  const where = approval.environment ?? approval.stage ?? stages.find(stage => stage.approvalId?.toLowerCase() === wanted)?.name ?? null
  const waited = `Waiting for approval${where ? ` at ${where}` : ''} for ${durationText(approval.createdAt, null, now)}.`
  if (approval.approvers.length === 0) return waited
  const names = approval.approvers.map(approver => (approver.isGroup ? `${approver.name} (group)` : approver.name))
  return `${waited} Approvers: ${names.join(', ')}.`
}

export function countsText(errors: number, warnings: number): string {
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function watchedOf(view: RunView, toggle: WatchToggle | null): boolean {
  return toggle && view.updatedAt < toggle.at ? toggle.value : view.run.watched
}

export function openedText(result: { opened: boolean; path?: string; line?: number | null; message?: string }): string {
  if (!result.opened) return result.message ?? messageOf(null)
  return result.line ? `Opened ${result.path}, line ${result.line}.` : `Opened ${result.path}.`
}

export function issueFile(issue: Issue): FileRef | null {
  return issue.file ?? fileRefOf(issue.message)
}

function stepsOf(stage: StageView): StepView[] {
  return stage.jobs.flatMap(job => job.steps)
}

function exists(view: RunView, selection: Selection): boolean {
  const stage = view.stages.find(entry => entry.id === selection.stageId)
  return stage !== undefined && (selection.stepId === null || selectedRecord(view, selection) !== null)
}
