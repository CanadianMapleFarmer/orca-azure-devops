import type { DetailTask } from '../shared/work'
import { NO_CHILDREN, NO_TASKS, SAVING, TASKS_UNREAD, UNASSIGNED, doneLabel, moreTasks, tasksDone } from './copy'
import { openIcon } from './icons'
import { initials } from './layout'
import { linkTo } from './links'
import { el } from './render'

export interface TaskListInput {
  tasks: DetailTask[]
  more: number
  tasksRead: boolean
  taskTypes: string[]
  taskType: string | null
  busy: ReadonlySet<string>
  itemUrl: string
}

export interface TaskListHandlers {
  toggle(task: DetailTask): void
  open(url: string): void
}

export function toggleTarget(task: DetailTask): string | null {
  return task.done ? task.openState : task.doneState
}

export function tickable(task: DetailTask, taskTypes: readonly string[], taskType: string | null): boolean {
  return taskType !== null && taskTypes.includes(task.type) && toggleTarget(task) !== null
}

export function taskSummary(tasks: DetailTask[], more: number): { done: number; total: number; percent: number; text: string } {
  const total = tasks.length + more
  const done = tasks.filter(task => task.done).length
  return { done, total, percent: total === 0 ? 0 : Math.round((100 * done) / total), text: tasksDone(done, total) }
}

export function taskList(input: TaskListInput, handlers: TaskListHandlers): HTMLElement {
  const node = el('div')
  if (!input.tasksRead) {
    node.append(el('p', 'empty', TASKS_UNREAD))
    return node
  }
  if (input.tasks.length === 0 && input.more === 0) {
    node.append(el('p', 'empty', input.taskType !== null ? NO_TASKS : NO_CHILDREN))
    return node
  }
  const list = el('ul', 'tasks')
  for (const task of input.tasks) {
    list.append(tickable(task, input.taskTypes, input.taskType) ? taskRow(task, input, handlers) : childRow(task, input.taskType, handlers.open))
  }
  node.append(list)
  if (input.more > 0) node.append(linkTo(input.itemUrl, moreTasks(input.more), handlers.open, { className: 'more' }))
  return node
}

export function taskBox(root: Element, id: number): HTMLInputElement | null {
  const key = String(id)
  const pending = [...root.children]
  for (let node = pending.pop(); node; node = pending.pop()) {
    if ((node as HTMLElement).dataset?.task === key) return node as HTMLInputElement
    pending.push(...node.children)
  }
  return null
}

export function who(name: string | null): HTMLElement {
  const node = el('span', 'who', name ? initials(name) : '–')
  node.title = name ?? UNASSIGNED
  return node
}

function taskRow(task: DetailTask, input: TaskListInput, handlers: TaskListHandlers): HTMLElement {
  const busy = input.busy.has(`task:${task.id}`)
  const row = el('li', ['task', task.done ? 'done' : '', busy ? 'busy' : ''].filter(Boolean).join(' '))
  if (busy) row.setAttribute('aria-busy', 'true')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = busy ? !task.done : task.done
  box.disabled = busy
  box.dataset.task = String(task.id)
  box.setAttribute('aria-label', doneLabel(task.title))
  box.addEventListener('change', () => handlers.toggle(task))
  row.append(box, titleOf(task, input.taskType), who(task.assignedTo), el('span', 'state', busy ? SAVING : task.state), rowLink(task, handlers.open))
  return row
}

function childRow(task: DetailTask, taskType: string | null, open: (url: string) => void): HTMLElement {
  const row = el('li', task.done ? 'task read-only done' : 'task read-only')
  row.append(titleOf(task, taskType), who(task.assignedTo), el('span', 'badge', task.state), rowLink(task, open))
  return row
}

function titleOf(task: DetailTask, taskType: string | null): HTMLElement {
  const title = el('span', 'task-title')
  if (task.type !== taskType) title.append(el('span', 'type', task.type))
  title.append(task.title)
  return title
}

function rowLink(task: DetailTask, open: (url: string) => void): HTMLElement {
  return openIcon(task.url, `Open ${task.id} in Azure DevOps`, open)
}
