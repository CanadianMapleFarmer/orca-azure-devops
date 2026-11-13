import { messageOf } from '../shared/messages'
import type { Assignee } from '../shared/work'
import { NO_ONE_FOUND, SEARCHING, UNASSIGNED, searchFor } from './copy'
import { initials } from './layout'
import { el } from './render'

export interface PickerOption { kind: 'me' | 'unassigned' | 'person' | 'search'; label: string; detail: string | null; person: Assignee | null; current: boolean }

export interface AssigneePicker { node: HTMLElement; input: HTMLInputElement; open(current: Assignee | null): void; close(): void; isOpen(): boolean }

interface PickerHandlers {
  pick(person: Assignee | null): void
  load(): Promise<{ me: Assignee | null; members: Assignee[] }>
  search(query: string): Promise<Assignee[]>
  closed(): void
}

type Search = { status: 'searching' } | { status: 'ready'; found: Assignee[] } | { status: 'failed'; message: string }

const ASSIGN_TO_ME = 'Assign to me'
const ASSIGNED = 'Assigned'
const MAX_PEOPLE = 20
const MIN_SEARCH = 2
const LIST_ID = 'panel-people'

const keyOf = (person: Assignee) => person.uniqueName.toLowerCase()
const same = (a: Assignee | null, b: Assignee | null) => a !== null && b !== null && keyOf(a) === keyOf(b)

export function pickerOptions(input: { query: string; me: Assignee | null; members: Assignee[]; found: Assignee[]; current: Assignee | null }): PickerOption[] {
  const { me, current } = input
  const options: PickerOption[] = []
  const offerMe = me !== null && !same(me, current)
  if (offerMe) options.push({ kind: 'me', label: ASSIGN_TO_ME, detail: me.displayName, person: me, current: false })
  if (current) options.push({ kind: 'unassigned', label: UNASSIGNED, detail: null, person: null, current: false })

  const term = input.query.trim()
  const needle = term.toLowerCase()
  const people: Assignee[] = []
  const listed = new Set<string>()
  const add = (person: Assignee) => {
    if (people.length === MAX_PEOPLE || listed.has(keyOf(person))) return
    listed.add(keyOf(person))
    people.push(person)
  }
  input.members.filter(person => person.displayName.toLowerCase().includes(needle) || keyOf(person).includes(needle)).forEach(add)
  if (offerMe) listed.add(keyOf(me))
  input.found.forEach(add)
  for (const person of people) {
    const mine = same(person, current)
    options.push({ kind: 'person', label: person.displayName, detail: mine ? ASSIGNED : null, person, current: mine })
  }

  if (term.length >= MIN_SEARCH) options.push({ kind: 'search', label: searchFor(term), detail: null, person: null, current: false })
  return options
}

export function createAssigneePicker(handlers: PickerHandlers): AssigneePicker {
  const node = el('div', 'assignee-menu')
  node.hidden = true
  const input = el('input')
  input.type = 'text'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', LIST_ID)
  input.setAttribute('aria-label', 'Assign to')
  const list = el('ul')
  list.id = LIST_ID
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'People')
  const status = el('p', 'muted')
  status.setAttribute('role', 'status')
  node.append(input, list, status)

  let current: Assignee | null = null
  let team: { me: Assignee | null; members: Assignee[] } = { me: null, members: [] }
  let teamMessage = ''
  let searches = new Map<string, Search>()
  let options: PickerOption[] = []
  let rows: HTMLElement[] = []
  let active = -1
  let opening = 0

  const term = () => input.value.trim()
  const isOpen = () => !node.hidden

  function render(): void {
    const search = searches.get(term())
    options = pickerOptions({ query: input.value, me: team.me, members: team.members, found: search?.status === 'ready' ? search.found : [], current })
    rows = options.map(row)
    list.replaceChildren(...rows)
    const person = options.findIndex(option => option.kind === 'person')
    choose(term() === '' ? -1 : person >= 0 ? person : options.findIndex(option => option.kind === 'search'))
    status.textContent = statusText(search)
    status.hidden = status.textContent === ''
  }

  function statusText(search: Search | undefined): string {
    if (search?.status === 'searching') return SEARCHING
    if (search?.status === 'failed') return search.message
    if (search?.status === 'ready' && search.found.length === 0) return NO_ONE_FOUND
    return teamMessage
  }

  function row(option: PickerOption, index: number): HTMLElement {
    const item = el('li', option.kind === 'search' ? 'search-row' : '')
    item.id = `${LIST_ID}-${index}`
    item.setAttribute('role', 'option')
    if (option.kind !== 'search') item.append(el('span', 'who', option.person ? initials(option.person.displayName) : '–'))
    item.append(option.label)
    if (option.detail) item.append(el('small', '', option.detail))
    if (option.person) item.title = option.person.uniqueName
    item.addEventListener('click', () => activate(index))
    return item
  }

  function choose(index: number): void {
    active = index
    rows.forEach((item, at) => item.setAttribute('aria-selected', String(at === index)))
    if (index >= 0) input.setAttribute('aria-activedescendant', rows[index].id)
    else input.removeAttribute('aria-activedescendant')
  }

  function activate(index: number): void {
    const option = options[index]
    if (!option) return
    if (option.kind === 'search') return search()
    hide()
    if (option.current) handlers.closed()
    else handlers.pick(option.person)
  }

  function search(): void {
    const query = term()
    const held = searches.get(query)
    if (query.length < MIN_SEARCH || (held && held.status !== 'failed')) return
    const mine = opening
    searches.set(query, { status: 'searching' })
    render()
    const land = (result: Search) => {
      if (mine !== opening) return
      searches.set(query, result)
      if (isOpen()) render()
    }
    handlers.search(query).then(
      found => land({ status: 'ready', found }),
      error => land({ status: 'failed', message: messageOf(error) })
    )
  }

  function hide(): void {
    if (!isOpen()) return
    node.hidden = true
    input.setAttribute('aria-expanded', 'false')
    options = []
    rows = []
    list.replaceChildren()
    choose(-1)
    status.textContent = ''
  }

  function step(to: (last: number) => number): void {
    if (options.length > 0) choose(to(options.length - 1))
  }

  input.addEventListener('input', () => render())
  input.addEventListener('blur', () => hide())
  node.addEventListener('mousedown', event => {
    if (event.target !== input) event.preventDefault()
  })
  input.addEventListener('keydown', event => {
    switch (event.key) {
      case 'ArrowDown':
        step(last => (active < 0 ? 0 : Math.min(active + 1, last)))
        break
      case 'ArrowUp':
        step(last => (active < 0 ? last : Math.max(active - 1, 0)))
        break
      case 'Home':
        step(() => 0)
        break
      case 'End':
        step(last => last)
        break
      case 'Enter':
        activate(active)
        break
      case 'Escape':
        event.stopPropagation()
        hide()
        handlers.closed()
        break
      default:
        return
    }
    event.preventDefault()
  })

  return {
    node,
    input,
    isOpen,
    close: hide,
    open(person) {
      current = person
      const mine = ++opening
      searches = new Map()
      teamMessage = ''
      input.value = ''
      node.hidden = false
      input.setAttribute('aria-expanded', 'true')
      render()
      input.focus()
      handlers.load().then(
        answer => {
          if (mine !== opening) return
          team = answer
          if (isOpen()) render()
        },
        error => {
          if (mine !== opening) return
          teamMessage = messageOf(error)
          if (isOpen()) render()
        }
      )
    },
  }
}
