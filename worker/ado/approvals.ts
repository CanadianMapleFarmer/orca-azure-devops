import type { ApprovalSummary, Approver } from '../../src/shared/pipelines'
import { MALFORMED } from '../messages'
import { AdoError, type AdoHttp, type AdoRequest } from './http'
import { expectList, expectText, malformed, shaped } from './shape'
import { textOr, timestamp } from './workitems'

export interface RawApprover {
  id: string
  displayName: string
  uniqueName?: string
  isContainer?: boolean
}

export interface RawApprovalStep {
  assignedApprover: RawApprover
  status?: string
  actualApprover?: RawApprover | null
  comment?: string
}

export interface RawApproval {
  id: string
  status: string
  createdOn?: string
  instructions?: string
  minRequiredApprovers?: number
  permissions?: number
  steps?: RawApprovalStep[]
  pipeline?: { id?: number | string; name?: string; owner?: { id: number; name?: string } }
}

interface CheckResource {
  type?: unknown
  name?: unknown
}

export const APPROVAL_UPDATE_PERMISSION = 2

const APPROVALS_PATH = '/_apis/pipelines/approvals'
const PENDING_TOP = 50
const WITH_PERMISSIONS = 'steps,permissions'
const WITHOUT_PERMISSIONS = 'steps'
const PENDING = 'pending'
const ENVIRONMENT = 'environment'
const CHECK_RUN_API_VERSION = '7.1-preview.1'

export function listPendingApprovals(http: AdoHttp, org: string, projectId: string, signal?: AbortSignal): Promise<RawApproval[]> {
  return fetchApprovals(http, org, projectId, { state: PENDING, top: PENDING_TOP }, signal)
}

export async function getApprovals(
  http: AdoHttp,
  org: string,
  projectId: string,
  ids: string[],
  signal?: AbortSignal
): Promise<RawApproval[]> {
  if (ids.length === 0) return []
  return fetchApprovals(http, org, projectId, { approvalIds: ids.join(',') }, signal)
}

export async function decideApproval(
  http: AdoHttp,
  org: string,
  projectId: string,
  approvalId: string,
  status: 'approved' | 'rejected',
  comment: string
): Promise<RawApproval> {
  const { data } = await http.json<{ value: RawApproval[] }>({
    org,
    project: projectId,
    method: 'PATCH',
    path: APPROVALS_PATH,
    body: [{ approvalId, status, comment }]
  })
  const wanted = approvalId.toLowerCase()
  const decided = shaped(() => {
    const found = expectList<RawApproval>(data.value).find(raw => expectText(raw.id).toLowerCase() === wanted)
    if (found) expectText(found.status)
    return found
  }, MALFORMED.approval)
  return decided ?? malformed(MALFORMED.approval)
}

export function runIdOf(raw: RawApproval): number {
  const id = raw.pipeline?.owner?.id
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : malformed(MALFORMED.approval)
}

export function toApprovalSummary(
  raw: RawApproval,
  input: { projectId: string; me: string; stage: string | null; environment: string | null }
): ApprovalSummary {
  const buildId = runIdOf(raw)
  return shaped(() => {
    const steps = expectList<RawApprovalStep>(raw.steps ?? [])
    const approvers = approversOf(steps)
    return {
      projectId: input.projectId,
      buildId,
      approvalId: expectText(raw.id),
      stage: input.stage,
      environment: input.environment,
      approvers,
      minRequired: minRequiredOf(raw.minRequiredApprovers, approvers.length),
      instructions: textOr(raw.instructions, ''),
      createdAt: timestamp(raw.createdOn),
      canApprove: canDecide(raw.permissions, steps, input.me)
    }
  }, MALFORMED.approval)
}

export async function checkSuiteEnvironment(
  http: AdoHttp,
  org: string,
  projectId: string,
  checkSuiteId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const { data } = await http.json<{ resources?: (CheckResource | null)[] | null } | null | undefined>({
    org,
    project: projectId,
    path: `/_apis/pipelines/checks/runs/${encodeURIComponent(checkSuiteId)}`,
    query: { $expand: 'resources' },
    apiVersion: CHECK_RUN_API_VERSION,
    signal
  })
  const resources = data?.resources
  if (resources === undefined || resources === null) return null
  return shaped(() => environmentName(expectList<CheckResource | null>(resources)), MALFORMED.approval)
}

async function fetchApprovals(
  http: AdoHttp,
  org: string,
  projectId: string,
  filter: NonNullable<AdoRequest['query']>,
  signal?: AbortSignal
): Promise<RawApproval[]> {
  const read = (expand: string) =>
    http.json<{ value: RawApproval[] }>({ org, project: projectId, path: APPROVALS_PATH, query: { ...filter, $expand: expand }, signal })
  const { data } = await read(WITH_PERMISSIONS).catch((error: unknown) => {
    if (error instanceof AdoError && error.code === 'bad_request') return read(WITHOUT_PERMISSIONS)
    throw error
  })
  return shaped(() => expectList<RawApproval>(data.value), MALFORMED.approval)
}

function approversOf(steps: readonly RawApprovalStep[]): Approver[] {
  const seen = new Set<string>()
  const approvers: Approver[] = []
  for (const { assignedApprover } of steps) {
    const id = expectText(assignedApprover.id)
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    approvers.push({
      id,
      name: expectText(assignedApprover.displayName),
      uniqueName: textOr(assignedApprover.uniqueName, ''),
      isGroup: assignedApprover.isContainer === true
    })
  }
  return approvers
}

function minRequiredOf(value: unknown, approverCount: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : Math.max(1, approverCount)
}

function canDecide(permissions: unknown, steps: readonly RawApprovalStep[], me: string): boolean {
  if (typeof permissions === 'number' && (permissions & APPROVAL_UPDATE_PERMISSION) !== 0) return true
  const mine = me.toLowerCase()
  return mine !== '' && steps.some(step => step.status === PENDING && step.assignedApprover.id.toLowerCase() === mine)
}

function environmentName(resources: readonly (CheckResource | null)[]): string | null {
  const environment = resources.find(resource => resource?.type === ENVIRONMENT)
  return typeof environment?.name === 'string' && environment.name !== '' ? environment.name : null
}
