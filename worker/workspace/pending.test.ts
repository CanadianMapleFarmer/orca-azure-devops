import { assert, test } from 'orca/testing'
import { CLONE_CLAIM_MS, createPendingLinks, onItemBranch } from './pending'

const T0 = Date.parse('2026-11-11T09:00:00Z')
const MINUTE = 60_000
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ITEM = { org: 'contoso', itemId: 1204 }

function setup() {
  let now = T0
  return { pending: createPendingLinks(() => now), advance: (ms: number) => void (now += ms) }
}

test('onItemBranch matches the branch, and the -N name Orca gives a taken branch', () => {
  for (const actual of [BRANCH, `${BRANCH}-2`, `${BRANCH}-13`, `refs/heads/${BRANCH}`, `refs/heads/${BRANCH}-2`]) assert.equal(onItemBranch(actual, BRANCH), true, actual)
  for (const actual of [null, '', `${BRANCH}-`, `${BRANCH}-x`, `${BRANCH}-2a`, `${BRANCH}2`, `users/ada/${BRANCH}`, 'feature/1204-add', `${BRANCH}/sub`]) {
    assert.equal(onItemBranch(actual, BRANCH), false, String(actual))
  }
})

test('a pending link is claimed once by the workspace created on its branch', () => {
  const { pending } = setup()
  pending.expect({ ...ITEM, branch: BRANCH })
  assert.equal(pending.claim('main'), null)
  assert.deepEqual(pending.claim(`${BRANCH}-2`), ITEM)
  assert.equal(pending.claim(BRANCH), null)
})

test("an exact branch is claimed before another item's -N copy", () => {
  const { pending } = setup()
  pending.expect({ org: 'contoso', itemId: 1, branch: 'fix-1' })
  pending.expect({ org: 'contoso', itemId: 2, branch: 'fix-1-2' })
  assert.deepEqual(pending.claim('fix-1-2'), { org: 'contoso', itemId: 2 })
  assert.deepEqual(pending.claim('fix-1'), { org: 'contoso', itemId: 1 })
})

test('awaits says whether a pending link waits for a branch, without using it up', () => {
  const { pending, advance } = setup()
  pending.expect({ ...ITEM, branch: BRANCH })
  assert.equal(pending.awaits(BRANCH), true)
  assert.equal(pending.awaits(`${BRANCH}-2`), true)
  assert.equal(pending.awaits('main'), false)
  assert.deepEqual(pending.claim(BRANCH), ITEM)
  assert.equal(pending.awaits(BRANCH), false, 'claimed')

  pending.expect({ ...ITEM, branch: BRANCH })
  advance(2 * MINUTE + 1)
  assert.equal(pending.awaits(BRANCH), false, 'expired')
})

test('expecting says whether an item still waits for its workspace', () => {
  const { pending, advance } = setup()
  assert.equal(pending.expecting(ITEM), false)
  pending.expect({ ...ITEM, branch: BRANCH })
  assert.equal(pending.expecting(ITEM), true)
  assert.equal(pending.expecting({ org: 'contoso', itemId: 1205 }), false)
  assert.equal(pending.expecting({ org: 'fabrikam', itemId: 1204 }), false)
  pending.claim(BRANCH)
  assert.equal(pending.expecting(ITEM), false, 'claimed')

  pending.expect({ ...ITEM, branch: BRANCH })
  advance(2 * MINUTE + 1)
  assert.equal(pending.expecting(ITEM), false, 'expired')
})

test('a pending link lasts two minutes', () => {
  const { pending, advance } = setup()
  pending.expect({ ...ITEM, branch: BRANCH })
  advance(2 * MINUTE)
  assert.deepEqual(pending.claim(BRANCH), ITEM)

  pending.expect({ ...ITEM, branch: BRANCH })
  advance(2 * MINUTE + 1)
  assert.equal(pending.claim(BRANCH), null)
})

test('pending links of several items wait side by side, and a newer one for the same item replaces the older', () => {
  const { pending } = setup()
  pending.expect({ ...ITEM, branch: 'feature/1204-old' })
  pending.expect({ org: 'contoso', itemId: 1205, branch: 'feature/1205-other' })
  pending.expect({ ...ITEM, branch: BRANCH })
  assert.equal(pending.claim('feature/1204-old'), null)
  assert.deepEqual(pending.claim('feature/1205-other'), { org: 'contoso', itemId: 1205 })
  assert.deepEqual(pending.claim(BRANCH), ITEM)
})

test('at most twenty links wait, and the oldest goes first', () => {
  const { pending } = setup()
  for (let id = 1; id <= 21; id += 1) pending.expect({ org: 'contoso', itemId: id, branch: `feature/${id}-x` })
  assert.equal(pending.claim('feature/1-x'), null)
  assert.deepEqual(pending.claim('feature/2-x'), { org: 'contoso', itemId: 2 })
  assert.deepEqual(pending.claim('feature/21-x'), { org: 'contoso', itemId: 21 })
})

test('a claimed link releases its files once, and so does a link a newer one replaces', () => {
  const { pending } = setup()
  const released: string[] = []
  pending.expect({ ...ITEM, branch: BRANCH, release: () => released.push('first') })
  pending.expect({ ...ITEM, branch: BRANCH, release: () => released.push('second') })
  assert.deepEqual(released, ['first'])
  pending.claim(BRANCH)
  assert.deepEqual(released, ['first', 'second'])
})

test('the oldest of more than twenty links releases its files', () => {
  const { pending } = setup()
  const released: number[] = []
  for (let id = 1; id <= 21; id += 1) pending.expect({ org: 'contoso', itemId: id, branch: `feature/${id}-x`, release: () => released.push(id) })
  assert.deepEqual(released, [1])
})

test('forget drops the pending link of an attempt that never ran, and releases its files', () => {
  const { pending } = setup()
  const released: string[] = []
  pending.expect({ ...ITEM, branch: BRANCH, release: () => released.push('files') })
  pending.forget({ org: 'contoso', itemId: 1205 })
  assert.equal(pending.expecting(ITEM), true)
  pending.forget(ITEM)
  assert.equal(pending.expecting(ITEM), false)
  assert.equal(pending.claim(BRANCH), null)
  assert.deepEqual(released, ['files'])
})

const itemNamed = (itemId: number) => (ref: { itemId: number }) => ref.itemId === itemId

test("a started agent is tied to the terminal whose launch prompt names the item, and only that terminal's work counts", () => {
  const { pending } = setup()
  pending.expectAgent(ITEM)
  assert.equal(pending.working('term-agent'), null, 'not tied yet')
  assert.equal(pending.tie('term-other', itemNamed(1205)), null, 'another item')
  assert.deepEqual(pending.tie('term-agent', itemNamed(1204)), ITEM)
  assert.equal(pending.tie('term-again', itemNamed(1204)), null, 'tied once')
  assert.equal(pending.working('term-other'), null)
  assert.deepEqual(pending.working('term-agent'), ITEM)
  assert.equal(pending.working('term-agent'), null, 'heard once')
})

test('a terminal is never tied to an agent nobody started', () => {
  const { pending } = setup()
  assert.equal(pending.tie('term-agent', itemNamed(1204)), null)
  assert.equal(pending.working('term-agent'), null)
})

test('a started agent waits ten minutes to be tied, and a tied terminal ten minutes to work', () => {
  const { pending, advance } = setup()
  pending.expectAgent(ITEM)
  advance(10 * MINUTE + 1)
  assert.equal(pending.tie('term-agent', itemNamed(1204)), null)

  pending.expectAgent(ITEM)
  pending.tie('term-agent', itemNamed(1204))
  advance(10 * MINUTE + 1)
  assert.equal(pending.working('term-agent'), null)
})

test("a clone's link can be claimed for 10 minutes while the item's start guard ends after 2", () => {
  const { pending, advance } = setup()
  assert.equal(CLONE_CLAIM_MS, 10 * MINUTE)
  pending.expect({ ...ITEM, branch: BRANCH, claimMs: CLONE_CLAIM_MS })
  advance(2 * MINUTE + 1)
  assert.equal(pending.expecting(ITEM), false)
  assert.equal(pending.awaits(BRANCH), true)
  advance(8 * MINUTE - 1)
  assert.deepEqual(pending.claim(BRANCH), ITEM)

  pending.expect({ ...ITEM, branch: BRANCH, claimMs: CLONE_CLAIM_MS })
  advance(10 * MINUTE + 1)
  assert.equal(pending.awaits(BRANCH), false)
  assert.equal(pending.claim(BRANCH), null)
})

test('the agent watch runs from the claim, so an agent working 9 minutes after an 8-minute clone still counts', () => {
  const { pending, advance } = setup()
  pending.expect({ ...ITEM, branch: BRANCH, claimMs: CLONE_CLAIM_MS })
  pending.expectAgent(ITEM)
  advance(8 * MINUTE)
  assert.deepEqual(pending.claim(BRANCH), ITEM)
  advance(9 * MINUTE)
  assert.deepEqual(pending.tie('term-agent', itemNamed(1204)), ITEM)
  assert.deepEqual(pending.working('term-agent'), ITEM)

  pending.expect({ ...ITEM, branch: BRANCH })
  pending.expectAgent(ITEM)
  advance(MINUTE)
  pending.claim(BRANCH)
  advance(10 * MINUTE)
  assert.deepEqual(pending.tie('term-quick', itemNamed(1204)), ITEM, 'every start watches from the claim')
})

test('at most twenty started agents wait, and the oldest goes first', () => {
  const { pending } = setup()
  for (let itemId = 1; itemId <= 21; itemId += 1) pending.expectAgent({ org: 'contoso', itemId })
  assert.equal(pending.tie('term-1', itemNamed(1)), null)
  assert.deepEqual(pending.tie('term-21', itemNamed(21)), { org: 'contoso', itemId: 21 })
})
