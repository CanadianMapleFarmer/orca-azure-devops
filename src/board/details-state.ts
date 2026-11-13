import type { Assignee, DetailTask, WorkComment, WorkItemDetails, WorkItemSummary } from '../shared/work'

export const COMMENT_CAP = 50
export const TASK_CAP = 50

export type Section = 'fields' | 'tasks' | 'comments'

export type Load =
  | { status: 'loading' }
  | { status: 'ready'; details: WorkItemDetails; refreshing: boolean }
  | { status: 'failed'; message: string }

export interface Notice { tone: 'danger' | 'success'; text: string }

export interface PanelState {
  id: number
  seq: number
  load: Load
  busy: ReadonlySet<string>
  notices: Partial<Record<Section, Notice>>
  offBoard: boolean
}

export function opened(id: number, seq: number): PanelState {
  return { id, seq, load: { status: 'loading' }, busy: new Set(), notices: {}, offBoard: false }
}

export function refreshing(state: PanelState, seq: number): PanelState {
  const load: Load = state.load.status === 'ready' ? { ...state.load, refreshing: true } : { status: 'loading' }
  return { ...state, seq, load }
}

export function loaded(state: PanelState, seq: number, details: WorkItemDetails): PanelState {
  if (seq !== state.seq) return state
  const held = state.load.status === 'ready' ? state.load.details : null
  return { ...state, load: { status: 'ready', details: held ? kept(held, details) : details, refreshing: false } }
}

function kept(held: WorkItemDetails, incoming: WorkItemDetails): WorkItemDetails {
  if (held.item.rev > incoming.item.rev) return held
  const rows = new Map(held.tasks.map(task => [task.id, task]))
  const tasks = incoming.tasks.map(task => {
    const own = rows.get(task.id)
    return own && own.rev > task.rev ? own : task
  })
  return { ...incoming, tasks }
}

export function failed(state: PanelState, seq: number, message: string): PanelState {
  return seq === state.seq ? { ...state, load: { status: 'failed', message } } : state
}

export function needsReread(state: PanelState, boardItem: WorkItemSummary | null): boolean {
  return state.load.status === 'ready' && !state.load.refreshing && boardItem !== null && boardItem.rev > state.load.details.item.rev
}

export function onBoard(state: PanelState, boardItem: WorkItemSummary | null): PanelState {
  const offBoard = boardItem === null
  return state.load.status === 'ready' && state.offBoard !== offBoard ? { ...state, offBoard } : state
}

export function shownItem(state: PanelState, boardItem: WorkItemSummary | null): WorkItemSummary | null {
  if (state.load.status !== 'ready') return boardItem
  const own = state.load.details.item
  return boardItem && boardItem.rev >= own.rev ? boardItem : own
}

function patched(state: PanelState, patch: (details: WorkItemDetails) => Partial<WorkItemDetails>): PanelState {
  if (state.load.status !== 'ready') return state
  const { details } = state.load
  return { ...state, load: { ...state.load, details: { ...details, ...patch(details) } } }
}

export function withItem(state: PanelState, item: WorkItemSummary): PanelState {
  return patched(state, () => ({ item }))
}

export function withComment(state: PanelState, comment: WorkComment): PanelState {
  return patched(state, details => ({ comments: [comment, ...details.comments.filter(entry => entry.id !== comment.id)].slice(0, COMMENT_CAP) }))
}

export function withAssignee(state: PanelState, item: WorkItemSummary, assignee: Assignee | null): PanelState {
  return patched(state, () => ({ item, assignee }))
}

export function withTaskRow(state: PanelState, id: number, summary: WorkItemSummary, done: boolean): PanelState {
  return patched(state, details => ({
    tasks: details.tasks.map(task => (task.id === id && summary.rev >= task.rev ? { ...task, rev: summary.rev, state: summary.state, done } : task)),
  }))
}

export function withNewTask(state: PanelState, task: DetailTask, parent: WorkItemSummary): PanelState {
  return patched(state, details => {
    const others = details.tasks.filter(row => row.id !== task.id)
    const at = others.findIndex(row => (Number(row.done) - Number(task.done) || row.id - task.id) > 0)
    const tasks = at < 0 ? [...others, task] : [...others.slice(0, at), task, ...others.slice(at)]
    return { item: parent, tasks: tasks.slice(0, TASK_CAP), moreTasks: details.moreTasks + Math.max(0, tasks.length - TASK_CAP) }
  })
}

export function noticed(state: PanelState, section: Section, notice: Notice | null): PanelState {
  const notices = { ...state.notices }
  if (notice) notices[section] = notice
  else delete notices[section]
  return { ...state, notices }
}

export function busyWith(state: PanelState, key: string, on: boolean): PanelState {
  const busy = new Set(state.busy)
  if (on) busy.add(key)
  else busy.delete(key)
  return { ...state, busy }
}

export type DraftField = 'comment' | 'task'

export interface Drafts {
  get(id: number, field: DraftField): string
  set(id: number, field: DraftField, text: string): void
  clear(id: number, field: DraftField): void
}

export function createDrafts(): Drafts {
  const drafts = new Map<string, string>()
  const key = (id: number, field: DraftField) => `${id}:${field}`
  return {
    get: (id, field) => drafts.get(key(id, field)) ?? '',
    set: (id, field, text) => {
      drafts.set(key(id, field), text)
    },
    clear: (id, field) => {
      drafts.delete(key(id, field))
    },
  }
}
