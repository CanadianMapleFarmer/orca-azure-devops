import { assert, test } from 'orca/testing'
import { dropTarget, moveFor } from './dnd'
import { boardConfig, DEFAULT_LANE, EXPEDITE, item } from './fixtures'

const CELLS = [
  { column: 'New', lane: DEFAULT_LANE, rect: { left: 0, top: 0, width: 100, height: 50 } },
  { column: 'Active', lane: DEFAULT_LANE, rect: { left: 100, top: 0, width: 100, height: 50 } },
  { column: 'New', lane: EXPEDITE, rect: { left: 0, top: 80, width: 100, height: 50 } }
]

test('dropTarget finds the cell under the pointer and null outside', () => {
  assert.deepEqual(dropTarget({ x: 150, y: 10 }, CELLS), { column: 'Active', lane: DEFAULT_LANE })
  assert.deepEqual(dropTarget({ x: 100, y: 0 }, CELLS), { column: 'Active', lane: DEFAULT_LANE })
  assert.deepEqual(dropTarget({ x: 99.5, y: 49.5 }, CELLS), { column: 'New', lane: DEFAULT_LANE })
  assert.deepEqual(dropTarget({ x: 20, y: 100 }, CELLS), { column: 'New', lane: EXPEDITE })
  assert.equal(dropTarget({ x: 50, y: 65 }, CELLS), null)
  assert.equal(dropTarget({ x: 200, y: 10 }, CELLS), null)
  assert.equal(dropTarget({ x: -1, y: 10 }, CELLS), null)
  assert.equal(dropTarget({ x: 10, y: 10 }, []), null)
})

test('moveFor returns null for own cell and unmapped columns', () => {
  const cfg = boardConfig()
  assert.equal(moveFor(item(1, { column: 'Active' }), { column: 'Active', lane: DEFAULT_LANE }, cfg), null)
  assert.equal(moveFor(item(2, { column: 'New', lane: 'Expedite' }), { column: 'New', lane: EXPEDITE }, cfg), null)
  assert.equal(moveFor(item(3, { column: null }), { column: 'New', lane: DEFAULT_LANE }, cfg), null)
  assert.equal(moveFor(item(4, { type: 'Bug' }), { column: 'In Review', lane: DEFAULT_LANE }, cfg), null)
  assert.equal(moveFor(item(5), { column: 'Archived', lane: DEFAULT_LANE }, cfg), null)
  assert.equal(moveFor(item(6, { type: 'Task', column: null }), { column: 'Active', lane: DEFAULT_LANE }, cfg), null)
  assert.equal(moveFor(item(7, { type: 'Task', column: null }), { column: 'New', lane: EXPEDITE }, cfg), null)
})

test('moveFor names the column and lane the item is dropped on', () => {
  const cfg = boardConfig()
  assert.deepEqual(moveFor(item(1), { column: 'Resolved', lane: DEFAULT_LANE }, cfg), { column: 'Resolved' })
  assert.deepEqual(moveFor(item(2), { column: 'Active', lane: EXPEDITE }, cfg), { lane: 'Expedite' })
  assert.deepEqual(moveFor(item(3), { column: 'New', lane: EXPEDITE }, cfg), { column: 'New', lane: 'Expedite' })
  assert.deepEqual(moveFor(item(4, { lane: 'Expedite' }), { column: 'Active', lane: DEFAULT_LANE }, cfg), { lane: '' })
  assert.deepEqual(moveFor(item(5, { column: null }), { column: 'Active', lane: DEFAULT_LANE }, cfg), { column: 'Active' })
})

test('moveFor never writes a lane the board does not show', () => {
  const single = boardConfig({ lanes: [{ id: DEFAULT_LANE, name: '' }] })
  assert.deepEqual(moveFor(item(1, { lane: 'Expedite' }), { column: 'New', lane: DEFAULT_LANE }, single), { column: 'New' })
  assert.deepEqual(moveFor(item(2), { column: 'New', lane: 'gone' }, boardConfig()), { column: 'New' })
})
