import type { PrChip } from '../../src/shared/work'
import { AdoError, type AdoHttp } from './http'
import { expectList, expectText, malformed, shaped } from './shape'
import type { PrRef } from './workitems'

interface RawPullRequest {
  status: string
  targetRefName: string
  repository?: { webUrl?: string }
}

interface RawEvaluation {
  status: string
  configuration?: {
    type?: { displayName?: string }
    settings?: { buildDefinitionId?: unknown }
  }
}

type BuildState = PrChip['build']

export type PrChipCache = Map<string, { at: number; chip: PrChip | null }>

const CACHE_TTL_MS = 2 * 60 * 1000
const MAX_CONCURRENT = 6
const HEADS_PREFIX = /^refs\/heads\//
const BUILD_POLICY_TYPE = 'Build'
const BUILD_SEVERITY: Record<BuildState, number> = { none: 0, succeeded: 1, running: 2, failed: 3 }
const MALFORMED_MESSAGE = 'Azure DevOps returned an unexpected pull request response.'

export async function loadPrChips(
  http: AdoHttp,
  org: string,
  refs: PrRef[],
  cache: PrChipCache,
  now: () => number
): Promise<PrChip[]> {
  const distinct = [...new Map(refs.map(ref => [ref.prId, ref])).values()]
  const chips = await mapLimit(distinct, MAX_CONCURRENT, async ref => {
    const key = String(ref.prId)
    const cached = cache.get(key)
    if (cached && now() - cached.at < CACHE_TTL_MS) return cached.chip ?? undefined
    const chip = await fetchChip(http, org, ref)
    cache.set(key, { at: now(), chip: chip ?? null })
    return chip
  })
  return chips.filter((chip): chip is PrChip => chip !== undefined)
}

async function fetchChip(http: AdoHttp, org: string, ref: PrRef): Promise<PrChip | undefined> {
  const pullRequest = await fetchPullRequest(http, org, ref)
  if (!pullRequest) return undefined
  const state = shape(() => prState(expectText(pullRequest.status)))
  const evaluations = state === 'open' ? await fetchEvaluations(http, org, ref) : []
  return shape(() => ({
    prId: ref.prId,
    repoId: ref.repoId,
    projectId: ref.projectId,
    target: expectText(pullRequest.targetRefName).replace(HEADS_PREFIX, ''),
    state,
    build: buildState(evaluations),
    url: pullRequestUrl(pullRequest, org, ref)
  }))
}

async function fetchEvaluations(http: AdoHttp, org: string, ref: PrRef): Promise<RawEvaluation[]> {
  const { data } = await http.json<{ value: RawEvaluation[] }>({
    org,
    project: ref.projectId,
    path: '/_apis/policy/evaluations',
    query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${ref.projectId}/${ref.prId}` },
    apiVersion: '7.1-preview.1'
  })
  return shape(() => expectList<RawEvaluation>(data.value))
}

async function fetchPullRequest(http: AdoHttp, org: string, ref: PrRef): Promise<RawPullRequest | undefined> {
  try {
    const { data } = await http.json<RawPullRequest>({ org, project: ref.projectId, path: `/_apis/git/pullrequests/${ref.prId}` })
    return data ?? malformed(MALFORMED_MESSAGE)
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') return undefined
    throw error
  }
}

function pullRequestUrl(pullRequest: RawPullRequest, org: string, ref: PrRef): string {
  const webUrl = pullRequest.repository?.webUrl
  const repository = typeof webUrl === 'string' && webUrl !== ''
    ? webUrl
    : `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(ref.projectId)}/_git/${encodeURIComponent(ref.repoId)}`
  return `${repository}/pullrequest/${ref.prId}`
}

function prState(status: string): PrChip['state'] {
  if (status === 'completed') return 'merged'
  return status === 'abandoned' ? 'abandoned' : 'open'
}

function buildState(evaluations: RawEvaluation[]): BuildState {
  return evaluations
    .filter(isBuildPolicy)
    .map(evaluation => stateOf(evaluation.status))
    .reduce<BuildState>((worst, state) => (BUILD_SEVERITY[state] > BUILD_SEVERITY[worst] ? state : worst), 'none')
}

function isBuildPolicy({ configuration }: RawEvaluation): boolean {
  const definitionId = configuration?.settings?.buildDefinitionId
  return configuration?.type?.displayName === BUILD_POLICY_TYPE || (definitionId !== undefined && definitionId !== null)
}

function stateOf(status: string): BuildState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'approved':
      return 'succeeded'
    case 'rejected':
      return 'failed'
    default:
      return 'none'
  }
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await run(items[index])
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED_MESSAGE)
}
