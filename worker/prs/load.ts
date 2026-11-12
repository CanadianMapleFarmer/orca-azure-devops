import type { PrChecks, PrKey, PrSummary } from '../../src/shared/prs'
import type { NamedItem } from '../ado/core'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { checksDue, readChecks } from '../ado/policy'
import { listThreads, type RawThread } from '../ado/pr-review'
import { listPullRequests, pullRequestWorkItems, toPrRecord, toPrSummary, type PrCriteria } from '../ado/pullrequests'
import type { OrgEntities } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { createHeat } from '../data/heat'
import { prKey, type PrRecord } from '../data/records'
import { COMPLETED_WINDOW_MS } from './release-sets'

const MINUTE = 60_000
const IN_FLIGHT = 4
const MINE_TOP = 100
const COMPLETED_TOP = 50
const REVIEW_TOP = 100
const COMPLETED_EVERY_MS = 5 * MINUTE
const ENRICHMENT_OFF_MS = 10 * MINUTE

export type Enrichment = 'workItems' | 'checks'

export type ThreadRead = { threads: RawThread[] } | { unreadable: 'gone' | 'forbidden' | 'failed' }

export interface FullLoad {
  mine: PrSummary[]
  review: PrSummary[]
  off: Record<Enrichment, boolean>
}

export interface PrSource {
  full(me: string, projects: NamedItem[], all: boolean, signal?: AbortSignal): Promise<FullLoad>
  reviews(me: string, projects: NamedItem[], all: boolean, signal?: AbortSignal): Promise<PrSummary[]>
  active(me: string, projects: NamedItem[], all: boolean, signal?: AbortSignal): Promise<PrSummary[]>
  threads(prs: PrKey[], signal?: AbortSignal): Promise<ThreadRead[]>
}

type PrTables = Pick<OrgEntities, 'prs' | 'prChecks' | 'prWorkItems'>
type Listed = PrSummary & { record: PrRecord }
type List = 'mine' | 'completed' | 'review'
type Kept = Partial<Record<List, Listed[]>> & { completedAt?: number }

export function createPrSource(http: AdoHttp, org: string, now: () => number, tables: PrTables, longestTickMs: number): PrSource {
  const heat = createHeat<List>(now, longestTickMs)
  const kept = new Map<string, Kept>()
  const offUntil: Record<Enrichment, number> = { workItems: -Infinity, checks: -Infinity }

  function keptOf(me: string, projectId: string): Kept {
    const key = `${me}/${projectId}`
    const entry = kept.get(key) ?? {}
    kept.set(key, entry)
    return entry
  }

  async function listsOf(scoped: AdoHttp, me: string, projects: NamedItem[], all: boolean, lists: readonly List[]): Promise<Kept[]> {
    const current = new Set(projects.map(project => `${me}/${project.id}`))
    for (const key of kept.keys()) if (!current.has(key)) kept.delete(key)
    const reads = projects.flatMap(project => {
      const entry = keptOf(me, project.id)
      return lists.flatMap(list => {
        const criteria = (all || !entry[list] || heat.due(list, project.id)) && criteriaOf(me, entry, list)
        return criteria ? [{ entry, projectId: project.id, list, criteria }] : []
      })
    })
    await mapLimit(reads, IN_FLIGHT, async ({ entry, projectId, list, criteria }) => {
      entry[list] = await listed(scoped, projectId, criteria)
      if (list === 'completed') entry.completedAt = now()
    })
    for (const { entry, projectId, list } of reads) heat.saw(list, projectId, found(entry))
    return projects.map(project => keptOf(me, project.id))
  }

  function criteriaOf(me: string, entry: Kept, list: List): PrCriteria | null {
    if (list === 'mine') return activeOf(me)
    if (list === 'review') return reviewerOf(me)
    if (entry.completedAt !== undefined && now() - entry.completedAt < COMPLETED_EVERY_MS) return null
    return { creatorId: me, status: 'completed', closedSince: now() - COMPLETED_WINDOW_MS, top: COMPLETED_TOP }
  }

  async function listed(scoped: AdoHttp, projectId: string, criteria: PrCriteria): Promise<Listed[]> {
    return (await listPullRequests(scoped, org, projectId, criteria)).map(raw => {
      const record = toPrRecord(raw, org)
      tables.prs.put(prKey(record), record)
      return { ...toPrSummary(raw, org), record }
    })
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
    async full(me, projects, all, signal) {
      const scoped = withSignal(http, signal)
      const held = await listsOf(scoped, me, projects, all, ['mine', 'completed', 'review'])
      const mine = await mapLimit(held.flatMap(entry => [...(entry.mine ?? []), ...(entry.completed ?? [])]), IN_FLIGHT, pr => enrich(scoped, pr))
      const review = held.flatMap(entry => entry.review ?? []).map(summaryOf)
      return { mine, review, off: { workItems: now() < offUntil.workItems, checks: now() < offUntil.checks } }
    },

    async reviews(me, projects, all, signal) {
      const held = await listsOf(withSignal(http, signal), me, projects, all, ['review'])
      return held.flatMap(entry => entry.review ?? []).map(summaryOf)
    },

    async active(me, projects, all, signal) {
      const held = await listsOf(withSignal(http, signal), me, projects, all, ['mine'])
      return held.flatMap(entry => entry.mine ?? []).map(summaryOf)
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

function found(entry: Kept): boolean {
  return [entry.mine, entry.completed, entry.review].some(list => (list?.length ?? 0) > 0)
}

function summaryOf({ record: _, ...pr }: Listed): PrSummary {
  return pr
}
