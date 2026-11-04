import type { BoardConfig, MoveTarget, WorkItemSummary } from '../shared/work'
import { cellOf, shownLanes, type Cell } from './layout'

export interface Rect { left: number; top: number; width: number; height: number }

export function dropTarget(point: { x: number; y: number }, cells: (Cell & { rect: Rect })[]): Cell | null {
  const hit = cells.find(({ rect }) => point.x >= rect.left && point.x < rect.left + rect.width && point.y >= rect.top && point.y < rect.top + rect.height)
  return hit ? { column: hit.column, lane: hit.lane } : null
}

export function moveFor(item: WorkItemSummary, target: Cell, cfg: BoardConfig): MoveTarget | null {
  const column = cfg.columns.find(entry => entry.name === target.column)
  if (!column || !Object.hasOwn(column.stateMappings, item.type)) return null
  const own = cellOf(item, cfg)
  const lane = shownLanes(cfg).length > 1 ? cfg.lanes.find(entry => entry.id === target.lane) : undefined
  const move: MoveTarget = {
    ...(own.column === column.name ? {} : { column: column.name }),
    ...(lane && own.lane !== lane.id ? { lane: lane.name } : {})
  }
  return Object.keys(move).length === 0 ? null : move
}
