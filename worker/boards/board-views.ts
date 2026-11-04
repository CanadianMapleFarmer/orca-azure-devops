import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import type { BoardArgs } from '../ado/board-config'
import type { Scheduler } from '../poll/scheduler'

export interface BoardChange { org: string; teamId: string; boardId: string }
export interface BoardResult { board: BoardConfig; items: WorkItemSummary[]; message?: string }
export interface BoardRequest { key: string; org: string; args: BoardArgs; everyone: boolean }
export interface BoardView extends BoardRequest { at: number; result: BoardResult }
export interface BoardRef { teamId: string; boardId: string }

export interface BoardViewsDeps {
  scheduler: Scheduler
  now: () => number
  load: (request: BoardRequest) => Promise<BoardResult>
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

const BOARD_MS = { visibleMs: 30_000, backgroundMs: 300_000 }

export function boardKey(org: string, teamId: string, boardId: string): string {
  return `board:${org}:${teamId}:${boardId}`
}

export function createBoardViews(deps: BoardViewsDeps): BoardViews {
  const views = new Map<string, BoardView>()
  const hidden = new Set<string>()
  const hiddenViews = new Set<string>()
  const generations = new Map<string, number>()

  function changed(view: BoardView): void {
    deps.changed({ org: view.org, teamId: view.result.board.teamId, boardId: view.result.board.boardId })
  }

  async function reload(key: string): Promise<void> {
    const view = views.get(key)
    if (!view || deps.now() - view.at < BOARD_MS.visibleMs) return
    const result = await deps.load(view)
    if (views.get(key) !== view) return
    const before = JSON.stringify(view.result)
    view.result = result
    view.at = deps.now()
    if (JSON.stringify(result) !== before) changed(view)
  }

  function sync(org: string): void {
    const active = deps.polls(org) && !hidden.has(org)
    for (const view of views.values()) {
      if (view.org !== org) continue
      if (!active || hiddenViews.has(view.key)) {
        deps.scheduler.remove(view.key)
        continue
      }
      deps.scheduler.upsert({ key: view.key, ...BOARD_MS, run: () => reload(view.key) })
      deps.scheduler.setVisible(view.key, true)
    }
  }

  function bump(key: string): void {
    generations.set(key, (generations.get(key) ?? 0) + 1)
  }

  function generationOf(org: string, key: string): string {
    return `${generations.get(org) ?? 0}:${generations.get(key) ?? 0}`
  }

  function drop(key: string): void {
    bump(key)
    if (!views.delete(key)) return
    deps.scheduler.remove(key)
    deps.dropped(key)
  }

  function forget(org: string): void {
    bump(org)
    for (const view of [...views.values()]) if (view.org === org) drop(view.key)
  }

  return {
    async open(org, args, boardId, everyone) {
      const key = boardKey(org, args.teamId, boardId)
      const cached = views.get(key)
      if (cached && cached.everyone === everyone && deps.now() - cached.at < BOARD_MS.visibleMs) return cached.result
      const request = { key, org, args, everyone }
      const generation = generationOf(org, key)
      const result = await deps.load(request)
      if (generationOf(org, key) !== generation) return result
      views.set(key, { ...request, at: deps.now(), result })
      sync(org)
      return result
    },

    get: key => views.get(key),

    of: org => [...views.values()].filter(view => view.org === org),

    update(view, result) {
      if (views.get(view.key) !== view) return
      view.result = result
      changed(view)
    },

    setVisible(org, visible, board) {
      const key = board ? boardKey(org, board.teamId, board.boardId) : null
      if (visible) {
        if (key) hiddenViews.delete(key)
        else hidden.delete(org)
        sync(org)
      } else if (key) {
        hiddenViews.add(key)
        drop(key)
      } else {
        hidden.add(org)
        forget(org)
      }
    },

    syncAll() {
      for (const org of new Set([...views.values()].map(view => view.org))) sync(org)
    },

    forget
  }
}
