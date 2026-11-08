import type { IconName } from 'orca'
import type { BoardConfig, TaskList, WorkItemSummary, WorkParent, WorkSnapshot, WorkTask } from '../../shared/work'

export interface TaskRow {
  id: number
  title: string
  state: string
  done: boolean
  assignee: string | null
  mine: boolean
  item: WorkItemSummary | null
}

export interface WorkCard {
  key: string
  id: number
  item: WorkItemSummary | null
  parent: WorkParent | null
  column: string | null
  lane: string | null
  tasks: TaskRow[]
  total: number
  done: number
  more: number
}

export interface WorkPlan {
  board: WorkCard[]
  offBoard: { type: string; cards: WorkCard[] }[]
  unknown: WorkCard[]
  noParent: TaskRow[]
}

export const MAX_TITLE_CHARS = 90
export const GROUP_PAGE = 25
export const WORK_NODE_BUDGET = 3200
export const DEFAULT_LANE = 'Default lane'

const NO_COLUMN = 'No column'

const TYPE_ICONS: Record<string, IconName> = {
  'User Story': 'book',
  'Product Backlog Item': 'book',
  Requirement: 'book',
  Bug: 'bug',
  Task: 'check',
  Feature: 'layers',
  Epic: 'flag',
  Impediment: 'warning',
  Risk: 'warning',
  'Test Case': 'activity'
}

export function typeIcon(type: string): IconName {
  return TYPE_ICONS[type] ?? 'file-text'
}

export function cutTitle(title: string): string {
  const chars = [...title]
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS).join('')}…` : title
}

export const tasksKey = (id: number): string => `tasks:${id}`

export function tasksOpenByDefault(card: WorkCard): boolean {
  return card.item === null || card.tasks.some(row => row.mine && !row.done)
}

const rowOfItem = (item: WorkItemSummary): TaskRow => ({
  id: item.id,
  title: item.title,
  state: item.state,
  done: false,
  assignee: item.assignedTo,
  mine: true,
  item
})

const parentOfItem = (item: WorkItemSummary): WorkParent => ({
  id: item.id,
  type: item.type,
  title: item.title,
  state: item.state,
  column: item.column,
  lane: item.lane
})

function listIn<K, V>(map: Map<K, V[]>, key: K): V[] {
  const found = map.get(key)
  if (found) return found
  const created: V[] = []
  map.set(key, created)
  return created
}

function distinctLists(lists: readonly TaskList[]): Map<number, TaskList> {
  const kept = new Map<number, TaskList>()
  const seen = new Set<number>()
  for (const list of lists) {
    if (kept.has(list.parentId)) continue
    const tasks = list.tasks.filter(task => !seen.has(task.id))
    tasks.forEach(task => seen.add(task.id))
    kept.set(list.parentId, { ...list, tasks })
  }
  return kept
}

export function planWork(snapshot: WorkSnapshot): WorkPlan {
  const config = snapshot.board
  const taskTypes = new Set(config?.taskTypes ?? [])
  const requirementTypes = new Set(config?.requirementTypes ?? [])
  const columns = new Set(config?.columns.map(column => column.name) ?? [])
  const isTask = (type: string) => taskTypes.has(type)

  const listed = new Set([...snapshot.mine, ...snapshot.other].map(item => item.id))
  const myTasks = snapshot.other.filter(item => isTask(item.type))
  const myTaskById = new Map(myTasks.map(item => [item.id, item]))
  const lists = distinctLists(snapshot.families.lists)
  const inLists = new Set([...lists.values()].flatMap(list => list.tasks.map(task => task.id)))
  const dimmed = new Map<number, WorkParent>()
  for (const parent of snapshot.families.parents) if (!listed.has(parent.id) && !dimmed.has(parent.id)) dimmed.set(parent.id, parent)

  const extras = new Map<number, WorkItemSummary[]>()
  for (const task of myTasks) if (task.parentId !== null && !inLists.has(task.id)) listIn(extras, task.parentId).push(task)
  const hasRows = (id: number) => lists.has(id) || extras.has(id)

  const rowOfTask = (task: WorkTask): TaskRow => ({ ...task, item: myTaskById.get(task.id) ?? null })

  function cardOf(key: string, id: number, item: WorkItemSummary | null, parent: WorkParent | null, column: string | null, lane: string | null): WorkCard {
    const list = lists.get(id)
    const tasks = [...(list?.tasks.map(rowOfTask) ?? []), ...(extras.get(id) ?? []).map(rowOfItem)]
    const total = list ? Math.max(list.total, tasks.length) : tasks.length
    const done = list ? list.done : tasks.filter(row => row.done).length
    return { key, id, item, parent, column, lane, tasks, total, done, more: Math.max(0, total - tasks.length) }
  }
  const itemCard = (item: WorkItemSummary) => cardOf(`item:${item.id}`, item.id, item, null, item.column, item.lane)
  const dimmedCard = (parent: WorkParent) => cardOf(`parent:${parent.id}`, parent.id, null, parent, parent.column, parent.lane)

  const board = snapshot.mine.map(itemCard)
  const types = new Map<string, WorkCard[]>()
  const addOff = (type: string, card: WorkCard) => listIn(types, type).push(card)

  for (const item of snapshot.other) if (!isTask(item.type)) addOff(item.type, itemCard(item))
  for (const parent of dimmed.values()) {
    const onBoard = requirementTypes.has(parent.type) && parent.column !== null && columns.has(parent.column)
    if (onBoard) board.push(dimmedCard(parent))
    else addOff(parent.type, dimmedCard(parent))
  }

  const noParent: TaskRow[] = []
  for (const task of myTasks) {
    const placed = task.parentId !== null || inLists.has(task.id)
    if (hasRows(task.id)) addOff(task.type, placed ? dimmedCard(parentOfItem(task)) : itemCard(task))
    else if (!placed) noParent.push(rowOfItem(task))
  }

  const known = (id: number) => listed.has(id) || dimmed.has(id)
  const unknownIds = new Set<number>()
  for (const task of myTasks) if (task.parentId !== null && !known(task.parentId)) unknownIds.add(task.parentId)
  for (const id of lists.keys()) if (!known(id)) unknownIds.add(id)
  const unknown = [...unknownIds].map(id => cardOf(`unknown:${id}`, id, null, null, null, null))

  const offBoard = [...types].sort(([a], [b]) => a.localeCompare(b)).map(([type, cards]) => ({ type, cards }))
  return { board, offBoard, unknown, noParent }
}

export function byColumn(cards: readonly WorkCard[], board: Pick<BoardConfig, 'columns'>): { name: string; cards: WorkCard[] }[] {
  const names = board.columns.map(column => column.name)
  const groups = new Map(names.map(name => [name, [] as WorkCard[]]))
  for (const card of cards) listIn(groups, card.column !== null && groups.has(card.column) ? card.column : (names[0] ?? card.column ?? NO_COLUMN)).push(card)
  return [...groups].filter(([, listedCards]) => listedCards.length > 0).map(([name, listedCards]) => ({ name, cards: listedCards }))
}

export interface LaneGroup {
  id: string
  name: string
  columns: { name: string; cards: WorkCard[] }[]
}

export function byLane(cards: readonly WorkCard[], board: Pick<BoardConfig, 'columns' | 'lanes'>): LaneGroup[] {
  const index = new Map<string, number>()
  board.lanes.forEach((lane, at) => {
    if (!index.has(lane.name)) index.set(lane.name, at)
  })
  const home = index.get('') ?? 0
  const buckets = board.lanes.map((): WorkCard[] => [])
  for (const card of cards) buckets[(card.lane === null ? undefined : index.get(card.lane)) ?? home]?.push(card)
  return board.lanes.map((lane, at) => ({
    id: lane.id,
    name: lane.name === '' ? DEFAULT_LANE : lane.name,
    columns: byColumn(buckets[at] ?? [], board)
  }))
}
