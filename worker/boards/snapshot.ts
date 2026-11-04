import type { BoardConfig, PrChip, WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { DONE_CATEGORIES, loadTypeStates, type TypeState } from '../ado/board-config'
import { AdoError, type AdoHttp } from '../ado/http'
import { stateTargets, targetsFor } from '../ado/move'
import { loadPrChips, type PrChipCache } from '../ado/pr-links'
import { hydrate, queryBoardIds, queryIds, textOr, toSummary, wiqlMine, type PrRef, type RawWorkItem } from '../ado/workitems'
import { CHIPS_NEED_CODE_READ, showingNewest } from '../messages'

const TYPE_STATES_TTL_MS = 60 * 60_000
const CHIPS_OFF_MS = 10 * 60_000
const MAX_ITEMS = 1000
const POST_BUDGET_BYTES = 240 * 1024

type Base = ReturnType<typeof toSummary>
type StatesByType = Map<string, TypeState[]>

export interface ItemSource {
  http: AdoHttp
  org: string
  orgUrl: string
  chips(refs: PrRef[]): Promise<PrChip[] | null>
  states(projectId: string, type: string): Promise<TypeState[]>
}

export interface Loaded { items: WorkItemSummary[]; chipsOff: boolean; chips: PrChip[] }

export function createItemSource(http: AdoHttp, org: string, orgUrl: string, now: () => number): ItemSource {
  const chipCache: PrChipCache = new Map()
  const stateCache = new Map<string, { at: number; states: TypeState[] }>()
  let chipsOffUntil = -Infinity
  return {
    http,
    org,
    orgUrl,
    async chips(refs) {
      if (now() < chipsOffUntil) return null
      try {
        return await loadPrChips(http, org, refs, chipCache, now)
      } catch (error) {
        if (!(error instanceof AdoError) || error.code !== 'forbidden') throw error
        chipsOffUntil = now() + CHIPS_OFF_MS
        return null
      }
    },
    async states(projectId, type) {
      const key = `${projectId}/${type}`
      const cached = stateCache.get(key)
      if (cached && now() - cached.at < TYPE_STATES_TTL_MS) return cached.states
      const states = await loadTypeStates(http, { org, projectId }, type)
      stateCache.set(key, { at: now(), states })
      return states
    }
  }
}

export async function loadMine(source: ItemSource, cfg: BoardConfig): Promise<Loaded> {
  const doneStates = [...new Set(Object.values(cfg.doneStates).flat())]
  const ids = await queryIds(source.http, source.org, cfg.projectId, cfg.teamId, wiqlMine(cfg, doneStates))
  const bases = await hydrateBases(source, cfg, ids)
  const states = await offBoardStates(source, cfg, bases)
  return summarize(source, cfg, bases.filter(base => !isDone(base, states)), states)
}

export async function loadBoardItems(source: ItemSource, cfg: BoardConfig, everyone: boolean): Promise<Loaded> {
  const ids = await queryBoardIds(source.http, source.org, cfg.projectId, cfg.teamId, cfg, everyone)
  return summarize(source, cfg, await hydrateBases(source, cfg, ids), new Map())
}

export async function loadItem(source: ItemSource, cfg: BoardConfig, id: number): Promise<{ raw: RawWorkItem; item: WorkItemSummary; chips: PrChip[] } | null> {
  const [raw] = await hydrate(source.http, source.org, cfg.projectId, [id])
  if (!raw) return null
  const base = toSummary(raw, cfg, source.orgUrl)
  const { items, chips } = await summarize(source, cfg, [base], await offBoardStates(source, cfg, [base]))
  return { raw, item: items[0], chips }
}

export async function restate(source: ItemSource, cfg: BoardConfig, raw: RawWorkItem, like: WorkItemSummary): Promise<WorkItemSummary> {
  const base = toSummary(raw, cfg, source.orgUrl)
  return itemOf(base, like.parentTitle, like.prs, cfg, await offBoardStates(source, cfg, [base]))
}

export function isOnBoard(item: { type: string }, cfg: BoardConfig): boolean {
  return cfg.requirementTypes.includes(item.type)
}

export function capSnapshot(snapshot: WorkSnapshot): WorkSnapshot {
  const newest = [...snapshot.mine, ...snapshot.other].sort((a, b) => b.changedAt - a.changedAt)
  let budget = POST_BUDGET_BYTES - byteLength({ ...snapshot, mine: [], other: [] })
  const kept = new Set<WorkItemSummary>()
  for (const item of newest) {
    budget -= byteLength(item) + 1
    if (kept.size === MAX_ITEMS || budget < 0) break
    kept.add(item)
  }
  if (kept.size === newest.length) return snapshot
  const ids = new Set([...kept].map(item => item.id))
  return {
    ...snapshot,
    mine: snapshot.mine.filter(item => kept.has(item)),
    other: snapshot.other.filter(item => kept.has(item)),
    nudges: snapshot.nudges.filter(nudge => ids.has(nudge.itemId)),
    message: joinMessages(snapshot.message, showingNewest(kept.size))
  }
}

export function foldChips(chips: PrChip[]): PrChip[] {
  const byTarget = new Map<string, PrChip>()
  for (const chip of chips) {
    const kept = byTarget.get(chip.target)
    if (!kept || chipRank(chip) < chipRank(kept) || (chipRank(chip) === chipRank(kept) && chip.prId > kept.prId)) byTarget.set(chip.target, chip)
  }
  return [...byTarget.values()]
}

function chipRank(chip: PrChip): number {
  if (chip.state === 'merged') return 0
  if (chip.state === 'abandoned') return 4
  return chip.build === 'failed' ? 1 : chip.build === 'running' ? 2 : 3
}

export function joinMessages(...messages: (string | undefined)[]): string | undefined {
  return messages.filter(Boolean).join(' ') || undefined
}

async function hydrateBases(source: ItemSource, cfg: BoardConfig, ids: number[]): Promise<Base[]> {
  const raws = await hydrate(source.http, source.org, cfg.projectId, ids)
  return raws.map(raw => toSummary(raw, cfg, source.orgUrl))
}

async function offBoardStates(source: ItemSource, cfg: BoardConfig, bases: Base[]): Promise<StatesByType> {
  const types = [...new Set(bases.map(base => base.type).filter(type => type !== '' && !isOnBoard({ type }, cfg)))]
  const lists = await Promise.all(types.map(type => source.states(cfg.projectId, type)))
  return new Map(types.map((type, index) => [type, lists[index]]))
}

function isDone(base: Base, states: StatesByType): boolean {
  const category = states.get(base.type)?.find(state => state.name === base.state)?.category
  return category !== undefined && DONE_CATEGORIES.has(category)
}

async function summarize(source: ItemSource, cfg: BoardConfig, bases: Base[], states: StatesByType): Promise<Loaded> {
  const [titles, chips] = await Promise.all([parentTitles(source, cfg, bases), source.chips(bases.flatMap(base => base.prRefs))])
  const byPr = new Map((chips ?? []).map(chip => [chip.prId, chip]))
  const items = bases.map(base => {
    const parentTitle = base.parentId === null ? null : titles.get(base.parentId) || null
    const prs = foldChips([...new Set(base.prRefs.map(ref => ref.prId))].flatMap(prId => byPr.get(prId) ?? []))
    return itemOf(base, parentTitle, prs, cfg, states)
  })
  return { items, chipsOff: chips === null, chips: chips ?? [] }
}

function itemOf({ prRefs: _, ...base }: Base, parentTitle: string | null, prs: PrChip[], cfg: BoardConfig, states: StatesByType): WorkItemSummary {
  const item: WorkItemSummary = { ...base, parentTitle, prs, targets: { columns: [], states: [] } }
  const typeStates = states.get(item.type)
  item.targets = typeStates
    ? { columns: [], states: stateTargets(typeStates.map(state => state.name), item.state) }
    : { columns: targetsFor(item, cfg).columns, states: [] }
  return item
}

async function parentTitles(source: ItemSource, cfg: BoardConfig, bases: Base[]): Promise<Map<number, string>> {
  const titles = new Map(bases.map(base => [base.id, base.title]))
  const missing = [...new Set(bases.flatMap(base => base.parentId ?? []))].filter(id => !titles.has(id))
  for (const parent of await hydrate(source.http, source.org, cfg.projectId, missing)) {
    titles.set(parent.id, textOr(parent.fields['System.Title'], ''))
  }
  return titles
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
