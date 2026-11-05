import { assert, test } from 'orca/testing'
import { scrollTopFor, windowOf } from './virtual'

const ROW = 18

test('windowOf and scrollTopFor place the rows', () => {
  assert.deepEqual(windowOf({ scrollTop: 0, viewport: 180, rowHeight: ROW, count: 1000 }), { start: 0, end: 30, offset: 0 })
  assert.deepEqual(windowOf({ scrollTop: 1800, viewport: 180, rowHeight: ROW, count: 1000 }), { start: 80, end: 130, offset: 80 * ROW })
  assert.deepEqual(windowOf({ scrollTop: 1800, viewport: 180, rowHeight: ROW, count: 1000, overscan: 0 }), { start: 100, end: 110, offset: 100 * ROW })
  assert.deepEqual(windowOf({ scrollTop: 1809, viewport: 180, rowHeight: ROW, count: 1000, overscan: 0 }), { start: 100, end: 111, offset: 100 * ROW })
  assert.deepEqual(windowOf({ scrollTop: 1800, viewport: 180, rowHeight: ROW, count: 105 }), { start: 80, end: 105, offset: 80 * ROW })
  assert.deepEqual(windowOf({ scrollTop: 0, viewport: 180, rowHeight: ROW, count: 0 }), { start: 0, end: 0, offset: 0 })
  assert.deepEqual(windowOf({ scrollTop: -40, viewport: 180, rowHeight: ROW, count: 1000 }), { start: 0, end: 30, offset: 0 })
  assert.deepEqual(windowOf({ scrollTop: 5000, viewport: 180, rowHeight: ROW, count: 10 }), { start: 10, end: 10, offset: 10 * ROW })

  const big = windowOf({ scrollTop: 45_000, viewport: 600, rowHeight: ROW, count: 5000 })
  assert.ok(big.end - big.start <= Math.ceil(600 / ROW) + 1 + 40, `${big.start}-${big.end}`)
  assert.ok(big.start <= 45_000 / ROW && big.end >= (45_000 + 600) / ROW)

  assert.equal(scrollTopFor(0, ROW, 600), 0)
  assert.equal(scrollTopFor(5, ROW, 600), 0)
  const top = scrollTopFor(100, ROW, 600)
  assert.equal(top, 1509)
  const shown = windowOf({ scrollTop: top, viewport: 600, rowHeight: ROW, count: 1000, overscan: 0 })
  assert.ok(shown.start <= 100 && 100 < shown.end)
  assert.ok(100 - shown.start >= 14 && shown.end - 100 >= 14)
})
