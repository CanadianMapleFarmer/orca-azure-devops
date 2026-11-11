import {
  MAX_CHILD_TASKS,
  NO_FAMILIES,
  type BoardConfig,
  type PrChip,
  type TaskList,
  type WorkFamilies,
  type WorkItemSummary,
  type WorkParent,
  type WorkSnapshot,
  type WorkTask
} from '../../src/shared/work'
import { DONE_CATEGORIES, loadTypeStates, type TypeState } from '../ado/board-config'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { stateTargets, targetsFor } from '../ado/move'
import { chipOf, loadPrChips } from '../ado/pr-links'
import { shaped } from '../ado/shape'
import {
  childIdsOf,
  displayName,
  hydrate,
  prRefsOf,
  readFields,
  TASK_FIELDS,
  textOr,
  toRecord,
  toSummary,
  WIQL_TOP,
  type PrRef,
  type RawWorkItem
} from '../ado/workitems'
import { ANSWER_BUDGET_BYTES, byteLength, itemBytes, newestThatFit, POST_BUDGET_BYTES } from '../budget'
import type { OrgEntities } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { prKey, type ItemRecord } from '../data/records'
import { joinMessages, MALFORMED, showingNewest, TASKS_NOT_LOADED } from '../messages'
import type { BoardResult } from './board-views'

const CHIPS_OFF_MS = 10 * 60_000
const NONE_STALE: ReadonlySet<number> = new Set()
const MAX_ITEMS = 1000
export const MAX_CHILD_READS = 1000
export const FAMILY_BUDGET_BYTES = 64 * 1024

type Base = ReturnType<typeof toSummary>
type StatesByType = Map<string, TypeState[]>

export interface Me { id: string; uniqueName: string }

export interface ItemSource {
  http: AdoHttp
  org: string
  orgUrl: string
  items(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  fields(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  put(raw: RawWorkItem): RawWorkItem
  revOf(id: number): number | undefined
  forget(ids: readonly number[]): void
  chips(refs: PrRef[]): Promise<PrChip[] | null>
  states(projectId: string, type: string): Promise<TypeState[]>
  withSignal(signal?: AbortSignal): ItemSource
}

export interface ViewIds { members: number[]; stale: ReadonlySet<number> }

export interface Loaded { items: WorkItemSummary[]; chipsOff: boolean; chips: PrChip[] }

export function createItemSource(http: AdoHttp, org: string, orgUrl: string, now: () => number, tables: OrgEntities): ItemSource {
  const missingPrs = new Map<string, number>()
  const { workItems } = tables
  let chipsOffUntil = -Infinity
  const held = (id: number) => workItems.get(String(id))?.value
  const keep = (raw: RawWorkItem, withRelations: boolean) => workItems.put(String(raw.id), toRecord(raw, withRelations))

  function settle(ids: number[], wanted: number[], fetched: RawWorkItem[], withRelations: boolean): ItemRecord[] {
    const found = new Set(fetched.map(raw => raw.id))
    for (const raw of fetched) keep(raw, withRelations)
    for (const id of wanted) if (!found.has(id)) workItems.drop(String(id))
    return ids.flatMap(id => held(id) ?? [])
  }

  const bound = (scoped: AdoHttp, signal?: AbortSignal): ItemSource => ({
    http: scoped,
    org,
    orgUrl,
    async items(projectId, ids, stale) {
      const wanted = ids.filter(id => stale.has(id) || !held(id)?.withRelations)
      return settle(ids, wanted, await hydrate(scoped, org, projectId, wanted), true)
    },
    async fields(projectId, ids, stale) {
      const wanted = ids.filter(id => stale.has(id) || !held(id))
      return settle(ids, wanted, await readFields(scoped, org, projectId, wanted, TASK_FIELDS), false)
    },
    put: raw => keep(raw, true),
    revOf: id => held(id)?.rev,
    forget(ids) {
      for (const id of ids) workItems.drop(String(id))
    },
    async chips(refs) {
      if (now() < chipsOffUntil) return null
      try {
        return await loadPrChips(scoped, org, refs, tables, now, missingPrs)
      } catch (error) {
        if (!(error instanceof AdoError) || error.code !== 'forbidden') throw error
        chipsOffUntil = now() + CHIPS_OFF_MS
        return null
      }
    },
    states(projectId, type) {
      const load = (own: AbortSignal) => loadTypeStates(withSignal(http, own), { org, projectId }, type)
      return tables.typeStates.read(`${projectId}/${type}`, FRESHNESS.typeStates, load, signal)
    },
    withSignal: signal => bound(withSignal(http, signal), signal)
  })
  return bound(http)
}

export function doneStatesOf(cfg: BoardConfig): string[] {
  return [...new Set(Object.values(cfg.doneStates).flat())]
}

export async function loadMine(
  source: ItemSource,
  cfg: BoardConfig,
  me: Me | null,
  ids: ViewIds
): Promise<Loaded & { families: WorkFamilies; message?: string; known: number[] }> {
  const raws = await source.items(cfg.projectId, ids.members, ids.stale)
  const bases = raws.map(raw => toSummary(raw, cfg, source.orgUrl))
  const states = await stateMoves(source, cfg, bases)
  const open = bases.flatMap((base, index) => (isDone(base, states) ? [] : [{ base, raw: raws[index] }]))
  const { loaded, parents } = await summarizeWithParents(source, cfg, open.map(entry => entry.base), states, ids.stale)
  const taskTypes = new Set(cfg.taskTypes ?? [])
  const taskParents = new Set(open.filter(entry => taskTypes.has(entry.base.type)).flatMap(entry => entry.base.parentId ?? []))
  const dimmed = parents.filter(raw => taskParents.has(raw.id))
  const { lists, message, read } = await taskLists(source, cfg, [...open.map(entry => entry.raw), ...dimmed], taskTypes, me, ids.stale)
  const families = { lists, parents: dimmed.map(raw => parentOf(toSummary(raw, cfg, source.orgUrl))) }
  const known = [...new Set([...ids.members, ...parents.map(raw => raw.id), ...read])]
  return { ...loaded, families, ...(message ? { message } : {}), known }
}

export function patchFamilies(families: WorkFamilies, item: WorkItemSummary, done: boolean): WorkFamilies {
  if (!hasTask(families, item.id)) return families
  const lists = families.lists.map(list => {
    const row = list.tasks.find(task => task.id === item.id)
    if (!row) return list
    const tasks = list.tasks.map(task => (task === row ? { ...task, title: item.title, state: item.state, done } : task))
    return { ...list, tasks, done: list.done + Number(done) - Number(row.done) }
  })
  return { ...families, lists }
}

export function hasTask(families: WorkFamilies, id: number): boolean {
  return families.lists.some(list => list.tasks.some(task => task.id === id))
}

export async function isCompleted(source: ItemSource, cfg: BoardConfig, item: { type: string; state: string }): Promise<boolean> {
  return completedIn(await source.states(cfg.projectId, item.type), item.state)
}

export async function loadBoardItems(source: ItemSource, cfg: BoardConfig, ids: ViewIds): Promise<Loaded & { truncated: boolean; known: number[] }> {
  const raws = await source.items(cfg.projectId, ids.members, ids.stale)
  const bases = raws.map(raw => toSummary(raw, cfg, source.orgUrl))
  const { loaded, parents } = await summarizeWithParents(source, cfg, bases, new Map(), ids.stale)
  const known = [...new Set([...ids.members, ...parents.map(raw => raw.id)])]
  return { ...loaded, truncated: ids.members.length >= WIQL_TOP, known }
}

export async function loadItem(source: ItemSource, cfg: BoardConfig, id: number): Promise<{ raw: RawWorkItem; item: WorkItemSummary; chips: PrChip[] } | null> {
  const [raw] = await hydrate(source.http, source.org, cfg.projectId, [id])
  if (!raw) {
    source.forget([id])
    return null
  }
  const base = toSummary(source.put(raw), cfg, source.orgUrl)
  const { items, chips } = await summarize(source, cfg, [base], await stateMoves(source, cfg, [base]))
  return { raw, item: items[0], chips }
}

export async function restate(source: ItemSource, cfg: BoardConfig, raw: RawWorkItem, like: WorkItemSummary): Promise<WorkItemSummary> {
  const base = toSummary(raw, cfg, source.orgUrl)
  return itemOf(base, like.parentTitle, like.prs, cfg, await stateMoves(source, cfg, [base]))
}

export function isOnBoard(item: { type: string }, cfg: BoardConfig): boolean {
  return cfg.requirementTypes.includes(item.type)
}

export function movesByState(item: { type: string; column: string | null }, cfg: BoardConfig): boolean {
  return !isOnBoard(item, cfg) || item.column === null
}

export function capSnapshot(snapshot: WorkSnapshot): WorkSnapshot {
  const bare = { ...snapshot, families: NO_FAMILIES }
  const items = capItems(bare)
  const families = fitFamilies(namedFamilies(snapshot.families, items), Math.min(FAMILY_BUDGET_BYTES, POST_BUDGET_BYTES - byteLength(items)))
  if (items === bare && families === snapshot.families) return snapshot
  return { ...items, families }
}

function capItems(snapshot: WorkSnapshot): WorkSnapshot {
  const all = [...snapshot.mine, ...snapshot.other]
  const kept = newestThatFit(all, POST_BUDGET_BYTES - byteLength({ ...snapshot, mine: [], other: [] }), item => item.changedAt, MAX_ITEMS)
  if (kept.size === all.length) return snapshot
  const ids = new Set([...kept].map(item => item.id))
  return {
    ...snapshot,
    mine: snapshot.mine.filter(item => kept.has(item)),
    other: snapshot.other.filter(item => kept.has(item)),
    nudges: snapshot.nudges.filter(nudge => ids.has(nudge.itemId)),
    message: joinMessages(snapshot.message, showingNewest(kept.size))
  }
}

function namedFamilies(families: WorkFamilies, snapshot: WorkSnapshot): WorkFamilies {
  const items = [...snapshot.mine, ...snapshot.other]
  const named = new Set(items.flatMap(item => item.parentId ?? []))
  const parents = families.parents.filter(parent => named.has(parent.id))
  const anchors = new Set([...items.map(item => item.id), ...parents.map(parent => parent.id)])
  const lists = families.lists.filter(list => anchors.has(list.parentId))
  return parents.length === families.parents.length && lists.length === families.lists.length ? families : { lists, parents }
}

function fitFamilies(families: WorkFamilies, budget: number): WorkFamilies {
  let left = budget
  let whole = true
  const fits = (value: unknown) => {
    if (whole) {
      left -= itemBytes(value)
      whole = left >= 0
    }
    return whole
  }
  const parents: WorkParent[] = []
  for (const parent of families.parents) {
    if (!fits(parent)) break
    parents.push(parent)
  }
  const lists: TaskList[] = []
  for (const list of families.lists) {
    const counts = { ...list, tasks: [] }
    if (!fits(counts)) break
    lists.push(counts)
  }
  lists.forEach((list, index) => {
    for (const task of families.lists[index].tasks) {
      if (!fits(task)) break
      list.tasks.push(task)
    }
  })
  return whole ? families : { lists, parents }
}

export function capBoard(result: BoardResult, truncated: boolean): BoardResult {
  const header = byteLength({ ...result, items: [], message: joinMessages(result.message, showingNewest(result.items.length)) })
  const kept = newestThatFit(result.items, ANSWER_BUDGET_BYTES - header, item => item.changedAt)
  if (!truncated && kept.size === result.items.length) return result
  return { ...result, items: result.items.filter(item => kept.has(item)), message: joinMessages(result.message, showingNewest(kept.size)) }
}

export function rechip(items: WorkItemSummary[], tables: Pick<OrgEntities, 'workItems' | 'prs' | 'prChecks'>): WorkItemSummary[] {
  const next = items.map(item => {
    const record = tables.workItems.get(String(item.id))?.value
    if (!record?.withRelations) return item
    const keys = [...new Set(prRefsOf(record).map(prKey))]
    const prs = foldChips(keys.flatMap(key => {
      const pr = tables.prs.get(key)?.value
      return pr ? [chipOf(pr, tables.prChecks.get(key)?.value)] : []
    }))
    return JSON.stringify(prs) === JSON.stringify(item.prs) ? item : { ...item, prs }
  })
  return next.every((item, index) => item === items[index]) ? items : next
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

async function stateMoves(source: ItemSource, cfg: BoardConfig, bases: Base[]): Promise<StatesByType> {
  const types = [...new Set(bases.filter(base => base.type !== '' && movesByState(base, cfg)).map(base => base.type))]
  const lists = await Promise.all(types.map(type => source.states(cfg.projectId, type)))
  return new Map(types.map((type, index) => [type, lists[index]]))
}

function isDone(base: Base, states: StatesByType): boolean {
  const category = categoryOf(states.get(base.type), base.state)
  return category !== undefined && DONE_CATEGORIES.has(category)
}

function categoryOf(states: TypeState[] | undefined, name: string): string | undefined {
  return states?.find(state => state.name === name)?.category
}

function completedIn(states: TypeState[] | undefined, name: string): boolean {
  return categoryOf(states, name) === 'Completed'
}

async function summarize(source: ItemSource, cfg: BoardConfig, bases: Base[], states: StatesByType): Promise<Loaded> {
  return (await summarizeWithParents(source, cfg, bases, states, NONE_STALE)).loaded
}

async function summarizeWithParents(
  source: ItemSource,
  cfg: BoardConfig,
  bases: Base[],
  states: StatesByType,
  stale: ReadonlySet<number>
): Promise<{ loaded: Loaded; parents: RawWorkItem[] }> {
  const [parents, chips] = await Promise.all([missingParents(source, cfg, bases, stale), source.chips(bases.flatMap(base => base.prRefs))])
  const titles = new Map<number, string>([
    ...bases.map((base): [number, string] => [base.id, base.title]),
    ...parents.map((raw): [number, string] => [raw.id, textOr(raw.fields['System.Title'], '')])
  ])
  const byPr = new Map((chips ?? []).map(chip => [chip.prId, chip]))
  const items = bases.map(base => {
    const parentTitle = base.parentId === null ? null : titles.get(base.parentId) || null
    const prs = foldChips([...new Set(base.prRefs.map(ref => ref.prId))].flatMap(prId => byPr.get(prId) ?? []))
    return itemOf(base, parentTitle, prs, cfg, states)
  })
  return { loaded: { items, chipsOff: chips === null, chips: chips ?? [] }, parents }
}

function itemOf({ prRefs: _, ...base }: Base, parentTitle: string | null, prs: PrChip[], cfg: BoardConfig, states: StatesByType): WorkItemSummary {
  const item: WorkItemSummary = { ...base, parentTitle, prs, targets: { columns: [], states: [] } }
  const typeStates = movesByState(item, cfg) ? states.get(item.type) : undefined
  item.targets = typeStates
    ? { columns: [], states: stateTargets(typeStates.map(state => state.name), item.state) }
    : { columns: targetsFor(item, cfg).columns, states: [] }
  return item
}

function missingParents(source: ItemSource, cfg: BoardConfig, bases: Base[], stale: ReadonlySet<number>): Promise<RawWorkItem[]> {
  const listed = new Set(bases.map(base => base.id))
  const missing = [...new Set(bases.flatMap(base => base.parentId ?? []))].filter(id => !listed.has(id))
  return source.items(cfg.projectId, missing, stale)
}

function parentOf({ id, type, title, state, column, lane }: Base): WorkParent {
  return { id, type, title, state, column, lane }
}

async function taskLists(
  source: ItemSource,
  cfg: BoardConfig,
  holders: RawWorkItem[],
  taskTypes: Set<string>,
  me: Me | null,
  stale: ReadonlySet<number>
): Promise<{ lists: TaskList[]; message?: string; read: number[] }> {
  const linkedFrom = new Map<number, number>()
  for (const holder of holders) {
    for (const id of childIdsOf(holder)) if (!linkedFrom.has(id)) linkedFrom.set(id, holder.id)
  }
  const ids = [...linkedFrom.keys()].slice(0, MAX_CHILD_READS)
  if (ids.length === 0 || taskTypes.size === 0) return { lists: [], read: [] }
  try {
    const children = await source.fields(cfg.projectId, ids, stale)
    const types = shaped(() => [...new Set(children.map(typeOf))].filter(type => taskTypes.has(type)), MALFORMED.workItem)
    const states: StatesByType = new Map(await Promise.all(types.map(async type => [type, await source.states(cfg.projectId, type)] as const)))
    return { lists: shaped(() => groupTasks(children, linkedFrom, states, me), MALFORMED.workItem), read: ids }
  } catch (error) {
    if (!(error instanceof AdoError)) throw error
    return { lists: [], message: TASKS_NOT_LOADED, read: ids }
  }
}

function groupTasks(children: RawWorkItem[], linkedFrom: Map<number, number>, states: StatesByType, me: Me | null): TaskList[] {
  const byParent = new Map<number, WorkTask[]>()
  for (const raw of children) {
    const typeStates = states.get(typeOf(raw))
    const state = textOr(raw.fields['System.State'], '')
    const category = categoryOf(typeStates, state)
    const parent = raw.fields['System.Parent']
    const parentId = typeof parent === 'number' ? parent : linkedFrom.get(raw.id)
    if (!typeStates || category === 'Removed' || parentId === undefined) continue
    const tasks = byParent.get(parentId) ?? []
    tasks.push(taskOf(raw, completedIn(typeStates, state), me))
    byParent.set(parentId, tasks)
  }
  return [...byParent].map(([parentId, tasks]) => taskListOf(parentId, tasks))
}

function taskListOf(parentId: number, tasks: WorkTask[]): TaskList {
  const ordered = [...tasks].sort((a, b) => taskRank(a) - taskRank(b) || a.id - b.id)
  const yoursOpen = ordered.filter(task => taskRank(task) === 0).length
  return { parentId, tasks: ordered.slice(0, Math.max(MAX_CHILD_TASKS, yoursOpen)), total: tasks.length, done: tasks.filter(task => task.done).length }
}

function taskRank(task: WorkTask): number {
  if (task.done) return 2
  return task.mine ? 0 : 1
}

function taskOf(raw: RawWorkItem, done: boolean, me: Me | null): WorkTask {
  const assignee = raw.fields['System.AssignedTo']
  return {
    id: raw.id,
    title: textOr(raw.fields['System.Title'], ''),
    state: textOr(raw.fields['System.State'], ''),
    done,
    assignee: displayName(assignee),
    mine: isMe(assignee, me)
  }
}

function isMe(identity: unknown, me: Me | null): boolean {
  if (me === null || typeof identity !== 'object' || identity === null) return false
  const { id, uniqueName } = identity as { id?: unknown; uniqueName?: unknown }
  return sameText(id, me.id) || sameText(uniqueName, me.uniqueName)
}

function sameText(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && value !== '' && value.toLowerCase() === wanted.toLowerCase()
}

function typeOf(raw: RawWorkItem): string {
  return textOr(raw.fields['System.WorkItemType'], '')
}
