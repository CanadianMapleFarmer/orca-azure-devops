import type { PrKey, PrReviewer, PrSummary } from '../../src/shared/prs'
import { reviewersSignature, type PrRecord, type RepoRecord } from '../data/records'
import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { branchName, pullRequestUrl } from './pr-links'
import { expectList, expectText, malformed, shaped } from './shape'
import { textOr, timestamp } from './workitems'

export interface RawReviewer {
  id: string
  displayName: string
  uniqueName?: string
  vote?: number
  isRequired?: boolean
  isContainer?: boolean
  hasDeclined?: boolean
}

export interface RawPullRequest {
  pullRequestId: number
  status: string
  title: string
  sourceRefName: string
  targetRefName: string
  isDraft?: boolean
  mergeStatus?: string
  createdBy: { id: string; displayName: string }
  creationDate: string
  closedDate?: string
  repository: { id: string; name: string; webUrl?: string; project: { id: string; name: string } }
  reviewers?: RawReviewer[]
  autoCompleteSetBy?: { id: string }
  completionOptions?: { deleteSourceBranch?: boolean }
  description?: string
  forkSource?: unknown
  lastMergeSourceCommit?: { commitId?: string }
}

export interface PrCriteria {
  creatorId?: string
  reviewerId?: string
  repositoryId?: string
  sourceBranch?: string
  status: 'active' | 'completed'
  closedSince?: number
  top: number
}

interface RawRepository {
  id: string
  name: string
  project: { id: string; name: string }
  sshUrl?: string | null
  isDisabled?: boolean
  isInMaintenance?: boolean
}

export async function listPullRequests(
  http: AdoHttp,
  org: string,
  projectId: string,
  criteria: PrCriteria,
  signal?: AbortSignal
): Promise<RawPullRequest[]> {
  const closedSince = criteria.closedSince === undefined ? undefined : new Date(criteria.closedSince)
  const { data } = await http.json<{ value: RawPullRequest[] }>({
    org,
    project: projectId,
    path: '/_apis/git/pullrequests',
    query: {
      'searchCriteria.creatorId': criteria.creatorId,
      'searchCriteria.reviewerId': criteria.reviewerId,
      'searchCriteria.repositoryId': criteria.repositoryId,
      'searchCriteria.sourceRefName': criteria.sourceBranch === undefined ? undefined : `refs/heads/${criteria.sourceBranch}`,
      'searchCriteria.status': criteria.status,
      'searchCriteria.queryTimeRangeType': closedSince ? 'closed' : undefined,
      'searchCriteria.minTime': closedSince?.toISOString(),
      $top: criteria.top
    },
    signal
  })
  return shape(() => expectList<RawPullRequest>(data.value))
}

export async function getPullRequest(http: AdoHttp, org: string, key: PrKey): Promise<RawPullRequest> {
  const { data } = await http.json<RawPullRequest>({
    org,
    project: key.projectId,
    path: `/_apis/git/repositories/${encodeURIComponent(key.repoId)}/pullrequests/${key.prId}`
  })
  return data ?? malformed(MALFORMED.pullRequest)
}

export async function pullRequestWorkItems(http: AdoHttp, org: string, key: PrKey): Promise<number[]> {
  const { data } = await http.json<{ value: { id: unknown }[] }>({
    org,
    project: key.projectId,
    path: `/_apis/git/repositories/${encodeURIComponent(key.repoId)}/pullRequests/${key.prId}/workitems`
  })
  return shape(() => expectList<{ id: unknown }>(data.value).flatMap(item => workItemId(item.id)))
}

export async function listRepositories(http: AdoHttp, org: string): Promise<RepoRecord[]> {
  const { data } = await http.json<{ value: RawRepository[] }>({ org, path: '/_apis/git/repositories' })
  return shape(() => expectList<RawRepository>(data.value).map(toRepoRecord))
}

export function deletesSourceBranch(raw: RawPullRequest): boolean {
  return Boolean(raw.autoCompleteSetBy) && raw.completionOptions?.deleteSourceBranch === true
}

export function toReviewer(raw: RawReviewer): PrReviewer {
  return shape(() => ({
    id: expectText(raw.id),
    name: expectText(raw.displayName),
    uniqueName: textOr(raw.uniqueName, ''),
    vote: typeof raw.vote === 'number' ? raw.vote : 0,
    isRequired: raw.isRequired === true,
    isGroup: raw.isContainer === true,
    hasDeclined: raw.hasDeclined === true
  }))
}

export function toPrSummary(raw: RawPullRequest, org: string): PrSummary {
  return shape(() => {
    const { repository } = raw
    const projectName = expectText(repository.project.name)
    const repoName = expectText(repository.name)
    const prId = expectPrId(raw.pullRequestId)
    return {
      org,
      projectId: expectText(repository.project.id),
      projectName,
      repoId: expectText(repository.id),
      repoName,
      prId,
      title: expectText(raw.title),
      url: pullRequestUrl(org, repository.webUrl, projectName, repoName, prId),
      source: branchName(expectText(raw.sourceRefName)),
      target: branchName(expectText(raw.targetRefName)),
      status: statusOf(expectText(raw.status)),
      isDraft: raw.isDraft === true,
      mergeStatus: mergeStatusOf(raw.mergeStatus),
      createdBy: { id: expectText(raw.createdBy.id), name: expectText(raw.createdBy.displayName) },
      createdAt: timestamp(raw.creationDate),
      closedAt: typeof raw.closedDate === 'string' ? timestamp(raw.closedDate) : null,
      reviewers: (raw.reviewers ?? []).map(toReviewer),
      autoComplete: Boolean(raw.autoCompleteSetBy),
      workItemIds: [],
      checks: null
    }
  })
}

export function toPrRecord(raw: RawPullRequest, org: string): PrRecord {
  return shape(() => {
    const projectId = expectText(raw.repository.project.id)
    const repoId = expectText(raw.repository.id)
    const prId = expectPrId(raw.pullRequestId)
    const title = textOr(raw.title, null)
    return {
      projectId,
      repoId,
      prId,
      status: statusOf(expectText(raw.status)),
      target: branchName(expectText(raw.targetRefName)),
      sourceCommit: textOr(raw.lastMergeSourceCommit?.commitId, null),
      reviewers: reviewersSignature(raw.reviewers),
      url: pullRequestUrl(org, raw.repository.webUrl, projectId, repoId, prId),
      ...(title === null ? {} : { title })
    }
  })
}

function toRepoRecord(raw: RawRepository): RepoRecord {
  return {
    id: expectText(raw.id),
    name: expectText(raw.name),
    projectId: expectText(raw.project.id),
    projectName: expectText(raw.project.name),
    ssh: typeof raw.sshUrl === 'string',
    disabled: raw.isDisabled === true || raw.isInMaintenance === true
  }
}

function workItemId(id: unknown): number[] {
  return typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? [Number(id)] : []
}

function expectPrId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('expected a pull request id')
  return value
}

function statusOf(status: string): PrSummary['status'] {
  return status === 'completed' || status === 'abandoned' ? status : 'active'
}

function mergeStatusOf(status: string | undefined): PrSummary['mergeStatus'] {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'conflicts':
      return 'conflicts'
    case 'failure':
    case 'rejectedByPolicy':
      return 'failed'
    default:
      return 'pending'
  }
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.pullRequest)
}
