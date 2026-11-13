import type { MoveTarget, WorkItemSummary } from './work'

export function movesByColumn(item: WorkItemSummary): boolean {
  return item.targets.columns.length > 0
}

export function moveTargets(item: WorkItemSummary): string[] {
  const byColumn = movesByColumn(item)
  const current = byColumn ? item.column : item.state
  return (byColumn ? item.targets.columns : item.targets.states).filter(value => value !== current)
}

export function moveTo(item: WorkItemSummary, value: string): MoveTarget {
  return movesByColumn(item) ? { column: value } : { state: value }
}
