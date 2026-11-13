import { messageOf } from '../shared/messages'
import { recordOwn, withOwn, type OwnComments } from '../shared/own-comments'
import type { Assignee, DetailTask, MoveTarget, WorkComment, WorkItemDetails, WorkItemSummary } from '../shared/work'
import { moveTo } from '../shared/work-moves'
import { SEND_HINT, SEND_HINT_MAC } from './copy'
import {
  busyWith,
  COMMENT_CAP,
  failed,
  loaded,
  needsReread,
  noticed,
  onBoard,
  opened,
  refreshing,
  shownItem,
  withAssignee,
  withComment,
  withItem,
  withNewTask,
  withTaskRow,
  type Drafts,
  type Notice,
  type PanelState,
  type Section,
} from './details-state'
import { paintPanel, panelSkeleton, placeOf, type PanelHandlers } from './panel-view'
import { createStart, type ItemEvent, type Start, type StartRequests } from './start'
import { taskBox, toggleTarget } from './task-list'

export interface PanelHost {
  org: string
  boardRef(): { teamId: string; boardId: string } | null
  projectId(): string | null
  item(id: number): WorkItemSummary | null
  move(id: number, to: MoveTarget): Promise<WorkItemSummary>
  replace(item: WorkItemSummary): void
  focusCard(id: number): boolean
  focusBoard(): void
  openExternal(url: string): Promise<string | null>
  showing(id: number | null): void
  narrow(): boolean
}

export interface PanelApi extends StartRequests {
  details(input: { org: string; id: number; board?: { teamId: string; boardId: string }; fresh?: boolean }): Promise<WorkItemDetails>
  comment(input: { org: string; id: number; text: string }): Promise<WorkComment>
  assign(input: { org: string; id: number; rev: number; to: Assignee | null; board?: { teamId: string; boardId: string } }): Promise<WorkItemSummary>
  assignees(input: { org: string; projectId: string; teamId: string }): Promise<{ me: Assignee | null; members: Assignee[] }>
  people(input: { org: string; query: string }): Promise<Assignee[]>
  moveTask(input: { org: string; id: number; rev: number; state: string; board?: { teamId: string; boardId: string } }): Promise<WorkItemSummary>
  addTask(input: { org: string; parentId: number; title: string; board?: { teamId: string; boardId: string } }): Promise<{ task: DetailTask; parent: WorkItemSummary }>
}

export interface Panel {
  node: HTMLElement
  open(id: number, how: 'pointer' | 'keyboard'): void
  close(): void
  isOpen(): boolean
  openId(): number | null
  boardChanged(): void
  workspaceReady(event: ItemEvent & { workspaceId: string; branch: string }): void
  agentWorking(event: ItemEvent): void
  dispose(): void
}

export interface PanelDeps {
  now: () => number
  locale: () => string
  drafts: Drafts
  timers: Pick<typeof globalThis, 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'>
  platform: () => string
}

interface Write<T> {
  section: Section
  key: string
  control(): HTMLElement | null
  send(): Promise<T>
  done(value: T): void
  undo?(): void
}

const AGE_REPAINT_MS = 60_000

export function createPanel(host: PanelHost, api: PanelApi, deps: PanelDeps): Panel {
  let state: PanelState | null = null
  let seq = 0
  let chased = 0
  let aging: ReturnType<typeof setInterval> | null = null
  let start: Start | null = null
  let ownComments: OwnComments = {}
  const closed = new Set<string>()
  const writing = new Map<number, Set<string>>()
  const unseen = new Map<number, Partial<Record<Section, Notice>>>()
  const handlers: PanelHandlers = {
    close: () => close(),
    refresh: () => void read(true),
    retry: () => void read(false),
    open: url => openLink(url),
    toggle: section => {
      if (!closed.delete(section)) closed.add(section)
      paint()
    },
    move: value => move(value),
    choose: () => {
      if (state?.load.status === 'ready') skeleton.controls.picker.open(state.load.details.assignee)
    },
    assign: person => assign(person),
    assignees: () => assignees(),
    people: query => api.people({ org: host.org, query }),
    pickerClosed: () => skeleton.controls.assignee.focus(),
    draft: (field, text) => {
      if (!state) return
      deps.drafts.set(state.id, field, text)
      paint()
    },
    send: () => send(),
    toggleTask: task => toggleTask(task),
    addTask: () => addTask(),
    startWork: () => void start?.startWork(),
    startAgent: () => void start?.startAgent(),
    showWorkspace: workspace => void start?.show(workspace),
    changeRepo: () => start?.changeRepo(),
    chooseRepo: value => start?.chooseRepo(value),
    chooseProject: projectId => start?.chooseProject(projectId),
    chooseCloneRepo: repoId => start?.chooseCloneRepo(repoId),
  }
  const skeleton = panelSkeleton(handlers)
  const mac = deps.platform().includes('Mac')
  skeleton.controls.hint.textContent = mac ? SEND_HINT_MAC : SEND_HINT
  skeleton.node.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state) return
    event.preventDefault()
    close()
  })
  skeleton.controls.comment.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(mac ? event.metaKey : event.ctrlKey)) return
    event.preventDefault()
    send()
  })

  function paint(): void {
    if (state && start) paintPanel(skeleton, state, { card: host.item(state.id), now: deps.now(), locale: deps.locale(), closed, drafts: deps.drafts, start: start.state() }, handlers)
  }

  function stopStart(): void {
    start?.dispose()
    start = null
  }

  function shown(): WorkItemSummary | null {
    return state ? shownItem(state, host.item(state.id)) : null
  }

  function track(id: number, key: string, on: boolean): void {
    const keys = writing.get(id) ?? new Set<string>()
    if (on) keys.add(key)
    else keys.delete(key)
    if (keys.size > 0) writing.set(id, keys)
    else writing.delete(id)
  }

  function resumed(id: number): PanelState {
    const notices = unseen.get(id) ?? {}
    unseen.delete(id)
    return { ...opened(id, ++seq), busy: new Set(writing.get(id)), notices }
  }

  async function write<T>(job: Write<T>): Promise<void> {
    if (!state || state.busy.has(job.key)) return
    const { id } = state
    state = busyWith(noticed(state, job.section, null), job.key, true)
    track(id, job.key, true)
    paint()
    const outcome = await job.send().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    track(id, job.key, false)
    const notice: Notice | null = outcome.ok ? null : { tone: 'danger', text: messageOf(outcome.error) }
    if (state?.id !== id) {
      if (notice) unseen.set(id, { ...unseen.get(id), [job.section]: notice })
      return
    }
    state = busyWith(state, job.key, false)
    if (outcome.ok) {
      job.done(outcome.value)
      paint()
    } else {
      state = noticed(state, job.section, notice)
      job.undo?.()
      void read(false)
    }
    const active = document.activeElement
    if (!active || active === document.body) job.control()?.focus()
  }

  function move(value: string): void {
    const item = shown()
    if (!state || !item || value === '') return
    const { id } = state
    const select = skeleton.controls.move
    void write({
      section: 'fields',
      key: 'move',
      control: () => select,
      send: () => host.move(id, moveTo(item, value)),
      done: moved => {
        if (state) state = withItem(state, moved)
      },
      undo: () => {
        select.value = placeOf(shown() ?? item)
      },
    })
  }

  function assign(person: Assignee | null): void {
    const item = shown()
    if (!state || !item) return
    const { id } = state
    const board = host.boardRef()
    skeleton.controls.assignee.focus()
    void write({
      section: 'fields',
      key: 'assign',
      control: () => skeleton.controls.assignee,
      send: () => api.assign({ org: host.org, id, rev: item.rev, to: person, ...(board ? { board } : {}) }),
      done: summary => {
        if (state) state = withAssignee(state, summary, person)
        host.replace(summary)
      },
    })
  }

  function assignees(): Promise<{ me: Assignee | null; members: Assignee[] }> {
    const projectId = host.projectId()
    const board = host.boardRef()
    if (!projectId || !board) return Promise.resolve({ me: null, members: [] })
    return api.assignees({ org: host.org, projectId, teamId: board.teamId })
  }

  function send(): void {
    if (!state) return
    const { id } = state
    const text = deps.drafts.get(id, 'comment').trim()
    if (text === '') return
    void write({
      section: 'comments',
      key: 'comment',
      control: () => skeleton.controls.comment,
      send: async () => {
        const posted = await api.comment({ org: host.org, id, text })
        ownComments = recordOwn(ownComments, String(id), posted, deps.now())
        deps.drafts.clear(id, 'comment')
        return posted
      },
      done: posted => {
        if (state) state = withComment(state, posted)
        skeleton.controls.comment.value = ''
      },
    })
  }

  function toggleTask(task: DetailTask): void {
    const to = toggleTarget(task)
    if (!state || to === null) return
    const board = host.boardRef()
    void write({
      section: 'tasks',
      key: `task:${task.id}`,
      control: () => taskBox(skeleton.slots.body.children, task.id),
      send: () => api.moveTask({ org: host.org, id: task.id, rev: task.rev, state: to, ...(board ? { board } : {}) }),
      done: summary => {
        if (state) state = withTaskRow(state, task.id, summary, !task.done)
      },
    })
  }

  function addTask(): void {
    if (!state) return
    const { id } = state
    const title = deps.drafts.get(id, 'task').trim()
    if (title === '') return
    const board = host.boardRef()
    void write({
      section: 'tasks',
      key: 'task:new',
      control: () => skeleton.controls.task,
      send: async () => {
        const added = await api.addTask({ org: host.org, parentId: id, title, ...(board ? { board } : {}) })
        deps.drafts.clear(id, 'task')
        return added
      },
      done: ({ task, parent }) => {
        if (state) state = withNewTask(state, task, parent)
        skeleton.controls.task.value = ''
        host.replace(parent)
      },
    })
  }

  async function read(fresh: boolean): Promise<void> {
    if (!state) return
    const mine = ++seq
    state = refreshing(state, mine)
    paint()
    const board = host.boardRef()
    const input = { org: host.org, id: state.id, ...(board ? { board } : {}), ...(fresh ? { fresh } : {}) }
    try {
      const details = await api.details(input)
      if (state) state = loaded(state, mine, { ...details, comments: withOwn(ownComments, String(input.id), details.comments, deps.now()).slice(0, COMMENT_CAP) })
    } catch (error) {
      if (state) state = failed(state, mine, messageOf(error))
    }
    if (state?.seq !== mine) return
    paint()
    chase()
  }

  function chase(): void {
    if (!state) return
    const card = host.item(state.id)
    if (!card || !needsReread(state, card) || card.rev <= chased) return
    chased = card.rev
    void read(false)
  }

  function openLink(url: string): void {
    const id = state?.id
    void host.openExternal(url).then(message => {
      if (!message || !state || state.id !== id) return
      state = noticed(state, 'fields', { tone: 'danger', text: message })
      paint()
    })
  }

  function stopAging(): void {
    if (aging === null) return
    deps.timers.clearInterval(aging)
    aging = null
  }

  function open(id: number, how: 'pointer' | 'keyboard'): void {
    if (state?.id === id) return
    skeleton.controls.picker.close()
    stopStart()
    state = resumed(id)
    start = createStart({ org: host.org, itemId: id, board: host.boardRef(), requests: api, timers: deps.timers, changed: paint })
    chased = 0
    skeleton.node.hidden = false
    skeleton.scroller.scrollTop = 0
    aging ??= deps.timers.setInterval(paint, AGE_REPAINT_MS)
    host.showing(id)
    paint()
    if (how === 'keyboard' || host.narrow()) skeleton.title.focus()
    void read(false)
  }

  function close(): void {
    if (!state) return
    const { id } = state
    skeleton.controls.picker.close()
    stopStart()
    state = null
    skeleton.node.hidden = true
    stopAging()
    host.showing(null)
    if (!host.focusCard(id)) host.focusBoard()
  }

  return {
    node: skeleton.node,
    open,
    close,
    isOpen: () => state !== null,
    openId: () => state?.id ?? null,
    boardChanged() {
      if (!state) return
      state = onBoard(state, host.item(state.id))
      paint()
      chase()
    },
    workspaceReady: event => start?.workspaceReady(event),
    agentWorking: event => start?.agentWorking(event),
    dispose() {
      stopAging()
      skeleton.controls.picker.close()
      stopStart()
      state = null
      skeleton.node.hidden = true
    },
  }
}
