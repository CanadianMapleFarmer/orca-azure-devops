import type { ApprovalSummary, RunsSnapshot, RunSummary, StageChip, StepState } from '../../shared/pipelines'
import { runCounts } from '../../shared/runs'

export const NOW = Date.now()
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export const stageOf = (name: string, state: StepState): StageChip => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, state })

export function runOf(buildId: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    org: 'contoso',
    projectId: 'proj-web',
    projectName: 'Fabrikam Web',
    buildId,
    pipeline: { id: 8, name: 'web-app-ci' },
    runNumber: `20261105.${buildId}`,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=${buildId}`,
    branch: 'develop',
    prId: null,
    reason: 'individualCI',
    repository: null,
    requestedFor: { id: 'u-contoso', name: 'Ada Lovelace' },
    state: 'succeeded',
    queuedAt: NOW - 30 * MINUTE,
    startedAt: NOW - 29 * MINUTE,
    finishedAt: NOW - 20 * MINUTE,
    stages: null,
    approvals: [],
    mine: true,
    watched: false,
    ...over
  }
}

export function approvalOf(approvalId: string, buildId: number, over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    projectId: 'proj-web',
    buildId,
    approvalId,
    stage: 'Deploy production',
    environment: 'production',
    approvers: [{ id: 'u-grace', name: 'Grace Hopper', uniqueName: 'grace@contoso.com', isGroup: false }],
    minRequired: 1,
    instructions: '',
    createdAt: NOW - 20 * MINUTE,
    canApprove: false,
    ...over
  }
}

export function runsSnapshotOf(over: Partial<RunsSnapshot> = {}): RunsSnapshot {
  const runs = over.runs ?? []
  return { org: 'contoso', me: 'u-contoso', runs, counts: runCounts(runs, NOW), updatedAt: NOW, stale: false, ...over }
}

export function waitingRun(buildId: number, approvals: ApprovalSummary[], over: Partial<RunSummary> = {}): RunSummary {
  return runOf(buildId, {
    state: 'waiting',
    pipeline: { id: 9, name: 'web-app-cd' },
    branch: 'main',
    finishedAt: null,
    stages: [stageOf('Build', 'succeeded'), stageOf('Image', 'succeeded'), stageOf('Deploy production', 'waiting')],
    approvals,
    ...over
  })
}
