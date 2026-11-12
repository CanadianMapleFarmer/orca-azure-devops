import type { PrChip } from '../../src/shared/work'
import type { OrgEntities } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { prKey, type CheckRecord, type PrRecord } from '../data/records'
import { MALFORMED } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { mapLimit } from './limit'
import { orgWebUrl } from './org'
import { checksDue, MAX_CHECK_READS, readChecks } from './policy'
import { listPullRequests, toPrRecord, type RawPullRequest } from './pullrequests'
import { malformed } from './shape'
import type { PrRef } from './workitems'

type PrTables = Pick<OrgEntities, 'prs' | 'prChecks'>

export const SWEEP_TOP = 500
const MAX_CONCURRENT = 6
const HEADS_PREFIX = /^refs\/heads\//

export async function loadPrChips(
  http: AdoHttp,
  org: string,
  refs: PrRef[],
  tables: PrTables,
  now: () => number,
  missing: Map<string, number> = new Map()
): Promise<PrChip[]> {
  const distinct = [...new Map(refs.map(ref => [prKey(ref), ref])).values()]
  const stale = distinct.filter(ref => isStale(tables, ref, now(), missing))
  if (stale.length > 0) await sweep(http, org, stale, tables, now, missing)
  await readDueChecks(http, org, distinct, tables, now)
  return distinct.flatMap(ref => {
    const record = tables.prs.get(prKey(ref))?.value
    return record ? [chipOf(record, tables.prChecks.get(prKey(ref))?.value)] : []
  })
}

export function chipOf(record: PrRecord, checks: CheckRecord | undefined): PrChip {
  const state = record.status === 'active' ? 'open' : record.status === 'completed' ? 'merged' : 'abandoned'
  return {
    prId: record.prId,
    repoId: record.repoId,
    projectId: record.projectId,
    target: record.target,
    state,
    build: state === 'open' ? (checks?.build ?? 'none') : 'none',
    url: record.url
  }
}

function isStale(tables: PrTables, ref: PrRef, now: number, missing: Map<string, number>): boolean {
  const held = tables.prs.get(prKey(ref))
  if (held) return held.value.status === 'active' && now - held.at >= FRESHNESS.prActive
  const lostAt = missing.get(prKey(ref))
  return lostAt === undefined || now - lostAt >= FRESHNESS.prActive
}

async function sweep(http: AdoHttp, org: string, stale: PrRef[], tables: PrTables, now: () => number, missing: Map<string, number>): Promise<void> {
  const keep = (ref: PrRef, raw: RawPullRequest) => {
    missing.delete(prKey(ref))
    tables.prs.put(prKey(ref), toPrRecord(raw, org))
  }
  const byProject = new Map<string, PrRef[]>()
  for (const ref of stale) byProject.set(ref.projectId, [...(byProject.get(ref.projectId) ?? []), ref])
  const unlisted = await mapLimit([...byProject], MAX_CONCURRENT, async ([projectId, wanted]) => {
    const listed = new Map((await activeIn(http, org, projectId)).map(raw => [listedKey(raw), raw]))
    for (const ref of wanted) {
      const raw = listed.get(prKey(ref))
      if (raw) keep(ref, raw)
    }
    return wanted.filter(ref => !listed.has(prKey(ref)))
  })
  await mapLimit(unlisted.flat(), MAX_CONCURRENT, async ref => {
    const raw = await fetchPullRequest(http, org, ref)
    if (raw) {
      keep(ref, raw)
      return
    }
    tables.prs.drop(prKey(ref))
    missing.set(prKey(ref), now())
  })
}

async function readDueChecks(http: AdoHttp, org: string, refs: PrRef[], tables: PrTables, now: () => number): Promise<void> {
  const due = refs.flatMap(ref => {
    const record = tables.prs.get(prKey(ref))?.value
    const held = tables.prChecks.get(prKey(ref))
    return record && checksDue(record, held, now()) ? [{ record, at: held?.at ?? -Infinity }] : []
  })
  const oldest = due.sort((a, b) => a.at - b.at).slice(0, MAX_CHECK_READS)
  await mapLimit(oldest, MAX_CONCURRENT, async ({ record }) => {
    tables.prChecks.put(prKey(record), await readChecks(http, org, record))
  })
}

async function activeIn(http: AdoHttp, org: string, projectId: string): Promise<RawPullRequest[]> {
  try {
    return await listPullRequests(http, org, projectId, { status: 'active', top: SWEEP_TOP })
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') return []
    throw error
  }
}

function listedKey(raw: RawPullRequest): string {
  return `${raw.repository?.project?.id}/${raw.repository?.id}/${raw.pullRequestId}`
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

export function parsedHref(url: string): string | undefined {
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
