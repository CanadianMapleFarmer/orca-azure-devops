import { assert, test } from 'orca/testing'
import { byteLength, itemBytes, newestThatFit } from './budget'

test('byteLength measures the UTF-8 bytes of the JSON text, and itemBytes adds the list separator', () => {
  assert.equal(byteLength({ a: 1 }), 7)
  assert.equal(byteLength('é'), 4)
  assert.equal(itemBytes({ a: 1 }), 8)
})

test('newestThatFit keeps the newest items within the budget and the cap', () => {
  const items = [
    { id: 1, at: 10, text: 'a'.repeat(40) },
    { id: 2, at: 30, text: 'b'.repeat(40) },
    { id: 3, at: 20, text: 'c'.repeat(40) },
    { id: 4, at: 40, text: 'd'.repeat(40) }
  ]
  const each = itemBytes(items[0])
  const kept = (budget: number, maxItems?: number) => {
    const set = newestThatFit(items, budget, item => item.at, maxItems)
    return items.filter(item => set.has(item)).map(item => item.id)
  }
  assert.deepEqual(kept(Infinity), [1, 2, 3, 4])
  assert.deepEqual(kept(3 * each), [2, 3, 4])
  assert.deepEqual(kept(3 * each - 1), [2, 4])
  assert.deepEqual(kept(Infinity, 1), [4])
  assert.deepEqual(kept(0), [])
})
