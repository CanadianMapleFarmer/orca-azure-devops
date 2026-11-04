import type { BoardsTarget, OrgStatus } from '../../src/shared/types'
import type { BoardConfig, MoveTarget, WorkComment, WorkItemDetails, WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { boardConfigKey, createBoardConfigCache, loadBoardConfig, type BoardArgs } from '../ado/board-config'
import { addComment, linkPr as linkPullRequest, loadDetails } from '../ado/details'
import { AdoError, type AdoHttp } from '../ado/http'
import { moveItem } from '../ado/move'
import type { StorePort } from '../connections'
import type { Scheduler } from '../poll/scheduler'
import { createNudgeStore, findNudges } from './nudges'
import { capSnapshot, CHIPS_NEED_CODE_READ, createItemSource, isOnBoard, loadBoardItems, loadItem, loadMine, type ItemSource } from './snapshot'

export interface BoardChange { org: string; teamId: string; boardId: string }

export interface BoardsServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  store: StorePort
  scheduler: Scheduler
  post: (snapshot: WorkSnapshot) => void
  postBoard: (change: BoardChange) => void
  now: () => number
}

type BoardResult = { board: BoardConfig; items: WorkItemSummary[] }

export interface BoardsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<WorkSnapshot>
  refresh(org: string): Promise<WorkSnapshot>
  details(org: string, id: number): Promise<WorkItemDetails>
  move(input: { org: string; id: number; rev: number; to: MoveTarget }): Promise<WorkItemSummary>
  comment(org: string, id: number, text: string): Promise<WorkComment>
  linkPr(input: { org: string; id: number; rev: number; prUrl: string }): Promise<WorkItemSummary>
  board(input: BoardArgs & { everyone: boolean }): Promise<BoardResult>
  dismissNudge(input: { org: string; itemId: number; prId: number }): Promise<{ ok: true }>
  visibility(input: { surface: 'work' | 'board'; org: string; visible: boolean }): { ok: true }
}

interface OrgWork {
  snapshot: WorkSnapshot | null
  failure: unknown
  loading: Promise<WorkSnapshot> | null
}

interface BoardView { org: string; args: BoardArgs; everyone: boolean; at: number; result: BoardResult }

const MINE_MS = { visibleMs: 60_000, backgroundMs: 300_000 }
const BOARD_MS = { visibleMs: 30_000, backgroundMs: 300_000 }
const NO_BOARDS = "Pick a boards project and team in this org's settings."
const NOT_CONNECTED = 'Connect this organization first.'
const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const GONE = "That work item no longer exists, or you can't see it."
const LOAD_FAILED = "Couldn't load work items."

export function createBoardsService(deps: BoardsServiceDeps): BoardsService {
  const { http, scheduler, now } = deps
  const configs = createBoardConfigCache(now)
  const nudges = createNudgeStore(deps.store)
  const sources = new Map<string, ItemSource>()
  const work = new Map<string, OrgWork>()
  const polled = new Map<string, BoardsTarget>()
  const connected = new Set<string>()
  const workVisible = new Set<string>()
  const boardHidden = new Set<string>()
  const views = new Map<string, BoardView>()

  async function statusOf(org: string): Promise<OrgStatus> {
    const status = (await deps.orgs()).find(item => item.org === org)
    if (!status) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return status
  }

  function sourceOf(status: OrgStatus): ItemSource {
    const source = sources.get(status.org) ?? createItemSource(http, status.org, status.url, now)
    sources.set(status.org, source)
    return source
  }

  function workOf(org: string): OrgWork {
    const entry = work.get(org) ?? { snapshot: null, failure: null, loading: null }
    work.set(org, entry)
    return entry
  }

  async function config(args: BoardArgs): Promise<BoardConfig> {
    const key = boardConfigKey(args)
    const cached = configs.get(key)
    if (cached) return cached
    const cfg = await loadBoardConfig(http, args)
    configs.set(key, cfg)
    return cfg
  }

  async function defaultConfig(status: OrgStatus): Promise<BoardConfig> {
    if (!status.boards) throw new AdoError('bad_request', 400, NO_BOARDS)
    return config({ org: status.org, projectId: status.boards.projectId, teamId: status.boards.teamId })
  }

  function noBoards(org: string): WorkSnapshot {
    return { org, board: null, mine: [], other: [], nudges: [], updatedAt: now(), stale: false, message: NO_BOARDS }
  }

  async function nudgesFor(org: string, cfg: BoardConfig, mine: WorkItemSummary[]) {
    const [rules, dismissed] = await Promise.all([nudges.rules(org, cfg.teamId), nudges.dismissed(org)])
    return findNudges(cfg, mine, rules, dismissed)
  }

  async function build(status: OrgStatus): Promise<WorkSnapshot> {
    const cfg = await defaultConfig(status)
    const { items, chipsOff } = await loadMine(sourceOf(status), cfg)
    const mine = items.filter(item => isOnBoard(item, cfg))
    return capSnapshot({
      org: status.org,
      board: cfg,
      mine,
      other: items.filter(item => !isOnBoard(item, cfg)),
      nudges: await nudgesFor(status.org, cfg, mine),
      updatedAt: now(),
      stale: false,
      ...(chipsOff ? { message: CHIPS_NEED_CODE_READ } : {})
    })
  }

  function load(org: string): Promise<WorkSnapshot> {
    const entry = workOf(org)
    entry.loading ??= (async () => {
      try {
        const status = await statusOf(org)
        if (!status.boards) return noBoards(org)
        entry.snapshot = await build(status)
        entry.failure = null
        deps.post(entry.snapshot)
        return entry.snapshot
      } catch (error) {
        entry.failure = error
        if (entry.snapshot) {
          entry.snapshot = { ...entry.snapshot, stale: true, message: messageOf(error) }
          deps.post(entry.snapshot)
        }
        throw error
      } finally {
        entry.loading = null
      }
    })()
    return entry.loading
  }

  function mineKey(org: string): string {
    return `mine:${org}`
  }

  function boardKey(org: string, teamId: string, boardId: string): string {
    return `board:${org}:${teamId}:${boardId}`
  }

  async function loadView(status: OrgStatus, args: BoardArgs, everyone: boolean): Promise<BoardResult> {
    const board = await config(args)
    const { items } = await loadBoardItems(sourceOf(status), board, everyone)
    const result = { board, items }
    views.set(boardKey(status.org, args.teamId, board.boardId), { org: status.org, args, everyone, at: now(), result })
    return result
  }

  async function reloadView(key: string): Promise<void> {
    const view = views.get(key)
    if (!view || now() - view.at < BOARD_MS.visibleMs) return
    const { board, items } = await loadView(await statusOf(view.org), view.args, view.everyone)
    if (JSON.stringify(items) === JSON.stringify(view.result.items)) return
    deps.postBoard({ org: view.org, teamId: board.teamId, boardId: board.boardId })
  }

  function syncBoardJobs(org: string): void {
    const active = connected.has(org) && !boardHidden.has(org)
    for (const [key, view] of views) {
      if (view.org !== org) continue
      if (!active) {
        scheduler.remove(key)
        continue
      }
      scheduler.upsert({ key, ...BOARD_MS, run: () => reloadView(key) })
      scheduler.setVisible(key, true)
    }
  }

  function forget(org: string): void {
    work.delete(org)
    sources.delete(org)
    for (const [key, view] of views) {
      if (view.org !== org) continue
      scheduler.remove(key)
      views.delete(key)
    }
  }

  function locate(org: string, id: number): { item: WorkItemSummary; cfg: BoardConfig } | null {
    const snapshot = work.get(org)?.snapshot
    const cached = snapshot?.board && [...snapshot.mine, ...snapshot.other].find(item => item.id === id)
    if (cached && snapshot?.board) return { item: cached, cfg: snapshot.board }
    for (const view of views.values()) {
      const item = view.org === org ? view.result.items.find(entry => entry.id === id) : undefined
      if (item) return { item, cfg: view.result.board }
    }
    return null
  }

  async function itemConfig(status: OrgStatus, id: number): Promise<{ cfg: BoardConfig; cached: WorkItemSummary | null }> {
    const located = locate(status.org, id)
    return located ? { cfg: located.cfg, cached: located.item } : { cfg: await defaultConfig(status), cached: null }
  }

  async function reload(status: OrgStatus, cfg: BoardConfig, id: number) {
    const loaded = await loadItem(sourceOf(status), cfg, id)
    if (!loaded) throw new AdoError('not_found', 404, GONE)
    return loaded
  }

  async function publishItem(org: string, item: WorkItemSummary): Promise<void> {
    for (const view of views.values()) {
      if (view.org === org) view.result = { ...view.result, items: replaced(view.result.items, item) }
    }
    const board = work.get(org)?.snapshot?.board
    if (!board) return
    const [rules, dismissed] = await Promise.all([nudges.rules(org, board.teamId), nudges.dismissed(org)])
    const entry = work.get(org)
    const snapshot = entry?.snapshot
    if (!entry || !snapshot?.board) return
    const mine = replaced(snapshot.mine, item)
    const other = replaced(snapshot.other, item)
    if (mine === snapshot.mine && other === snapshot.other) return
    entry.snapshot = { ...snapshot, mine, other, nudges: findNudges(snapshot.board, mine, rules, dismissed) }
    deps.post(entry.snapshot)
  }

  async function change(status: OrgStatus, cfg: BoardConfig, id: number, rev: number, send: () => Promise<number>): Promise<WorkItemSummary> {
    try {
      await send()
    } catch (error) {
      const fresh = await loadItem(sourceOf(status), cfg, id).catch(() => null)
      if (fresh) await publishItem(status.org, fresh.item)
      if (fresh && fresh.item.rev !== rev) throw new AdoError('conflict', 409, CONFLICT)
      throw error
    }
    const { item } = await reload(status, cfg, id)
    await publishItem(status.org, item)
    return item
  }

  return {
    onOrgs(orgs) {
      const listed = new Set(orgs.map(status => status.org))
      for (const org of [...work.keys(), ...sources.keys()]) if (!listed.has(org)) forget(org)
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
        scheduler.upsert({ key: mineKey(org), ...MINE_MS, run: async () => void (await load(org)) })
        scheduler.setVisible(mineKey(org), workVisible.has(org))
      }
      for (const org of new Set([...views.values()].map(view => view.org))) syncBoardJobs(org)
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
      const entry = workOf(org)
      if (entry.snapshot) return entry.snapshot
      throw entry.failure ?? new AdoError('server', 500, LOAD_FAILED)
    },

    async details(org, id) {
      const status = await statusOf(org)
      const { cfg } = await itemConfig(status, id)
      const { raw, item } = await reload(status, cfg, id)
      return loadDetails(http, org, cfg.projectId, item, raw)
    },

    async move({ org, id, rev, to }) {
      const status = await statusOf(org)
      const { cfg, cached } = await itemConfig(status, id)
      const current = cached && cached.rev >= rev ? cached : (await reload(status, cfg, id)).item
      return change(status, cfg, id, rev, () => moveItem(http, org, cfg.projectId, { ...current, rev }, cfg, to))
    },

    async comment(org, id, text) {
      const status = await statusOf(org)
      const { cfg } = await itemConfig(status, id)
      return addComment(http, org, cfg.projectId, id, text)
    },

    async linkPr({ org, id, rev, prUrl }) {
      const status = await statusOf(org)
      const { cfg } = await itemConfig(status, id)
      const { raw } = await reload(status, cfg, id)
      return change(status, cfg, id, rev, () => linkPullRequest(http, org, cfg.projectId, id, rev, prUrl, raw))
    },

    async board({ everyone, ...args }) {
      const status = await statusOf(args.org)
      const board = await config(args)
      const view = views.get(boardKey(args.org, args.teamId, board.boardId))
      if (view && view.everyone === everyone && now() - view.at < BOARD_MS.visibleMs) return view.result
      const result = await loadView(status, args, everyone)
      syncBoardJobs(args.org)
      return result
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

    visibility({ surface, org, visible }) {
      if (surface === 'work') {
        toggle(workVisible, org, visible)
        scheduler.setVisible(mineKey(org), visible)
      } else {
        toggle(boardHidden, org, !visible)
        syncBoardJobs(org)
      }
      return { ok: true }
    }
  }
}

function replaced(items: WorkItemSummary[], item: WorkItemSummary): WorkItemSummary[] {
  return items.some(entry => entry.id === item.id) ? items.map(entry => (entry.id === item.id ? item : entry)) : items
}

function toggle(set: Set<string>, org: string, on: boolean): void {
  if (on) set.add(org)
  else set.delete(org)
}

function messageOf(error: unknown): string {
  return error instanceof AdoError ? error.message : LOAD_FAILED
}
