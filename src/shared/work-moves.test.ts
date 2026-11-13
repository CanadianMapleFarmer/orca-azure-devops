import { assert, test } from 'orca/testing'
import { item, task } from '../panel/work/fixtures'
import { moveTargets, moveTo, movesByColumn } from './work-moves'

test('moveTargets lists the other columns of a board item', () => {
  const story = item(1, { column: 'Active', state: 'Active', targets: { columns: ['New', 'Active', 'Closed'], states: ['New', 'Active'] } })
  assert.equal(movesByColumn(story), true)
  assert.deepEqual(moveTargets(story), ['New', 'Closed'])
})

test('moveTargets lists the other states of an item that moves by state', () => {
  const chore = task(2, { state: 'Active', targets: { columns: [], states: ['New', 'Active', 'Closed'] } })
  assert.equal(movesByColumn(chore), false)
  assert.deepEqual(moveTargets(chore), ['New', 'Closed'])
})

test('moveTo sends a column for a board item and a state otherwise', () => {
  assert.deepEqual(moveTo(item(1), 'Done'), { column: 'Done' })
  assert.deepEqual(moveTo(task(2), 'Closed'), { state: 'Closed' })
})
