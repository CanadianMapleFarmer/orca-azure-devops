import type { ApprovalSummary, RunSummary } from '../pipelines'

export const APPROVAL_ID = '8d4e5f6a-7002-4d5e-8f6a-7b8c9d0e1f22'
export const RUN_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4520'

export const RUN_4520: RunSummary = {
  org: 'contoso',
  projectId: 'proj-web',
  projectName: 'Fabrikam Web',
  buildId: 4520,
  pipeline: { id: 9, name: 'web-app-cd' },
  runNumber: '20261105.3',
  url: RUN_URL,
  branch: 'main',
  prId: null,
  reason: 'individualCI',
  repository: null,
  requestedFor: { id: 'u-grace', name: 'Grace Hopper' },
  state: 'waiting',
  queuedAt: 0,
  startedAt: 0,
  finishedAt: null,
  stages: null,
  approvals: [],
  mine: false,
  watched: false
}

export const APPROVAL_4520: ApprovalSummary = {
  projectId: 'proj-web',
  buildId: 4520,
  approvalId: APPROVAL_ID,
  stage: 'Deploy production',
  environment: 'production',
  approvers: [],
  minRequired: 1,
  instructions: '',
  createdAt: 0,
  canApprove: false
}
