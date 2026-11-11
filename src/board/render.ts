import { chipOf } from '../shared/chips'
import type { WorkItemSummary } from '../shared/work'
import { ageText } from './age'
import { cardLabel, initials, type Lane, type ParentOption } from './layout'

export function noteText(view: { stale: boolean; updatedAt: number | null; message: string | undefined; empty: boolean }, now: number, locale: string): string {
  if (view.stale && view.updatedAt !== null) return `Updated ${ageText(view.updatedAt, now, locale)} · ${view.message || 'refreshing…'}`
  if (view.empty) return [view.message, 'No work items match.'].filter(Boolean).join(' ')
  return view.message ?? ''
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function button(label: string, onClick: () => void, className = 'button'): HTMLButtonElement {
  const node = el('button', className, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

function cardElement(item: WorkItemSummary, column: string): HTMLElement {
  const card = el('div', 'card')
  card.tabIndex = 0
  card.dataset.id = String(item.id)
  card.setAttribute('role', 'listitem')
  card.setAttribute('aria-label', cardLabel(item, column))
  const meta = el('div', 'meta')
  meta.append(el('span', '', `${item.type} #${item.id}`))
  if (item.assignedTo) {
    const who = el('span', 'who', initials(item.assignedTo))
    who.title = item.assignedTo
    meta.append(who)
  }
  card.append(meta, el('div', 'card-title', item.title))
  if (item.parentTitle) card.append(el('div', 'parent', `↑ ${item.parentTitle}`))
  if (item.prs.length > 0) {
    const chips = el('div', 'chips')
    for (const pr of item.prs) {
      const chip = chipOf(pr)
      chips.append(el('span', `chip ${chip.tone}`, chip.text))
    }
    card.append(chips)
  }
  return card
}

export function createCards() {
  const cards = new Map<number, { key: string; node: HTMLElement }>()
  return {
    card(item: WorkItemSummary, column: string, busy: boolean): HTMLElement {
      const key = JSON.stringify([item, column])
      let entry = cards.get(item.id)
      if (!entry || entry.key !== key) {
        entry = { key, node: cardElement(item, column) }
        cards.set(item.id, entry)
      }
      entry.node.classList.toggle('busy', busy)
      entry.node.setAttribute('aria-busy', String(busy))
      return entry.node
    },
    keep(ids: ReadonlySet<number>): void {
      for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id)
    }
  }
}

export type Cards = ReturnType<typeof createCards>

export function boardGrid(layout: { columns: string[]; lanes: Lane[] }, cards: Cards, busy: (id: number) => boolean, onToggle: (laneId: string) => void): HTMLElement {
  const grid = el('div', 'grid')
  grid.style.setProperty('--columns', String(layout.columns.length))
  for (const column of layout.columns) {
    const count = layout.lanes.reduce((total, lane) => total + (lane.cells[column]?.length ?? 0), 0)
    grid.append(el('div', 'column-head', `${column} (${count})`))
  }
  const showLanes = layout.lanes.length > 1
  for (const lane of layout.lanes) {
    const laneName = lane.name || 'Default lane'
    if (showLanes) {
      const count = Object.values(lane.cells).reduce((total, items) => total + items.length, 0)
      const head = button(`${lane.collapsed ? '▸' : '▾'} ${laneName} (${count})`, () => onToggle(lane.id), 'lane-head')
      head.dataset.lane = lane.id
      head.setAttribute('aria-expanded', String(!lane.collapsed))
      grid.append(head)
    }
    if (lane.collapsed) continue
    for (const column of layout.columns) {
      const cell = el('div', 'cell')
      cell.dataset.column = column
      cell.dataset.lane = lane.id
      cell.setAttribute('role', 'list')
      cell.setAttribute('aria-label', showLanes ? `${column}, ${laneName}` : column)
      cell.append(...(lane.cells[column] ?? []).map(item => cards.card(item, column, busy(item.id))))
      grid.append(cell)
    }
  }
  return grid
}

export function focusSelectorOf(focused: { closest(selector: string): { dataset: DOMStringMap } | null }): string | null {
  const card = focused.closest('.card')?.dataset.id
  if (card !== undefined) return `.card[data-id="${cssString(card)}"]`
  const lane = focused.closest('.lane-head')?.dataset.lane
  return lane === undefined ? null : `.lane-head[data-lane="${cssString(lane)}"]`
}

function cssString(value: string): string {
  return value.replace(/[^\w-]/g, char => `\\${char.codePointAt(0)?.toString(16)} `)
}

export function createToolbar(handlers: { everyone(value: boolean): void; parent(id: number | null): void }) {
  const bar = el('header', 'toolbar')
  const title = el('span', 'title')
  const status = el('span', 'muted')
  const scope = el('div', 'segmented')
  scope.setAttribute('role', 'group')
  scope.setAttribute('aria-label', 'Assigned to')
  const me = button('Me', () => handlers.everyone(false), '')
  const everyone = button('Everyone', () => handlers.everyone(true), '')
  scope.append(me, everyone)
  const parent = el('select')
  parent.setAttribute('aria-label', 'Parent')
  parent.addEventListener('change', () => handlers.parent(parent.value === '' ? null : Number(parent.value)))
  let shownOptions = ''
  bar.append(title, status, scope, parent)
  return {
    node: bar,
    update(view: { title: string; loading: boolean; everyone: boolean | null; parents: ParentOption[]; parent: number | null }): void {
      title.textContent = view.title
      status.textContent = view.loading ? 'Loading…' : ''
      me.setAttribute('aria-pressed', String(view.everyone === false))
      everyone.setAttribute('aria-pressed', String(view.everyone === true))
      const options = JSON.stringify(view.parents)
      if (options !== shownOptions) {
        shownOptions = options
        parent.replaceChildren(new Option('All parents', ''), ...view.parents.map(option => new Option(option.title, String(option.id))))
      }
      parent.value = view.parent === null ? '' : String(view.parent)
    }
  }
}
