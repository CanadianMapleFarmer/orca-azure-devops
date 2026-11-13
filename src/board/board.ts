import { messageOf, OPEN_LINK_UNAVAILABLE } from '../shared/messages'
import type { BoardColumn, BoardConfig, MoveTarget, WorkItemSummary } from '../shared/work'
import { NO_LINK_OPENER, OFF_BOARD } from './copy'
import { createDrafts } from './details-state'
import { moveFor } from './dnd'
import { followDocument } from './document'
import { attachDrag } from './drag'
import { layoutBoard, parentOptions, withParent, type Cell } from './layout'
import { createPanel } from './panel'
import { showPicker } from './picker'
import type { BoardRef } from './ref'
import { boardGrid, button, createCards, createToolbar, el, focusSelectorOf, noteText } from './render'
import { closePanelFirst } from './screen'

interface State {
  ref: BoardRef
  board: BoardConfig | null
  base: WorkItemSummary[]
  pending: Map<number, WorkItemSummary>
  message: string | undefined
  stale: boolean
  updatedAt: number | null
  everyone: boolean | null
  parent: number | null
  toggled: Set<string>
  banner: string | null
  notice: string | null
  failure: string | null
  loading: boolean
}

const root = document.getElementById('app') as HTMLElement
const READ_FAILED = "Couldn't read this board file."
const AGE_REPAINT_MS = 60_000
const START_WAIT = { timeoutMs: 90_000 }

const cards = createCards()
const toolbar = createToolbar({
  everyone(value) {
    if (!state || state.everyone === value) return
    state.everyone = value
    void load({ remember: true })
  },
  parent(id) {
    if (!state) return
    state.parent = id
    paint()
  }
})
const banner = el('div', 'banner')
banner.setAttribute('role', 'alert')
const note = el('p', 'note muted')
const scroller = el('main', 'board')
scroller.tabIndex = -1
scroller.setAttribute('aria-label', 'Board')
const drag = attachDrag(scroller, {
  canDrag: id => Boolean(state?.board) && !state?.pending.has(id),
  accepts: (id, cell) => moveOf(id, cell) !== null,
  drop: (id, cell) => {
    const to = cell ? moveOf(id, cell) : null
    if (to) dragMove(id, to)
  },
  pressed: id => panel.open(id, 'pointer'),
  ended: () => {
    if (deferred) paint()
  }
})

let state: State | null = null
let reported: BoardRef | null = null
let seq = 0
let deferred = false
let aging: ReturnType<typeof setInterval> | null = null
let revealed: number | null = null

const panel = createPanel(
  {
    get org() {
      return state?.ref.org ?? ''
    },
    boardRef: () => (state ? { teamId: state.ref.teamId, boardId: state.ref.boardId } : null),
    projectId: () => state?.ref.projectId ?? null,
    item: id => (state ? (state.pending.get(id) ?? state.base.find(entry => entry.id === id) ?? null) : null),
    move,
    replace,
    focusCard,
    focusBoard: () => scroller.focus(),
    openExternal,
    showing: () => {
      syncInert()
      paint()
    },
    narrow: () => narrow.matches
  },
  {
    details: input => orca.plugin.request('work.details', input),
    comment: input => orca.plugin.request('work.comment', input),
    assign: input => orca.plugin.request('work.assign', input),
    assignees: input => orca.plugin.request('work.assignees', input),
    people: async ({ org, query }) => {
      const found = await orca.plugin.request('share.people', { org, query, groups: false })
      return found.filter(person => person.uniqueName).map(({ displayName, uniqueName }) => ({ displayName, uniqueName }))
    },
    moveTask: ({ state: to, ...input }) => orca.plugin.request('work.move', { ...input, to: { state: to } }),
    addTask: input => orca.plugin.request('work.addTask', input),
    itemWorkspace: input => orca.plugin.request('work.itemWorkspace', input),
    startRepos: input => orca.plugin.request('work.startRepos', input, START_WAIT),
    cloneTargets: input => orca.plugin.request('work.cloneTargets', input, START_WAIT),
    startWork: input => orca.plugin.request('work.startWork', input, START_WAIT),
    startAgent: input => orca.plugin.request('work.startAgent', input, START_WAIT),
    openWorkspace: input => orca.plugin.request('work.openWorkspace', input)
  },
  { now: () => Date.now(), locale: () => orca.locale, drafts: createDrafts(), timers: globalThis, platform: () => navigator.platform }
)
const body = el('div', 'body')
body.append(scroller, panel.node)
const narrow = matchMedia('(max-width: 759px)')
narrow.addEventListener('change', syncInert)
scroller.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const card = (event.target as Element).closest<HTMLElement>('.card')
  if (!card) return
  event.preventDefault()
  panel.open(Number(card.dataset.id), 'keyboard')
})

function moveOf(id: number, cell: Cell) {
  const item = state?.base.find(entry => entry.id === id)
  return state?.board && item ? moveFor(item, cell, state.board) : null
}

function paint(): void {
  keepAging(Boolean(state?.stale && state.updatedAt !== null))
  deferred = drag.dragging()
  if (!state || deferred) return
  const current = state
  const all = current.base.map(item => current.pending.get(item.id) ?? item)
  const parents = parentOptions(all)
  if (current.parent !== null && !parents.some(option => option.id === current.parent)) current.parent = null
  toolbar.update({ title: current.board?.boardName ?? 'Azure DevOps board', loading: current.loading, everyone: current.everyone, parents, parent: current.parent })
  banner.replaceChildren()
  banner.hidden = current.banner === null
  if (current.banner) banner.append(el('span', '', current.banner), button('Dismiss', () => dismissBanner(), 'button secondary'))
  const items = withParent(all, current.parent)
  const empty = Boolean(current.board) && items.length === 0 && !current.loading
  const status = noteText({ stale: current.stale, updatedAt: current.updatedAt, message: current.message, empty }, Date.now(), orca.locale)
  note.textContent = [current.notice, status].filter(Boolean).join(' · ')
  note.hidden = note.textContent === ''
  cards.keep(new Set(all.map(item => item.id)))
  const focused = focusedSelector()
  const openId = panel.openId()
  if (current.board) {
    scroller.replaceChildren(boardGrid(layoutBoard(current.board, items, current.toggled), cards, id => current.pending.has(id), id => id === openId, toggleLane))
  } else if (current.failure) {
    scroller.replaceChildren(el('p', 'muted', current.failure), button('Try again', () => void load()))
  } else {
    scroller.replaceChildren(el('p', 'muted', 'Loading board…'))
  }
  if (focused) scroller.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true })
  reveal(openId)
  panel.boardChanged()
}

function cardNode(id: number): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`.card[data-id="${id}"]`)
}

function reveal(id: number | null): void {
  if (id === revealed) return
  revealed = id
  if (id !== null) cardNode(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function focusCard(id: number): boolean {
  const card = cardNode(id)
  card?.focus()
  return card !== null
}

function syncInert(): void {
  scroller.inert = panel.isOpen() && narrow.matches
}

function openExternal(url: string): Promise<string | null> {
  const shell = orca.shell
  if (!shell) return Promise.resolve(NO_LINK_OPENER)
  return shell.openExternal(url).then(
    result => (!result.opened && result.reason === 'consent-unavailable' ? OPEN_LINK_UNAVAILABLE : null),
    error => messageOf(error)
  )
}

function focusedSelector(): string | null {
  const active = document.activeElement
  return active instanceof HTMLElement && scroller.contains(active) ? focusSelectorOf(active) : null
}

function keepAging(on: boolean): void {
  if (on && aging === null) aging = setInterval(paint, AGE_REPAINT_MS)
  if (!on && aging !== null) {
    clearInterval(aging)
    aging = null
  }
}

function dismissBanner(): void {
  if (!state) return
  state.banner = null
  paint()
}

function toggleLane(id: string): void {
  if (!state) return
  if (!state.toggled.delete(id)) state.toggled.add(id)
  paint()
}

async function load(options: { remember?: true } = {}): Promise<void> {
  const current = state
  if (!current) return
  const mine = ++seq
  current.loading = true
  paint()
  const { org, projectId, teamId, boardId } = current.ref
  const filter = current.everyone === null ? {} : { everyone: current.everyone }
  try {
    const result = await orca.plugin.request('work.board', { org, projectId, teamId, boardId, ...filter, ...options })
    if (mine !== seq || state !== current) return
    current.everyone = result.everyone
    current.board = result.board
    current.base = result.items
    current.message = result.message
    current.stale = result.stale === true
    current.updatedAt = result.updatedAt
    current.failure = null
  } catch (error) {
    if (mine !== seq || state !== current) return
    if (current.board) current.banner = messageOf(error)
    else current.failure = messageOf(error)
  }
  current.loading = false
  paint()
}

async function move(id: number, to: MoveTarget): Promise<WorkItemSummary> {
  const current = state
  const board = current?.board
  const item = current?.base.find(entry => entry.id === id)
  if (!current || !board || !item) throw new Error(OFF_BOARD)
  current.pending.set(id, { ...item, column: to.column ?? item.column, lane: to.lane ?? item.lane, state: pendingState(item, to, board.columns) })
  current.banner = null
  paint()
  try {
    const moved = await orca.plugin.request('work.move', { org: current.ref.org, id, rev: item.rev, to, board: { teamId: board.teamId, boardId: board.boardId } })
    current.base = current.base.map(entry => (entry.id === id ? moved : entry))
    return moved
  } finally {
    current.pending.delete(id)
    paint()
  }
}

function pendingState(item: WorkItemSummary, to: MoveTarget, columns: BoardColumn[]): string {
  const mapped = to.column === undefined ? undefined : columns.find(column => column.name === to.column)?.stateMappings[item.type]
  return to.state ?? mapped ?? item.state
}

function dragMove(id: number, to: MoveTarget): void {
  const current = state
  move(id, to).catch(error => {
    if (!current) return
    current.banner = messageOf(error)
    if (state === current) paint()
  })
}

function replace(item: WorkItemSummary): void {
  const current = state
  if (!current) return
  current.base = current.base.map(entry => (entry.id === item.id && entry.rev <= item.rev ? item : entry))
  paint()
}

function tell(ref: BoardRef, visible: boolean): void {
  const board = { teamId: ref.teamId, boardId: ref.boardId }
  orca.plugin.request('ui.visibility', { surface: 'board', org: ref.org, visible, board }).catch(() => {})
}

function reportVisibility(): void {
  const next = state?.ref ?? null
  if (reported && !sameBoard(reported, next)) tell(reported, false)
  if (next) tell(next, document.visibilityState === 'visible')
  reported = next
}

function sameBoard(a: BoardRef, b: BoardRef | null): boolean {
  return b !== null && a.org === b.org && a.teamId === b.teamId && a.boardId === b.boardId
}

function openRef(ref: BoardRef): void {
  state = { ref, board: null, base: [], pending: new Map(), message: undefined, stale: false, updatedAt: null, everyone: null, parent: null, toggled: new Set(), banner: null, notice: null, failure: null, loading: false }
  root.replaceChildren(toolbar.node, banner, note, body)
  reportVisibility()
  void load()
}

function openPicker(picked: (ref: BoardRef) => void): void {
  state = null
  reportVisibility()
  showPicker(root, picked)
}

function showNotice(text: string): void {
  if (!state) return
  state.notice = text
  paint()
}

function showReadFailure(): void {
  banner.replaceChildren(el('span', '', READ_FAILED))
  banner.hidden = false
  root.replaceChildren(banner)
}

function applyTheme(colorScheme: 'light' | 'dark'): void {
  document.documentElement.style.colorScheme = colorScheme
}

async function start(): Promise<void> {
  applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  orca.on('theme', theme => applyTheme(theme.colorScheme))
  orca.plugin.on('work.boardChanged', change => {
    const board = state?.board
    if (board && change.org === state?.ref.org && change.teamId === board.teamId && change.boardId === board.boardId) void load()
  })
  orca.plugin.on('work.workspaceReady', event => panel.workspaceReady(event))
  orca.plugin.on('work.agentWorking', event => panel.agentWorking(event))
  document.addEventListener('visibilitychange', () => {
    reportVisibility()
    if (document.visibilityState === 'visible') void load()
  })
  window.addEventListener('pagehide', () => {
    if (reported) tell(reported, false)
  })
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return
    reportVisibility()
    void load()
  })
  const doc = orca.document
  if (!doc) {
    root.replaceChildren(el('p', 'muted', 'This view opens only as the Azure DevOps board editor.'))
    return
  }
  await followDocument(doc, closePanelFirst(panel, { board: openRef, picker: openPicker, note: showNotice, readFailed: showReadFailure }))
}

void start()
