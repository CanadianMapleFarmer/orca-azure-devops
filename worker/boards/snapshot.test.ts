import { assert, test } from 'orca/testing'
import type { WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { capSnapshot } from './snapshot'

function tiny(id: number, changedAt: number): WorkItemSummary {
  return { id, changedAt } as WorkItemSummary
}

function snapshotOf(mine: WorkItemSummary[], other: WorkItemSummary[] = []): WorkSnapshot {
  return { org: 'contoso', board: null, mine, other, nudges: [], updatedAt: 0, stale: false }
}

test('capSnapshot keeps the 1,000 most recently changed items across mine and other', () => {
  const mine = Array.from({ length: 700 }, (_, index) => tiny(index, 2 * index))
  const other = Array.from({ length: 500 }, (_, index) => tiny(1000 + index, 2 * index + 1))
  const nudges = [{ itemId: 699, prId: 1, branch: 'main', toColumn: 'Done' }, { itemId: 0, prId: 2, branch: 'main', toColumn: 'Done' }]
  const capped = capSnapshot({ ...snapshotOf(mine, other), nudges, message: 'Linked PR status needs Code (Read) access.' })
  assert.equal(capped.mine.length + capped.other.length, 1000)
  assert.ok(capped.mine.every(item => item.changedAt >= 200))
  assert.ok(capped.other.every(item => item.changedAt >= 200))
  assert.deepEqual(capped.mine.slice(0, 2).map(item => item.id), [100, 101], 'each list keeps its order')
  assert.deepEqual(capped.nudges.map(nudge => nudge.itemId), [699])
  assert.equal(capped.message, 'Linked PR status needs Code (Read) access. Showing the 1,000 most recently changed items.')
})

test('capSnapshot returns a snapshot that fits unchanged', () => {
  const snapshot = snapshotOf([tiny(1, 1), tiny(2, 2)])
  assert.equal(capSnapshot(snapshot), snapshot)
})
