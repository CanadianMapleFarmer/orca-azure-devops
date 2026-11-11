import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import type { BoardArgs } from '../ado/board-config'
import { failureMessage, joinMessages, LAST_BOARD } from '../messages'
import type { Scheduler } from '../poll/scheduler'
import type { SyncState } from './sync'

export interface BoardChange { org: string; teamId: string; boardId: string }
export interface BoardResult { board: BoardConfig; items: WorkItemSummary[]; message?: string; stale?: boolean; updatedAt: number }
export interface BoardRequest { key: string; org: string; args: BoardArgs; everyone: boolean }
export interface Synced { sync: SyncState | null; known: number[] }
export interface BoardLoad extends Synced { result: BoardResult }
export interface BoardView extends BoardRequest, Synced { at: number; result: BoardResult }
export interface BoardRef { teamId: string; boardId: string }
export interface SavedBoard { result: BoardResult; savedAt: number }

export interface BoardViewsDeps {
  scheduler: Scheduler
  now: () => number
  load: (request: BoardRequest & Synced, signal?: AbortSignal) => Promise<BoardLoad>
  restore: (request: BoardRequest, boardId: string) => Promise<SavedBoard | null>
  polls: (org: string) => boolean
  changed: (change: BoardChange) => void
  dropped: (key: string) => void
}

export interface BoardViews {
  open(org: string, args: BoardArgs, boardId: string, everyone: boolean): Promise<BoardResult>
  get(key: string): BoardView | undefined
  of(org: string): BoardView[]
  update(view: BoardView, result: BoardResult): void
  setVisible(org: string, visible: boolean, board?: BoardRef): void
  syncAll(): void
  forget(org: string): void
}

const BOARD_MS = { visibleMs: 30_000, backgroundMs: null, quietMax: 2 }
const MAX_HELD_VIEWS = 4

export function boardKey(org: string, teamId: string, boardId: string): string {
  return `board:${org}:${teamId}:${boardId}`
}

function sameApartFromTime(a: BoardResult, b: BoardResult): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })
}

export function createBoardViews(deps: BoardViewsDeps): BoardViews {
  const views = new Map<string, BoardView>()
  const hidden = new Set<string>()
  const hiddenViews = new Set<string>()
  const generations = new Map<string, number>()
  const opened = new Set<string>()

  function changed(view: BoardView): void {
    deps.changed({ org: view.org, teamId: view.result.board.teamId, boardId: view.result.board.boardId })
  }

  function isStale(view: BoardView): boolean {
    return deps.now() - view.at >= BOARD_MS.visibleMs
  }

  async function reload(key: string, signal: AbortSignal): Promise<void | 'unchanged'> {
    const view = views.get(key)
    if (!view || !isStale(view)) return
    let loaded: BoardLoad
    try {
      loaded = await deps.load(view, signal)
    } catch (error) {
      if (views.get(key) === view && !signal.aborted) failed(view, error)
      throw error
    }
    if (views.get(key) !== view) return
    const unchanged = sameApartFromTime(view.result, loaded.result)
    Object.assign(view, loaded, { at: deps.now() })
    if (unchanged) return 'unchanged'
    changed(view)
  }

  function failed(view: BoardView, error: unknown): void {
    view.result = { ...view.result, stale: true, message: joinMessages(failureMessage(error), LAST_BOARD) }
    view.at = deps.now()
    changed(view)
  }

  function isHidden(view: BoardView): boolean {
    return hidden.has(view.org) || hiddenViews.has(view.key)
  }

  function sync(org: string): void {
    const active = deps.polls(org)
    for (const view of views.values()) {
      if (view.org !== org) continue
      if (!active || isHidden(view)) {
        deps.scheduler.remove(view.key)
        continue
      }
      deps.scheduler.upsert({ key: view.key, org, ...BOARD_MS, run: signal => reload(view.key, signal) })
      deps.scheduler.setVisible(view.key, true)
    }
  }

  function bump(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1)
  }

  function generationOf(org: string, key: string): string {
    return `${generations.get(org) ?? 0}:${generations.get(key) ?? 0}`
  }

  function touch(key: string): void {
    opened.delete(key)
    opened.add(key)
  }

  function trim(org: string, kept: string): void {
    const held = [...opened].map(key => views.get(key)!).filter(view => view.org === org)
    const evictable = held.filter(view => view.key !== kept && isHidden(view))
    for (const view of evictable.slice(0, Math.max(0, held.length - MAX_HELD_VIEWS))) drop(view.key)
  }

  function drop(key: string): void {
    bump(key)
    opened.delete(key)
    if (!views.delete(key)) return
    deps.scheduler.remove(key)
    deps.dropped(key)
  }

  function forget(org: string): void {
    bump(org)
    for (const view of [...views.values()]) if (view.org === org) drop(view.key)
  }

  function hold(view: BoardView): void {
    views.set(view.key, view)
    touch(view.key)
    trim(view.org, view.key)
    sync(view.org)
  }

  return {
    async open(org, args, boardId, everyone) {
      const key = boardKey(org, args.teamId, boardId)
      const held = views.get(key)
      if (held && held.everyone === everyone) {
        touch(key)
        if (isStale(held)) void deps.scheduler.runNow(key)
        return held.result
      }
      const request = { key, org, args, everyone }
      const generation = generationOf(org, key)
      const saved = held ? null : await deps.restore(request, boardId)
      if (saved && generationOf(org, key) === generation && !views.has(key)) {
        hold({ ...request, result: saved.result, sync: null, known: [], at: Math.min(saved.savedAt, deps.now() - BOARD_MS.visibleMs) })
        void deps.scheduler.runNow(key)
        return saved.result
      }
      const loaded = await deps.load({ ...request, sync: null, known: [] })
      if (generationOf(org, key) !== generation) return loaded.result
      hold({ ...request, ...loaded, at: deps.now() })
      return loaded.result
    },

    get: key => views.get(key),

    of: org => [...views.values()].filter(view => view.org === org),

    update(view, result) {
      if (views.get(view.key) !== view) return
      view.result = result
      changed(view)
    },

    setVisible(org, visible, board) {
      const marks = board ? hiddenViews : hidden
      const mark = board ? boardKey(org, board.teamId, board.boardId) : org
      if (visible) marks.delete(mark)
      else marks.add(mark)
      sync(org)
    },

    syncAll() {
      for (const org of new Set([...views.values()].map(view => view.org))) sync(org)
    },

    forget
  }
}
