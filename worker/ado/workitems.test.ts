import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { BoardConfig } from '../../src/shared/work'
import { AdoError, createAdoHttp } from './http'
import {
  boardClause,
  CHILD_LINK,
  childIdsOf,
  deltaWiql,
  hydrate,
  isDatePrecisionError,
  KEPT_FIELDS,
  membershipWiql,
  mineClause,
  parsePrRef,
  queryIdsAt,
  readFields,
  readRevs,
  stillInWiql,
  TASK_FIELDS,
  toRecord,
  toSummary,
  type RawWorkItem
} from './workitems'

const ORG = 'contoso'
const ORG_URL = `https://dev.azure.com/${ORG}`
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const WEF = 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban'

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T
}

function config(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    org: ORG,
    projectId: PROJECT,
    teamId: TEAM,
    boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091',
    boardName: 'Stories',
    requirementTypes: ['User Story', 'Bug'],
    columns: [],
    lanes: [],
    fields: { column: `${WEF}.Column`, columnDone: `${WEF}.Column.Done`, lane: `${WEF}.Lane` },
    areaPaths: [
      { value: 'Fabrikam Web\\Platform', includeChildren: true },
      { value: 'Fabrikam Web\\Shared', includeChildren: false }
    ],
    doneStates: { 'User Story': ['Closed', 'Removed'], Bug: ['Closed'] },
    ...overrides
  }
}

interface Call { url: string; method: string; body: unknown }

function recorder(respond: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    calls.push(call)
    return new Response(JSON.stringify(await respond(call)), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer secret-token-value' })
  return { http, calls }
}

const SEARCH = [
  'SELECT [System.Id] FROM WorkItems WHERE',
  '[System.TeamProject] = @project',
  "AND [System.WorkItemType] IN ('User Story', 'Bug')",
  "AND ([System.AreaPath] UNDER 'Fabrikam Web\\Platform' OR [System.AreaPath] = 'Fabrikam Web\\Shared')"
].join(' ')
const RECENT_DONE = "([System.State] NOT IN ('Closed', 'Removed') OR [System.ChangedDate] >= @Today - 14)"
const NEWEST_FIRST = 'ORDER BY [System.ChangedDate] DESC'

test('the mine query excludes done states and escapes quotes', () => {
  assert.equal(
    membershipWiql(mineClause(['Closed', "Won't Fix"])),
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Won''t Fix') ORDER BY [System.ChangedDate] DESC"
  )
})

test('the mine query lists each done state once and drops the state clause when there are none', () => {
  assert(membershipWiql(mineClause(['Closed', 'Removed', 'Closed'])).includes("NOT IN ('Closed', 'Removed')"))
  assert.equal(
    membershipWiql(mineClause([])),
    'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC'
  )
})

test('the board query adds the area clause and the me filter', () => {
  assert.equal(membershipWiql(boardClause(config(), true)), `${SEARCH} AND ${RECENT_DONE} ${NEWEST_FIRST}`)
  assert.equal(membershipWiql(boardClause(config(), false)), `${SEARCH} AND [System.AssignedTo] = @Me AND ${RECENT_DONE} ${NEWEST_FIRST}`)
})

test('the board query escapes quotes in types, areas and states, and keeps one entry per done state', () => {
  const cfg = config({
    requirementTypes: ["Dealer's Story"],
    areaPaths: [{ value: "Fabrikam Web\\Owner's", includeChildren: true }],
    doneStates: { "Dealer's Story": ["Won't Fix", 'Closed'], Bug: ['Closed'], Task: ['Closed'] }
  })
  const query = membershipWiql(boardClause(cfg, true))
  assert(query.includes("[System.WorkItemType] IN ('Dealer''s Story')"))
  assert(query.includes("([System.AreaPath] UNDER 'Fabrikam Web\\Owner''s')"))
  assert(query.includes("[System.State] NOT IN ('Won''t Fix', 'Closed')"))
})

test('the board query without done states or area paths drops those clauses', () => {
  const query = membershipWiql(boardClause(config({ areaPaths: [], doneStates: {} }), true))
  assert.equal(query, `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') ${NEWEST_FIRST}`)
})

test('queryIdsAt posts the query to the team-scoped endpoint and returns the ids in order with asOf', async () => {
  const { http, calls } = recorder(() => fixture('wiql-board'))
  assert.deepEqual(await queryIdsAt(http, ORG, PROJECT, TEAM, 'SELECT [System.Id] FROM WorkItems', false), {
    ids: [1206, 1204, 1205],
    asOf: '2026-11-04T08:15:30.103Z'
  })
  assert.deepEqual(calls, [{
    url: `${ORG_URL}/${PROJECT}/${TEAM}/_apis/wit/wiql?$top=500&api-version=7.1`,
    method: 'POST',
    body: { query: 'SELECT [System.Id] FROM WorkItems' }
  }])
})

test('queryIdsAt sends timePrecision only when asked and returns asOf', async () => {
  const { http, calls } = recorder(() => ({ asOf: '2026-11-11T10:00:00.123Z', workItems: [{ id: 3 }, { id: 1 }] }))
  assert.deepEqual(await queryIdsAt(http, ORG, PROJECT, TEAM, 'q', true), { ids: [3, 1], asOf: '2026-11-11T10:00:00.123Z' })
  assert.deepEqual(await queryIdsAt(http, ORG, PROJECT, TEAM, 'q', false), { ids: [3, 1], asOf: '2026-11-11T10:00:00.123Z' })
  const endpoint = `${ORG_URL}/${PROJECT}/${TEAM}/_apis/wit/wiql`
  assert.deepEqual(calls.map(call => call.url), [`${endpoint}?$top=500&timePrecision=true&api-version=7.1`, `${endpoint}?$top=500&api-version=7.1`])
})

test('queryIdsAt returns an empty list when the query matches nothing', async () => {
  const { http } = recorder(() => ({ queryType: 'flat', asOf: '2026-11-11T10:00:00Z', workItems: [] }))
  assert.deepEqual(await queryIdsAt(http, ORG, PROJECT, TEAM, 'q', false), { ids: [], asOf: '2026-11-11T10:00:00Z' })
})

test('queryIdsAt treats a missing or unparsable asOf as malformed', async () => {
  for (const asOf of [undefined, 'yesterday', 42, '']) {
    const { http } = recorder(() => ({ asOf, workItems: [{ id: 1 }] }))
    await assert.rejects(queryIdsAt(http, ORG, PROJECT, TEAM, 'q', true), (error: unknown) => {
      assert.ok(error instanceof AdoError, String(asOf))
      assert.deepEqual([error.code, error.message], ['server', 'Azure DevOps returned an unexpected work item response.'], String(asOf))
      return true
    })
  }
})

test('deltaWiql puts the change-date clause first, scopes the clause to the project and lists known ids outside it', () => {
  assert.equal(
    deltaWiql('[System.AssignedTo] = @Me', "'2026-11-11T09:59:50.000Z'", [7, 9]),
    "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '2026-11-11T09:59:50.000Z' AND (([System.TeamProject] = @project AND ([System.AssignedTo] = @Me)) OR [System.Id] IN (7, 9)) ORDER BY [System.ChangedDate] DESC"
  )
  assert.equal(
    deltaWiql('[System.AssignedTo] = @Me', '@Today - 1', [7, 9]),
    'SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= @Today - 1 AND (([System.TeamProject] = @project AND ([System.AssignedTo] = @Me)) OR [System.Id] IN (7, 9)) ORDER BY [System.ChangedDate] DESC'
  )
  assert.equal(
    deltaWiql('[System.AssignedTo] = @Me', '@Today - 1', []),
    'SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= @Today - 1 AND (([System.TeamProject] = @project AND ([System.AssignedTo] = @Me))) ORDER BY [System.ChangedDate] DESC'
  )
})

test('stillInWiql asks which of the ids still match the clause in the project', () => {
  assert.equal(
    stillInWiql('[System.AssignedTo] = @Me', [2, 9]),
    'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([System.AssignedTo] = @Me) AND [System.Id] IN (2, 9)'
  )
})

test('readRevs reads only System.Id with errorPolicy omit and leaves out the ids it could not read', async () => {
  const { http, calls } = recorder(call => {
    const requested = (call.body as { ids: number[] }).ids
    return { count: requested.length, value: requested.map(id => (id === 8 ? null : { id, rev: id * 10, fields: { 'System.Id': id }, url: '' })) }
  })
  assert.deepEqual([...(await readRevs(http, ORG, PROJECT, [7, 8, 9]))], [[7, 70], [9, 90]])
  assert.deepEqual(calls.map(call => call.body), [{ ids: [7, 8, 9], fields: ['System.Id'], errorPolicy: 'omit' }])
})

test('isDatePrecisionError matches only the date-precision 400', () => {
  const precision = 'You cannot supply a time with the date when running a query using date precision.'
  assert.equal(isDatePrecisionError(new AdoError('bad_request', 400, precision)), true)
  assert.equal(isDatePrecisionError(new AdoError('bad_request', 400, 'TF51005: The query references a field that does not exist.')), false)
  assert.equal(isDatePrecisionError(new AdoError('server', 500, precision)), false)
  assert.equal(isDatePrecisionError(new Error(precision)), false)
  assert.equal(isDatePrecisionError(precision), false)
})

function rawItem(id: number): RawWorkItem {
  return { id, rev: 1, fields: {}, url: `${ORG_URL}/_apis/wit/workItems/${id}` }
}

test('hydrate splits into 200-id batches and keeps order', async () => {
  const ids = Array.from({ length: 450 }, (_, index) => 10_000 + index)
  const missing = new Set([10_005, 10_250])
  let inFlight = 0
  let maxInFlight = 0
  const { http, calls } = recorder(async call => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inFlight -= 1
    const requested = (call.body as { ids: number[] }).ids
    return { count: requested.length, value: requested.filter(id => !missing.has(id)).reverse().map(rawItem) }
  })
  const items = await hydrate(http, ORG, PROJECT, ids)
  assert.deepEqual(items.map(item => item.id), ids.filter(id => !missing.has(id)))
  assert.deepEqual(calls.map(call => (call.body as { ids: number[] }).ids.length), [200, 200, 50])
  assert.equal(maxInFlight, 1)
  for (const call of calls) {
    assert.equal(call.url, `${ORG_URL}/${PROJECT}/_apis/wit/workitemsbatch?api-version=7.1`)
    assert.equal(call.method, 'POST')
    assert.deepEqual(Object.keys(call.body as object).sort(), ['$expand', 'errorPolicy', 'ids'])
    assert.equal((call.body as { $expand: string }).$expand, 'relations')
    assert.equal((call.body as { errorPolicy: string }).errorPolicy, 'omit')
  }
})

test('hydrate skips the null entries ADO leaves for items it could not read', async () => {
  const { http } = recorder(call => {
    const requested = (call.body as { ids: number[] }).ids
    return { count: requested.length, value: requested.map(id => (id === 11 ? null : rawItem(id))) }
  })
  const items = await hydrate(http, ORG, PROJECT, [10, 11, 12])
  assert.deepEqual(items.map(item => item.id), [10, 12])
})

test('hydrate with no ids makes no request', async () => {
  const { http, calls } = recorder(() => ({ value: [] }))
  assert.deepEqual(await hydrate(http, ORG, PROJECT, []), [])
  assert.equal(calls.length, 0)
})

test('hydrate fails with a server error when the batch has no value list', async () => {
  const { http } = recorder(() => ({}))
  try {
    await hydrate(http, ORG, PROJECT, [1])
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'server')
    return
  }
  assert.fail('expected hydrate to fail')
})

test('childIdsOf reads child links only and skips malformed ones', () => {
  const link = (rel: unknown, url: unknown) => ({ rel, url, attributes: { name: 'Child' } }) as never
  const raw: RawWorkItem = {
    ...rawItem(1204),
    relations: [
      link('System.LinkTypes.Hierarchy-Reverse', `${ORG_URL}/_apis/wit/workItems/1100`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/1209`),
      link('System.LinkTypes.Related', `${ORG_URL}/_apis/wit/workItems/1300`),
      link('ArtifactLink', `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F321`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/1210`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/0`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/-4`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/12x`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/99999999999999999999`),
      link(CHILD_LINK, `${ORG_URL}/_apis/wit/workItems/`),
      link(CHILD_LINK, 1211),
      link(CHILD_LINK, undefined),
      null as never
    ]
  }
  assert.deepEqual(childIdsOf(raw), [1209, 1210])
  assert.deepEqual(childIdsOf(rawItem(1205)), [])
  assert.deepEqual(childIdsOf({ ...rawItem(1206), relations: {} as never }), [])
})

test('readFields posts the ids, the fields and errorPolicy omit without expanding relations, 200 ids a request', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => 20_000 + index)
  const { http, calls } = recorder(call => {
    const requested = (call.body as { ids: number[] }).ids
    return { count: requested.length, value: requested.map(id => (id === 20_007 ? null : { ...rawItem(id), fields: { 'System.Id': id } })) }
  })
  const items = await readFields(http, ORG, PROJECT, ids, TASK_FIELDS)
  assert.deepEqual(items.map(item => item.id), ids.filter(id => id !== 20_007), 'in order, without the null the account could not read')
  assert.deepEqual(TASK_FIELDS, ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo', 'System.Parent'])
  const url = `${ORG_URL}/${PROJECT}/_apis/wit/workitemsbatch?api-version=7.1`
  assert.deepEqual(calls.map(call => [call.url, call.method]), [[url, 'POST'], [url, 'POST']])
  assert.deepEqual(calls.map(call => call.body), [
    { ids: ids.slice(0, 200), fields: TASK_FIELDS, errorPolicy: 'omit' },
    { ids: ids.slice(200), fields: TASK_FIELDS, errorPolicy: 'omit' }
  ])
  assert.deepEqual(await readFields(http, ORG, PROJECT, [], TASK_FIELDS), [])
  assert.equal(calls.length, 2, 'no ids, no request')
})

function batchItem(id: number): RawWorkItem {
  const items = fixture<{ value: RawWorkItem[] }>('workitems-batch').value
  const item = items.find(candidate => candidate.id === id)
  return item ?? assert.fail(`no fixture item ${id}`)
}

test('toRecord keeps only the fields the views read and the child and PR links', () => {
  const raw = batchItem(1204)
  const otherBoard = 'WEF_8D2E3F4A5B6C4D7E9F0A1B2C3D4E5F60_Kanban.Column'
  const child = { rel: CHILD_LINK, url: `${ORG_URL}/_apis/wit/workItems/1209`, attributes: { name: 'Child' } }
  const wide: RawWorkItem = {
    ...raw,
    fields: { ...raw.fields, 'System.Description': '<p>Long text</p>', 'Microsoft.VSTS.Common.Priority': 2, [otherBoard]: 'Active', 'Custom.WEF_Kanban.Column': 'x' },
    relations: [...(raw.relations ?? []), child]
  }
  const record = toRecord(wide, true)
  assert.deepEqual(record, {
    id: 1204,
    rev: 9,
    url: raw.url,
    fields: { ...Object.fromEntries(Object.entries(raw.fields).filter(([name]) => name !== 'System.Description')), [otherBoard]: 'Active' },
    relations: [
      { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F321` },
      { rel: CHILD_LINK, url: `${ORG_URL}/_apis/wit/workItems/1209` }
    ],
    withRelations: true
  })
  assert.deepEqual([...KEPT_FIELDS].sort(), [
    'System.AreaPath', 'System.AssignedTo', 'System.ChangedDate', 'System.Id', 'System.IterationPath', 'System.Parent', 'System.State', 'System.TeamProject', 'System.Title', 'System.WorkItemType'
  ])
  assert.deepEqual(toSummary(record, config(), ORG_URL), toSummary(raw, config(), ORG_URL), 'the views read the same summary')
  assert.deepEqual(childIdsOf(record), [1209])

  const fieldsOnly = toRecord({ id: 1207, rev: 2, url: 'u', fields: { 'System.Id': 1207, 'System.Title': 'Task' } }, false)
  assert.deepEqual(fieldsOnly, { id: 1207, rev: 2, url: 'u', fields: { 'System.Id': 1207, 'System.Title': 'Task' }, withRelations: false })
  assert.deepEqual(toRecord({ ...raw, relations: [null, { rel: CHILD_LINK, url: 7 }] as never }, true).relations, [])
})

test('records keep the iteration path', () => {
  const raw = batchItem(1204)
  const fields = { ...raw.fields, 'System.IterationPath': 'Fabrikam Web\\Sprint 12' }
  assert.equal(toRecord({ ...raw, fields }, true).fields['System.IterationPath'], 'Fabrikam Web\\Sprint 12')
  assert.equal(toRecord({ ...raw, fields }, false).fields['System.IterationPath'], 'Fabrikam Web\\Sprint 12')
})

test('toSummary reads column, done flag, lane and parent from WEF fields', () => {
  const summary = toSummary(batchItem(1204), config(), ORG_URL)
  assert.deepEqual(summary, {
    org: ORG,
    id: 1204,
    rev: 9,
    type: 'User Story',
    title: 'Add vehicle search filters',
    state: 'Active',
    column: 'In Review',
    columnDone: true,
    lane: 'Expedite',
    assignedTo: 'Alex Contoso',
    parentId: 1100,
    changedAt: Date.parse('2026-11-03T14:20:11.5Z'),
    url: `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204`,
    prRefs: [{ projectId: PROJECT, repoId: REPO, prId: 321 }]
  })
})

test('toSummary maps absent board fields, assignee, parent and relations to null, false and none', () => {
  const summary = toSummary(batchItem(1205), config(), ORG_URL)
  assert.equal(summary.column, null)
  assert.equal(summary.columnDone, false)
  assert.equal(summary.lane, null)
  assert.equal(summary.assignedTo, null)
  assert.equal(summary.parentId, null)
  assert.deepEqual(summary.prRefs, [])
})

test('toSummary treats the done flag as true only when it is exactly true', () => {
  assert.equal(toSummary(batchItem(1206), config(), ORG_URL).columnDone, false)
  const withText = { ...batchItem(1204), fields: { ...batchItem(1204).fields, [`${WEF}.Column.Done`]: 'true' } }
  assert.equal(toSummary(withText, config(), ORG_URL).columnDone, false)
})

test('toSummary reads the column fields named by the board, not fixed names', () => {
  const cfg = config({ fields: { column: 'WEF_OTHER_Kanban.Column', columnDone: 'WEF_OTHER_Kanban.Column.Done', lane: 'WEF_OTHER_Kanban.Lane' } })
  const summary = toSummary(batchItem(1204), cfg, ORG_URL)
  assert.deepEqual([summary.column, summary.columnDone, summary.lane], [null, false, null])
})

test('toSummary keeps only PR artifact links', () => {
  const raw = batchItem(1204)
  const summary = toSummary({ ...raw, relations: [...(raw.relations ?? []), { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p%2Fr%2F7' }] }, config(), ORG_URL)
  assert.deepEqual(summary.prRefs, [
    { projectId: PROJECT, repoId: REPO, prId: 321 },
    { projectId: 'p', repoId: 'r', prId: 7 }
  ])
})

test('parsePrRef decodes the artifact url and rejects others', () => {
  assert.deepEqual(parsePrRef(`vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F321`), { projectId: PROJECT, repoId: REPO, prId: 321 })
  const rejected = [
    `vstfs:///Git/Commit/${PROJECT}%2F${REPO}%2F0a1b2c3d`,
    `vstfs:///Build/Build/42`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F321%2F9`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2Fabc`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F0`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F-4`,
    `vstfs:///Git/PullRequestId/%2F${REPO}%2F321`,
    `vstfs:///Git/PullRequestId/${PROJECT}%2F%2F321`,
    'vstfs:///Git/PullRequestId/%E0%A4%A',
    `https://dev.azure.com/${ORG}/_git/web-app/pullrequest/321`,
    ''
  ]
  for (const url of rejected) assert.equal(parsePrRef(url), null, url)
})
