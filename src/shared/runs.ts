import type { ApprovalSummary, RunCounts, RunFilter, RunState, RunSummary, StepState } from './pipelines'

export const FAILED_WINDOW_MS = 24 * 60 * 60_000

export const STEP_GLYPH: Record<StepState, string> = {
  succeeded: '✓',
  failed: '✗',
  running: '●',
  waiting: '⏸',
  warning: '!',
  canceled: '⊘',
  skipped: '–',
  pending: '○'
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

const ACTIVE_STATES: ReadonlySet<RunState> = new Set(['queued', 'running', 'waiting', 'cancelling'])
const REPLACING_STATES: ReadonlySet<RunState> = new Set(['queued', 'running', 'waiting', 'cancelling', 'succeeded', 'warning'])
const COMPLETED_STATUS = 'completed'
const CANCELLING_STATUS = 'cancelling'

export function isActive(run: RunSummary): boolean {
  return ACTIVE_STATES.has(run.state)
}

export function isBuildId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function finishedStatus(status: string): boolean {
  return status === COMPLETED_STATUS
}

export function cancellableStatus(status: string): boolean {
  return !finishedStatus(status) && status !== CANCELLING_STATUS
}

export function orderRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || recency(b) - recency(a) || b.buildId - a.buildId
  )
}

export function needsMe(run: RunSummary): boolean {
  return isActive(run) && run.approvals.some(approval => approvalNeedsMe(run, approval))
}

export function approvalsNeedingMe(runs: readonly RunSummary[]): ApprovalSummary[] {
  return runs.filter(isActive).flatMap(run => run.approvals.filter(approval => approvalNeedsMe(run, approval)))
}

export function failedRuns(runs: readonly RunSummary[], now: number): RunSummary[] {
  const newestReplacement = new Map<string, number>()
  for (const run of runs) {
    if (REPLACING_STATES.has(run.state)) {
      newestReplacement.set(lineOf(run), Math.max(newestReplacement.get(lineOf(run)) ?? -Infinity, run.queuedAt))
    }
  }
  const isReplaced = (run: RunSummary) => (newestReplacement.get(lineOf(run)) ?? -Infinity) > run.queuedAt
  return runs.filter(
    run =>
      (run.mine || run.watched) &&
      run.state === 'failed' &&
      run.finishedAt !== null &&
      now - run.finishedAt <= FAILED_WINDOW_MS &&
      !isReplaced(run)
  )
}

export function runsFor(filter: RunFilter, runs: readonly RunSummary[], now: number): RunSummary[] {
  return orderRuns(matching(filter, runs, now))
}

export function runCounts(runs: readonly RunSummary[], now: number): RunCounts {
  return { failedRuns: failedRuns(runs, now).length, approvals: approvalsNeedingMe(runs).length }
}

function matching(filter: RunFilter, runs: readonly RunSummary[], now: number): readonly RunSummary[] {
  switch (filter) {
    case 'mine':
      return runs.filter(run => run.mine)
    case 'running':
      return runs.filter(isActive)
    case 'needsMe':
      return runs.filter(needsMe)
    case 'failed':
      return failedRuns(runs, now)
  }
}

function approvalNeedsMe(run: RunSummary, approval: ApprovalSummary): boolean {
  return approval.canApprove || run.mine
}

function recency(run: RunSummary): number {
  return isActive(run) ? run.queuedAt : (run.finishedAt ?? run.queuedAt)
}

function lineOf(run: RunSummary): string {
  return `${run.pipeline.id}:${run.branch}`
}
