import type { EditorDocument } from 'orca/frame'
import { messageOf } from '../shared/messages'
import type { BoardConfig, WorkItemSummary } from '../shared/work'
import { moveFor } from './dnd'
import { attachDrag } from './drag'
import { layoutBoard, parentOptions, withParent, type Cell } from './layout'
import { showPicker } from './picker'
import { parseBoardRef, type BoardRef } from './ref'
import { boardGrid, button, createCards, createToolbar, el, focusSelectorOf } from './render'

interface State {
  ref: BoardRef
  board: BoardConfig | null
  base: WorkItemSummary[]
  pending: Map<number, WorkItemSummary>
  message: string | undefined
  everyone: boolean | null
  parent: number | null
  toggled: Set<string>
  banner: string | null
  failure: string | null
  loading: boolean
}

const root = document.getElementById('app') as HTMLElement
const READ_FAILED = "Couldn't read this board file."

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
const drag = attachDrag(scroller, {
  canDrag: id => Boolean(state?.board) && !state?.pending.has(id),
  accepts: (id, cell) => moveOf(id, cell) !== null,
  drop: (id, cell) => {
    if (cell) void move(id, cell)
  },
  ended: () => {
    if (deferred) paint()
  }
})

let state: State | null = null
let shownText: string | null = null
let reported: BoardRef | null = null
let seq = 0
let deferred = false

function moveOf(id: number, cell: Cell) {
  const item = state?.base.find(entry => entry.id === id)
  return state?.board && item ? moveFor(item, cell, state.board) : null
}

function paint(): void {
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
  note.textContent = current.board && items.length === 0 && !current.loading ? joined(current.message, 'No work items match.') : (current.message ?? '')
  note.hidden = note.textContent === ''
  cards.keep(new Set(all.map(item => item.id)))
  const focused = focusedSelector()
  if (current.board) {
    scroller.replaceChildren(boardGrid(layoutBoard(current.board, items, current.toggled), cards, id => current.pending.has(id), toggleLane))
  } else if (current.failure) {
    scroller.replaceChildren(el('p', 'muted', current.failure), button('Try again', () => void load()))
  } else {
    scroller.replaceChildren(el('p', 'muted', 'Loading board…'))
  }
  if (focused) scroller.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true })
}

function focusedSelector(): string | null {
  const active = document.activeElement
  return active instanceof HTMLElement && scroller.contains(active) ? focusSelectorOf(active) : null
}

function joined(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
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
    current.failure = null
  } catch (error) {
    if (mine !== seq || state !== current) return
    if (current.board) current.banner = messageOf(error)
    else current.failure = messageOf(error)
  }
  current.loading = false
  paint()
}

async function move(id: number, cell: Cell): Promise<void> {
  const current = state
  const board = current?.board
  const item = current?.base.find(entry => entry.id === id)
  const to = board && item ? moveFor(item, cell, board) : null
  if (!current || !board || !item || !to) return
  current.pending.set(id, { ...item, column: to.column ?? item.column, lane: to.lane ?? item.lane })
  current.banner = null
  paint()
  try {
    const moved = await orca.plugin.request('work.move', { org: current.ref.org, id, rev: item.rev, to, board: { teamId: board.teamId, boardId: board.boardId } })
    current.base = current.base.map(entry => (entry.id === id ? moved : entry))
  } catch (error) {
    current.banner = messageOf(error)
  } finally {
    current.pending.delete(id)
    paint()
  }
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
  state = { ref, board: null, base: [], pending: new Map(), message: undefined, everyone: null, parent: null, toggled: new Set(), banner: null, failure: null, loading: false }
  root.replaceChildren(toolbar.node, banner, note, scroller)
  reportVisibility()
  void load()
}

function openText(text: string): void {
  if (text === shownText) return
  shownText = text
  const ref = parseBoardRef(text)
  if (ref) return openRef(ref)
  state = null
  reportVisibility()
  showPicker(root, openRef)
}

function showReadFailure(): void {
  banner.replaceChildren(el('span', '', READ_FAILED))
  banner.hidden = false
  root.replaceChildren(banner)
}

function textOf(doc: EditorDocument): string {
  return doc.content.kind === 'text' ? doc.content.text : ''
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
  const first = await doc.get().catch(() => null)
  if (first) openText(textOf(first))
  else showReadFailure()
  doc.onDidChange(next => openText(textOf(next)))
}

void start()
