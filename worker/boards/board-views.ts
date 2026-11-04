import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import type { BoardArgs } from '../ado/board-config'
import type { Scheduler } from '../poll/scheduler'

export interface BoardChange { org: string; teamId: string; boardId: string }
export interface BoardResult { board: BoardConfig; items: WorkItemSummary[]; message?: string }
export interface BoardRequest { key: string; org: string; args: BoardArgs; everyone: boolean }
export interface BoardView extends BoardRequest { at: number; result: BoardResult }

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
  setVisible(org: string, visible: boolean): void
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
      if (!active) {
        deps.scheduler.remove(view.key)
        continue
      }
      deps.scheduler.upsert({ key: view.key, ...BOARD_MS, run: () => reload(view.key) })
      deps.scheduler.setVisible(view.key, true)
    }
  }

  function forget(org: string): void {
    for (const [key, view] of views) {
      if (view.org !== org) continue
      deps.scheduler.remove(key)
      views.delete(key)
      deps.dropped(key)
    }
  }

  return {
    async open(org, args, boardId, everyone) {
      const key = boardKey(org, args.teamId, boardId)
      const cached = views.get(key)
      if (cached && cached.everyone === everyone && deps.now() - cached.at < BOARD_MS.visibleMs) return cached.result
      const request = { key, org, args, everyone }
      const result = await deps.load(request)
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

    setVisible(org, visible) {
      if (visible) {
        hidden.delete(org)
        sync(org)
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
