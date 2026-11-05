import type { PrChip } from '../../src/shared/work'
import { MALFORMED } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { mapLimit } from './limit'
import { orgWebUrl } from './org'
import { buildStateOf, loadEvaluations } from './policy'
import { expectText, malformed, shaped } from './shape'
import type { PrRef } from './workitems'

interface RawPullRequest {
  status: string
  targetRefName: string
  repository?: { webUrl?: string }
}

export type PrChipCache = Map<string, { at: number; chip: PrChip | null }>

const CACHE_TTL_MS = 2 * 60 * 1000
const TERMINAL_TTL_MS = 60 * 60 * 1000
const MAX_CONCURRENT = 6
const HEADS_PREFIX = /^refs\/heads\//

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
    if (cached && now() - cached.at < ttlOf(cached.chip)) return cached.chip ?? undefined
    const chip = await fetchChip(http, org, ref)
    cache.set(key, { at: now(), chip: chip ?? null })
    return chip
  })
  return chips.filter((chip): chip is PrChip => chip !== undefined)
}

function ttlOf(chip: PrChip | null): number {
  return chip?.state === 'merged' || chip?.state === 'abandoned' ? TERMINAL_TTL_MS : CACHE_TTL_MS
}

async function fetchChip(http: AdoHttp, org: string, ref: PrRef): Promise<PrChip | undefined> {
  const pullRequest = await fetchPullRequest(http, org, ref)
  if (!pullRequest) return undefined
  const state = shape(() => prState(expectText(pullRequest.status)))
  const evaluations = state === 'open' ? await loadEvaluations(http, org, ref) : []
  return shape(() => ({
    prId: ref.prId,
    repoId: ref.repoId,
    projectId: ref.projectId,
    target: branchName(expectText(pullRequest.targetRefName)),
    state,
    build: buildStateOf(evaluations),
    url: pullRequestUrl(org, pullRequest.repository?.webUrl, ref.projectId, ref.repoId, ref.prId)
  }))
}

async function fetchPullRequest(http: AdoHttp, org: string, ref: PrRef): Promise<RawPullRequest | undefined> {
  try {
    const { data } = await http.json<RawPullRequest>({ org, project: ref.projectId, path: `/_apis/git/pullrequests/${ref.prId}` })
    return data ?? malformed(MALFORMED.pullRequest)
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') return undefined
    throw error
  }
}

export function pullRequestUrl(
  org: string,
  webUrl: string | undefined,
  projectIdOrName: string,
  repoIdOrName: string,
  prId: number
): string {
  const base = typeof webUrl === 'string' ? parsedHref(webUrl) : undefined
  return base === undefined
    ? pullRequestNamedUrl(org, projectIdOrName, repoIdOrName, prId)
    : `${base}/pullrequest/${prId}`
}

function parsedHref(url: string): string | undefined {
  try {
    return new URL(url).href
  } catch {
    return undefined
  }
}

export function pullRequestNamedUrl(org: string, projectIdOrName: string, repoIdOrName: string, prId: number): string {
  return `${orgWebUrl(org)}/${encodeURIComponent(projectIdOrName)}/_git/${encodeURIComponent(repoIdOrName)}/pullrequest/${prId}`
}

export function branchName(ref: string): string {
  return ref.replace(HEADS_PREFIX, '')
}

function prState(status: string): PrChip['state'] {
  if (status === 'completed') return 'merged'
  return status === 'abandoned' ? 'abandoned' : 'open'
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.pullRequest)
}
