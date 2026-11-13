import { checkChip, type CheckChip } from '../shared/checks'
import type { Assignee, DetailPr, DetailTask, WorkComment, WorkItemDetails, WorkItemSummary, WorkspaceRef } from '../shared/work'
import { moveTargets, movesByColumn } from '../shared/work-moves'
import { ageText } from './age'
import { createAssigneePicker, type AssigneePicker } from './assignee-picker'
import {
  ADD_TASK,
  CHILDREN,
  DETAILS_FAILED,
  LOADING_DETAILS,
  NEWEST_COMMENTS,
  NO_ACCEPTANCE,
  NO_COMMENTS,
  NO_DESCRIPTION,
  NO_PRS,
  NOT_SHOWN,
  OFF_BOARD,
  READ_JUST_NOW,
  REFRESHING,
  TASK_PLACEHOLDER,
  UNASSIGNED,
  into,
  readAge,
} from './copy'
import { COMMENT_CAP, shownItem, type DraftField, type Drafts, type Load, type Notice, type PanelState, type Section } from './details-state'
import { icon, openIcon, type IconName } from './icons'
import { linkTo } from './links'
import { button, el } from './render'
import { renderRich } from './rich-text'
import { startControl, startSection, type StartState } from './start'
import { taskBox, taskList, taskSummary, who } from './task-list'

type Part = 'description' | 'acceptance' | 'children' | 'prs' | 'comments'

export interface PanelSkeleton {
  node: HTMLElement
  title: HTMLElement
  scroller: HTMLElement
  sections: Record<'head' | 'fields' | Part | 'foot', HTMLElement>
  folds: Record<Part, { head: HTMLElement; body: HTMLElement }>
  slots: Record<'meta' | 'body' | 'notice', Record<string, HTMLElement>>
  controls: PanelControls
}

export interface PanelControls {
  move: HTMLSelectElement
  assignee: HTMLButtonElement
  picker: AssigneePicker
  comment: HTMLTextAreaElement
  send: HTMLButtonElement
  hint: HTMLElement
  task: HTMLInputElement
  add: HTMLButtonElement
  taskForm: HTMLElement
}

export interface ViewContext { card: WorkItemSummary | null; now: number; locale: string; closed: ReadonlySet<string>; drafts: Drafts; start: StartState }

export interface PanelHandlers {
  close(): void
  refresh(): void
  retry(): void
  open(url: string): void
  toggle(section: string): void
  move(value: string): void
  choose(): void
  assign(person: Assignee | null): void
  assignees(): Promise<{ me: Assignee | null; members: Assignee[] }>
  people(query: string): Promise<Assignee[]>
  pickerClosed(): void
  draft(field: DraftField, text: string): void
  send(): void
  toggleTask(task: DetailTask): void
  addTask(): void
  startWork(): void
  startAgent(): void
  showWorkspace(workspace: WorkspaceRef): void
  changeRepo(): void
  chooseRepo(value: string): void
  chooseProject(projectId: string): void
  chooseCloneRepo(repoId: string): void
}

const OPEN_IN_ADO = 'Open in Azure DevOps'
const TASKS = 'Tasks'
const COMMENTS = 'Comments'
const MERGED = 'merged'
const ABANDONED = 'abandoned'
const ADD_COMMENT = 'Add a comment'
const ASSIGNED_NAME = 'panel-assigned-name'
const READ_FRESH_MS = 60_000
const SKELETON_WIDTHS = ['46%', '72%', '88%', '64%', '80%']
const PARTS: Part[] = ['description', 'acceptance', 'children', 'prs', 'comments']
const NOTICES: Section[] = ['fields', 'tasks', 'comments']

const filled = new WeakMap<HTMLElement, string>()
const startKeys = new WeakMap<StartState, number>()
let startSerial = 0
const commentAges = new WeakMap<HTMLElement, CommentAge[]>()

interface CommentAge { node: HTMLElement; at: number }

export function fill(slot: HTMLElement, key: string, build: () => (Node | string)[]): void {
  if (filled.get(slot) === key) return
  slot.replaceChildren(...built(build))
  filled.set(slot, key)
}

function built(build: () => (Node | string)[]): (Node | string)[] {
  try {
    return build()
  } catch {
    return [el('p', 'empty', NOT_SHOWN)]
  }
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

function iconButton(label: string, name: IconName, onClick: () => void): HTMLButtonElement {
  const node = button('', onClick, 'icon-button')
  node.setAttribute('aria-label', label)
  node.title = label
  node.append(icon(name))
  return node
}

function fold(name: Part, label: Node | string, toggle: (section: string) => void) {
  const section = el('section', 'section')
  const head = button('', () => toggle(name), 'section-head')
  head.id = `panel-${name}-head`
  head.setAttribute('aria-expanded', 'true')
  head.append(icon('chevron'), label)
  section.setAttribute('aria-labelledby', head.id)
  const body = el('div', 'section-body')
  section.append(head, body)
  return { section, head, body }
}

export function panelSkeleton(handlers: PanelHandlers): PanelSkeleton {
  const node = el('aside', 'panel')
  node.id = 'item-panel'
  node.setAttribute('aria-labelledby', 'panel-title')
  node.hidden = true

  const kicker = el('span')
  const openSlot = el('div', 'slot')
  const kickerRow = el('div', 'panel-kicker')
  kickerRow.append(kicker, iconButton('Refresh', 'refresh', () => handlers.refresh()), openSlot, iconButton('Close', 'close', () => handlers.close()))
  const title = el('h2', 'panel-title')
  title.id = 'panel-title'
  title.setAttribute('tabindex', '-1')
  const read = el('div', 'panel-meta')
  const head = el('div', 'panel-head')
  head.append(kickerRow, title, read)

  const moveLabel = el('span', '', 'Column')
  moveLabel.id = 'panel-move-label'
  const move = el('select')
  move.setAttribute('aria-labelledby', moveLabel.id)
  move.addEventListener('change', () => handlers.move(move.value))
  const moveValue = el('div', 'field-value')
  moveValue.append(move)
  const assignedLabel = el('span', '', 'Assigned to')
  assignedLabel.id = 'panel-assigned-label'
  const assignee = button('', () => handlers.choose(), 'assignee')
  assignee.setAttribute('aria-haspopup', 'listbox')
  assignee.setAttribute('aria-labelledby', `${assignedLabel.id} ${ASSIGNED_NAME}`)
  const picker = createAssigneePicker({
    pick: person => handlers.assign(person),
    load: () => handlers.assignees(),
    search: query => handlers.people(query),
    closed: () => handlers.pickerClosed(),
  })
  const anchor = el('div', 'anchor')
  anchor.append(assignee, picker.node)
  const assignedValue = el('div', 'field-value assigned')
  assignedValue.append(anchor)
  const parentLabel = el('span', '', 'Parent')
  const parentValue = el('span')
  const fieldsNotice = el('div', 'notice-slot')
  const fields = el('div', 'fields')
  fields.append(moveLabel, moveValue, assignedLabel, assignedValue, parentLabel, parentValue, fieldsNotice)

  const toggle = (section: string) => handlers.toggle(section)
  const childrenLabel = el('span', 'slot')
  const commentsLabel = el('span', 'slot')
  const folds = {
    description: fold('description', 'Description', toggle),
    acceptance: fold('acceptance', 'Acceptance criteria', toggle),
    children: fold('children', childrenLabel, toggle),
    prs: fold('prs', 'Pull requests', toggle),
    comments: fold('comments', commentsLabel, toggle),
  }
  const description = el('div', 'rich')
  const acceptance = el('div', 'rich')
  const children = el('div')
  const task = el('input')
  task.setAttribute('aria-label', ADD_TASK)
  task.placeholder = TASK_PLACEHOLDER
  task.addEventListener('input', () => handlers.draft('task', task.value))
  task.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    handlers.addTask()
  })
  const add = button('Add', () => handlers.addTask(), 'button secondary')
  const taskForm = el('div', 'add-task')
  taskForm.append(task, add)
  const addSlot = el('div', 'slot')
  const tasksNotice = el('div', 'notice-slot')
  const prs = el('div')
  const comments = el('div')
  const commentsNotice = el('div', 'notice-slot')
  folds.description.body.append(description)
  folds.acceptance.body.append(acceptance)
  folds.children.body.append(children, addSlot, tasksNotice)
  folds.prs.body.append(prs)
  const comment = el('textarea')
  comment.setAttribute('aria-label', ADD_COMMENT)
  comment.placeholder = ADD_COMMENT
  comment.addEventListener('input', () => handlers.draft('comment', comment.value))
  const send = button('Comment', () => handlers.send())
  const hint = el('span', 'muted hint')
  const sendRow = el('div', 'row')
  sendRow.append(send, hint)
  const composer = el('div', 'composer')
  composer.append(comment, sendRow)
  folds.comments.body.append(composer, commentsNotice, comments)

  const offBoard = el('p', 'muted off-board', OFF_BOARD)
  const status = el('div')
  const content = el('div')
  content.append(offBoard, fields, ...PARTS.map(name => folds[name].section))
  const scroller = el('div', 'panel-scroll')
  scroller.append(status, content)

  const footLink = el('div', 'slot')
  const foot = el('footer', 'panel-foot')
  foot.append(footLink)
  node.append(head, scroller, foot)

  return {
    node,
    title,
    scroller,
    sections: {
      head,
      fields,
      description: folds.description.section,
      acceptance: folds.acceptance.section,
      children: folds.children.section,
      prs: folds.prs.section,
      comments: folds.comments.section,
      foot,
    },
    folds: {
      description: folds.description,
      acceptance: folds.acceptance,
      children: folds.children,
      prs: folds.prs,
      comments: folds.comments,
    },
    slots: {
      meta: { kicker, read, move: moveLabel, parent: parentLabel, children: childrenLabel, comments: commentsLabel },
      body: { open: openSlot, status, content, move: moveValue, assigned: assignedValue, parent: parentValue, description, acceptance, children, add: addSlot, prs, comments, foot: footLink },
      notice: { board: offBoard, fields: fieldsNotice, tasks: tasksNotice, comments: commentsNotice },
    },
    controls: { move, assignee, picker, comment, send, hint, task, add, taskForm },
  }
}

export function paintPanel(skeleton: PanelSkeleton, state: PanelState, context: ViewContext, handlers: PanelHandlers): void {
  const { slots } = skeleton
  const open = (url: string) => handlers.open(url)
  const item = shownItem(state, context.card)
  const load = state.load
  const ready = load.status === 'ready'

  setText(slots.meta.kicker, item ? `${item.type} ${item.id}` : String(state.id))
  setText(skeleton.title, item?.title ?? '')
  fill(slots.body.open, item?.url ?? '', () => (item ? [openIcon(item.url, OPEN_IN_ADO, open)] : []))
  setText(slots.meta.read, readLine(load, context))
  slots.meta.read.hidden = load.status === 'failed'
  fill(slots.body.status, load.status === 'failed' ? `failed:${load.message}` : load.status, () => statusParts(load, () => handlers.retry()))
  slots.body.content.hidden = !ready
  skeleton.sections.foot.hidden = !ready
  if (load.status !== 'ready' || !item) return

  slots.notice.board.hidden = !state.offBoard
  paintFields(skeleton, state, item)
  paintComposer(skeleton.controls, state, context.drafts.get(state.id, 'comment'))
  paintTaskForm(skeleton, state, load.details.taskType !== null, context.drafts.get(state.id, 'task'))
  for (const section of NOTICES) paintNotice(slots.notice[section], state.notices[section])
  for (const name of PARTS) {
    const closed = context.closed.has(name)
    skeleton.folds[name].head.setAttribute('aria-expanded', String(!closed))
    skeleton.folds[name].body.hidden = closed
  }
  paintDetails(slots, state, load.details, context, handlers)
  paintFoot(slots.body.foot, context.start, item.url, state.busy.size > 0, handlers)
}

function paintFoot(slot: HTMLElement, start: StartState, url: string, writing: boolean, handlers: PanelHandlers): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.start
  const actions = {
    startWork: () => handlers.startWork(),
    startAgent: () => handlers.startAgent(),
    show: (workspace: WorkspaceRef) => handlers.showWorkspace(workspace),
    changeRepo: () => handlers.changeRepo(),
    chooseRepo: (value: string) => handlers.chooseRepo(value),
    chooseProject: (projectId: string) => handlers.chooseProject(projectId),
    chooseCloneRepo: (repoId: string) => handlers.chooseCloneRepo(repoId),
    open: (link: string) => handlers.open(link),
  }
  fill(slot, JSON.stringify([url, startKey(start), writing]), () => [startSection(start, url, actions, writing)])
  const control = focused === undefined ? null : (startControl(slot, focused) ?? (focused === 'change' ? startControl(slot, 'repo') : null))
  if (control && control !== document.activeElement) control.focus()
}

function startKey(start: StartState): number {
  const known = startKeys.get(start)
  if (known !== undefined) return known
  startKeys.set(start, ++startSerial)
  return startSerial
}

function readLine(load: Load, context: ViewContext): string {
  if (load.status === 'loading') return LOADING_DETAILS
  if (load.status === 'failed') return ''
  if (load.refreshing) return REFRESHING
  const { readAt } = load.details
  return context.now - readAt < READ_FRESH_MS ? READ_JUST_NOW : readAge(ageText(readAt, context.now, context.locale))
}

function statusParts(load: Load, retry: () => void): HTMLElement[] {
  if (load.status === 'loading') {
    const lines = el('div', 'skeleton')
    lines.setAttribute('aria-busy', 'true')
    lines.append(el('span', 'visually-hidden', LOADING_DETAILS))
    for (const width of SKELETON_WIDTHS) {
      const line = el('i')
      line.style.width = width
      lines.append(line)
    }
    return [lines]
  }
  if (load.status === 'failed') {
    const alert = el('div', 'notice danger')
    alert.setAttribute('role', 'alert')
    alert.append(el('div', '', `${DETAILS_FAILED} ${load.message}`), button('Try again', retry, 'button secondary'))
    return [alert]
  }
  return []
}

export function placeOf(item: WorkItemSummary): string {
  return (movesByColumn(item) ? item.column : item.state) ?? ''
}

function paintFields(skeleton: PanelSkeleton, state: PanelState, item: WorkItemSummary): void {
  const { slots, controls } = skeleton
  setText(slots.meta.move, movesByColumn(item) ? 'Column' : 'State')
  paintMove(controls.move, state, item)
  fill(controls.assignee, item.assignedTo ?? '', () => assigneeParts(item.assignedTo))
  controls.assignee.disabled = state.busy.has('assign')
  const parent = item.parentId === null ? '' : `#${item.parentId} ${item.parentTitle ?? ''}`.trim()
  setText(slots.body.parent, parent)
  slots.meta.parent.hidden = parent === ''
  slots.body.parent.hidden = parent === ''
}

function paintMove(select: HTMLSelectElement, state: PanelState, item: WorkItemSummary): void {
  const place = placeOf(item)
  const targets = moveTargets(item)
  if (document.activeElement !== select) {
    fill(select, JSON.stringify([place, item.state, targets]), () => [new Option(place || item.state, place), ...targets.map(value => new Option(value, value))])
    if (select.value !== place) select.value = place
  }
  select.disabled = state.busy.has('move') || state.offBoard || targets.length === 0
}

function assigneeParts(name: string | null): Node[] {
  const label = el('span', '', name ?? UNASSIGNED)
  label.id = ASSIGNED_NAME
  return [...(name ? [who(name)] : []), label, icon('chevron')]
}

function paintComposer(controls: PanelControls, state: PanelState, draft: string): void {
  const sending = state.busy.has('comment')
  if (document.activeElement !== controls.comment && controls.comment.value !== draft) controls.comment.value = draft
  controls.comment.readOnly = sending
  controls.send.disabled = sending || draft.trim() === ''
}

function paintTaskForm(skeleton: PanelSkeleton, state: PanelState, shown: boolean, draft: string): void {
  const { controls } = skeleton
  const adding = state.busy.has('task:new')
  fill(skeleton.slots.body.add, String(shown), () => (shown ? [controls.taskForm] : []))
  if (document.activeElement !== controls.task && controls.task.value !== draft) controls.task.value = draft
  controls.task.readOnly = adding
  controls.add.disabled = adding || draft.trim() === ''
}

function paintNotice(slot: HTMLElement, notice: Notice | undefined): void {
  fill(slot, notice ? `${notice.tone}:${notice.text}` : '', () => {
    if (!notice) return []
    const node = el('div', `notice ${notice.tone}`, notice.text)
    node.setAttribute('role', notice.tone === 'danger' ? 'alert' : 'status')
    return [node]
  })
  slot.hidden = !notice
}

function paintDetails(slots: PanelSkeleton['slots'], state: PanelState, details: WorkItemDetails, context: ViewContext, handlers: PanelHandlers): void {
  const open = (url: string) => handlers.open(url)
  fill(slots.body.description, details.descriptionMd, () => rich(details.descriptionMd, NO_DESCRIPTION, open))
  fill(slots.body.acceptance, details.acceptanceMd, () => rich(details.acceptanceMd, NO_ACCEPTANCE, open))
  paintChildren(slots, state, details, handlers)

  fill(slots.body.prs, JSON.stringify(details.prs), () => prRows(details.prs, open))

  fill(slots.meta.comments, String(details.comments.length), () => [COMMENTS, ...count(details.comments.length)])
  paintComments(slots.body.comments, details.comments, context, open)
}

function paintComments(slot: HTMLElement, comments: WorkComment[], context: ViewContext, open: (url: string) => void): void {
  fill(slot, JSON.stringify(comments), () => {
    const list = commentList(comments, open)
    commentAges.set(slot, list.ages)
    return list.nodes
  })
  for (const { node, at } of commentAges.get(slot) ?? []) setText(node, ` · ${ageText(at, context.now, context.locale)}`)
}

function paintChildren(slots: PanelSkeleton['slots'], state: PanelState, details: WorkItemDetails, handlers: PanelHandlers): void {
  const { tasks, moreTasks: more, tasksRead, taskTypes, taskType } = details
  const total = tasksRead ? tasks.length + more : 0
  if (taskType !== null) {
    const summary = taskSummary(tasks, more)
    fill(slots.meta.children, `${TASKS}:${total}:${summary.done}`, () => [TASKS, ...(total > 0 ? progress(summary) : [])])
  } else {
    fill(slots.meta.children, `${CHILDREN}:${total}`, () => [CHILDREN, ...count(total)])
  }
  const busy = new Set([...state.busy].filter(key => key.startsWith('task:') && key !== 'task:new'))
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.task
  const input = { tasks, more, tasksRead, taskTypes, taskType, busy, itemUrl: details.item.url }
  fill(slots.body.children, JSON.stringify({ ...input, busy: [...busy] }), () => [taskList(input, { toggle: task => handlers.toggleTask(task), open: url => handlers.open(url) })])
  const box = focused === undefined ? null : taskBox(slots.body.children, Number(focused))
  if (box && box !== document.activeElement) box.focus()
}

function progress(summary: { percent: number; text: string }): HTMLElement[] {
  const bar = el('span', 'progress')
  bar.setAttribute('aria-hidden', 'true')
  const fillBar = el('i')
  fillBar.style.width = `${summary.percent}%`
  bar.append(fillBar)
  return [el('span', 'count', summary.text), bar]
}

function count(total: number): HTMLElement[] {
  return total > 0 ? [el('span', 'count', `(${total})`)] : []
}

function rich(markdown: string, empty: string, open: (url: string) => void): Node[] {
  return markdown.trim() === '' ? [el('p', 'empty', empty)] : [renderRich(markdown, open)]
}

function prChip(pr: DetailPr): CheckChip | null {
  if (pr.state === 'merged') return { tone: 'success', text: MERGED }
  if (pr.state === 'abandoned') return { tone: 'neutral', text: ABANDONED }
  if (pr.state !== 'open') return null
  return checkChip({ build: pr.build ?? 'none', policies: pr.policies ?? 'none' })
}

function prRows(prs: DetailPr[], open: (url: string) => void): HTMLElement[] {
  if (prs.length === 0) return [el('p', 'empty', NO_PRS)]
  const list = el('ul', 'prs')
  for (const pr of prs) {
    const row = el('li')
    row.append(prRow(pr, open))
    list.append(row)
  }
  return [list]
}

function prRow(pr: DetailPr, open: (url: string) => void): HTMLElement {
  const known = pr.state !== null
  const title = known ? pr.title : null
  const target = known ? pr.target : null
  const chip = prChip(pr)
  const name = `Pull request ${pr.prId}`
  const parts: Node[] = []
  if (title !== null) parts.push(el('span', 'pr-id', `!${pr.prId}`))
  const heading = el('span', 'pr-title', title ?? name)
  if (target) heading.append(el('span', 'target', into(target)))
  parts.push(heading)
  if (chip) {
    const chips = el('span', 'chips')
    chips.append(el('span', `chip ${chip.tone}`, chip.text))
    parts.push(chips)
  }
  const label = [title === null ? name : `${name}: ${title}`, target ? into(target) : null, chip?.text ?? null].filter(part => part !== null).join(', ')
  return linkTo(pr.url, parts, open, { className: 'pr', ariaLabel: label })
}

function commentList(comments: WorkComment[], open: (url: string) => void): { nodes: HTMLElement[]; ages: CommentAge[] } {
  if (comments.length === 0) return { nodes: [el('p', 'empty', NO_COMMENTS)], ages: [] }
  const ages = comments.map(entry => ({ node: el('span'), at: entry.createdAt }))
  const nodes = comments.map((entry, index) => {
    const article = el('article', 'comment')
    const by = el('div', 'by')
    by.append(el('strong', '', entry.author), ages[index].node)
    const body = el('div', 'rich')
    body.append(renderRich(entry.textMd, open))
    article.append(by, body)
    return article
  })
  if (comments.length >= COMMENT_CAP) nodes.push(el('p', 'muted', NEWEST_COMMENTS))
  return { nodes, ages }
}
