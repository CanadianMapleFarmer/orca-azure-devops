import { assert, test } from 'orca/testing'
import { NO_FAMILIES, type BoardConfig, type PrChip, type TaskList, type WorkFamilies, type WorkItemSummary, type WorkParent, type WorkSnapshot, type WorkTask } from '../../src/shared/work'
import { loadBoardConfig } from '../ado/board-config'
import { createAdoHttp } from '../ado/http'
import { toRecord, type RawWorkItem } from '../ado/workitems'
import { byteLength, POST_BUDGET_BYTES } from '../budget'
import { createEntities } from '../data/entities'
import { addChildren, fakeAdo, fixture, isBatch, isHydrate, ORG, ORG_URL, PROJECT, TEAM, WEF } from './fake-ado'
import { capBoard, capSnapshot, createItemSource, FAMILY_BUDGET_BYTES, foldChips, loadBoardItems, loadMine, patchFamilies } from './snapshot'

function tiny(id: number, changedAt: number): WorkItemSummary {
  return { id, changedAt } as WorkItemSummary
}

function snapshotOf(mine: WorkItemSummary[], other: WorkItemSummary[] = []): WorkSnapshot {
  return { org: 'contoso', board: null, mine, other, nudges: [], families: NO_FAMILIES, updatedAt: 0, stale: false }
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

function full(id: number, changedAt: number, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    org: 'contoso',
    id,
    rev: 3,
    type: 'User Story',
    title: `Add the saved search filter for dealer stock number ${id}`,
    state: 'Active',
    column: 'Active',
    columnDone: false,
    lane: null,
    assignedTo: 'Alex Contoso',
    parentId: 900 + (id % 10),
    parentTitle: 'Vehicle search and saved filters',
    changedAt,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/${id}`,
    prs: [chip(id * 10, 'dev', 'merged'), chip(id * 10 + 1, 'main', 'open', 'running')],
    targets: { columns: ['New', 'Active', 'In Review', 'Resolved', 'Closed'], states: [] },
    ...over
  }
}

function taskOf(id: number, over: Partial<WorkTask> = {}): WorkTask {
  return { id, title: `Write the tests for filter case ${id}`, state: 'Active', done: false, assignee: 'Grace Hopper', mine: false, ...over }
}

function parentOf(id: number): WorkParent {
  return { id, type: 'User Story', title: `Show saved searches on the dealer page ${id}`, state: 'Active', column: 'Active', lane: 'Expedite' }
}

function listOf(parentId: number, tasks: WorkTask[], over: Partial<TaskList> = {}): TaskList {
  return { parentId, tasks, total: tasks.length, done: tasks.filter(task => task.done).length, ...over }
}

function asTasks(id: number, parentId: number): WorkItemSummary {
  return full(id, id, { type: 'Task', column: null, parentId, targets: { columns: [], states: ['New', 'Active', 'Closed'] } })
}

test('150 items with 300 tasks fit the post budget whole', () => {
  const mine = Array.from({ length: 140 }, (_, index) => full(5000 + index, index))
  const other = Array.from({ length: 10 }, (_, index) => asTasks(6000 + index, 7000 + index))
  const pair = (id: number) => [taskOf(id * 10, { mine: true, assignee: 'Alex Contoso' }), taskOf(id * 10 + 1, { done: true, state: 'Closed' })]
  const families: WorkFamilies = {
    parents: other.map(item => parentOf(item.parentId!)),
    lists: [...mine.map(item => listOf(item.id, pair(item.id))), ...other.map(item => listOf(item.parentId!, pair(item.parentId!)))]
  }
  assert.equal(families.lists.flatMap(list => list.tasks).length, 300)
  const snapshot = { ...snapshotOf(mine, other), families }
  const capped = capSnapshot(snapshot)
  assert.equal(capped, snapshot, 'nothing is trimmed')
  assert.ok(byteLength(capped) < POST_BUDGET_BYTES, String(byteLength(capped)))
})

test('a snapshot at the item budget posts the same items with families as without', () => {
  const mine = Array.from({ length: 600 }, (_, index) => full(5000 + index, 10_000 - index, { title: `${5000 + index} ${'é'.repeat(250)}` }))
  const families: WorkFamilies = { parents: [], lists: mine.map(item => listOf(item.id, [taskOf(item.id * 10)])) }
  const without = capSnapshot(snapshotOf(mine))
  const withFamilies = capSnapshot({ ...snapshotOf(mine), families })
  assert.ok(without.mine.length > 100 && without.mine.length < 600, String(without.mine.length))
  assert.deepEqual(withFamilies.mine, without.mine)
  assert.equal(withFamilies.message, without.message)
  assert.ok(byteLength(withFamilies) <= POST_BUDGET_BYTES, String(byteLength(withFamilies)))
  const kept = families.lists.filter(list => without.mine.some(item => item.id === list.parentId))
  const posted = withFamilies.families.lists
  assert.ok(posted.length < kept.length, 'what does not fit drops from the end')
  assert.deepEqual(posted.map(list => list.parentId), kept.slice(0, posted.length).map(list => list.parentId))
})

test("families over the budget keep every list's counts and trim tasks from the end", () => {
  const mine = Array.from({ length: 40 }, (_, index) => full(5000 + index, index))
  const other = Array.from({ length: 5 }, (_, index) => asTasks(6000 + index, 7000 + index))
  const long = (id: number, n: number) => taskOf(id * 100 + n, { title: `${'Write the filter tests and the copy '.repeat(5)}${n}` })
  const lists = mine.map(item => listOf(item.id, Array.from({ length: 20 }, (_, n) => long(item.id, n)), { total: 25, done: 3 }))
  const parents = other.map(item => parentOf(item.parentId!))
  assert.ok(byteLength({ lists, parents }) > 2 * FAMILY_BUDGET_BYTES)

  const capped = capSnapshot({ ...snapshotOf(mine, other), families: { lists, parents } })
  assert.deepEqual([capped.mine, capped.other, capped.message], [mine, other, undefined])
  assert.deepEqual(capped.families.parents, parents)
  assert.deepEqual(capped.families.lists.map(list => [list.parentId, list.total, list.done]), lists.map(list => [list.parentId, 25, 3]))
  capped.families.lists.forEach((list, index) => assert.deepEqual(list.tasks, lists[index].tasks.slice(0, list.tasks.length), `list ${index} keeps its start`))
  const shown = capped.families.lists.map(list => list.tasks.length)
  const cut = shown.findIndex(count => count < 20)
  assert.ok(cut > 0, JSON.stringify(shown))
  assert.ok(shown.slice(cut + 1).every(count => count === 0), `later lists lose their tasks first: ${JSON.stringify(shown)}`)
  assert.ok(byteLength(capped.families) <= FAMILY_BUDGET_BYTES, String(byteLength(capped.families)))
})

test('a list or dimmed parent whose item was cut by the item budget is dropped', () => {
  const mine = Array.from({ length: 1050 }, (_, index) => tiny(5000 + index, 10_000 - index))
  const other = [{ id: 8000, changedAt: 20_000, parentId: 7000 }, { id: 8001, changedAt: 0, parentId: 7001 }] as WorkItemSummary[]
  const families: WorkFamilies = {
    parents: [parentOf(7000), parentOf(7001)],
    lists: [5000, 6049, 7000, 7001, 8000, 8001].map(parentId => listOf(parentId, [taskOf(parentId * 10)]))
  }
  const capped = capSnapshot({ ...snapshotOf(mine, other), families })
  assert.equal(capped.mine.length + capped.other.length, 1000)
  assert.equal(capped.mine.some(item => item.id === 6049), false)
  assert.deepEqual(capped.other.map(item => item.id), [8000])
  assert.deepEqual(capped.families.parents.map(parent => parent.id), [7000])
  assert.deepEqual(capped.families.lists.map(list => list.parentId), [5000, 7000, 8000])
})

test('patchFamilies gives the matching row the item title, state and done, and keeps the done count true', () => {
  const families: WorkFamilies = {
    parents: [parentOf(7000)],
    lists: [listOf(1204, [taskOf(1207, { mine: true }), taskOf(1209, { done: true, state: 'Closed' })]), listOf(7000, [taskOf(1221)])]
  }
  const item = full(1207, 1, { type: 'Task', title: 'Write the filter and sort tests', state: 'Closed' })
  const patched = patchFamilies(families, item, true)
  assert.deepEqual(patched.lists[0], listOf(1204, [taskOf(1207, { mine: true, title: 'Write the filter and sort tests', state: 'Closed', done: true }), taskOf(1209, { done: true, state: 'Closed' })]))
  assert.equal(patched.lists[1], families.lists[1])
  assert.equal(patched.parents, families.parents)
  assert.deepEqual(patchFamilies(patched, { ...item, state: 'Active' }, false).lists[0].done, 1)
  assert.equal(patchFamilies(families, full(4242, 1), false), families, 'no matching row, nothing changes')
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

test('capSnapshot and capBoard keep the newest items that fit a budget they are given', () => {
  const budget = 160 * 1024
  const items = Array.from({ length: 400 }, (_, index) => wide(index, index))
  const snapshot = capSnapshot(snapshotOf(items), budget)
  const board = capBoard({ board: BOARD, items }, false, budget)
  for (const capped of [snapshot.mine, board.items]) {
    assert.ok(capped.length > 10 && capped.length < 100, String(capped.length))
    assert.equal(capped.at(-1)?.id, 399)
  }
  assert.ok(byteLength(snapshot) <= budget, String(byteLength(snapshot)))
  assert.ok(byteLength(board) <= budget, String(byteLength(board)))
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

const T0 = Date.parse('2026-11-04T09:00:00Z')
const ME = { id: '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b', uniqueName: 'alex@contoso.example' }

function sourced() {
  const ado = fakeAdo({ now: () => T0 })
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const tables = createEntities(() => T0).of(ORG)
  const source = createItemSource(http, ORG, ORG_URL, () => T0, tables)
  const hold = (id: number, over: Partial<RawWorkItem> = {}, withRelations = true) =>
    tables.workItems.put(String(id), toRecord({ ...structuredClone(ado.items.get(id)!), ...over }, withRelations))
  return { ado, http, tables, source, hold }
}

test('items hydrates only stale, missing or relation-less records and serves the rest from the store', async () => {
  const { ado, source, hold } = sourced()
  hold(1204)
  hold(1205, {}, false)
  const items = await source.items(PROJECT, [1204, 1205, 1206], new Set())
  assert.deepEqual(ado.calls.filter(isBatch).map(call => call.body), [{ ids: [1205, 1206], $expand: 'relations', errorPolicy: 'omit' }])
  assert.deepEqual(items.map(item => [item.id, item.rev]), [[1204, 9], [1205, 3], [1206, 12]])
  assert.deepEqual(items.map(item => (item as { withRelations?: boolean }).withRelations), [true, true, true])
  assert.equal(source.revOf(1206), 12)

  await source.items(PROJECT, [1204, 1205, 1206], new Set([1204]))
  assert.deepEqual(ado.calls.filter(isBatch).at(-1)?.body.ids, [1204], 'a stale record is read again')
})

test('items returns the record the store kept, not an older one it fetched', async () => {
  const { ado, source, hold } = sourced()
  hold(1204, { rev: 10, fields: { ...ado.items.get(1204)!.fields, [`${WEF}.Column`]: 'Resolved' } })
  const [item] = await source.items(PROJECT, [1204], new Set([1204]))
  assert.equal(ado.count(isHydrate), 1)
  assert.deepEqual([item.rev, item.fields[`${WEF}.Column`]], [10, 'Resolved'])
})

test('items drops a record ADO no longer returns', async () => {
  const { ado, source, hold } = sourced()
  hold(1205)
  ado.remove(1205)
  const items = await source.items(PROJECT, [1204, 1205], new Set([1205]))
  assert.deepEqual(items.map(item => item.id), [1204])
  assert.equal(source.revOf(1205), undefined)
})

test('a task-fields read never replaces a record that has relations', async () => {
  const { ado, tables, source, hold } = sourced()
  hold(1207)
  const [task] = await source.fields(PROJECT, [1207], new Set([1207]))
  assert.equal(ado.calls.filter(isBatch).length, 1)
  assert.equal((task as { withRelations?: boolean }).withRelations, true)
  assert.equal(tables.workItems.get('1207')?.value.withRelations, true)

  const [fresh] = await source.fields(PROJECT, [1208], new Set())
  assert.deepEqual([fresh.id, (fresh as { withRelations?: boolean }).withRelations], [1208, false])
  await source.fields(PROJECT, [1207, 1208], new Set())
  assert.equal(ado.calls.filter(isBatch).length, 2, 'held tasks are served from the store')
})

test('forget drops the records of the ids it is given', () => {
  const { source, hold } = sourced()
  hold(1204)
  hold(1205)
  source.forget([1205])
  assert.deepEqual([source.revOf(1204), source.revOf(1205)], [9, undefined])
})

test('loadMine with nothing stale makes no work-item request, and that includes parents', async () => {
  const { ado, http, source } = sourced()
  addChildren(ado, 1204, fixture<{ value: RawWorkItem[] }>('workitems-children').value)
  const cfg = await loadBoardConfig(http, { org: ORG, projectId: PROJECT, teamId: TEAM })
  const members = [1204, 1207, 1205, 1208]
  const first = await loadMine(source, cfg, ME, { members, stale: new Set(members) })
  assert.deepEqual(ado.calls.filter(isBatch).map(call => call.body.ids), [members, [1100], [1213, 1209, 1210, 1211]])
  assert.deepEqual(first.known, [1204, 1207, 1205, 1208, 1100, 1213, 1209, 1210, 1211])

  const calls = ado.calls.length
  const again = await loadMine(source, cfg, ME, { members, stale: new Set() })
  assert.deepEqual(ado.calls.slice(calls), [])
  assert.deepEqual(again, first)
})

test('loadBoardItems projects the members it is given and knows their parents', async () => {
  const { ado, http, source } = sourced()
  const cfg = await loadBoardConfig(http, { org: ORG, projectId: PROJECT, teamId: TEAM })
  const loaded = await loadBoardItems(source, cfg, { members: [1204, 1205], stale: new Set([1204, 1205]) })
  assert.deepEqual(loaded.items.map(item => item.id), [1204, 1205])
  assert.deepEqual([loaded.truncated, loaded.known], [false, [1204, 1205, 1100]])
  assert.equal(loaded.items[0].parentTitle, 'Vehicle search')

  const calls = ado.calls.length
  assert.deepEqual(await loadBoardItems(source, cfg, { members: [1204, 1205], stale: new Set() }), loaded)
  assert.deepEqual(ado.calls.slice(calls), [])
})
