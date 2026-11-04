import { assert, test } from 'orca/testing'
import type { BoardConfig, PrChip, WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { capBoard, capSnapshot, foldChips } from './snapshot'

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

const BOARD = { boardId: 'board-stories' } as BoardConfig
const BOARD_BUDGET = 900 * 1024

function wide(id: number, changedAt: number): WorkItemSummary {
  return { id, changedAt, title: `${id} ${'é'.repeat(2_000)}` } as WorkItemSummary
}

test('capBoard keeps the newest items that fit in 900 KiB, in their order, and says how many', () => {
  const items = Array.from({ length: 400 }, (_, index) => wide(index, index % 2 === 0 ? 10_000 - index : index))
  const capped = capBoard({ board: BOARD, items, message: 'Linked PR status needs Code (Read) access.' }, false)
  const count = capped.items.length
  assert.ok(count > 100 && count < 400, String(count))
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= BOARD_BUDGET)
  const newest = [...items].sort((a, b) => b.changedAt - a.changedAt).slice(0, count)
  assert.deepEqual(capped.items, items.filter(item => newest.includes(item)))
  assert.equal(capped.message, `Linked PR status needs Code (Read) access. Showing the ${count} most recently changed items.`)
})

test('capBoard says how many are shown when the query hit its 500-item limit', () => {
  const items = [tiny(1, 1), tiny(2, 2)]
  assert.deepEqual(capBoard({ board: BOARD, items }, true), { board: BOARD, items, message: 'Showing the 2 most recently changed items.' })
})

test('capBoard returns a board that fits unchanged', () => {
  const result = { board: BOARD, items: [tiny(1, 1), tiny(2, 2)] }
  assert.equal(capBoard(result, false), result)
})

function chip(prId: number, target: string, state: PrChip['state'], build: PrChip['build'] = 'none'): PrChip {
  return { prId, repoId: 'repo-web', projectId: 'proj-web', target, state, build, url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${prId}` }
}

test('foldChips keeps one chip for each target branch, so PRs into dev, staging and master all show', () => {
  const chips = [chip(1, 'dev', 'merged'), chip(2, 'staging', 'merged'), chip(3, 'master', 'open', 'running')]
  assert.deepEqual(foldChips(chips), chips)
})

test('foldChips folds an abandoned PR and its replacement into the same branch to one chip', () => {
  assert.deepEqual(foldChips([chip(7, 'dev', 'abandoned'), chip(9, 'dev', 'open'), chip(8, 'master', 'open')]), [chip(9, 'dev', 'open'), chip(8, 'master', 'open')])
})

test('foldChips picks merged, then open with a failed build, a running build, open, then abandoned, and the highest PR id on a tie', () => {
  const ladder = [chip(1, 'dev', 'abandoned'), chip(2, 'dev', 'open', 'succeeded'), chip(3, 'dev', 'open', 'running'), chip(4, 'dev', 'open', 'failed'), chip(5, 'dev', 'merged')]
  for (let rank = 0; rank < ladder.length; rank += 1) {
    const candidates = ladder.slice(0, rank + 1)
    assert.deepEqual(foldChips(candidates), [ladder[rank]], `rank ${rank}`)
    assert.deepEqual(foldChips([...candidates].reverse()), [ladder[rank]], `rank ${rank}, reversed`)
  }
  assert.deepEqual(foldChips([chip(10, 'dev', 'open', 'none'), chip(12, 'dev', 'open', 'succeeded'), chip(11, 'dev', 'open', 'none')]), [chip(12, 'dev', 'open', 'succeeded')])
  assert.deepEqual(foldChips([chip(21, 'dev', 'merged'), chip(20, 'dev', 'merged')]), [chip(21, 'dev', 'merged')])
  assert.deepEqual(foldChips([chip(30, 'dev', 'abandoned'), chip(31, 'dev', 'abandoned')]), [chip(31, 'dev', 'abandoned')])
})
