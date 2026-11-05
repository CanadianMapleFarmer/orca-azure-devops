import type { RunState, RunSummary } from '../../src/shared/pipelines'
import { MALFORMED, UNKNOWN_AUTHOR } from '../messages'
import type { AdoHttp, AdoRequest } from './http'
import { orgWebUrl } from './org'
import { branchName, parsedHref } from './pr-links'
import { expectList, expectText, malformed, shaped } from './shape'
import { textOr, timestamp } from './workitems'

export interface RawBuild {
  id: number
  buildNumber: string
  status: string
  result?: string
  queueTime?: string
  startTime?: string
  finishTime?: string
  sourceBranch: string
  reason?: string
  definition: { id: number; name: string }
  project: { id: string; name: string }
  requestedFor?: { id: string; displayName: string }
  repository?: { id: string; name: string; type?: string }
  triggerInfo?: Record<string, string>
  _links?: { web?: { href?: string } }
}

export interface BuildCriteria {
  requestedFor?: string
  statusFilter?: 'inProgress'
  minTime?: number
  top: number
}

export const MAX_BUILD_IDS = 100

const BUILDS_PATH = '/_apis/build/builds'
const GIT_REPOSITORY = 'TfsGit'
const PULL_MERGE_REF = /^refs\/pull\/(\d+)\/merge$/
const DIGITS = /^\d+$/

export function listBuilds(
  http: AdoHttp,
  org: string,
  projectId: string,
  criteria: BuildCriteria,
  signal?: AbortSignal
): Promise<RawBuild[]> {
  return fetchBuilds(
    http,
    org,
    projectId,
    {
      requestedFor: criteria.requestedFor,
      statusFilter: criteria.statusFilter,
      minTime: criteria.minTime === undefined ? undefined : new Date(criteria.minTime).toISOString(),
      queryOrder: 'queueTimeDescending',
      $top: criteria.top
    },
    signal
  )
}

export async function buildsByIds(
  http: AdoHttp,
  org: string,
  projectId: string,
  ids: number[],
  signal?: AbortSignal
): Promise<RawBuild[]> {
  if (ids.length === 0) return []
  if (ids.length > MAX_BUILD_IDS) throw new RangeError(`At most ${MAX_BUILD_IDS} runs can be read at once.`)
  return fetchBuilds(http, org, projectId, { buildIds: ids.join(',') }, signal)
}

export async function getBuild(
  http: AdoHttp,
  org: string,
  projectId: string,
  buildId: number,
  signal?: AbortSignal
): Promise<RawBuild> {
  const { data } = await http.json<RawBuild>({ org, project: projectId, path: `${BUILDS_PATH}/${buildId}`, signal })
  return data ?? malformed(MALFORMED.build)
}

export function runWebUrl(org: string, projectName: string, buildId: number): string {
  return `${orgWebUrl(org)}/${encodeURIComponent(projectName)}/_build/results?buildId=${buildId}`
}

export function runStateOf(raw: Pick<RawBuild, 'status' | 'result'>): RunState {
  switch (raw.status) {
    case 'notStarted':
    case 'postponed':
      return 'queued'
    case 'inProgress':
      return 'running'
    case 'cancelling':
      return 'cancelling'
    case 'completed':
      return completedState(raw.result)
    default:
      return 'warning'
  }
}

export function toRunSummary(raw: RawBuild, org: string, me: string): RunSummary {
  return shape(() => {
    const buildId = expectId(raw.id)
    const projectName = expectText(raw.project.name)
    const requester = requesterOf(raw)
    return {
      org,
      projectId: expectText(raw.project.id),
      buildId,
      projectName,
      pipeline: { id: expectId(raw.definition.id), name: expectText(raw.definition.name) },
      runNumber: expectText(raw.buildNumber),
      url: runUrl(org, raw, projectName, buildId),
      branch: branchName(textOr(raw.triggerInfo?.['pr.sourceBranch'], expectText(raw.sourceBranch))),
      prId: pullRequestId(raw),
      reason: textOr(raw.reason, ''),
      repository: repositoryOf(raw),
      requestedFor: requester,
      state: runStateOf({ status: expectText(raw.status), result: raw.result }),
      queuedAt: timestamp(raw.queueTime),
      startedAt: optionalTimestamp(raw.startTime),
      finishedAt: optionalTimestamp(raw.finishTime),
      stages: null,
      approvals: [],
      mine: requester.id !== '' && requester.id.toLowerCase() === me.toLowerCase(),
      watched: false
    }
  })
}

async function fetchBuilds(
  http: AdoHttp,
  org: string,
  projectId: string,
  query: AdoRequest['query'],
  signal?: AbortSignal
): Promise<RawBuild[]> {
  const { data } = await http.json<{ value: RawBuild[] }>({ org, project: projectId, path: BUILDS_PATH, query, signal })
  return shape(() => expectList<RawBuild>(data.value))
}

function completedState(result: string | undefined): RunState {
  switch (result) {
    case 'succeeded':
      return 'succeeded'
    case 'partiallySucceeded':
      return 'warning'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    default:
      return 'warning'
  }
}

function runUrl(org: string, raw: RawBuild, projectName: string, buildId: number): string {
  const href = raw._links?.web?.href
  return (typeof href === 'string' ? parsedHref(href) : undefined) ?? runWebUrl(org, projectName, buildId)
}

function pullRequestId(raw: RawBuild): number | null {
  return positiveInteger(raw.triggerInfo?.['pr.number']) ?? positiveInteger(PULL_MERGE_REF.exec(expectText(raw.sourceBranch))?.[1])
}

function repositoryOf(raw: RawBuild): RunSummary['repository'] {
  const { repository } = raw
  return repository?.type === GIT_REPOSITORY ? { id: expectText(repository.id), name: expectText(repository.name) } : null
}

function requesterOf(raw: RawBuild): RunSummary['requestedFor'] {
  const { requestedFor } = raw
  if (!requestedFor) return { id: '', name: UNKNOWN_AUTHOR }
  return { id: expectText(requestedFor.id), name: expectText(requestedFor.displayName) }
}

function positiveInteger(text: unknown): number | null {
  if (typeof text !== 'string' || !DIGITS.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function expectId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('expected an id')
  return value
}

function optionalTimestamp(value: unknown): number | null {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(ms) ? null : ms
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.build)
}
