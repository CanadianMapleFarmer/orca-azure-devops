import { assert, mount, test } from 'orca/testing'
import { foldedAfter, isFoldOpen, isOpenIn, MAX_OVERRIDES, override, setAllFolds, setFoldOpen, type Folds } from './folds'
import { closeCleanly } from './test-support'

const keys = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `g${from + index}`)

test('isOpenIn follows the natural state, then Collapse all or Expand all, then a group set by hand', () => {
  assert.equal(isOpenIn(undefined, 'g', true), true)
  assert.equal(isOpenIn(undefined, 'g', false), false)
  assert.equal(isOpenIn({ all: null, open: [], closed: [] }, 'g', false), false)

  const collapsed: Folds = { all: 'closed', open: [], closed: [] }
  const expanded: Folds = { all: 'open', open: [], closed: [] }
  assert.equal(isOpenIn(collapsed, 'g', true), false)
  assert.equal(isOpenIn(expanded, 'g', false), true)

  assert.equal(isOpenIn({ all: 'closed', open: ['g'], closed: [] }, 'g', false), true)
  assert.equal(isOpenIn({ all: 'closed', open: ['g'], closed: [] }, 'other', true), false)
  assert.equal(isOpenIn({ all: 'open', open: [], closed: ['g'] }, 'g', true), false)
  assert.equal(isOpenIn({ all: null, open: ['g'], closed: [] }, 'g', false), true)
  assert.equal(isOpenIn({ all: null, open: [], closed: ['g'] }, 'g', true), false)
})

test('override records a group set by hand, open or closed, and keeps the newest 300', () => {
  assert.equal(MAX_OVERRIDES, 300)
  const closed = override(undefined, 'a', false)
  assert.deepEqual(closed, { all: null, open: [], closed: ['a'] })
  assert.deepEqual(override(closed, 'a', true), { all: null, open: ['a'], closed: [] })
  assert.deepEqual(override({ all: 'closed', open: [], closed: [] }, 'b', true), { all: 'closed', open: ['b'], closed: [] })
  assert.deepEqual(override({ all: null, open: ['a', 'b'], closed: [] }, 'a', true), { all: null, open: ['b', 'a'], closed: [] })

  let sameWay: Folds | undefined
  for (const key of keys(MAX_OVERRIDES + 1)) sameWay = override(sameWay, key, false)
  assert.deepEqual(sameWay, { all: null, open: [], closed: keys(MAX_OVERRIDES, 1) })
  assert.equal(isOpenIn(sameWay, 'g0', true), true)

  let alternating: Folds | undefined
  keys(MAX_OVERRIDES + 2).forEach((key, index) => {
    alternating = override(alternating, key, index % 2 === 0)
  })
  assert.equal((alternating?.open.length ?? 0) + (alternating?.closed.length ?? 0), MAX_OVERRIDES)
  assert.deepEqual(alternating?.open.slice(0, 2), ['g2', 'g4'])
  assert.deepEqual(alternating?.closed.slice(0, 2), ['g3', 'g5'])
  assert.deepEqual([alternating?.open.at(-1), alternating?.closed.at(-1)], ['g300', 'g301'])

  let mixed: Folds | undefined
  for (const key of keys(MAX_OVERRIDES)) mixed = override(mixed, key, true)
  mixed = override(mixed, 'last', false)
  assert.deepEqual(mixed, { all: null, open: keys(MAX_OVERRIDES - 1, 1), closed: ['last'] })
})

test('a task list closed by hand stays closed after its default changes', () => {
  const closed = override(undefined, 'tasks:1204', false)
  assert.equal(isOpenIn(closed, 'tasks:1204', false), false)
  assert.equal(isOpenIn(closed, 'tasks:1204', true), false)

  const opened = override(undefined, 'tasks:1204', true)
  assert.equal(isOpenIn(opened, 'tasks:1204', true), true)
  assert.equal(isOpenIn(opened, 'tasks:1204', false), true)
})

test('folds are remembered per organisation and tab and survive a panel reload', async () => {
  const panel = await mount(() => null)
  assert.equal(isFoldOpen('contoso', 'work', 'tasks:1204'), true)

  setFoldOpen('contoso', 'work', 'tasks:1204', false)
  setFoldOpen('contoso', 'prs', 'mine/project:p1', false)
  await panel.settled()
  assert.equal(isFoldOpen('contoso', 'work', 'tasks:1204', true), false)
  assert.equal(isFoldOpen('contoso', 'work', 'tasks:1204', false), false)
  assert.equal(isFoldOpen('fabrikam', 'work', 'tasks:1204'), true)
  assert.equal(isFoldOpen('contoso', 'pipelines', 'tasks:1204'), true)

  setAllFolds('contoso', 'prs', true)
  setAllFolds('fabrikam', 'pipelines', false)
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.folds, {
    'contoso|work': { all: null, open: [], closed: ['tasks:1204'] },
    'contoso|prs': { all: 'open', open: [], closed: [] },
    'fabrikam|pipelines': { all: 'closed', open: [], closed: [] }
  })

  const plugin = panel.persisted.plugin
  await closeCleanly(panel)
  const reloaded = await mount(() => null, { persisted: { plugin } })
  assert.equal(isFoldOpen('contoso', 'work', 'tasks:1204'), false)
  assert.equal(isFoldOpen('contoso', 'prs', 'mine/project:p1', false), true)
  assert.equal(isFoldOpen('fabrikam', 'pipelines', 'project:p1'), false)
  assert.equal(isFoldOpen('fabrikam', 'prs', 'project:p1'), true)
  await closeCleanly(reloaded)
})

test('a malformed remembered fold entry reads as natural and is rewritten whole', async () => {
  const panel = await mount(() => null, { persisted: { plugin: { folds: { 'contoso|prs': { all: 'sideways', open: 'g', closed: [3] } } } } })
  assert.equal(isFoldOpen('contoso', 'prs', 'g', false), false)
  assert.equal(isFoldOpen('contoso', 'prs', 'g', true), true)

  setFoldOpen('contoso', 'prs', 'g', false)
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.folds, { 'contoso|prs': { all: null, open: [], closed: ['g'] } })
  await closeCleanly(panel)
})

test('foldedAfter still adds a closed fold once and removes it when opened', () => {
  assert.deepEqual(foldedAfter(['a'], 'b', false), ['a', 'b'])
  assert.deepEqual(foldedAfter(['a', 'b'], 'b', false), ['a', 'b'])
  assert.deepEqual(foldedAfter(['a', 'b'], 'a', true), ['b'])
})
