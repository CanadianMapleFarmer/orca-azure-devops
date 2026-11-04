import type { BoardConfig, WorkItemSummary } from '../shared/work'

export interface Lane { id: string; name: string; collapsed: boolean; cells: Record<string, WorkItemSummary[]> }
export interface Cell { column: string; lane: string }
export interface ParentOption { id: number; title: string }

const SINGLE_LANE = 'default'

export function shownLanes(cfg: BoardConfig): { id: string; name: string }[] {
  return cfg.lanes.length > 1 ? cfg.lanes : [{ id: cfg.lanes[0]?.id ?? SINGLE_LANE, name: '' }]
}

export function cellOf(item: WorkItemSummary, cfg: BoardConfig): Cell {
  const lanes = shownLanes(cfg)
  const column = cfg.columns.find(entry => entry.name === item.column) ?? cfg.columns[0]
  const lane = lanes.find(entry => entry.name === (item.lane ?? '')) ?? lanes.find(entry => entry.name === '') ?? lanes[0]
  return { column: column?.name ?? '', lane: lane.id }
}

export function layoutBoard(cfg: BoardConfig, items: WorkItemSummary[], toggled: ReadonlySet<string>): { columns: string[]; lanes: Lane[] } {
  const columns = cfg.columns.map(column => column.name)
  const shown = shownLanes(cfg)
  const lanes = shown.map((lane, index): Lane => ({
    id: lane.id,
    name: lane.name,
    collapsed: shown.length > 1 && (index > 0) !== toggled.has(lane.id),
    cells: Object.fromEntries(columns.map(column => [column, []]))
  }))
  for (const item of items) {
    const cell = cellOf(item, cfg)
    lanes.find(lane => lane.id === cell.lane)?.cells[cell.column]?.push(item)
  }
  return { columns, lanes }
}

export function parentOptions(items: WorkItemSummary[]): ParentOption[] {
  const parents = new Map<number, string>()
  for (const item of items) {
    if (item.parentId !== null && !parents.has(item.parentId)) parents.set(item.parentId, item.parentTitle ?? `#${item.parentId}`)
  }
  return [...parents].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id)
}

export function withParent(items: WorkItemSummary[], parentId: number | null): WorkItemSummary[] {
  return parentId === null ? items : items.filter(item => item.parentId === parentId)
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = Array.from(words[0])[0]
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : ''
  return `${first}${last}`.toUpperCase()
}

export function cardLabel(item: WorkItemSummary, column: string): string {
  return `${item.type} ${item.id}: ${item.title}, in ${column}`
}
