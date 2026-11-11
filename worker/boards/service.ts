import { NO_BOARDS } from '../../src/shared/messages'
import type { BoardsTarget, OrgStatus } from '../../src/shared/types'
import { NO_FAMILIES, type BoardConfig, type MoveTarget, type WorkComment, type WorkFamilies, type WorkItemDetails, type WorkItemSummary, type WorkSnapshot } from '../../src/shared/work'
import { boardConfigKey, loadBoardConfig, type BoardArgs } from '../ado/board-config'
import { addComment, addPullRequestLink, loadDetails, resolvePullRequest } from '../ado/details'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { moveItem } from '../ado/move'
import { readFields, textOr, workItemUrl, type RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { fly, inLane, join, type Flight } from '../data/context'
import type { Entities } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { badRequest, CHIPS_NEED_CODE_READ, CONFLICT, failureMessage, GONE, joinMessages, LOAD_FAILED, NOT_CONNECTED, REOPEN_BOARD, UNKNOWN_COLUMN } from '../messages'
import type { Scheduler } from '../poll/scheduler'
import { createBoardFilters } from './board-filters'
import { boardKey, createBoardViews, type BoardChange, type BoardRef, type BoardRequest, type BoardResult } from './board-views'
import { cleanRules, createNudgeStore, findNudges, type NudgeRule } from './nudges'
import { createRecentWrites } from './recent'
import {
  capBoard,
  capSnapshot,
  createItemSource,
  hasTask,
  isCompleted,
  isOnBoard,
  loadBoardItems,
  loadItem,
  loadMine,
  movesByState,
  patchFamilies,
  restate,
  type ItemSource,
  type Me
} from './snapshot'

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
}

export interface BoardsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<WorkSnapshot>
  refresh(org: string): Promise<WorkSnapshot>
  details(org: string, id: number): Promise<WorkItemDetails>
  cachedItem(org: string, id: number): WorkItemSummary | null
  itemInfo(org: string, id: number, signal: AbortSignal): Promise<ItemInfo | null>
  move(input: { org: string; id: number; rev: number; to: MoveTarget; board?: BoardRef }): Promise<WorkItemSummary>
  comment(org: string, id: number, text: string): Promise<WorkComment>
  linkPr(input: { org: string; id: number; rev: number; prUrl: string; board?: BoardRef }): Promise<WorkItemSummary>
  board(input: BoardArgs & { everyone?: boolean; remember?: boolean }): Promise<BoardResult & { everyone: boolean }>
  defaultBoard(org: string): Promise<{ projectId: string; teamId: string; boardId: string } | null>
  dismissNudge(input: { org: string; itemId: number; prId: number }): Promise<{ ok: true }>
  nudgeRules(input: { org: string; teamId: string; rules?: NudgeRule[] }): Promise<{ rules: NudgeRule[] }>
  visibility(input: { surface: 'work' | 'board'; org: string; visible: boolean; board?: BoardRef }): { ok: true }
}

interface OrgWork {
  snapshot: WorkSnapshot | null
  failure: unknown
  loading: Flight<WorkSnapshot> | null
}

interface Holder { board: BoardConfig; items: WorkItemSummary[] }

type ItemInfo = Pick<WorkItemSummary, 'type' | 'title' | 'url'>

const MINE_MS = { visibleMs: 60_000, backgroundMs: null, quietMax: 2 }
const INFO_FIELDS = ['System.WorkItemType', 'System.Title', 'System.TeamProject']

export function createBoardsService(deps: BoardsServiceDeps): BoardsService {
  const { http, scheduler, now, entities } = deps
  const nudges = createNudgeStore(deps.store)
  const filters = createBoardFilters(deps.store)
  const recent = createRecentWrites()
  const sources = new Map<string, ItemSource>()
  const work = new Map<string, OrgWork>()
  const homes = new Map<string, string>()
  const polled = new Map<string, BoardsTarget>()
  const connected = new Set<string>()
  const workVisible = new Set<string>()
  const boardViews = createBoardViews({
    scheduler,
    now,
    load: loadBoard,
    polls: org => connected.has(org),
    changed: deps.postBoard,
    dropped: key => recent.drop(key)
  })

  async function statusOf(org: string): Promise<OrgStatus> {
    const status = (await deps.orgs()).find(item => item.org === org)
    if (!status) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return status
  }

  function sourceOf(status: OrgStatus): ItemSource {
    const source = sources.get(status.org) ?? createItemSource(http, status.org, status.url, now, entities.of(status.org))
    sources.set(status.org, source)
    return source
  }

  function workOf(org: string): OrgWork {
    const entry = work.get(org) ?? { snapshot: null, failure: null, loading: null }
    work.set(org, entry)
    return entry
  }

  function config(args: BoardArgs, signal?: AbortSignal): Promise<BoardConfig> {
    return entities.of(args.org).boardConfigs.read(boardConfigKey(args), FRESHNESS.boardConfig, scoped => loadBoardConfig(withSignal(http, scoped), args), signal)
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

  async function build(status: OrgStatus, signal?: AbortSignal): Promise<WorkSnapshot> {
    const cfg = await defaultConfig(status, signal)
    const source = sourceOf(status).withSignal(signal)
    const [loaded, rules, dismissed] = await Promise.all([loadMine(source, cfg, meOf(status)), nudges.rules(status.org, cfg.teamId), nudges.dismissed(status.org)])
    const items = await recent.overlay(mineKey(status.org), loaded.items, written => restate(source, cfg, written.raw, written.like))
    const families = await restatedRows(source, cfg, loaded.families, items.filter((item, index) => item !== loaded.items[index]))
    const mine = items.filter(item => !movesByState(item, cfg))
    const message = joinMessages(loaded.chipsOff ? CHIPS_NEED_CODE_READ : undefined, loaded.message)
    return capSnapshot({
      org: status.org,
      board: cfg,
      mine,
      other: items.filter(item => movesByState(item, cfg)),
      nudges: findNudges(cfg, mine, rules, dismissed),
      families,
      updatedAt: now(),
      stale: false,
      ...(message ? { message } : {})
    })
  }

  function load(org: string, signal?: AbortSignal): Promise<WorkSnapshot> {
    const entry = workOf(org)
    entry.loading ??= fly(async () => {
      try {
        const status = await statusOf(org)
        if (!status.boards) return noBoards(org)
        const snapshot = await build(status, signal)
        if (work.get(org) !== entry) return snapshot
        entry.snapshot = snapshot
        entry.failure = null
        deps.post(snapshot)
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

  async function loadBoard(request: BoardRequest, signal?: AbortSignal): Promise<BoardResult> {
    const status = await statusOf(request.org)
    const board = await config(request.args, signal)
    const source = sourceOf(status).withSignal(signal)
    const loaded = await loadBoardItems(source, board, request.everyone)
    const items = await recent.overlay(request.key, loaded.items, written => restate(source, board, written.raw, written.like))
    return capBoard({ board, items, ...(loaded.chipsOff ? { message: CHIPS_NEED_CODE_READ } : {}) }, loaded.truncated)
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
    if (view) return view.result.board
    const own = status.boards?.teamId === ref.teamId ? status.boards.projectId : undefined
    const projectId = homes.get(`${status.org}/${ref.teamId}`) ?? own
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
    recent.record([mineKey(org), ...boardViews.of(org).map(view => view.key)], { raw, like })
    for (const view of boardViews.of(org)) {
      if (!view.result.items.some(item => item.id === raw.id)) continue
      const item = await restate(source, view.result.board, raw, like)
      boardViews.update(view, { ...view.result, items: replaced(view.result.items, item) })
    }
    const entry = work.get(org)
    const board = entry?.snapshot?.board
    if (!entry?.snapshot || !board || !holds(entry.snapshot, raw.id)) return
    const listed = hasTask(entry.snapshot.families, raw.id)
    const [item, rules, dismissed] = await Promise.all([
      restate(source, board, raw, like),
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
      boardViews.syncAll()
    },

    async snapshot(org) {
      const status = await statusOf(org)
      if (!status.boards) return noBoards(org)
      const current = work.get(org)?.snapshot
      const board = current?.board
      if (current && board?.projectId === status.boards.projectId && board.teamId === status.boards.teamId) return current
      return load(org)
    },

    async refresh(org) {
      const status = await statusOf(org)
      if (!status.boards) return noBoards(org)
      if (polled.has(org)) await scheduler.runNow(mineKey(org))
      else await load(org).catch(() => {})
      const entry = work.get(org)
      if (entry?.snapshot) return entry.snapshot
      throw entry?.failure ?? new AdoError('server', 500, LOAD_FAILED)
    },

    async details(org, id) {
      const status = await statusOf(org)
      const { cfg } = await target(status, id)
      const { raw, item, chips } = await reload(status, cfg, id)
      return loadDetails(http, org, cfg.projectId, item, raw, chips)
    },

    cachedItem(org, id) {
      const snapshot = work.get(org)?.snapshot
      const listed = [...(snapshot?.mine ?? []), ...(snapshot?.other ?? [])].find(item => item.id === id)
      return listed ?? boardViews.of(org).flatMap(view => view.result.items).find(item => item.id === id) ?? null
    },

    async itemInfo(org, id, signal) {
      const held = service.cachedItem(org, id)
      if (held) return { type: held.type, title: held.title, url: held.url }
      return inLane('work', 'user', () => readItemInfo(org, id, signal))
    },

    async move({ org, id, rev, to, board }) {
      const status = await statusOf(org)
      const { cfg, cached } = await target(status, id, board)
      const current = cached && cached.rev >= rev ? cached : (await reload(status, cfg, id)).item
      return change(status, cfg, id, rev, () => moveItem(http, org, cfg.projectId, { ...current, rev }, cfg, to))
    },

    async comment(org, id, text) {
      const status = await statusOf(org)
      const { cfg } = await target(status, id)
      const comment = await addComment(http, org, cfg.projectId, id, text)
      await republish(status, cfg, id).catch(() => null)
      return comment
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
      if (remember === true && everyone !== undefined) await filters.remember(args.org, args.teamId, boardId, everyone)
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

function sameApartFromTime(a: WorkSnapshot, b: WorkSnapshot): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })
}

function holds(snapshot: WorkSnapshot, id: number): boolean {
  return [...snapshot.mine, ...snapshot.other].some(item => item.id === id)
}

function replaced(items: WorkItemSummary[], item: WorkItemSummary): WorkItemSummary[] {
  return items.some(entry => entry.id === item.id) ? items.map(entry => (entry.id === item.id ? item : entry)) : items
}
