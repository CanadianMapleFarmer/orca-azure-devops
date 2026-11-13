import { NO_BOARDS, NO_TASK_TYPE } from '../../src/shared/messages'
import { recordOwn, withOwn, type OwnComments } from '../../src/shared/own-comments'
import type { BoardsTarget, OrgStatus } from '../../src/shared/types'
import { NO_FAMILIES, type Assignee, type BoardConfig, type DetailTask, type MoveTarget, type WorkComment, type WorkFamilies, type WorkItemDetails, type WorkItemSummary, type WorkSnapshot } from '../../src/shared/work'
import { assignItem } from '../ado/assign'
import { boardConfigKey, loadBoardConfig, type BoardArgs, type TypeState } from '../ado/board-config'
import { createTask, createTaskPatch, taskTitle } from '../ado/create-task'
import { addComment, addPullRequestLink, COMMENT_LIMIT, readComments, resolvePullRequest } from '../ado/details'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { moveItem } from '../ado/move'
import { malformed } from '../ado/shape'
import { loadTeamMembers } from '../ado/team-members'
import { boardClause, LINKED_FIELDS, mineClause, readFields, textOr, workItemUrl, type PrRef, type RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { fly, inLane, join, type Flight } from '../data/context'
import type { Entities, OrgEntities, Stamped } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { VALUE_BUDGET_BYTES, type Persisted } from '../data/persist'
import type { DetailsRecord } from '../data/records'
import type { SavedTables } from '../data/saved-tables'
import { isRecord, sameApartFromTime } from '../data/values'
import { badRequest, CHIPS_NEED_CODE_READ, CONFLICT, failureMessage, FILTER_NOT_SAVED, GONE, joinMessages, LOAD_FAILED, MALFORMED, NOT_CONNECTED, REOPEN_BOARD, SHOWING_SAVED, UNKNOWN_COLUMN } from '../messages'
import type { Scheduler } from '../poll/scheduler'
import { createBoardFilters } from './board-filters'
import { boardKey, createBoardViews, type BoardChange, type BoardLoad, type BoardRef, type BoardRequest, type BoardResult, type Synced } from './board-views'
import { cleanRules, createNudgeStore, findNudges, type NudgeRule } from './nudges'
import { childIds, composeDetails, detailsFresh, linkedReadIds, prRowsOf, recordOf, taskRowOf, withNewChild, withWrite } from './item-details'
import { createRecentWrites } from './recent'
import {
  capBoard,
  capSnapshot,
  createItemSource,
  doneStatesOf,
  hasTask,
  isCompleted,
  isOnBoard,
  loadBoardItems,
  loadItem,
  loadMine,
  movesByState,
  patchFamilies,
  rechip,
  restate,
  SAVED_BOARD_BYTES,
  summaryFromStore,
  type ItemSource,
  type Me,
  type ViewIds
} from './snapshot'
import { syncView, type SyncState } from './sync'

export type { BoardChange, BoardRef, BoardResult }

export interface BoardsServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  store: StorePort
  scheduler: Scheduler
  post: (snapshot: WorkSnapshot) => void
  postBoard: (change: BoardChange) => void
  now: () => number
  entities: Entities
  persisted: Persisted
  savedTables: SavedTables
  log: (message: string) => void
}

export interface BoardsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<WorkSnapshot>
  refresh(org: string): Promise<WorkSnapshot>
  details(org: string, id: number, options?: DetailsOptions): Promise<WorkItemDetails>
  cachedItem(org: string, id: number): WorkItemSummary | null
  prRefs(org: string, id: number): PrRef[]
  itemInfo(org: string, id: number, signal: AbortSignal): Promise<ItemInfo | null>
  move(input: { org: string; id: number; rev: number; to: MoveTarget; board?: BoardRef }): Promise<WorkItemSummary>
  comment(org: string, id: number, text: string): Promise<WorkComment>
  assign(input: { org: string; id: number; rev: number; to: Assignee | null; board?: BoardRef }): Promise<WorkItemSummary>
  assignees(input: { org: string; projectId: string; teamId: string }): Promise<{ me: Assignee | null; members: Assignee[] }>
  addTask(input: { org: string; parentId: number; title: string; board?: BoardRef }): Promise<{ task: DetailTask; parent: WorkItemSummary }>
  linkPr(input: { org: string; id: number; rev: number; prUrl: string; board?: BoardRef }): Promise<WorkItemSummary>
  board(input: BoardArgs & { everyone?: boolean; remember?: boolean }): Promise<BoardResult & { everyone: boolean }>
  defaultBoard(org: string): Promise<{ projectId: string; teamId: string; boardId: string } | null>
  dismissNudge(input: { org: string; itemId: number; prId: number }): Promise<{ ok: true }>
  nudgeRules(input: { org: string; teamId: string; rules?: NudgeRule[] }): Promise<{ rules: NudgeRule[] }>
  visibility(input: { surface: 'work' | 'board'; org: string; visible: boolean; board?: BoardRef }): { ok: true }
}

interface OrgWork extends Synced {
  snapshot: WorkSnapshot | null
  failure: unknown
  loading: Flight<WorkSnapshot> | null
  restored: boolean
  restoring?: Promise<void>
  forceAudit: boolean
}

interface Built extends Synced { snapshot: WorkSnapshot; projected: WorkSnapshot; forced: boolean }

interface Holder { board: BoardConfig; items: WorkItemSummary[] }

type ItemInfo = Pick<WorkItemSummary, 'type' | 'title' | 'url'>

export interface DetailsOptions { board?: BoardRef; fresh?: boolean; comments?: boolean }

interface DetailsRead { record: DetailsRecord; item: WorkItemSummary }

interface TaskParent { url: string; type: string; project: string; areaPath: string; iterationPath: string }

const MINE_MS = { visibleMs: 60_000, backgroundMs: null, quietMax: 2 }
const INFO_FIELDS = ['System.WorkItemType', 'System.Title', 'System.TeamProject']
const NO_MEMBERS: ViewIds = { members: [], stale: new Set() }
const NO_STATES: ReadonlyMap<string, TypeState[]> = new Map()
const PARENT_FIELDS = ['System.WorkItemType', 'System.TeamProject', 'System.AreaPath', 'System.IterationPath']

export function createBoardsService(deps: BoardsServiceDeps): BoardsService {
  const { http, scheduler, now, entities, savedTables } = deps
  const nudges = createNudgeStore(deps.store)
  const filters = createBoardFilters(deps.store)
  const recent = createRecentWrites()
  let ownComments: OwnComments = {}
  const sources = new Map<string, ItemSource>()
  const work = new Map<string, OrgWork>()
  const homes = new Map<string, string>()
  const polled = new Map<string, BoardsTarget>()
  const loadedConfigs = new Set<string>()
  const connected = new Set<string>()
  const workVisible = new Set<string>()
  const boardViews = createBoardViews({
    scheduler,
    now,
    load: loadBoard,
    restore: savedBoard,
    connected: org => connected.has(org),
    changed: deps.postBoard,
    dropped: key => recent.drop(key)
  })
  const rechipping = new Set<string>()
  entities.watch('prs', queueRechip)
  entities.watch('prChecks', queueRechip)

  function queueRechip(org: string): void {
    if (rechipping.size === 0) queueMicrotask(rechipQueued)
    rechipping.add(org)
  }

  function rechipQueued(): void {
    const orgs = [...rechipping]
    rechipping.clear()
    for (const org of orgs) void rechipViews(org).catch(() => {})
  }

  async function rechipViews(org: string): Promise<void> {
    if (!sources.has(org)) return
    const tables = entities.of(org)
    for (const view of boardViews.of(org)) {
      const items = rechip(view.result.items, tables)
      if (items !== view.result.items) boardViews.update(view, capBoard({ ...view.result, items }, false))
    }
    await rechipWork(org, tables)
  }

  async function rechipWork(org: string, tables: OrgEntities): Promise<void> {
    const entry = work.get(org)
    const held = entry?.snapshot
    if (!entry || !held?.board || (rechip(held.mine, tables) === held.mine && rechip(held.other, tables) === held.other)) return
    const [rules, dismissed] = await Promise.all([nudges.rules(org, held.board.teamId), nudges.dismissed(org)])
    const snapshot = entry.snapshot
    if (work.get(org) !== entry || !snapshot?.board) return
    const mine = rechip(snapshot.mine, tables)
    const next = capSnapshot({ ...snapshot, mine, other: rechip(snapshot.other, tables), nudges: findNudges(snapshot.board, mine, rules, dismissed) })
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return
    entry.snapshot = next
    deps.post(next)
  }

  async function statusOf(org: string): Promise<OrgStatus> {
    const status = (await deps.orgs()).find(item => item.org === org)
    if (!status) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    const account = accountOf(status)
    if (account) await savedTables.seed(org, account)
    return status
  }

  function persist(status: OrgStatus, name: string, value: () => unknown): void {
    const account = accountOf(status)
    if (!account) return
    deps.persisted.save(status.org, name, account, value())
    savedTables.save(status.org, account)
  }

  function restore(status: OrgStatus): Promise<void> {
    const account = accountOf(status)
    if (!account || !status.boards) return Promise.resolve()
    const entry = workOf(status.org)
    entry.restoring ??= restoreWork(entry, status, account)
    return entry.restoring
  }

  async function restoreWork(entry: OrgWork, status: OrgStatus, account: string): Promise<void> {
    const saved = await deps.persisted.load(status.org, 'work', account)
    if (work.get(status.org) !== entry || entry.snapshot || !connected.has(status.org) || !isSavedWork(saved?.value, status)) return
    Object.assign(entry, { snapshot: { ...saved.value, stale: true, message: SHOWING_SAVED }, restored: true })
  }

  function unrestore(org: string): void {
    const entry = work.get(org)
    if (!entry) return
    if (entry.restored) Object.assign(entry, { snapshot: null, restored: false })
    entry.restoring = undefined
  }

  function revalidate(org: string): void {
    if (polled.has(org)) void scheduler.runNow(mineKey(org))
    else void load(org).catch(() => {})
  }

  async function savedBoard(request: BoardRequest, boardId: string): Promise<BoardResult | null> {
    const account = accountOf(await statusOf(request.org))
    if (!account || !connected.has(request.org)) return null
    const saved = await deps.persisted.load(request.org, savedBoardName(request.args.teamId, boardId), account)
    if (!saved || !connected.has(request.org) || !isSavedBoard(saved.value, boardId) || saved.value.everyone !== request.everyone) return null
    return { ...saved.value.result, stale: true }
  }

  function sourceOf(status: OrgStatus): ItemSource {
    const source = sources.get(status.org) ?? createItemSource(http, status.org, status.url, now, entities.of(status.org))
    sources.set(status.org, source)
    return source
  }

  function workOf(org: string): OrgWork {
    const entry = work.get(org) ?? { snapshot: null, failure: null, loading: null, sync: null, known: [], restored: false, forceAudit: false }
    work.set(org, entry)
    return entry
  }

  function config(args: BoardArgs, signal?: AbortSignal): Promise<BoardConfig> {
    const key = boardConfigKey(args)
    const table = entities.of(args.org).boardConfigs
    const held = table.get(key)?.value
    const outdated = held !== undefined && held.taskTypes === undefined && !loadedConfigs.has(key)
    const load = async (scoped: AbortSignal) => {
      const loaded = await loadBoardConfig(withSignal(http, scoped), args)
      loadedConfigs.add(key)
      return loaded
    }
    return table.read(key, outdated ? 0 : FRESHNESS.boardConfig, load, signal)
  }

  async function defaultConfig(status: OrgStatus, signal?: AbortSignal): Promise<BoardConfig> {
    if (!status.boards) throw badRequest(NO_BOARDS)
    return config({ org: status.org, projectId: status.boards.projectId, teamId: status.boards.teamId }, signal)
  }

  function noBoards(org: string): WorkSnapshot {
    return { org, board: null, mine: [], other: [], nudges: [], families: NO_FAMILIES, updatedAt: now(), stale: false, message: NO_BOARDS }
  }

  function mineKey(org: string): string {
    return `mine:${org}`
  }

  async function synced(source: ItemSource, cfg: BoardConfig, clause: string, held: Synced): Promise<{ ids: ViewIds; sync: SyncState }> {
    const scope = { org: source.org, projectId: cfg.projectId, teamId: cfg.teamId, clause }
    const result = await syncView(source.http, scope, held.sync, held.known, source.revOf, now)
    source.forget(result.gone)
    return { ids: result, sync: result.state }
  }

  async function build(status: OrgStatus, entry: OrgWork, signal?: AbortSignal): Promise<Built> {
    const cfg = await defaultConfig(status, signal)
    const source = sourceOf(status).withSignal(signal)
    const forced = entry.forceAudit
    const held = sameTarget(entry.snapshot?.board, cfg) ? entry : { sync: null, known: [] }
    const { ids, sync } = await synced(source, cfg, mineClause(doneStatesOf(cfg)), forced ? forcingAudit(held) : held)
    const [loaded, rules, dismissed] = await Promise.all([loadMine(source, cfg, meOf(status), ids), nudges.rules(status.org, cfg.teamId), nudges.dismissed(status.org)])
    const items = await recent.overlay(mineKey(status.org), loaded.items, written => restate(source, cfg, written.raw, written.like))
    const families = await restatedRows(source, cfg, loaded.families, items.filter((item, index) => item !== loaded.items[index]))
    const mine = items.filter(item => !movesByState(item, cfg))
    const message = joinMessages(loaded.chipsOff ? CHIPS_NEED_CODE_READ : undefined, loaded.message)
    const projected: WorkSnapshot = {
      org: status.org,
      board: cfg,
      mine,
      other: items.filter(item => movesByState(item, cfg)),
      nudges: findNudges(cfg, mine, rules, dismissed),
      families,
      updatedAt: now(),
      stale: false,
      ...(message ? { message } : {})
    }
    return { snapshot: capSnapshot(projected), projected, sync, known: loaded.known, forced }
  }

  function load(org: string, signal?: AbortSignal): Promise<WorkSnapshot> {
    const entry = workOf(org)
    entry.loading ??= fly(async () => {
      try {
        const status = await statusOf(org)
        if (!status.boards) return noBoards(org)
        const { snapshot, projected, sync, known, forced } = await build(status, entry, signal)
        if (work.get(org) !== entry) return snapshot
        Object.assign(entry, { snapshot, sync, known, failure: null, restored: false })
        if (forced) entry.forceAudit = false
        deps.post(snapshot)
        persist(status, 'work', () => capSnapshot(projected, VALUE_BUDGET_BYTES))
        return snapshot
      } catch (error) {
        if (signal?.aborted) throw error
        entry.failure = error
        if (work.get(org) === entry && entry.snapshot) {
          entry.snapshot = { ...entry.snapshot, stale: true, message: failureMessage(error) }
          deps.post(entry.snapshot)
        }
        throw error
      } finally {
        entry.loading = null
      }
    })
    return join(entry.loading)
  }

  async function poll(org: string, signal: AbortSignal): Promise<void | 'unchanged'> {
    const before = work.get(org)?.snapshot
    const after = await load(org, signal)
    if (before && sameApartFromTime(before, after)) return 'unchanged'
  }

  async function loadBoard(request: BoardRequest & Synced, signal?: AbortSignal): Promise<BoardLoad> {
    const status = await statusOf(request.org)
    const board = await config(request.args, signal)
    const source = sourceOf(status).withSignal(signal)
    const { ids, sync } = board.requirementTypes.length === 0 ? { ids: NO_MEMBERS, sync: null } : await synced(source, board, boardClause(board, request.everyone), request)
    const loaded = await loadBoardItems(source, board, ids)
    const items = await recent.overlay(request.key, loaded.items, written => restate(source, board, written.raw, written.like))
    const projected: BoardResult = { board, items, ...(loaded.chipsOff ? { message: CHIPS_NEED_CODE_READ } : {}), updatedAt: now() }
    persist(status, savedBoardName(board.teamId, board.boardId), () => ({ result: capBoard(projected, loaded.truncated, SAVED_BOARD_BYTES), everyone: request.everyone }))
    return { result: capBoard(projected, loaded.truncated), sync, known: loaded.known }
  }

  async function readItemInfo(org: string, id: number, signal: AbortSignal): Promise<ItemInfo | null> {
    const status = await statusOf(org)
    if (!status.boards) return null
    const [raw] = await readFields(withSignal(http, signal), org, status.boards.projectId, [id], INFO_FIELDS)
    if (!raw) return null
    const project = textOr(raw.fields['System.TeamProject'], '') || status.boards.projectId
    return { type: textOr(raw.fields['System.WorkItemType'], ''), title: textOr(raw.fields['System.Title'], ''), url: workItemUrl(status.url, project, id) }
  }

  function forget(org: string): void {
    work.delete(org)
    sources.delete(org)
    recent.drop(mineKey(org))
    boardViews.forget(org)
  }

  function holders(org: string): Holder[] {
    const list: Holder[] = boardViews.of(org).map(view => view.result)
    const snapshot = work.get(org)?.snapshot
    if (snapshot?.board) list.push({ board: snapshot.board, items: [...snapshot.mine, ...snapshot.other] })
    return list
  }

  async function namedConfig(status: OrgStatus, ref: BoardRef): Promise<BoardConfig> {
    const view = boardViews.get(boardKey(status.org, ref.teamId, ref.boardId))
    if (view?.result.board.taskTypes) return view.result.board
    const own = status.boards?.teamId === ref.teamId ? status.boards.projectId : undefined
    const projectId = view?.result.board.projectId ?? homes.get(`${status.org}/${ref.teamId}`) ?? own
    if (!projectId) throw badRequest(REOPEN_BOARD)
    return config({ org: status.org, projectId, teamId: ref.teamId, boardId: ref.boardId })
  }

  async function target(status: OrgStatus, id: number, ref?: BoardRef): Promise<{ cfg: BoardConfig; cached: WorkItemSummary | null }> {
    const all = holders(status.org)
    let cfg: BoardConfig
    if (ref) {
      cfg = await namedConfig(status, ref)
    } else {
      const holding = all.filter(holder => holder.items.some(item => item.id === id))
      const type = holding[0]?.items.find(item => item.id === id)?.type ?? ''
      cfg = (holding.find(holder => isOnBoard({ type }, holder.board)) ?? holding[0])?.board ?? (await defaultConfig(status))
    }
    const cached = all
      .filter(holder => holder.board.teamId === cfg.teamId && holder.board.boardId === cfg.boardId)
      .flatMap(holder => holder.items)
      .find(item => item.id === id)
    return { cfg, cached: cached ?? null }
  }

  async function reload(status: OrgStatus, cfg: BoardConfig, id: number) {
    const loaded = await loadItem(sourceOf(status), cfg, id)
    if (!loaded) throw new AdoError('not_found', 404, GONE)
    return loaded
  }

  async function publish(status: OrgStatus, raw: RawWorkItem, like: WorkItemSummary): Promise<void> {
    const { org } = status
    const source = sourceOf(status)
    const kept = source.put(raw)
    recent.record([mineKey(org), ...boardViews.of(org).map(view => view.key)], { raw: kept, like })
    await rewriteDetails(status, raw, like)
    for (const view of boardViews.of(org)) {
      if (!view.result.items.some(item => item.id === raw.id)) continue
      const item = await restate(source, view.result.board, kept, like)
      boardViews.update(view, { ...view.result, items: replaced(view.result.items, item) })
    }
    const entry = work.get(org)
    const board = entry?.snapshot?.board
    if (!entry?.snapshot || !board || !holds(entry.snapshot, raw.id)) return
    const listed = hasTask(entry.snapshot.families, raw.id)
    const [item, rules, dismissed] = await Promise.all([
      restate(source, board, kept, like),
      nudges.rules(org, board.teamId),
      nudges.dismissed(org)
    ])
    const done = listed ? await isCompleted(source, board, item) : null
    const snapshot = entry.snapshot
    if (work.get(org) !== entry || !snapshot?.board) return
    const mine = replaced(snapshot.mine, item)
    entry.snapshot = {
      ...snapshot,
      mine,
      other: replaced(snapshot.other, item),
      nudges: findNudges(snapshot.board, mine, rules, dismissed),
      families: done === null ? snapshot.families : patchFamilies(snapshot.families, item, done)
    }
    deps.post(entry.snapshot)
  }

  async function rewriteDetails(status: OrgStatus, raw: RawWorkItem, like: WorkItemSummary): Promise<void> {
    const table = entities.of(status.org).itemDetails
    const own = String(raw.id)
    const listing = table.entries().filter(([key, { value }]) => key === own || value.tasks.some(task => task.id === raw.id))
    for (const [key, { value }] of listing) {
      const states = key === own ? NO_STATES : await typeStatesOf(status, value.projectId, raw)
      const held = table.get(key)
      if (!held) continue
      const next = states && withWrite(held.value, raw, states, status.url, like.url)
      if (!next) table.drop(key)
      else if (next !== held.value) table.put(key, next, held.at)
    }
  }

  async function typeStatesOf(status: OrgStatus, projectId: string, raw: RawWorkItem): Promise<ReadonlyMap<string, TypeState[]> | null> {
    const type = textOr(raw.fields['System.WorkItemType'], '')
    if (type === '') return NO_STATES
    const states = await sourceOf(status).states(projectId, type).catch(() => null)
    return states && new Map([[type, states]])
  }

  async function readDetails(status: OrgStatus, cfg: BoardConfig, id: number, signal: AbortSignal): Promise<DetailsRead> {
    const source = sourceOf(status).withSignal(signal)
    const loaded = await loadItem(source, cfg, id)
    if (!loaded) throw new AdoError('not_found', 404, GONE)
    const { raw, item, chips } = loaded
    const ids = linkedReadIds(raw)
    const linked = ids.length === 0 ? [] : await unlessFailed(source.fields(cfg.projectId, ids, new Set(ids), LINKED_FIELDS))
    const states = linked && (await unlessFailed(childStates(source, cfg.projectId, raw, linked)))
    const home = textOr(raw.fields['System.TeamProject'], '') || cfg.projectId
    const record = recordOf({ raw, linked, states, chips, org: status.org, orgUrl: status.url, projectId: cfg.projectId, home, itemUrl: item.url })
    return { record, item }
  }

  async function detailsBody(status: OrgStatus, cfg: BoardConfig, id: number, fresh: boolean): Promise<Stamped<DetailsRecord> & { item?: WorkItemSummary }> {
    const table = entities.of(status.org).itemDetails
    const key = String(id)
    const held = table.get(key)
    if (!fresh && detailsFresh(held, sourceOf(status).revOf(id), now())) return held
    let read: DetailsRead | undefined
    const value = await table.read(key, 0, async signal => {
      read = await readDetails(status, cfg, id, signal)
      return read.record
    })
    const stored = table.get(key)
    const at = stored?.value === value ? stored.at : now()
    if (!value.tasksRead && stored?.value === value) table.put(key, value, now() - FRESHNESS.itemDetails)
    return { value, at, ...(read ? { item: read.item } : {}) }
  }

  async function detailsComments(status: OrgStatus, cfg: BoardConfig, id: number, options: DetailsOptions, itemUrl: string): Promise<WorkComment[]> {
    const table = entities.of(status.org).comments
    const key = String(id)
    if (options.comments === false) return table.get(key)?.value ?? []
    const held = options.fresh ? undefined : table.fresh(key, FRESHNESS.itemComments)
    return held ?? table.read(key, 0, async signal => withOwnComments(status.org, id, await readComments(withSignal(http, signal), status.org, cfg.projectId, id, itemUrl)))
  }

  function withOwnComments(org: string, id: number, comments: WorkComment[]): WorkComment[] {
    return withOwn(ownComments, `${org}:${id}`, comments, now()).slice(0, COMMENT_LIMIT)
  }

  async function taskParent(status: OrgStatus, cfg: BoardConfig, id: number): Promise<TaskParent> {
    const held = sourceOf(status).record(id)
    if (held && hasPaths(held)) return asTaskParent(held)
    const [read] = await readFields(http, status.org, cfg.projectId, [id], PARENT_FIELDS)
    if (!read) throw new AdoError('not_found', 404, GONE)
    return asTaskParent(read)
  }

  async function republish(status: OrgStatus, cfg: BoardConfig, id: number): Promise<WorkItemSummary | null> {
    const fresh = await loadItem(sourceOf(status), cfg, id).catch(() => null)
    if (fresh) await publish(status, fresh.raw, fresh.item)
    return fresh?.item ?? null
  }

  async function change(status: OrgStatus, cfg: BoardConfig, id: number, rev: number, send: () => Promise<number>): Promise<WorkItemSummary> {
    try {
      await send()
    } catch (error) {
      const fresh = await republish(status, cfg, id)
      if (fresh && fresh.rev !== rev) throw new AdoError('conflict', 409, CONFLICT)
      throw error
    }
    const { raw, item } = await reload(status, cfg, id)
    await publish(status, raw, item)
    return item
  }

  const service: BoardsService = {
    onOrgs(orgs) {
      const states = new Map(orgs.map(status => [status.org, status.state]))
      for (const org of new Set([...work.keys(), ...sources.keys()])) {
        const state = states.get(org)
        if (state === undefined || state === 'disconnected') forget(org)
        else if (state !== 'connected') unrestore(org)
      }
      connected.clear()
      const wanted = new Map<string, BoardsTarget>()
      for (const status of orgs) {
        if (status.state !== 'connected') continue
        connected.add(status.org)
        if (status.boards) wanted.set(status.org, status.boards)
      }
      for (const [org, target] of polled) {
        const next = wanted.get(org)
        if (next && next.projectId === target.projectId && next.teamId === target.teamId) continue
        scheduler.remove(mineKey(org))
        polled.delete(org)
      }
      for (const [org, target] of wanted) {
        if (polled.has(org)) continue
        polled.set(org, target)
        scheduler.upsert({ key: mineKey(org), org, ...MINE_MS, run: signal => poll(org, signal) })
        scheduler.setVisible(mineKey(org), workVisible.has(org))
      }
      for (const status of orgs) void restore(status)
      boardViews.syncAll()
    },

    async snapshot(org) {
      const status = await statusOf(org)
      if (!status.boards) return noBoards(org)
      await restore(status)
      const entry = work.get(org)
      const current = entry?.snapshot
      if (!entry || !current || !sameTarget(current.board, status.boards)) return load(org)
      if (entry.restored) revalidate(org)
      return current
    },

    async refresh(org) {
      const status = await statusOf(org)
      if (!status.boards) return noBoards(org)
      const held = work.get(org)
      if (held) held.forceAudit = true
      if (polled.has(org)) await scheduler.runNow(mineKey(org))
      else await load(org).catch(() => {})
      const entry = work.get(org)
      if (entry?.snapshot) return entry.snapshot
      throw entry?.failure ?? new AdoError('server', 500, LOAD_FAILED)
    },

    async details(org, id, options = {}) {
      const status = await statusOf(org)
      const { cfg, cached } = await target(status, id, options.board)
      const tables = entities.of(org)
      const project = textOr(tables.workItems.get(String(id))?.value.fields['System.TeamProject'], '') || cfg.projectId
      const itemUrl = cached?.url ?? workItemUrl(status.url, project, id)
      const [body, comments] = await Promise.all([detailsBody(status, cfg, id, options.fresh === true), detailsComments(status, cfg, id, options, itemUrl)])
      const record = tables.itemDetails.get(String(id))?.value ?? body.value
      const item = (cached?.rev === record.rev ? cached : null) ?? body.item ?? (await summaryFromStore(sourceOf(status), cfg, id))
      if (!item) throw new AdoError('not_found', 404, GONE)
      const taskTypes = cfg.taskTypes ?? []
      const taskType = isOnBoard(item, cfg) && taskTypes.length > 0 ? taskTypes[0] : null
      return composeDetails({ record, item, comments: withOwnComments(org, id, comments), prs: prRowsOf(org, record.prRefs, tables), taskTypes, taskType, readAt: body.at })
    },

    cachedItem(org, id) {
      const servable = (held: { restored: boolean }) => !held.restored || connected.has(org)
      const entry = work.get(org)
      const snapshot = entry && servable(entry) ? entry.snapshot : null
      const listed = [...(snapshot?.mine ?? []), ...(snapshot?.other ?? [])].find(item => item.id === id)
      return listed ?? boardViews.of(org).filter(servable).flatMap(view => view.result.items).find(item => item.id === id) ?? null
    },

    prRefs(org, id) {
      return entities.of(org).itemDetails.get(String(id))?.value.prRefs ?? []
    },

    async itemInfo(org, id, signal) {
      const held = service.cachedItem(org, id)
      if (held) return { type: held.type, title: held.title, url: held.url }
      return inLane('work', 'user', () => readItemInfo(org, id, signal))
    },

    async move({ org, id, rev, to, board }) {
      const status = await statusOf(org)
      const { cfg, cached } = await target(status, id, board)
      const current = (cached && cached.rev >= rev ? cached : null) ?? (await storedSummary(sourceOf(status), cfg, id, rev)) ?? (await reload(status, cfg, id)).item
      return change(status, cfg, id, rev, () => moveItem(http, org, cfg.projectId, { ...current, rev }, cfg, to))
    },

    async comment(org, id, text) {
      const status = await statusOf(org)
      const { cfg } = await target(status, id)
      const comment = await addComment(http, org, cfg.projectId, id, text)
      ownComments = recordOwn(ownComments, `${org}:${id}`, comment, now())
      const comments = entities.of(org).comments
      const held = comments.get(String(id))
      if (held) comments.put(String(id), withOwnComments(org, id, held.value), held.at)
      await republish(status, cfg, id).catch(() => null)
      return comment
    },

    async assign({ org, id, rev, to, board }) {
      const status = await statusOf(org)
      const { cfg } = await target(status, id, board)
      return change(status, cfg, id, rev, () => assignItem(http, org, cfg.projectId, id, rev, to))
    },

    async assignees({ org, projectId, teamId }) {
      const status = await statusOf(org)
      const load = (signal: AbortSignal) => loadTeamMembers(withSignal(http, signal), org, projectId, teamId)
      const members = await entities.of(org).teamMembers.read(`${projectId}/${teamId}`, FRESHNESS.teamMembers, load)
      const me = status.account ? { displayName: status.account.displayName, uniqueName: status.account.uniqueName } : null
      return { me, members }
    },

    async addTask({ org, parentId, title, board }) {
      const name = taskTitle(title)
      const status = await statusOf(org)
      const { cfg, cached } = await target(status, parentId, board)
      const type = cfg.taskTypes?.[0]
      if (type === undefined) throw badRequest(NO_TASK_TYPE)
      const source = sourceOf(status)
      const parent = await taskParent(status, cfg, parentId)
      if (!isOnBoard({ type: cached?.type ?? parent.type }, cfg)) throw badRequest(NO_TASK_TYPE)
      const raw = await createTask(http, org, cfg.projectId, type, createTaskPatch({ title: name, areaPath: parent.areaPath, iterationPath: parent.iterationPath, parentUrl: parent.url }))
      source.put(raw)
      const states = await source.states(cfg.projectId, type).catch(() => undefined)
      const task = taskRowOf(raw, states, status.url, parent.project || cfg.projectId) ?? malformed(MALFORMED.workItem)
      const details = entities.of(org).itemDetails
      const held = details.get(String(parentId))
      if (held) details.put(String(parentId), withNewChild(held.value, task), held.at)
      const summary = (await republish(status, cfg, parentId)) ?? cached ?? (await summaryFromStore(source, cfg, parentId))
      if (!summary) throw new AdoError('not_found', 404, GONE)
      return { task, parent: summary }
    },

    async linkPr({ org, id, prUrl, board }) {
      const status = await statusOf(org)
      const artifactUrl = await resolvePullRequest(http, org, prUrl)
      const { cfg } = await target(status, id, board)
      const { raw } = await reload(status, cfg, id)
      return change(status, cfg, id, raw.rev, () => addPullRequestLink(http, org, cfg.projectId, raw, artifactUrl))
    },

    async board({ everyone, remember, ...args }) {
      await statusOf(args.org)
      const { boardId } = await config(args)
      homes.set(`${args.org}/${args.teamId}`, args.projectId)
      const filter = everyone ?? (await filters.everyone(args.org, args.teamId, boardId))
      if (remember === true && everyone !== undefined) await filters.remember(args.org, args.teamId, boardId, everyone).catch(() => deps.log(FILTER_NOT_SAVED))
      return { ...(await boardViews.open(args.org, args, boardId, filter)), everyone: filter }
    },

    async defaultBoard(org) {
      const status = await statusOf(org)
      if (!status.boards) return null
      const { projectId, teamId, boardId } = await defaultConfig(status)
      return { projectId, teamId, boardId }
    },

    async nudgeRules({ org, teamId, rules }) {
      if (!rules) return { rules: await nudges.rules(org, teamId) }
      const status = await statusOf(org)
      if (status.boards?.teamId !== teamId) throw badRequest(NO_BOARDS)
      const cleaned = cleanRules(rules)
      const columns = new Set((await defaultConfig(status)).columns.map(column => column.name))
      if (cleaned.some(rule => !columns.has(rule.column))) throw badRequest(UNKNOWN_COLUMN)
      await nudges.saveRules(org, teamId, cleaned)
      void service.refresh(org).catch(() => {})
      return { rules: cleaned }
    },

    async dismissNudge({ org, itemId, prId }) {
      await nudges.dismiss(org, itemId, prId)
      const entry = work.get(org)
      const kept = entry?.snapshot?.nudges.filter(nudge => nudge.itemId !== itemId || nudge.prId !== prId)
      if (entry?.snapshot && kept && kept.length !== entry.snapshot.nudges.length) {
        entry.snapshot = { ...entry.snapshot, nudges: kept }
        deps.post(entry.snapshot)
      }
      return { ok: true }
    },

    visibility({ surface, org, visible, board }) {
      if (surface === 'board') {
        boardViews.setVisible(org, visible, board)
        return { ok: true }
      }
      if (visible) workVisible.add(org)
      else workVisible.delete(org)
      scheduler.setVisible(mineKey(org), visible)
      return { ok: true }
    }
  }
  return service
}

function accountOf(status: OrgStatus): string | null {
  return status.state === 'connected' ? (status.account?.adoId ?? null) : null
}

function savedBoardName(teamId: string, boardId: string): string {
  return `board:${teamId}:${boardId}`
}

function isSavedWork(value: unknown, status: OrgStatus): value is WorkSnapshot {
  return (
    isRecord(value) &&
    value.org === status.org &&
    isRecord(value.board) &&
    value.board.projectId === status.boards?.projectId &&
    value.board.teamId === status.boards?.teamId &&
    [value.mine, value.other, value.nudges].every(Array.isArray) &&
    isRecord(value.families) &&
    Number.isFinite(value.updatedAt)
  )
}

function isSavedBoard(value: unknown, boardId: string): value is { result: BoardResult; everyone: boolean } {
  return (
    isRecord(value) &&
    typeof value.everyone === 'boolean' &&
    isRecord(value.result) &&
    isRecord(value.result.board) &&
    value.result.board.boardId === boardId &&
    Array.isArray(value.result.items) &&
    Number.isFinite(value.result.updatedAt)
  )
}

function meOf(status: OrgStatus): Me | null {
  return status.account ? { id: status.account.adoId, uniqueName: status.account.uniqueName } : null
}

async function restatedRows(source: ItemSource, cfg: BoardConfig, families: WorkFamilies, items: WorkItemSummary[]): Promise<WorkFamilies> {
  let patched = families
  for (const item of items) {
    if (hasTask(patched, item.id)) patched = patchFamilies(patched, item, await isCompleted(source, cfg, item))
  }
  return patched
}

function hasPaths({ fields }: { fields: Record<string, unknown> }): boolean {
  return textOr(fields['System.AreaPath'], '') !== '' && textOr(fields['System.IterationPath'], '') !== ''
}

function asTaskParent({ url, fields }: { url: string; fields: Record<string, unknown> }): TaskParent {
  const text = (name: string) => textOr(fields[name], '')
  return { url, type: text('System.WorkItemType'), project: text('System.TeamProject'), areaPath: text('System.AreaPath'), iterationPath: text('System.IterationPath') }
}

async function storedSummary(source: ItemSource, cfg: BoardConfig, id: number, rev: number): Promise<WorkItemSummary | null> {
  const record = source.record(id)
  if (!record || (!record.withRelations && isOnBoard({ type: textOr(record.fields['System.WorkItemType'], '') }, cfg))) return null
  return summaryFromStore(source, cfg, id, rev)
}

async function childStates(source: ItemSource, projectId: string, raw: RawWorkItem, linked: readonly RawWorkItem[]): Promise<ReadonlyMap<string, TypeState[]>> {
  const children = new Set(childIds(raw))
  const types = [...new Set(linked.filter(item => children.has(item.id)).map(item => textOr(item.fields['System.WorkItemType'], '')))].filter(type => type !== '')
  const lists = await Promise.all(types.map(type => source.states(projectId, type)))
  return new Map(types.map((type, index) => [type, lists[index]]))
}

async function unlessFailed<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read
  } catch (error) {
    if (!(error instanceof AdoError) || error.code === 'rate_limited') throw error
    return null
  }
}

function forcingAudit(held: Synced): Synced {
  return { sync: held.sync && { ...held.sync, auditedAt: -Infinity }, known: held.known }
}

function sameTarget(board: BoardConfig | null | undefined, target: Pick<BoardConfig, 'projectId' | 'teamId'>): boolean {
  return board?.projectId === target.projectId && board.teamId === target.teamId
}

function holds(snapshot: WorkSnapshot, id: number): boolean {
  return [...snapshot.mine, ...snapshot.other].some(item => item.id === id)
}

function replaced(items: WorkItemSummary[], item: WorkItemSummary): WorkItemSummary[] {
  return items.some(entry => entry.id === item.id) ? items.map(entry => (entry.id === item.id ? item : entry)) : items
}
