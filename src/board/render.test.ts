import { assert, test } from 'orca/testing'
import { findAll, withFakeDom, type FakeNode } from './fake-dom'
import { boardConfig, item } from './fixtures'
import { layoutBoard } from './layout'
import { boardGrid, createCards, createToolbar, focusSelectorOf, noteText } from './render'

const NOW = Date.parse('2026-11-11T09:00:00Z')
const THREE_HOURS_AGO = NOW - 3 * 3600 * 1000
const FAILED = 'TF246017: the database is unavailable. Showing the last loaded board.'

test('a stale board shows its age and that it is refreshing', () => {
  assert.equal(noteText({ stale: true, updatedAt: THREE_HOURS_AGO, message: undefined, empty: false }, NOW, 'en'), 'Updated 3 hours ago · refreshing…')
  assert.equal(noteText({ stale: true, updatedAt: THREE_HOURS_AGO, message: undefined, empty: true }, NOW, 'en'), 'Updated 3 hours ago · refreshing…')
})

test('a stale board with a failure shows its age and the failure', () => {
  assert.equal(noteText({ stale: true, updatedAt: THREE_HOURS_AGO, message: FAILED, empty: false }, NOW, 'en'), `Updated 3 hours ago · ${FAILED}`)
})

test("a live board shows today's note", () => {
  assert.equal(noteText({ stale: false, updatedAt: NOW, message: undefined, empty: false }, NOW, 'en'), '')
  assert.equal(noteText({ stale: false, updatedAt: NOW, message: 'Showing the 500 most recently changed items.', empty: false }, NOW, 'en'), 'Showing the 500 most recently changed items.')
  assert.equal(noteText({ stale: false, updatedAt: NOW, message: undefined, empty: true }, NOW, 'en'), 'No work items match.')
  assert.equal(noteText({ stale: false, updatedAt: NOW, message: 'Linked PR status needs Code (Read) access.', empty: true }, NOW, 'en'), 'Linked PR status needs Code (Read) access. No work items match.')
  assert.equal(noteText({ stale: true, updatedAt: null, message: FAILED, empty: false }, NOW, 'en'), FAILED, 'a stale board of unknown age')
})

function focusedIn(found: Record<string, Record<string, string>>) {
  return { closest: (selector: string) => (selector in found ? { dataset: found[selector] } : null) }
}

test('focusSelectorOf finds the focused card again after a repaint', () => {
  assert.equal(focusSelectorOf(focusedIn({ '.card': { id: '102' } })), '.card[data-id="102"]')
})

test('focusSelectorOf finds the focused lane header again after a repaint, its id escaped', () => {
  assert.equal(focusSelectorOf(focusedIn({ '.lane-head': { lane: '48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7' } })), '.lane-head[data-lane="48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7"]')
  assert.equal(focusSelectorOf(focusedIn({ '.lane-head': { lane: 'a"b c' } })), '.lane-head[data-lane="a\\22 b\\20 c"]')
})

test('focusSelectorOf names nothing for other focused elements', () => {
  assert.equal(focusSelectorOf(focusedIn({})), null)
})

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  className = ''
  textContent = ''
  type = ''
  value = ''
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  addEventListener(): void {}
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }
}

function withFakeDocument(run: () => void): void {
  const saved = { document: globalThis.document, Option: globalThis.Option }
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document
  globalThis.Option = FakeElement as unknown as typeof Option
  try {
    run()
  } finally {
    Object.assign(globalThis, saved)
  }
}

test("the toolbar presses neither filter until the board's filter is known", () => {
  withFakeDocument(() => {
    const toolbar = createToolbar({ everyone: () => {}, parent: () => {} })
    const buttons = (toolbar.node as unknown as FakeElement).children.flatMap(node => node.children)
    const pressed = () => Object.fromEntries(buttons.map(node => [node.textContent, node.attributes.get('aria-pressed')]))
    const update = (everyone: boolean | null) => toolbar.update({ title: 'Stories', loading: true, everyone, parents: [], parent: null })

    update(null)
    assert.deepEqual(pressed(), { Me: 'false', Everyone: 'false' })
    update(false)
    assert.deepEqual(pressed(), { Me: 'true', Everyone: 'false' })
    update(true)
    assert.deepEqual(pressed(), { Me: 'false', Everyone: 'true' })
  })
})

const classes = (node: FakeNode) => node.className.split(' ')

test('the open card is marked current and selected', () => {
  withFakeDom(() => {
    const cards = createCards()
    const open = cards.card(item(4211), 'Active', false, true) as unknown as FakeNode
    assert.equal(classes(open).includes('selected'), true)
    assert.equal(open.attributes.get('aria-current'), 'true')

    const closed = cards.card(item(4211), 'Active', false, false) as unknown as FakeNode
    assert.equal(closed, open, 'the same card, unmarked')
    assert.equal(classes(closed).includes('selected'), false)
    assert.equal(closed.attributes.has('aria-current'), false)
  })
})

test('cards have no aria-haspopup', () => {
  withFakeDom(() => {
    const items = [item(4207, { column: 'New' }), item(4211)]
    const grid = boardGrid(layoutBoard(boardConfig(), items, new Set()), createCards(), () => false, id => id === 4211, () => {}) as unknown as FakeNode
    const cards = findAll(grid, node => classes(node).includes('card'))
    assert.deepEqual(cards.map(node => node.attributes.get('role')), ['listitem', 'listitem'])
    assert.equal(cards.some(node => node.attributes.has('aria-haspopup')), false)
    assert.deepEqual(cards.filter(node => node.attributes.get('aria-current') === 'true').map(node => node.dataset.id), ['4211'])
  })
})
