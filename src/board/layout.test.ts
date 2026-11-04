import { assert, test } from 'orca/testing'
import type { WorkItemSummary } from '../shared/work'
import { boardConfig, COLUMNS, DEFAULT_LANE, EXPEDITE, item } from './fixtures'
import { cardLabel, initials, layoutBoard, parentOptions, withParent, type Lane } from './layout'

function ids(lane: Lane): Record<string, number[]> {
  return Object.fromEntries(Object.entries(lane.cells).map(([column, items]) => [column, items.map(entry => entry.id)]))
}

test('layoutBoard puts items in their column and lane in board order', () => {
  const items = [
    item(1, { column: 'Active' }),
    item(2, { column: 'New', lane: 'Expedite' }),
    item(3, { column: 'Active', lane: '' }),
    item(4, { column: 'Closed', lane: 'Expedite' }),
    item(5, { column: null }),
    item(6, { column: 'Archived', lane: 'Hotfix' })
  ]
  const layout = layoutBoard(boardConfig(), items, new Set())
  assert.deepEqual(layout.columns, COLUMNS)
  assert.deepEqual(
    layout.lanes.map(lane => [lane.id, lane.name, lane.collapsed]),
    [
      [DEFAULT_LANE, '', false],
      [EXPEDITE, 'Expedite', true]
    ]
  )
  assert.deepEqual(ids(layout.lanes[0]), { New: [5, 6], Active: [1, 3], 'In Review': [], Resolved: [], Closed: [] })
  assert.deepEqual(ids(layout.lanes[1]), { New: [2], Active: [], 'In Review': [], Resolved: [], Closed: [4] })
})

test('layoutBoard flips the open or collapsed default of the toggled lanes', () => {
  const layout = layoutBoard(boardConfig(), [], new Set([DEFAULT_LANE, EXPEDITE]))
  assert.deepEqual(layout.lanes.map(lane => lane.collapsed), [true, false])
})

test('layoutBoard puts items without a known lane in the default lane wherever it sits', () => {
  const lanes = [
    { id: EXPEDITE, name: 'Expedite' },
    { id: DEFAULT_LANE, name: '' }
  ]
  const layout = layoutBoard(boardConfig({ lanes }), [item(1), item(2, { lane: 'Hotfix' }), item(3, { lane: 'Expedite' })], new Set())
  assert.deepEqual(
    layout.lanes.map(lane => [lane.id, lane.cells.Active.map(entry => entry.id)]),
    [
      [EXPEDITE, [3]],
      [DEFAULT_LANE, [1, 2]]
    ]
  )
})

test('layoutBoard hides lanes when the board has one', () => {
  const items = [item(1, { column: 'New' }), item(2, { column: 'Active', lane: 'Expedite' })]
  for (const lanes of [[{ id: DEFAULT_LANE, name: '' }], []]) {
    const layout = layoutBoard(boardConfig({ lanes }), items, new Set([DEFAULT_LANE]))
    assert.equal(layout.lanes.length, 1)
    assert.equal(layout.lanes[0].name, '')
    assert.equal(layout.lanes[0].collapsed, false)
    assert.deepEqual(ids(layout.lanes[0]), { New: [1], Active: [2], 'In Review': [], Resolved: [], Closed: [] })
  }
})

test('parentOptions lists each parent on the board once, by title', () => {
  const items = [
    item(1, { parentId: 900, parentTitle: 'Vehicle search' }),
    item(2, { parentId: 800, parentTitle: 'Checkout' }),
    item(3, { parentId: 900, parentTitle: 'Vehicle search' }),
    item(4),
    item(5, { parentId: 700, parentTitle: null })
  ]
  assert.deepEqual(parentOptions(items), [
    { id: 700, title: '#700' },
    { id: 800, title: 'Checkout' },
    { id: 900, title: 'Vehicle search' }
  ])
})

test('withParent keeps every item for all parents, or only the children of one', () => {
  const items: WorkItemSummary[] = [item(1, { parentId: 900 }), item(2, { parentId: 800 }), item(3)]
  assert.deepEqual(withParent(items, null).map(entry => entry.id), [1, 2, 3])
  assert.deepEqual(withParent(items, 900).map(entry => entry.id), [1])
})

test('initials take the first letters of the first and last names', () => {
  assert.equal(initials('Ada Lovelace'), 'AL')
  assert.equal(initials('grace brewster murray hopper'), 'GH')
  assert.equal(initials('  Alex  '), 'A')
  assert.equal(initials('Émile Zola'), 'ÉZ')
  assert.equal(initials(''), '')
})

test('cardLabel names the type, id, title and column', () => {
  assert.equal(cardLabel(item(42, { type: 'Bug', title: 'Fix the export' }), 'Active'), 'Bug 42: Fix the export, in Active')
})
