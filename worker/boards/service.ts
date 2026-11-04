import { NO_BOARDS } from '../../src/shared/messages'
import type { BoardsTarget, OrgStatus } from '../../src/shared/types'
import type { BoardConfig, MoveTarget, WorkComment, WorkItemDetails, WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { boardConfigKey, createBoardConfigCache, loadBoardConfig, type BoardArgs } from '../ado/board-config'
import { addComment, addPullRequestLink, loadDetails, resolvePullRequest } from '../ado/details'
import { AdoError, type AdoHttp } from '../ado/http'
import { moveItem } from '../ado/move'
import type { RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { badRequest, CHIPS_NEED_CODE_READ, CONFLICT, failureMessage, GONE, LOAD_FAILED, NOT_CONNECTED, REOPEN_BOARD, UNKNOWN_COLUMN } from '../messages'
import type { Scheduler } from '../poll/scheduler'
import { boardKey, createBoardViews, type BoardChange, type BoardRef, type BoardRequest, type BoardResult } from './board-views'
import { cleanRules, createNudgeStore, findNudges, type NudgeRule } from './nudges'
import { createRecentWrites } from './recent'
import { capSnapshot, createItemSource, isOnBoard, loadBoardItems, loadItem, loadMine, restate, type ItemSource } from './snapshot'

export type { BoardChange, BoardRef, BoardResult }

export interface BoardsServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  store: StorePort
  scheduler: Scheduler
  post: (snapshot: WorkSnapshot) => void
  postBoard: (change: BoardChange) => void
  now: () => number
}

export interface BoardsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<WorkSnapshot>
  refresh(org: string): Promise<WorkSnapshot>
  details(org: string, id: number): Promise<WorkItemDetails>
  cachedItem(org: string, id: number): WorkItemSummary | null
  move(input: { org: string; id: number; rev: number; to: MoveTarget; board?: BoardRef }): Promise<WorkItemSummary>
  comment(org: string, id: number, text: string): Promise<WorkComment>
  linkPr(input: { org: string; id: number; rev: number; prUrl: string; board?: BoardRef }): Promise<WorkItemSummary>
  board(input: BoardArgs & { everyone: boolean }): Promise<BoardResult>
  defaultBoard(org: string): Promise<{ projectId: string; teamId: string; boardId: string } | null>
  dismissNudge(input: { org: string; itemId: number; prId: number }): Promise<{ ok: true }>
  nudgeRules(input: { org: string; teamId: string; rules?: NudgeRule[] }): Promise<{ rules: NudgeRule[] }>
  visibility(input: { surface: 'work' | 'board'; org: string; visible: boolean; board?: BoardRef }): { ok: true }
}

interface OrgWork {
  snapshot: WorkSnapshot | null
  failure: unknown
  loading: Promise<WorkSnapshot> | null
}

interface Holder { board: BoardConfig; items: WorkItemSummary[] }

const MINE_MS = { visibleMs: 60_000, backgroundMs: 300_000 }

export function createBoardsService(deps: BoardsServiceDeps): BoardsService {
  const { http, scheduler, now } = deps
  const configs = createBoardConfigCache(now)
  const nudges = createNudgeStore(deps.store)
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
    if (!status.boards) throw badRequest(NO_BOARDS)
    return config({ org: status.org, projectId: status.boards.projectId, teamId: status.boards.teamId })
  }

  function noBoards(org: string): WorkSnapshot {
    return { org, board: null, mine: [], other: [], nudges: [], updatedAt: now(), stale: false, message: NO_BOARDS }
  }

  function mineKey(org: string): string {
    return `mine:${org}`
  }

  async function build(status: OrgStatus): Promise<WorkSnapshot> {
    const cfg = await defaultConfig(status)
    const source = sourceOf(status)
    const [loaded, rules, dismissed] = await Promise.all([loadMine(source, cfg), nudges.rules(status.org, cfg.teamId), nudges.dismissed(status.org)])
    const items = await recent.overlay(mineKey(status.org), loaded.items, written => restate(source, cfg, written.raw, written.like))
    const mine = items.filter(item => isOnBoard(item, cfg))
    return capSnapshot({
      org: status.org,
      board: cfg,
      mine,
      other: items.filter(item => !isOnBoard(item, cfg)),
      nudges: findNudges(cfg, mine, rules, dismissed),
      updatedAt: now(),
      stale: false,
      ...(loaded.chipsOff ? { message: CHIPS_NEED_CODE_READ } : {})
    })
  }

  function load(org: string): Promise<WorkSnapshot> {
    const entry = workOf(org)
    entry.loading ??= (async () => {
      try {
        const status = await statusOf(org)
        if (!status.boards) return noBoards(org)
        const snapshot = await build(status)
        if (work.get(org) !== entry) return snapshot
        entry.snapshot = snapshot
        entry.failure = null
        deps.post(snapshot)
        return snapshot
      } catch (error) {
        entry.failure = error
        if (work.get(org) === entry && entry.snapshot) {
          entry.snapshot = { ...entry.snapshot, stale: true, message: failureMessage(error) }
          deps.post(entry.snapshot)
        }
        throw error
      } finally {
        entry.loading = null
      }
    })()
    return entry.loading
  }

  async function loadBoard(request: BoardRequest): Promise<BoardResult> {
    const status = await statusOf(request.org)
    const board = await config(request.args)
    const source = sourceOf(status)
    const loaded = await loadBoardItems(source, board, request.everyone)
    const items = await recent.overlay(request.key, loaded.items, written => restate(source, board, written.raw, written.like))
    return { board, items, ...(loaded.chipsOff ? { message: CHIPS_NEED_CODE_READ } : {}) }
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
    const [item, rules, dismissed] = await Promise.all([
      restate(source, board, raw, like),
      nudges.rules(org, board.teamId),
      nudges.dismissed(org)
    ])
    const snapshot = entry.snapshot
    if (work.get(org) !== entry || !snapshot?.board) return
    const mine = replaced(snapshot.mine, item)
    entry.snapshot = { ...snapshot, mine, other: replaced(snapshot.other, item), nudges: findNudges(snapshot.board, mine, rules, dismissed) }
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
        scheduler.upsert({ key: mineKey(org), ...MINE_MS, run: async () => void (await load(org)) })
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
      await republish(status, cfg, id)
      return comment
    },

    async linkPr({ org, id, prUrl, board }) {
      const status = await statusOf(org)
      const artifactUrl = await resolvePullRequest(http, org, prUrl)
      const { cfg } = await target(status, id, board)
      const { raw } = await reload(status, cfg, id)
      return change(status, cfg, id, raw.rev, () => addPullRequestLink(http, org, cfg.projectId, raw, artifactUrl))
    },

    async board({ everyone, ...args }) {
      await statusOf(args.org)
      const board = await config(args)
      homes.set(`${args.org}/${args.teamId}`, args.projectId)
      return boardViews.open(args.org, args, board.boardId, everyone)
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

function holds(snapshot: WorkSnapshot, id: number): boolean {
  return [...snapshot.mine, ...snapshot.other].some(item => item.id === id)
}

function replaced(items: WorkItemSummary[], item: WorkItemSummary): WorkItemSummary[] {
  return items.some(entry => entry.id === item.id) ? items.map(entry => (entry.id === item.id ? item : entry)) : items
}
