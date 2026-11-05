import type { PrChecks, PrKey, PrSummary } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import type { NamedItem } from '../ado/core'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { buildStateOf, loadEvaluations, policyStateOf } from '../ado/policy'
import { codeProjects, listPullRequests, pullRequestWorkItems, toPrSummary, type PrCriteria } from '../ado/pullrequests'
import { COMPLETED_WINDOW_MS } from './release-sets'

const MINUTE = 60_000
const IN_FLIGHT = 4
const MINE_TOP = 100
const COMPLETED_TOP = 50
const REVIEW_TOP = 100
const PROJECTS_TTL_MS = 60 * MINUTE
const COMPLETED_TTL_MS = 5 * MINUTE
const WORK_ITEMS_TTL_MS = 10 * MINUTE
const COMPLETED_WORK_ITEMS_TTL_MS = 60 * MINUTE
const CHECKS_TTL_MS = 2 * MINUTE
const ENRICHMENT_OFF_MS = 10 * MINUTE

export type Enrichment = 'workItems' | 'checks'

export interface FullLoad {
  mine: PrSummary[]
  review: PrSummary[]
  off: Record<Enrichment, boolean>
}

export interface PrSource {
  full(me: string, projects: NamedItem[], signal?: AbortSignal): Promise<FullLoad>
  reviews(me: string, projects: NamedItem[], signal?: AbortSignal): Promise<PrSummary[]>
}

export type CodeProjects = (setting: OrgStatus['codeProjects'], signal?: AbortSignal) => Promise<NamedItem[]>

type Cache<T> = Map<string, { at: number; ttl: number; value: T }>

export function createPrSource(http: AdoHttp, org: string, now: () => number): PrSource {
  const completed: Cache<PrSummary[]> = new Map()
  const workItems: Cache<number[]> = new Map()
  const checks: Cache<PrChecks> = new Map()
  const offUntil: Record<Enrichment, number> = { workItems: -Infinity, checks: -Infinity }

  async function remember<T>(cache: Cache<T>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < hit.ttl) return hit.value
    const value = await load()
    cache.set(key, { at: now(), ttl, value })
    return value
  }

  async function list(scoped: AdoHttp, projectId: string, criteria: PrCriteria): Promise<PrSummary[]> {
    return (await listPullRequests(scoped, org, projectId, criteria)).map(raw => toPrSummary(raw, org))
  }

  function myCompleted(scoped: AdoHttp, me: string, projectId: string): Promise<PrSummary[]> {
    const criteria: PrCriteria = { creatorId: me, status: 'completed', closedSince: now() - COMPLETED_WINDOW_MS, top: COMPLETED_TOP }
    return remember(completed, `${me}/${projectId}`, COMPLETED_TTL_MS, () => list(scoped, projectId, criteria))
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

  async function workItemsOf(scoped: AdoHttp, pr: PrSummary): Promise<number[]> {
    const ttl = pr.status === 'completed' ? COMPLETED_WORK_ITEMS_TTL_MS : WORK_ITEMS_TTL_MS
    return (await unlessRefused('workItems', () => remember(workItems, keyOf(pr), ttl, () => pullRequestWorkItems(scoped, org, pr)))) ?? []
  }

  function checksOf(scoped: AdoHttp, pr: PrSummary): Promise<PrChecks | null> {
    return unlessRefused('checks', () =>
      remember(checks, keyOf(pr), CHECKS_TTL_MS, async () => {
        const evaluations = await loadEvaluations(scoped, org, pr)
        return { build: buildStateOf(evaluations), policies: policyStateOf(evaluations) }
      })
    )
  }

  async function enrich(scoped: AdoHttp, pr: PrSummary): Promise<PrSummary> {
    const workItemIds = await workItemsOf(scoped, pr)
    return { ...pr, workItemIds, checks: pr.status === 'active' ? await checksOf(scoped, pr) : null }
  }

  return {
    async full(me, projects, signal) {
      const scoped = withSignal(http, signal)
      const lists = projects.flatMap(project => [
        { kind: 'mine', load: () => list(scoped, project.id, { creatorId: me, status: 'active', top: MINE_TOP }) },
        { kind: 'mine', load: () => myCompleted(scoped, me, project.id) },
        { kind: 'review', load: () => list(scoped, project.id, reviewerOf(me)) }
      ])
      const loaded = await mapLimit(lists, IN_FLIGHT, entry => entry.load())
      const of = (kind: string) => lists.flatMap((entry, index) => (entry.kind === kind ? loaded[index] : []))
      const mine = await mapLimit(of('mine'), IN_FLIGHT, pr => enrich(scoped, pr))
      return { mine, review: of('review'), off: { workItems: now() < offUntil.workItems, checks: now() < offUntil.checks } }
    },

    async reviews(me, projects, signal) {
      const scoped = withSignal(http, signal)
      return (await mapLimit(projects, IN_FLIGHT, project => list(scoped, project.id, reviewerOf(me)))).flat()
    }
  }
}

export function cachedCodeProjects(http: AdoHttp, org: string, now: () => number): CodeProjects {
  let cached: { key: string; at: number; projects: NamedItem[] } | null = null
  return async (setting, signal) => {
    const key = JSON.stringify(setting)
    if (cached?.key === key && now() - cached.at < PROJECTS_TTL_MS) return cached.projects
    const projects = await codeProjects(withSignal(http, signal), org, setting)
    cached = { key, at: now(), projects }
    return projects
  }
}

function reviewerOf(me: string): PrCriteria {
  return { reviewerId: me, status: 'active', top: REVIEW_TOP }
}

function keyOf({ projectId, repoId, prId }: PrKey): string {
  return `${projectId}/${repoId}/${prId}`
}
