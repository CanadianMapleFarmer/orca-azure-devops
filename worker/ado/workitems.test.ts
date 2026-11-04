import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { BoardConfig } from '../../src/shared/work'
import { createAdoHttp } from './http'
import { hydrate, parsePrRef, queryBoardIds, queryIds, toSummary, wiqlBoard, wiqlMine, type RawWorkItem } from './workitems'

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

test('wiqlMine excludes done states and escapes quotes', () => {
  assert.equal(
    wiqlMine(config(), ['Closed', "Won't Fix"]),
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Won''t Fix') ORDER BY [System.ChangedDate] DESC"
  )
})

test('wiqlMine lists each done state once and drops the state clause when there are none', () => {
  assert(wiqlMine(config(), ['Closed', 'Removed', 'Closed']).includes("NOT IN ('Closed', 'Removed')"))
  assert.equal(
    wiqlMine(config(), []),
    'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC'
  )
})

test('wiqlBoard adds the area clause and the me filter', () => {
  assert.equal(wiqlBoard(config(), true), `${SEARCH} AND ${RECENT_DONE} ${NEWEST_FIRST}`)
  assert.equal(wiqlBoard(config(), false), `${SEARCH} AND [System.AssignedTo] = @Me AND ${RECENT_DONE} ${NEWEST_FIRST}`)
})

test('wiqlBoard escapes quotes in types, areas and states, and keeps one entry per done state', () => {
  const cfg = config({
    requirementTypes: ["Dealer's Story"],
    areaPaths: [{ value: "Fabrikam Web\\Owner's", includeChildren: true }],
    doneStates: { "Dealer's Story": ["Won't Fix", 'Closed'], Bug: ['Closed'], Task: ['Closed'] }
  })
  const query = wiqlBoard(cfg, true)
  assert(query.includes("[System.WorkItemType] IN ('Dealer''s Story')"))
  assert(query.includes("([System.AreaPath] UNDER 'Fabrikam Web\\Owner''s')"))
  assert(query.includes("[System.State] NOT IN ('Won''t Fix', 'Closed')"))
})

test('wiqlBoard without done states or area paths drops those clauses', () => {
  const query = wiqlBoard(config({ areaPaths: [], doneStates: {} }), true)
  assert.equal(query, `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') ${NEWEST_FIRST}`)
})

test('queryIds posts the query to the team-scoped endpoint and returns the ids in order', async () => {
  const { http, calls } = recorder(() => fixture('wiql-board'))
  const ids = await queryIds(http, ORG, PROJECT, TEAM, 'SELECT [System.Id] FROM WorkItems')
  assert.deepEqual(ids, [1206, 1204, 1205])
  assert.deepEqual(calls, [{
    url: `${ORG_URL}/${PROJECT}/${TEAM}/_apis/wit/wiql?$top=500&api-version=7.1`,
    method: 'POST',
    body: { query: 'SELECT [System.Id] FROM WorkItems' }
  }])
})

test('queryBoardIds runs the board query and returns the ids', async () => {
  const { http, calls } = recorder(() => fixture('wiql-board'))
  const cfg = config()
  assert.deepEqual(await queryBoardIds(http, ORG, PROJECT, TEAM, cfg, false), [1206, 1204, 1205])
  assert.deepEqual(calls.map(call => [call.url, call.body]), [
    [`${ORG_URL}/${PROJECT}/${TEAM}/_apis/wit/wiql?$top=500&api-version=7.1`, { query: wiqlBoard(cfg, false) }]
  ])
})

test('queryBoardIds returns no ids without a request when the board maps no work item type', async () => {
  const { http, calls } = recorder(() => fixture('wiql-board'))
  assert.deepEqual(await queryBoardIds(http, ORG, PROJECT, TEAM, config({ requirementTypes: [] }), true), [])
  assert.equal(calls.length, 0)
})

test('queryIds returns an empty list when the query matches nothing', async () => {
  const { http } = recorder(() => ({ queryType: 'flat', workItems: [] }))
  assert.deepEqual(await queryIds(http, ORG, PROJECT, TEAM, 'q'), [])
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

function batchItem(id: number): RawWorkItem {
  const items = fixture<{ value: RawWorkItem[] }>('workitems-batch').value
  const item = items.find(candidate => candidate.id === id)
  return item ?? assert.fail(`no fixture item ${id}`)
}

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
