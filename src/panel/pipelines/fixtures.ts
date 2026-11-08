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

const LARGE_PLACES: Pick<RunSummary, 'projectId' | 'projectName' | 'repository'>[] = [
  { projectId: 'proj-web', projectName: 'Fabrikam Web', repository: { id: 'repo-web-app', name: 'web-app' } },
  { projectId: 'proj-web', projectName: 'Fabrikam Web', repository: { id: 'repo-api', name: 'fabrikam-api' } },
  { projectId: 'proj-tools', projectName: 'Contoso Tools', repository: { id: 'repo-tools-app', name: 'web-app' } },
  { projectId: 'proj-boards', projectName: 'Fabrikam Boards', repository: { id: 'repo-boards', name: 'boards-app' } }
]

export function largeRuns(): RunSummary[] {
  const stages = Array.from({ length: 12 }, (_, index) => stageOf(`Stage number ${index + 1}`, index < 8 ? 'succeeded' : 'waiting'))
  return Array.from({ length: 30 }, (_, index) => {
    const buildId = 2000 + index
    const place = LARGE_PLACES[index % LARGE_PLACES.length]
    const approval = approvalOf(`ap-${index}`, buildId, {
      projectId: place.projectId,
      canApprove: true,
      instructions: 'z'.repeat(600),
      minRequired: 2,
      approvers: Array.from({ length: 3 }, (_, who) => ({ id: `u-${who}`, name: `Approver ${who}`, uniqueName: `a${who}@contoso.com`, isGroup: who === 2 }))
    })
    return waitingRun(buildId, [approval], { ...place, stages, watched: index % 2 === 0 })
  })
}
