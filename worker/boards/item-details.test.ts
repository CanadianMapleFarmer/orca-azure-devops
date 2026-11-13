import { assert, test } from 'orca/testing'
import type { TypeState } from '../ado/board-config'
import { CHILD_LINK, type PrRef, type RawWorkItem } from '../ado/workitems'
import { createEntities } from '../data/entities'
import { prKey, type PrRecord } from '../data/records'
import { fixture, ORG, ORG_URL, PROJECT, REPO } from './fake-ado'
import {
  detailsFresh,
  doneStateOf,
  MAX_DETAIL_TASKS,
  MAX_LINKED_READS,
  openStateOf,
  prRowsOf,
  recordOf,
  relationsKey,
  taskRowOf,
  withNewChild,
  withWrite
} from './item-details'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const HOME = 'Fabrikam Web'
const ITEM_URL = `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204`
const TASK_STATES = fixture<{ value: TypeState[] }>('states-task').value
const STATES: ReadonlyMap<string, TypeState[]> = new Map([['Task', TASK_STATES]])
const GRACE = { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }

function story(): RawWorkItem {
  return structuredClone(fixture<{ value: RawWorkItem[] }>('workitems-batch').value.find(raw => raw.id === 1204)!)
}

function children(): RawWorkItem[] {
  return fixture<{ value: RawWorkItem[] }>('workitems-children').value
}

const CHILD_IDS = children().map(child => child.id)

function withChildren(raw: RawWorkItem, ids: number[]): RawWorkItem {
  const links = ids.map(id => ({ rel: CHILD_LINK, url: `${ORG_URL}/_apis/wit/workItems/${id}`, attributes: { name: 'Child' } }))
  return { ...raw, relations: [...(raw.relations ?? []), ...links] }
}

function task(id: number, state: string, rev = 1): RawWorkItem {
  return {
    id,
    rev,
    url: `${ORG_URL}/${PROJECT}/_apis/wit/workItems/${id}`,
    fields: { 'System.Id': id, 'System.WorkItemType': 'Task', 'System.Title': `Task ${id}`, 'System.State': state, 'System.Parent': 1204 }
  }
}

function changed(raw: RawWorkItem, rev: number, fields: Record<string, unknown>): RawWorkItem {
  return { ...structuredClone(raw), rev, fields: { ...raw.fields, ...fields } }
}

function record(raw = withChildren(story(), CHILD_IDS), linked: RawWorkItem[] | null = children(), states: ReadonlyMap<string, TypeState[]> | null = STATES) {
  return recordOf({ raw, linked, states, chips: [], org: ORG, orgUrl: ORG_URL, projectId: PROJECT, home: HOME, itemUrl: ITEM_URL })
}

test('doneStateOf and openStateOf pick the first Completed, then the first In Progress or Proposed state', () => {
  assert.deepEqual([doneStateOf(TASK_STATES), openStateOf(TASK_STATES)], ['Closed', 'Active'])
  const plain = [
    { name: 'New', category: 'Proposed' },
    { name: 'Done', category: 'Completed' }
  ]
  assert.deepEqual([doneStateOf(plain), openStateOf(plain)], ['Done', 'New'])
  assert.equal(doneStateOf([{ name: 'New', category: 'Proposed' }]), null)
  assert.equal(openStateOf([{ name: 'Done', category: 'Completed' }]), null)
})

test('taskRowOf leaves out removed tasks and marks completed ones done', () => {
  const [active, closed, , removed] = children()
  assert.deepEqual(taskRowOf(active, TASK_STATES, ORG_URL, HOME), {
    id: 1213,
    rev: 1,
    type: 'Task',
    title: 'Write the filter tests',
    state: 'Active',
    done: false,
    assignedTo: 'Alex Contoso',
    doneState: 'Closed',
    openState: 'Active',
    url: `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1213`
  })
  assert.deepEqual([taskRowOf(closed, TASK_STATES, ORG_URL, HOME)?.done, taskRowOf(closed, TASK_STATES, ORG_URL, HOME)?.assignedTo], [true, 'Grace Hopper'])
  assert.equal(taskRowOf(removed, TASK_STATES, ORG_URL, HOME), null)

  const unknown = taskRowOf(active, undefined, ORG_URL, HOME)
  assert.deepEqual([unknown?.done, unknown?.doneState, unknown?.openState], [false, null, null])
  const elsewhere = changed(active, 1, { 'System.TeamProject': 'Contoso Ops' })
  assert.equal(taskRowOf(elsewhere, TASK_STATES, ORG_URL, HOME)?.url, `${ORG_URL}/Contoso%20Ops/_workitems/edit/1213`)
})

test('recordOf lists open tasks first, then done ones, by id, and counts the rest', () => {
  const built = record()
  assert.deepEqual(
    built.tasks.map(row => [row.id, row.done]),
    [
      [1210, false],
      [1213, false],
      [1209, true]
    ]
  )
  assert.deepEqual([built.moreTasks, built.tasksRead, built.rev, built.projectId, built.home], [0, true, 9, PROJECT, HOME])
  assert.deepEqual(built.links.map(link => [link.kind, link.title]), [
    ['parent', '#1100'],
    ['child', 'Write the filter tests'],
    ['child', 'Review the filter copy'],
    ['child', 'Add filter analytics'],
    ['child', 'Spike a saved-search endpoint'],
    ['pr', 'Pull request 321']
  ])

  const many = Array.from({ length: 52 }, (_, index) => task(5000 + index, index % 2 === 0 ? 'Closed' : 'Active'))
  const capped = record(withChildren(story(), many.map(child => child.id)), many)
  const open = many.filter(child => child.fields['System.State'] === 'Active').map(child => child.id)
  const done = many.filter(child => child.fields['System.State'] === 'Closed').map(child => child.id)
  assert.equal(capped.tasks.length, MAX_DETAIL_TASKS)
  assert.equal(capped.moreTasks, 2)
  assert.deepEqual(capped.tasks.map(row => row.id), [...open, ...done].slice(0, MAX_DETAIL_TASKS))
})

test('recordOf counts the children beyond the linked read as more', () => {
  const many = Array.from({ length: MAX_LINKED_READS + 5 }, (_, index) => task(6000 + index, 'Active'))
  const read = many.slice(0, MAX_LINKED_READS - 1)
  const built = record(withChildren(story(), many.map(child => child.id)), read)
  assert.equal(built.tasks.length, MAX_DETAIL_TASKS)
  assert.equal(built.moreTasks, read.length - MAX_DETAIL_TASKS + (many.length - read.length))
})

test('recordOf without the linked read has no rows and says so', () => {
  const unread = record(undefined, null)
  assert.deepEqual([unread.tasks, unread.moreTasks, unread.tasksRead], [[], 0, false])
  assert.deepEqual(
    unread.links.filter(link => link.kind !== 'pr').map(link => [link.title, link.url]),
    [1100, ...CHILD_IDS].map(id => [`#${id}`, `${ORG_URL}/Fabrikam%20Web/_workitems/edit/${id}`])
  )

  const stateless = record(undefined, children(), null)
  assert.deepEqual([stateless.tasks, stateless.moreTasks, stateless.tasksRead], [[], 0, false])
  assert.equal(stateless.links[1].title, 'Write the filter tests')
})

test('withWrite takes the body from the full raw when the relations are unchanged', () => {
  const before = record()
  const raw = changed(withChildren(story(), CHILD_IDS), 10, {
    'System.Description': '<p>Filter by <b>make</b>.</p>',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>Filters persist</li></ul>',
    'System.AssignedTo': GRACE
  })
  assert.deepEqual(withWrite(before, raw, STATES, ORG_URL, ITEM_URL), {
    ...before,
    rev: 10,
    descriptionMd: 'Filter by **make**.',
    acceptanceMd: '- Filters persist',
    assignee: GRACE
  })
})

test('withWrite drops the entry when the relations changed', () => {
  const before = record()
  const raw = withChildren(story(), CHILD_IDS)
  raw.rev = 10
  raw.relations = [...(raw.relations ?? []), { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F322`, attributes: { name: 'Pull Request' } }]
  assert.equal(withWrite(before, raw, STATES, ORG_URL, ITEM_URL), null)
  assert.equal(withWrite(before, { ...withChildren(story(), CHILD_IDS.slice(1)), rev: 10 }, STATES, ORG_URL, ITEM_URL), null)
})

test('withWrite ignores an older rev and leaves unrelated records alone', () => {
  const before = record()
  assert.equal(withWrite(before, { ...withChildren(story(), [5001]), rev: 8 }, STATES, ORG_URL, ITEM_URL), before)
  assert.equal(withWrite(before, task(4321, 'Closed', 3), STATES, ORG_URL, ITEM_URL), before)
  assert.equal(withWrite(before, changed(children()[1], 5, { 'System.State': 'Active' }), STATES, ORG_URL, ITEM_URL), before)
})

test('withWrite rebuilds the one task row it wrote', () => {
  const before = record()
  const ticked = withWrite(before, changed(children()[0], 2, { 'System.State': 'Closed' }), STATES, ORG_URL, ITEM_URL)
  assert.deepEqual(
    ticked?.tasks.map(row => [row.id, row.rev, row.state, row.done]),
    [
      [1210, 1, 'New', false],
      [1209, 6, 'Closed', true],
      [1213, 2, 'Closed', true]
    ]
  )
  assert.deepEqual([ticked?.rev, ticked?.links, ticked?.relations], [before.rev, before.links, before.relations])

  const removed = withWrite(before, changed(children()[0], 2, { 'System.State': 'Removed' }), STATES, ORG_URL, ITEM_URL)
  assert.deepEqual(removed?.tasks.map(row => row.id), [1210, 1209])
})

test('withNewChild extends the relations key, so the parent\'s next publish keeps the entry', () => {
  const before = record()
  const added = taskRowOf(task(5001, 'New'), TASK_STATES, ORG_URL, HOME)!
  const next = withNewChild(before, added)
  assert.deepEqual(next.tasks.map(row => row.id), [1210, 1213, 5001, 1209])
  assert.equal(next.rev, before.rev)
  assert.deepEqual(next.links.filter(link => link.kind === 'child').at(-1), { kind: 'child', title: 'Task 5001', url: added.url })
  assert.deepEqual(next.links.at(-1)?.kind, 'pr')

  const reloaded = { ...withChildren(story(), [...CHILD_IDS, 5001]), rev: 10 }
  assert.equal(next.relations, relationsKey(reloaded))
  assert.notEqual(withWrite(next, reloaded, STATES, ORG_URL, ITEM_URL), null)
  assert.equal(withWrite(before, reloaded, STATES, ORG_URL, ITEM_URL), null)
})

test('prRowsOf takes title, target and checks from the store, and a bare row when the store has none', () => {
  const tables = createEntities(() => T0).of(ORG)
  const open: PrRecord = {
    projectId: PROJECT,
    repoId: REPO,
    prId: 322,
    status: 'active',
    target: 'main',
    sourceCommit: 'c0ffee',
    reviewers: '',
    url: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322`,
    title: 'Fix pagination offset'
  }
  tables.prs.put(prKey(open), open)
  tables.prChecks.put(prKey(open), { build: 'failed', policies: 'rejected', commit: 'c0ffee', reviewers: '' })
  const ref = (prId: number): PrRef => ({ projectId: PROJECT, repoId: REPO, prId })

  assert.deepEqual(prRowsOf(ORG, [ref(321), ref(322), ref(322)], tables), [
    { prId: 322, title: 'Fix pagination offset', target: 'main', state: 'open', build: 'failed', policies: 'rejected', url: open.url },
    { prId: 321, title: null, target: null, state: null, build: null, policies: null, url: `${ORG_URL}/${PROJECT}/_git/${REPO}/pullrequest/321` }
  ])
})

test('detailsFresh needs the same rev and an age under 5 minutes', () => {
  const held = { value: record(), at: T0 }
  assert.equal(detailsFresh(held, 9, T0 + 299_999), true)
  assert.equal(detailsFresh(held, 9, T0 + 300_000), false)
  assert.equal(detailsFresh(held, 10, T0), false)
  assert.equal(detailsFresh(undefined, 9, T0), false)
})
