import { assert, test } from 'orca/testing'
import type { StorePort } from '../connections'
import { memoryStore } from '../test-support'
import { createBoardFilters, MAX_REMEMBERED_BOARDS } from './board-filters'
import { FEATURES, STORIES, TEAM } from './fake-ado'

function counted(store: StorePort): { store: StorePort; writes: () => number } {
  let writes = 0
  return {
    store: {
      get: key => store.get(key),
      set: async (key, value) => {
        writes++
        await store.set(key, value)
      }
    },
    writes: () => writes
  }
}

test('a board never opened uses Everyone', async () => {
  const { store } = memoryStore()
  assert.equal(await createBoardFilters(store).everyone('contoso', TEAM, STORIES), true)
})

test('a remembered filter comes back after a restart', async () => {
  const { data, store } = memoryStore()
  await createBoardFilters(store).remember('contoso', TEAM, STORIES, false)
  assert.deepEqual(data['boardFilters:contoso'], { [`${TEAM}/${STORIES}`]: false })
  assert.equal(await createBoardFilters(store).everyone('contoso', TEAM, STORIES), false)
})

test('filters are kept per board and per org', async () => {
  const { store } = memoryStore()
  const filters = createBoardFilters(store)
  await filters.remember('contoso', TEAM, STORIES, false)
  assert.equal(await filters.everyone('contoso', TEAM, FEATURES), true, 'another board')
  assert.equal(await filters.everyone('fabrikam', TEAM, STORIES), true, 'another org')
  await filters.remember('contoso', TEAM, STORIES, true)
  assert.equal(await filters.everyone('contoso', TEAM, STORIES), true, 'a later choice replaces the earlier one')
})

test('at most 50 boards are remembered per org, the oldest go first', async () => {
  const { data, store } = memoryStore()
  const filters = createBoardFilters(store)
  const boards = Array.from({ length: MAX_REMEMBERED_BOARDS + 2 }, (_, index) => `board-${index}`)
  for (const board of boards.slice(0, MAX_REMEMBERED_BOARDS)) await filters.remember('contoso', TEAM, board, false)
  await filters.remember('contoso', TEAM, boards[0], true)
  for (const board of boards.slice(MAX_REMEMBERED_BOARDS)) await filters.remember('contoso', TEAM, board, false)

  assert.equal(MAX_REMEMBERED_BOARDS, 50)
  const kept = Object.entries(data['boardFilters:contoso'] as Record<string, boolean>)
  assert.equal(kept.length, MAX_REMEMBERED_BOARDS)
  assert.deepEqual(kept.slice(0, 2), [[`${TEAM}/board-3`, false], [`${TEAM}/board-4`, false]], 'the oldest choices were dropped')
  assert.deepEqual(kept.slice(-3), [[`${TEAM}/board-0`, true], [`${TEAM}/board-50`, false], [`${TEAM}/board-51`, false]], 'a changed choice counts as new')
  assert.equal(await filters.everyone('contoso', TEAM, 'board-1'), true)
})

test('remembering the same choice writes nothing', async () => {
  const { store, writes } = counted(memoryStore().store)
  const filters = createBoardFilters(store)
  await filters.remember('contoso', TEAM, STORIES, false)
  await filters.remember('contoso', TEAM, STORIES, false)
  assert.equal(writes(), 1)
  await filters.remember('contoso', TEAM, FEATURES, true)
  assert.equal(writes(), 2, 'Everyone is stored once chosen, even though it is the default')
})

test('a malformed stored value is ignored', async () => {
  for (const stored of ['Everyone', [false], null, 42, { [`${TEAM}/${STORIES}`]: 'Me' }]) {
    const { store } = memoryStore({ 'boardFilters:contoso': stored })
    const filters = createBoardFilters(store)
    assert.equal(await filters.everyone('contoso', TEAM, STORIES), true, JSON.stringify(stored))
    await filters.remember('contoso', TEAM, FEATURES, false)
    assert.equal(await filters.everyone('contoso', TEAM, FEATURES), false, JSON.stringify(stored))
  }
})
