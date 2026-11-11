import type { PrChecks, PrKey, PrSummary } from '../../src/shared/prs'
import type { NamedItem } from '../ado/core'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { checksDue, readChecks } from '../ado/policy'
import { listThreads, type RawThread } from '../ado/pr-review'
import { listPullRequests, pullRequestWorkItems, toPrRecord, toPrSummary, type PrCriteria } from '../ado/pullrequests'
import type { OrgEntities } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { prKey, type PrRecord } from '../data/records'
import { COMPLETED_WINDOW_MS } from './release-sets'

const MINUTE = 60_000
const IN_FLIGHT = 4
const MINE_TOP = 100
const COMPLETED_TOP = 50
const REVIEW_TOP = 100
const COMPLETED_TTL_MS = 5 * MINUTE
const ENRICHMENT_OFF_MS = 10 * MINUTE

export type Enrichment = 'workItems' | 'checks'

export type ThreadRead = { threads: RawThread[] } | { unreadable: 'gone' | 'forbidden' | 'failed' }

export interface FullLoad {
  mine: PrSummary[]
  review: PrSummary[]
  off: Record<Enrichment, boolean>
}

export interface PrSource {
  full(me: string, projects: NamedItem[], signal?: AbortSignal): Promise<FullLoad>
  reviews(me: string, projects: NamedItem[], signal?: AbortSignal): Promise<PrSummary[]>
  active(me: string, projects: NamedItem[], signal?: AbortSignal): Promise<PrSummary[]>
  threads(prs: PrKey[], signal?: AbortSignal): Promise<ThreadRead[]>
}

type Cache<T> = Map<string, { at: number; ttl: number; value: T }>
type PrTables = Pick<OrgEntities, 'prs' | 'prChecks' | 'prWorkItems'>
type Listed = PrSummary & { record: PrRecord }

export function createPrSource(http: AdoHttp, org: string, now: () => number, tables: PrTables): PrSource {
  const completed: Cache<Listed[]> = new Map()
  const offUntil: Record<Enrichment, number> = { workItems: -Infinity, checks: -Infinity }

  async function remember<T>(cache: Cache<T>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < hit.ttl) return hit.value
    const value = await load()
    cache.set(key, { at: now(), ttl, value })
    return value
  }

  async function listed(scoped: AdoHttp, projectId: string, criteria: PrCriteria): Promise<Listed[]> {
    return (await listPullRequests(scoped, org, projectId, criteria)).map(raw => {
      const record = toPrRecord(raw, org)
      tables.prs.put(prKey(record), record)
      return { ...toPrSummary(raw, org), record }
    })
  }

  async function list(scoped: AdoHttp, projectId: string, criteria: PrCriteria): Promise<PrSummary[]> {
    return (await listed(scoped, projectId, criteria)).map(summaryOf)
  }

  function myCompleted(scoped: AdoHttp, me: string, projectId: string): Promise<Listed[]> {
    const criteria: PrCriteria = { creatorId: me, status: 'completed', closedSince: now() - COMPLETED_WINDOW_MS, top: COMPLETED_TOP }
    return remember(completed, `${me}/${projectId}`, COMPLETED_TTL_MS, () => listed(scoped, projectId, criteria))
  }

  async function unlessRefused<T>(enrichment: Enrichment, read: () => Promise<T>): Promise<T | null> {
    if (now() < offUntil[enrichment]) return null
    try {
      return await read()
    } catch (error) {
      if (!(error instanceof AdoError) || error.code !== 'forbidden') throw error
      offUntil[enrichment] = now() + ENRICHMENT_OFF_MS
      return null
    }
  }

  async function workItemsOf(scoped: AdoHttp, pr: PrRecord): Promise<number[]> {
    const key = prKey(pr)
    const maxAge = pr.status === 'active' ? FRESHNESS.prWorkItems : FRESHNESS.prWorkItemsClosed
    const read = async () => tables.prWorkItems.fresh(key, maxAge) ?? tables.prWorkItems.put(key, await pullRequestWorkItems(scoped, org, pr))
    return (await unlessRefused('workItems', read)) ?? []
  }

  function checksOf(scoped: AdoHttp, pr: PrRecord): Promise<PrChecks | null> {
    return unlessRefused('checks', async () => {
      const held = tables.prChecks.get(prKey(pr))
      const { build, policies } = held && !checksDue(pr, held, now()) ? held.value : tables.prChecks.put(prKey(pr), await readChecks(scoped, org, pr))
      return { build, policies }
    })
  }

  async function enrich(scoped: AdoHttp, { record, ...pr }: Listed): Promise<PrSummary> {
    const workItemIds = await workItemsOf(scoped, record)
    return { ...pr, workItemIds, checks: pr.status === 'active' ? await checksOf(scoped, record) : null }
  }

  return {
    async full(me, projects, signal) {
      const scoped = withSignal(http, signal)
      const lists = projects.flatMap(project => [
        { kind: 'mine', load: () => listed(scoped, project.id, activeOf(me)) },
        { kind: 'mine', load: () => myCompleted(scoped, me, project.id) },
        { kind: 'review', load: () => listed(scoped, project.id, reviewerOf(me)) }
      ])
      const loaded = await mapLimit(lists, IN_FLIGHT, entry => entry.load())
      const of = (kind: string) => lists.flatMap((entry, index) => (entry.kind === kind ? loaded[index] : []))
      const mine = await mapLimit(of('mine'), IN_FLIGHT, pr => enrich(scoped, pr))
      return { mine, review: of('review').map(summaryOf), off: { workItems: now() < offUntil.workItems, checks: now() < offUntil.checks } }
    },

    async reviews(me, projects, signal) {
      const scoped = withSignal(http, signal)
      return (await mapLimit(projects, IN_FLIGHT, project => list(scoped, project.id, reviewerOf(me)))).flat()
    },

    async active(me, projects, signal) {
      const scoped = withSignal(http, signal)
      return (await mapLimit(projects, IN_FLIGHT, project => list(scoped, project.id, activeOf(me)))).flat()
    },

    threads(prs, signal) {
      const scoped = withSignal(http, signal)
      return mapLimit(prs, IN_FLIGHT, async (pr): Promise<ThreadRead> => {
        try {
          return { threads: await listThreads(scoped, org, pr, null) }
        } catch (error) {
          if (signal?.aborted || (error instanceof AdoError && error.code === 'rate_limited')) throw error
          return { unreadable: unreadableBecause(error) }
        }
      })
    }
  }
}

function unreadableBecause(error: unknown): 'gone' | 'forbidden' | 'failed' {
  if (error instanceof AdoError && error.code === 'not_found') return 'gone'
  return error instanceof AdoError && error.code === 'forbidden' ? 'forbidden' : 'failed'
}

function activeOf(me: string): PrCriteria {
  return { creatorId: me, status: 'active', top: MINE_TOP }
}

function reviewerOf(me: string): PrCriteria {
  return { reviewerId: me, status: 'active', top: REVIEW_TOP }
}

function summaryOf({ record: _, ...pr }: Listed): PrSummary {
  return pr
}
