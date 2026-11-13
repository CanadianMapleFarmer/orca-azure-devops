import { assert, test } from 'orca/testing'
import type { Assignee } from '../shared/work'
import { createAssigneePicker, pickerOptions } from './assignee-picker'
import { findAll, fire, textOf, withFakeDom, type FakeNode } from './fake-dom'

const ALEX: Assignee = { displayName: 'Alex Contoso', uniqueName: 'alex@contoso.example' }
const GRACE: Assignee = { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }
const DENNIS: Assignee = { displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example' }
const BARBARA: Assignee = { displayName: 'Barbara Liskov', uniqueName: 'barbara@contoso.example' }
const TEAM = [ALEX, GRACE, DENNIS]

const fake = (node: HTMLElement) => node as unknown as FakeNode
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const summary = (options: ReturnType<typeof pickerOptions>) => options.map(option => [option.kind, option.label, option.detail, option.current])

function setup(team: { me: Assignee | null; members: Assignee[] } = { me: ALEX, members: TEAM }) {
  const calls: string[] = []
  const searches: { query: string; resolve(found: Assignee[]): void; reject(error: Error): void }[] = []
  const picker = createAssigneePicker({
    pick: person => calls.push(`pick ${person?.uniqueName ?? 'nobody'}`),
    load: () => {
      calls.push('load')
      return Promise.resolve(team)
    },
    search: query => {
      calls.push(`search ${query}`)
      return new Promise((resolve, reject) => searches.push({ query, resolve, reject }))
    },
    closed: () => calls.push('closed'),
  })
  const input = fake(picker.input)
  const root = fake(picker.node)
  const options = () => findAll(root, node => node.attributes.get('role') === 'option')
  const type = (text: string) => {
    input.value = text
    fire(input, 'input')
  }
  const key = (name: string) => fire(input, 'keydown', { key: name })
  const selected = () => options().filter(node => node.attributes.get('aria-selected') === 'true')
  return { picker, calls, searches, input, root, options, type, key, selected }
}

test('me and Unassigned come first, and the current person is marked', () => {
  assert.deepEqual(summary(pickerOptions({ query: '', me: ALEX, members: TEAM, found: [], current: GRACE })), [
    ['me', 'Assign to me', 'Alex Contoso', false],
    ['unassigned', 'Unassigned', null, false],
    ['person', 'Alex Contoso', null, false],
    ['person', 'Grace Hopper', 'Assigned', true],
    ['person', 'Dennis Ritchie', null, false],
  ])

  const mine = pickerOptions({ query: '', me: ALEX, members: TEAM, found: [], current: { displayName: 'Alex Contoso', uniqueName: 'ALEX@contoso.example' } })
  assert.equal(mine[0].kind, 'unassigned', "I'm already assigned, so there's no Assign to me")
  assert.deepEqual(mine.filter(option => option.current).map(option => option.person?.displayName), ['Alex Contoso'])

  const many = Array.from({ length: 30 }, (_, index) => ({ displayName: `Person ${index}`, uniqueName: `person${index}@contoso.example` }))
  const capped = pickerOptions({ query: '', me: null, members: many, found: [BARBARA], current: null })
  assert.equal(capped.filter(option => option.kind === 'person').length, 20)
})

test('an unassigned item doesn\'t offer Unassigned', () => {
  const options = pickerOptions({ query: '', me: ALEX, members: [GRACE], found: [], current: null })
  assert.deepEqual(summary(options), [
    ['me', 'Assign to me', 'Alex Contoso', false],
    ['person', 'Grace Hopper', null, false],
  ])
})

test('typing filters the team without a search, and offers one from 2 characters', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.picker.open(GRACE)
    assert.equal(t.picker.isOpen(), true)
    assert.equal(document.activeElement, t.picker.input)
    assert.equal(t.input.attributes.get('role'), 'combobox')
    assert.equal(t.input.attributes.get('aria-expanded'), 'true')
    await settle()
    assert.deepEqual(t.calls, ['load'])
    assert.equal(t.options().length, 5)

    t.type('g')
    assert.deepEqual(t.options().map(textOf), ['ACAssign to meAlex Contoso', '–Unassigned', 'GHGrace HopperAssigned'])
    assert.equal(t.calls.includes('search g'), false)

    t.type(' CONTOSO.example ')
    assert.deepEqual(t.options().map(textOf).slice(2), ['ACAlex Contoso', 'GHGrace HopperAssigned', 'DRDennis Ritchie', 'Search Azure DevOps for "CONTOSO.example"'], 'by unique name too, ignoring case')
    t.type('gr')
    assert.equal(t.options().at(-1) && textOf(t.options().at(-1)!), 'Search Azure DevOps for "gr"')
    assert.deepEqual(t.calls, ['load'], 'typing sends nothing')
  })
})

test('search results join the list without repeating the team', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.picker.open(null)
    await settle()
    t.type('ri')
    const search = t.options().at(-1)!
    assert.equal(textOf(search), 'Search Azure DevOps for "ri"')
    fire(search, 'click')
    assert.deepEqual(t.calls, ['load', 'search ri'])
    assert.equal(textOf(t.root).includes('Searching…'), true)

    t.key('End')
    t.key('Enter')
    assert.deepEqual(t.calls, ['load', 'search ri'], 'one search per query')

    t.searches[0].resolve([{ displayName: 'Dennis Ritchie', uniqueName: 'DENNIS@contoso.example' }, BARBARA])
    await settle()
    assert.deepEqual(t.options().map(textOf), ['ACAssign to meAlex Contoso', 'DRDennis Ritchie', 'BLBarbara Liskov', 'Search Azure DevOps for "ri"'])
    assert.equal(textOf(t.root).includes('Searching…'), false)

    t.type('zz')
    fire(t.options().at(-1)!, 'click')
    t.searches[1].resolve([])
    await settle()
    assert.equal(textOf(t.root).includes('No one found.'), true)

    t.type('qq')
    fire(t.options().at(-1)!, 'click')
    t.searches[2].reject(new Error('Finding people needs Graph (Read) and Identity (Read) access.'))
    await settle()
    assert.equal(textOf(t.root).includes('Finding people needs Graph (Read) and Identity (Read) access.'), true)
  })
})

test('Esc closes the picker and not the panel', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.picker.open(GRACE)
    await settle()
    const esc = t.key('Escape')
    assert.equal(esc.propagationStopped, true)
    assert.equal(esc.defaultPrevented, true)
    assert.equal(t.picker.isOpen(), false)
    assert.equal(t.root.hidden, true)
    assert.equal(t.input.attributes.get('aria-expanded'), 'false')
    assert.deepEqual(t.calls, ['load', 'closed'])
  })
})

test('arrow keys move the selection and Enter picks it', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.picker.open(GRACE)
    await settle()
    assert.deepEqual(t.selected(), [], 'nothing is chosen until the keys move')

    t.key('ArrowDown')
    assert.deepEqual(t.selected().map(textOf), ['ACAssign to meAlex Contoso'])
    assert.equal(t.input.attributes.get('aria-activedescendant'), t.selected()[0].id)
    t.key('ArrowDown')
    t.key('ArrowDown')
    assert.deepEqual(t.selected().map(textOf), ['ACAlex Contoso'])
    t.key('ArrowUp')
    assert.deepEqual(t.selected().map(textOf), ['–Unassigned'])
    t.key('End')
    assert.deepEqual(t.selected().map(textOf), ['DRDennis Ritchie'])
    t.key('ArrowDown')
    assert.deepEqual(t.selected().map(textOf), ['DRDennis Ritchie'], 'the last stays chosen')
    t.key('Home')
    t.key('ArrowDown')
    const enter = t.key('Enter')
    assert.equal(enter.defaultPrevented, true)
    assert.deepEqual(t.calls, ['load', 'pick nobody'])
    assert.equal(t.picker.isOpen(), false)

    t.picker.open(null)
    await settle()
    t.type('den')
    assert.deepEqual(t.selected().map(textOf), ['DRDennis Ritchie'], 'typing chooses the first person who matches')
    fire(t.options()[0], 'click')
    assert.deepEqual(t.calls.slice(-1), ['pick alex@contoso.example'])
  })
})
