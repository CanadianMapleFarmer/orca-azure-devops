import { assert, test } from 'orca/testing'
import type { BoardColumn, BoardConfig, WorkItemSummary } from '../../src/shared/work'
import { AdoError, createAdoHttp } from './http'
import { buildMovePatch, moveItem, stateTargets, targetsFor, type MoveTarget } from './move'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const WEF = 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban'
const COLUMN = `${WEF}.Column`
const COLUMN_DONE = `${WEF}.Column.Done`
const LANE = `${WEF}.Lane`
const CONFLICT_MESSAGE = "Someone else changed this item. It's been refreshed; try again."
const COLUMN_MISSING = "That column isn't on this board."
const LANE_MISSING = "That lane isn't on this board."
const UNMAPPED_TYPE = "This item type isn't on the board. Move it by state instead."
const MOVE_BY_COLUMN = 'Move this item by column.'
const INCOMPLETE_CONFIG = "This board's configuration is incomplete. Try refreshing."

function column(id: string, name: string, stateMappings: Record<string, string>, extra: Partial<BoardColumn> = {}): BoardColumn {
  return { id, name, isSplit: false, columnType: 'inProgress', stateMappings, ...extra }
}

function config(): BoardConfig {
  return {
    org: ORG,
    projectId: PROJECT,
    teamId: TEAM,
    boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091',
    boardName: 'Stories',
    requirementTypes: ['User Story', 'Bug'],
    columns: [
      column('c1', 'New', { 'User Story': 'New', Bug: 'New' }, { columnType: 'incoming' }),
      column('c2', 'Active', { 'User Story': 'Active', Bug: 'Active' }),
      column('c3', 'In Review', { 'User Story': 'Active' }, { isSplit: true }),
      column('c4', 'Resolved', { 'User Story': 'Resolved', Bug: 'Resolved' }),
      column('c5', 'Closed', { 'User Story': 'Closed', Bug: 'Closed' }, { columnType: 'outgoing' })
    ],
    lanes: [
      { id: '00000000-0000-0000-0000-000000000000', name: '' },
      { id: '48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7', name: 'Expedite' }
    ],
    fields: { column: COLUMN, columnDone: COLUMN_DONE, lane: LANE },
    areaPaths: [],
    doneStates: { 'User Story': ['Closed'], Bug: ['Closed'] }
  }
}

function withFields(fields: Partial<BoardConfig['fields']>): BoardConfig {
  const cfg = config()
  return { ...cfg, fields: { ...cfg.fields, ...fields } }
}

function item(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    org: ORG,
    id: 42,
    rev: 7,
    type: 'User Story',
    title: 'Add the export button',
    state: 'New',
    column: 'New',
    columnDone: false,
    lane: null,
    assignedTo: null,
    parentId: null,
    parentTitle: null,
    changedAt: 0,
    url: `https://dev.azure.com/${ORG}/Fabrikam%20Web/_workitems/edit/42`,
    prs: [],
    targets: { columns: [], states: [] },
    ...overrides
  }
}

const TEST_REV = { op: 'test', path: '/rev', value: 7 }

function failure(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

async function rejection(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function assertRefused(run: () => unknown, message: string): void {
  const error = failure(run)
  assert.equal(error.code, 'bad_request')
  assert.equal(error.status, 400)
  assert.equal(error.message, message)
}

test('column move sets state and the WEF column', () => {
  const patch = buildMovePatch(item(), config(), { column: 'Resolved' })
  assert.deepEqual(patch, [
    TEST_REV,
    { op: 'replace', path: '/fields/System.State', value: 'Resolved' },
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'Resolved' }
  ])
})

test('System.State is written only when the mapped state differs', () => {
  const patch = buildMovePatch(item({ state: 'Active', column: 'Active' }), config(), { column: 'Resolved' })
  assert.deepEqual(patch.map(op => op.path), ['/rev', '/fields/System.State', `/fields/${COLUMN}`])
  const same = buildMovePatch(item({ state: 'Resolved', column: 'Active' }), config(), { column: 'Resolved' })
  assert.deepEqual(same.map(op => op.path), ['/rev', `/fields/${COLUMN}`])
})

test('split column writes Column.Done=false', () => {
  const patch = buildMovePatch(item({ state: 'Active', column: 'Active' }), config(), { column: 'In Review' })
  assert.deepEqual(patch, [
    TEST_REV,
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'In Review' },
    { op: 'replace', path: `/fields/${COLUMN_DONE}`, value: false }
  ])
})

test('moving into a split column from another state writes the state too', () => {
  const patch = buildMovePatch(item(), config(), { column: 'In Review' })
  assert.deepEqual(patch, [
    TEST_REV,
    { op: 'replace', path: '/fields/System.State', value: 'Active' },
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'In Review' },
    { op: 'replace', path: `/fields/${COLUMN_DONE}`, value: false }
  ])
})

test('a plain column never writes Column.Done', () => {
  const patch = buildMovePatch(item(), config(), { column: 'Active' })
  assert.equal(patch.some(op => op.path === `/fields/${COLUMN_DONE}`), false)
})

test('dropping a card on its own column is a no-op whether it is Doing or Done', () => {
  const done = item({ state: 'Active', column: 'In Review', columnDone: true })
  assert.deepEqual(buildMovePatch(done, config(), { column: 'In Review' }), [])
  const doing = item({ state: 'Active', column: 'In Review', columnDone: false })
  assert.deepEqual(buildMovePatch(doing, config(), { column: 'In Review' }), [])
})

test('a lane change in a split column keeps the card Done', () => {
  const done = item({ state: 'Active', column: 'In Review', columnDone: true })
  assert.deepEqual(buildMovePatch(done, config(), { column: 'In Review', lane: 'Expedite' }), [
    TEST_REV,
    { op: 'replace', path: `/fields/${LANE}`, value: 'Expedite' }
  ])
})

test('leaving the Done half of a split column writes Column.Done=false', () => {
  const done = item({ state: 'Active', column: 'In Review', columnDone: true })
  assert.deepEqual(buildMovePatch(done, config(), { column: 'Resolved' }), [
    TEST_REV,
    { op: 'replace', path: '/fields/System.State', value: 'Resolved' },
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'Resolved' },
    { op: 'replace', path: `/fields/${COLUMN_DONE}`, value: false }
  ])
})

test('a split column and a lane change make one patch', () => {
  const patch = buildMovePatch(item({ state: 'Active', column: 'Active' }), config(), { column: 'In Review', lane: 'Expedite' })
  assert.deepEqual(patch, [
    TEST_REV,
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'In Review' },
    { op: 'replace', path: `/fields/${COLUMN_DONE}`, value: false },
    { op: 'replace', path: `/fields/${LANE}`, value: 'Expedite' }
  ])
})

test('lane move writes only the lane field', () => {
  assert.deepEqual(buildMovePatch(item(), config(), { lane: 'Expedite' }), [
    TEST_REV,
    { op: 'replace', path: `/fields/${LANE}`, value: 'Expedite' }
  ])
})

test('moving back to the default lane writes the empty string', () => {
  const patch = buildMovePatch(item({ lane: 'Expedite' }), config(), { lane: '' })
  assert.deepEqual(patch, [TEST_REV, { op: 'replace', path: `/fields/${LANE}`, value: '' }])
})

test('a lane equal to the current one, or the default lane for an item without one, is a no-op', () => {
  assert.deepEqual(buildMovePatch(item({ lane: 'Expedite' }), config(), { lane: 'Expedite' }), [])
  assert.deepEqual(buildMovePatch(item({ lane: null }), config(), { lane: '' }), [])
})

test('a column and a lane together make one patch', () => {
  const patch = buildMovePatch(item(), config(), { column: 'Resolved', lane: 'Expedite' })
  assert.deepEqual(patch.map(op => op.path), ['/rev', '/fields/System.State', `/fields/${COLUMN}`, `/fields/${LANE}`])
})

test('a lane change alongside the same column leaves the column untouched', () => {
  const patch = buildMovePatch(item(), config(), { column: 'New', lane: 'Expedite' })
  assert.deepEqual(patch, [TEST_REV, { op: 'replace', path: `/fields/${LANE}`, value: 'Expedite' }])
})

test('the same column with the same split flag and no other change is a no-op', () => {
  assert.deepEqual(buildMovePatch(item(), config(), { column: 'New' }), [])
  assert.deepEqual(buildMovePatch(item(), config(), {}), [])
})

test('unmapped type moves by state only', () => {
  const task = item({ type: 'Task', state: 'To Do', column: null })
  assert.deepEqual(buildMovePatch(task, config(), { state: 'Doing' }), [
    TEST_REV,
    { op: 'replace', path: '/fields/System.State', value: 'Doing' }
  ])
  assertRefused(() => buildMovePatch(task, config(), { column: 'Active' }), UNMAPPED_TYPE)
  assertRefused(() => buildMovePatch(task, config(), { lane: 'Expedite' }), UNMAPPED_TYPE)
  assertRefused(() => buildMovePatch(task, config(), { state: 'Doing', column: 'Active' }), UNMAPPED_TYPE)
  assert.deepEqual(buildMovePatch(task, config(), { state: 'To Do' }), [])
})

test('a mapped type with no column moves by state with no board-field write, and the board can still place it', () => {
  const loose = item({ type: 'Bug', state: 'New', column: null })
  assert.deepEqual(buildMovePatch(loose, config(), { state: 'Active' }), [TEST_REV, { op: 'replace', path: '/fields/System.State', value: 'Active' }])
  assert.deepEqual(buildMovePatch(loose, config(), { column: 'Active' }), [
    TEST_REV,
    { op: 'replace', path: '/fields/System.State', value: 'Active' },
    { op: 'replace', path: `/fields/${COLUMN}`, value: 'Active' }
  ])
})

test('a mapped type cannot be moved by state', () => {
  assertRefused(() => buildMovePatch(item(), config(), { state: 'Active' }), MOVE_BY_COLUMN)
  assertRefused(() => buildMovePatch(item(), config(), { column: 'Active', state: 'Active' }), MOVE_BY_COLUMN)
})

test('unknown columns and lanes are refused', () => {
  assertRefused(() => buildMovePatch(item(), config(), { column: 'Backlog' }), COLUMN_MISSING)
  assertRefused(() => buildMovePatch(item(), config(), { lane: 'Blocked' }), LANE_MISSING)
  assertRefused(() => buildMovePatch(item(), config(), { column: 'Active', lane: 'Blocked' }), LANE_MISSING)
})

test('a column that does not map the item type is refused', () => {
  const bug = item({ type: 'Bug', state: 'Active', column: 'Active' })
  assertRefused(() => buildMovePatch(bug, config(), { column: 'In Review' }), COLUMN_MISSING)
})

test('an empty field name is refused only when the move would write it', () => {
  const noColumn = withFields({ column: '' })
  assertRefused(() => buildMovePatch(item(), noColumn, { column: 'Resolved' }), INCOMPLETE_CONFIG)
  assert.deepEqual(buildMovePatch(item(), noColumn, { column: 'New' }), [])
  assert.equal(buildMovePatch(item(), noColumn, { lane: 'Expedite' }).length, 2)

  const noDone = withFields({ columnDone: '' })
  assertRefused(() => buildMovePatch(item(), noDone, { column: 'In Review' }), INCOMPLETE_CONFIG)
  const doneCard = item({ state: 'Active', column: 'In Review', columnDone: true })
  assertRefused(() => buildMovePatch(doneCard, noDone, { column: 'Resolved' }), INCOMPLETE_CONFIG)
  assert.equal(buildMovePatch(item(), noDone, { column: 'Resolved' }).length, 3)

  const noLane = withFields({ lane: '' })
  assertRefused(() => buildMovePatch(item(), noLane, { lane: 'Expedite' }), INCOMPLETE_CONFIG)
  assert.deepEqual(buildMovePatch(item(), noLane, { lane: '' }), [])
  assert.equal(buildMovePatch(item(), noLane, { column: 'Resolved' }).length, 3)
})

test('an unmapped type moves by state even when the board field names are empty', () => {
  const task = item({ type: 'Task', state: 'To Do', column: null })
  const patch = buildMovePatch(task, withFields({ column: '', columnDone: '', lane: '' }), { state: 'Doing' })
  assert.deepEqual(patch, [TEST_REV, { op: 'replace', path: '/fields/System.State', value: 'Doing' }])
})

test('every non-empty patch starts with the rev guard', () => {
  const targets: MoveTarget[] = [{ column: 'Resolved' }, { column: 'In Review' }, { lane: 'Expedite' }, { column: 'Active', lane: 'Expedite' }]
  for (const to of targets) {
    const [first] = buildMovePatch(item({ rev: 19 }), config(), to)
    assert.deepEqual(first, { op: 'test', path: '/rev', value: 19 })
  }
})

test('targetsFor lists only columns that map the item type', () => {
  const targets = targetsFor(item(), config())
  assert.deepEqual(targets.columns, ['New', 'Active', 'In Review', 'Resolved', 'Closed'])
  assert.deepEqual(targets.lanes, ['', 'Expedite'])
  assert.deepEqual(targets.states, [])

  const bug = targetsFor(item({ type: 'Bug' }), config())
  assert.deepEqual(bug.columns, ['New', 'Active', 'Resolved', 'Closed'])
})

test('targetsFor offers an unmapped type no columns and no lanes', () => {
  assert.deepEqual(targetsFor(item({ type: 'Task' }), config()), { columns: [], lanes: [], states: [] })
})

test('stateTargets drops the current state and keeps the order', () => {
  assert.deepEqual(stateTargets(['To Do', 'Doing', 'Done'], 'Doing'), ['To Do', 'Done'])
  assert.deepEqual(stateTargets(['To Do', 'Doing'], 'Removed'), ['To Do', 'Doing'])
  assert.deepEqual(stateTargets([], 'Doing'), [])
})

interface Call { url: string; method: string; contentType: string | null; body: unknown }

function adoServer(respond: () => Response) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    })
    return respond()
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer test-credential' })
  return { http, calls }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('moveItem patches the work item with the rev guard and returns the new rev', async () => {
  const { http, calls } = adoServer(() => reply(200, { id: 42, rev: 8, fields: {} }))
  const rev = await moveItem(http, ORG, PROJECT, item(), config(), { column: 'Resolved' })
  assert.equal(rev, 8)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].url, `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workitems/42?api-version=7.1`)
  assert.equal(calls[0].contentType, 'application/json-patch+json')
  assert.deepEqual(calls[0].body, buildMovePatch(item(), config(), { column: 'Resolved' }))
})

test('moveItem sends nothing when the move changes nothing', async () => {
  const { http, calls } = adoServer(() => reply(200, { rev: 99 }))
  const rev = await moveItem(http, ORG, PROJECT, item({ rev: 12 }), config(), { column: 'New' })
  assert.equal(rev, 12)
  assert.equal(calls.length, 0)
})

test('moveItem refuses an invalid target before any request', async () => {
  const { http, calls } = adoServer(() => reply(200, { rev: 99 }))
  const error = await rejection(moveItem(http, ORG, PROJECT, item(), config(), { column: 'Backlog' }))
  assert.equal(error.message, COLUMN_MISSING)
  assert.equal(calls.length, 0)
})

test('moveItem refuses an incomplete board configuration before any request', async () => {
  const { http, calls } = adoServer(() => reply(200, { rev: 99 }))
  const error = await rejection(moveItem(http, ORG, PROJECT, item(), withFields({ column: '' }), { column: 'Resolved' }))
  assert.equal(error.code, 'bad_request')
  assert.equal(error.status, 400)
  assert.equal(error.message, INCOMPLETE_CONFIG)
  assert.equal(calls.length, 0)
})

test('a stale rev is refused and the item is reloaded', async () => {
  for (const status of [412, 409]) {
    const { http, calls } = adoServer(() => reply(status, { message: 'TF26071: This work item has been changed by someone else since you opened it.' }))
    const error = await rejection(moveItem(http, ORG, PROJECT, item(), config(), { column: 'Resolved' }))
    assert.equal(error.code, 'conflict')
    assert.equal(error.status, 409)
    assert.equal(error.message, CONFLICT_MESSAGE)
    assert.deepEqual((calls[0].body as unknown[])[0], TEST_REV)
  }
})

test('a rule violation keeps ADO message as a bad request', async () => {
  const message = 'TF401320: Rule Error for field State. Error code: InvalidNotEmpty, InvalidListValue.'
  const { http } = adoServer(() => reply(400, { message }))
  const error = await rejection(moveItem(http, ORG, PROJECT, item(), config(), { column: 'Resolved' }))
  assert.equal(error.code, 'bad_request')
  assert.equal(error.status, 400)
  assert.equal(error.message, message)
})

test('other ADO errors propagate unchanged', async () => {
  const forbidden = adoServer(() => reply(403, {}))
  const denied = await rejection(moveItem(forbidden.http, ORG, PROJECT, item(), config(), { column: 'Resolved' }))
  assert.equal(denied.code, 'forbidden')

  const broken = adoServer(() => reply(500, {}))
  const failed = await rejection(moveItem(broken.http, ORG, PROJECT, item(), config(), { column: 'Resolved' }))
  assert.equal(failed.code, 'server')
})

test('a response without a rev is reported as malformed', async () => {
  const { http } = adoServer(() => reply(200, { id: 42 }))
  const error = await rejection(moveItem(http, ORG, PROJECT, item(), config(), { column: 'Resolved' }))
  assert.equal(error.code, 'server')
  assert.equal(error.message, 'Azure DevOps returned an unexpected work item response.')
})
