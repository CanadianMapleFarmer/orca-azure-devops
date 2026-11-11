import type { AdoHttp } from '../ado/http'
import { deltaWiql, isDatePrecisionError, membershipWiql, queryIdsAt, readRevs, stillInWiql, WIQL_TOP, type IdsAt } from '../ado/workitems'

export const OVERLAP_MS = 10_000
export const AUDIT_EVERY_MS = 15 * 60_000
export const DEEP_AUDIT_EVERY = 4
export const MAX_KNOWN_FOR_DELTA = 1500

export interface SyncState { clause: string; members: number[]; watermark: string; auditedAt: number; audits: number; precision: 'time' | 'day'; seen: ReadonlyMap<number, number> }
export interface SyncScope { org: string; projectId: string; teamId: string; clause: string }
export interface SyncResult { state: SyncState; members: number[]; stale: Set<number>; gone: number[] }

type RevOf = (id: number) => number | undefined
interface Revised { changed: number[]; stale: Set<number>; gone: number[]; seen: ReadonlyMap<number, number> }

const ANY_CHANGE_SINCE = '@Today - 1'

export function syncView(
  http: AdoHttp,
  scope: SyncScope,
  previous: SyncState | null,
  known: readonly number[],
  revOf: RevOf,
  now: () => number
): Promise<SyncResult> {
  const kept = previous?.clause === scope.clause ? previous : null
  if (!kept || now() - kept.auditedAt >= AUDIT_EVERY_MS || known.length > MAX_KNOWN_FOR_DELTA) return audit(http, scope, kept, known, revOf, now)
  return delta(http, scope, kept, known, revOf)
}

async function audit(http: AdoHttp, scope: SyncScope, previous: SyncState | null, known: readonly number[], revOf: RevOf, now: () => number): Promise<SyncResult> {
  const { ids, asOf } = await query(http, scope, membershipWiql(scope.clause), false)
  const audits = (previous?.audits ?? 0) + 1
  const all = [...new Set([...ids, ...known])]
  let gone: number[] = []
  let stale = new Set(ids)
  if (all.some(id => revOf(id) !== undefined)) {
    const revs = await readRevs(http, scope.org, scope.projectId, all)
    gone = known.filter(id => !revs.has(id))
    const left = new Set(gone)
    stale = new Set(all.filter(id => !left.has(id) && (revOf(id) === undefined || revs.get(id) !== revOf(id))))
  }
  const members = without(ids, gone)
  if (audits % DEEP_AUDIT_EVERY === 0) for (const id of members) stale.add(id)
  const state: SyncState = { clause: scope.clause, members, watermark: asOf, auditedAt: now(), audits, precision: previous?.precision ?? 'time', seen: previous?.seen ?? new Map() }
  return { state, members, stale, gone }
}

async function delta(http: AdoHttp, scope: SyncScope, previous: SyncState, known: readonly number[], revOf: RevOf): Promise<SyncResult> {
  const precise = previous.precision === 'time' ? await timeDelta(http, scope, previous, known) : null
  const { ids, asOf } = precise ?? (await query(http, scope, deltaWiql(scope.clause, ANY_CHANGE_SINCE, known), false))
  const { changed, stale, gone, seen } = precise ? { changed: ids, stale: new Set(ids), gone: [], seen: previous.seen } : await revised(http, scope, ids, known, revOf, previous)
  const kept = without(previous.members, gone)
  const base: SyncState = { ...previous, seen, watermark: asOf, precision: precise ? 'time' : 'day', auditedAt: ids.length >= WIQL_TOP ? -Infinity : previous.auditedAt }
  if (changed.length === 0) return { state: { ...base, members: kept }, members: kept, stale, gone }

  const listed = new Set(known)
  const held = new Set(previous.members)
  const recheck = changed.filter(id => held.has(id) || listed.has(id))
  const matching = new Set(recheck.length === 0 ? [] : (await query(http, scope, stillInWiql(scope.clause, recheck), false)).ids)
  const dropped = recheck.filter(id => held.has(id) && !matching.has(id))
  const added = changed.filter(id => !held.has(id) && (matching.has(id) || !listed.has(id)))
  const members = [...new Set([...without(kept, dropped), ...added])]
  return { state: { ...base, members }, members, stale, gone }
}

async function timeDelta(http: AdoHttp, scope: SyncScope, previous: SyncState, known: readonly number[]): Promise<IdsAt | null> {
  const since = `'${new Date(Date.parse(previous.watermark) - OVERLAP_MS).toISOString()}'`
  try {
    return await query(http, scope, deltaWiql(scope.clause, since, known), true)
  } catch (error) {
    if (isDatePrecisionError(error)) return null
    throw error
  }
}

async function revised(http: AdoHttp, scope: SyncScope, ids: number[], known: readonly number[], revOf: RevOf, previous: SyncState): Promise<Revised> {
  if (ids.length === 0) return { changed: [], stale: new Set(), gone: [], seen: previous.seen }
  const revs = await readRevs(http, scope.org, scope.projectId, ids)
  const listed = new Set(known)
  const found = ids.filter(id => revs.has(id))
  const gone = ids.filter(id => listed.has(id) && !revs.has(id))
  const watched = new Set([...previous.members, ...known])
  const seen = new Map([...previous.seen].filter(([id]) => watched.has(id)))
  for (const id of gone) seen.delete(id)
  for (const [id, rev] of revs) seen.set(id, rev)
  return {
    changed: found.filter(id => revs.get(id) !== previous.seen.get(id)),
    stale: new Set(found.filter(id => revs.get(id) !== revOf(id))),
    gone,
    seen
  }
}

function query(http: AdoHttp, scope: SyncScope, wiql: string, timePrecision: boolean): Promise<IdsAt> {
  return queryIdsAt(http, scope.org, scope.projectId, scope.teamId, wiql, timePrecision)
}

function without(ids: readonly number[], removed: readonly number[]): number[] {
  if (removed.length === 0) return [...ids]
  const drop = new Set(removed)
  return ids.filter(id => !drop.has(id))
}
