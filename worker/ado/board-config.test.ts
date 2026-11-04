import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { BoardConfig } from '../../src/shared/work'
import { boardConfigKey, createBoardConfigCache, listTeamBoards, loadBoardConfig } from './board-config'
import { AdoError, createAdoHttp } from './http'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const STORIES_BOARD = 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091'
const HOUR = 60 * 60 * 1000

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
}

function statesRoute(project: string, type: string): string {
  return `https://dev.azure.com/${ORG}/${project}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`
}

function routesFor(project: string, team: string): Record<string, unknown> {
  const work = `https://dev.azure.com/${ORG}/${project}/${team}/_apis/work`
  return {
    [`${work}/backlogconfiguration`]: fixture('backlog-configuration'),
    [`${work}/boards`]: fixture('boards'),
    [`${work}/boards/${STORIES_BOARD}`]: fixture('board-stories'),
    [`${work}/teamsettings/teamfieldvalues`]: fixture('team-field-values'),
    [statesRoute(project, 'User Story')]: fixture('states-user-story'),
    [statesRoute(project, 'Bug')]: fixture('states-bug')
  }
}

function server(routes: Record<string, unknown> = routesFor(PROJECT, TEAM)) {
  const requested: string[] = []
  const fetch = async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const [path, query] = url.split('?')
    assert.equal(query, 'api-version=7.1')
    const body = path in routes ? routes[path] : { message: 'not found' }
    return new Response(JSON.stringify(body), {
      status: path in routes ? 200 : 404,
      headers: { 'content-type': 'application/json' }
    })
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer secret-token-value' })
  return { http, requested }
}

function withBacklog(change: Record<string, unknown>): Record<string, unknown> {
  return { ...routesFor(PROJECT, TEAM), [`https://dev.azure.com/${ORG}/${PROJECT}/${TEAM}/_apis/work/backlogconfiguration`]: { ...fixture('backlog-configuration'), ...change } }
}

const ARGS = { org: ORG, projectId: PROJECT, teamId: TEAM }

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('picks the requirement-level board by default', async () => {
  const { http, requested } = server()
  const config = await loadBoardConfig(http, ARGS)
  assert.equal(config.boardId, STORIES_BOARD)
  assert.equal(config.boardName, 'Stories')
  assert.deepEqual([config.org, config.projectId, config.teamId], [ORG, PROJECT, TEAM])
  const work = `https://dev.azure.com/${ORG}/${PROJECT}/${TEAM}/_apis/work`
  assert(requested.includes(`${work}/boards/${STORIES_BOARD}?api-version=7.1`))
  assert.equal(requested.filter(url => url.includes('/boards/')).length, 1)
})

test('loads the board named by boardId without listing boards', async () => {
  const { http, requested } = server()
  const config = await loadBoardConfig(http, { ...ARGS, boardId: STORIES_BOARD })
  assert.equal(config.boardId, STORIES_BOARD)
  assert.equal(requested.some(url => url.endsWith('/_apis/work/boards?api-version=7.1')), false)
})

test('maps columns, split flag, lanes and WEF field names', async () => {
  const { http } = server()
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(config.columns, [
    { id: 'f3d4e5f6-6666-4f70-8a8c-5d6e7f8091a2', name: 'New', isSplit: false, columnType: 'incoming', stateMappings: { 'User Story': 'New', Bug: 'New' } },
    { id: '04e5f6a7-7777-4081-9b9d-6e7f8091a2b3', name: 'Active', isSplit: false, columnType: 'inProgress', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
    { id: '15f6a7b8-8888-4192-8cae-7f8091a2b3c4', name: 'In Review', isSplit: true, columnType: 'inProgress', stateMappings: { 'User Story': 'Active', Bug: 'Active' } },
    { id: '26a7b8c9-9999-42a3-9dbf-8091a2b3c4d5', name: 'Resolved', isSplit: false, columnType: 'inProgress', stateMappings: { 'User Story': 'Resolved', Bug: 'Resolved' } },
    { id: '37b8c9da-aaaa-43b4-8ec0-91a2b3c4d5e6', name: 'Closed', isSplit: false, columnType: 'outgoing', stateMappings: { 'User Story': 'Closed', Bug: 'Closed' } }
  ])
  assert.deepEqual(config.lanes, [
    { id: '00000000-0000-0000-0000-000000000000', name: '' },
    { id: '48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7', name: 'Expedite' }
  ])
  assert.deepEqual(config.fields, {
    column: 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban.Column',
    columnDone: 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban.Column.Done',
    lane: 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban.Lane'
  })
})

test('reads the team area paths', async () => {
  const { http } = server()
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(config.areaPaths, [
    { value: 'Fabrikam Web\\Platform', includeChildren: true },
    { value: 'Fabrikam Web\\Shared', includeChildren: false }
  ])
})

test('adds Bug to requirementTypes only when bugs are requirements', async () => {
  const types = async (bugsBehavior: string) =>
    (await loadBoardConfig(server(withBacklog({ bugsBehavior })).http, ARGS)).requirementTypes
  assert.deepEqual(await types('asRequirements'), ['User Story', 'Bug'])
  assert.deepEqual(await types('asTasks'), ['User Story'])
  assert.deepEqual(await types('off'), ['User Story'])
})

test('does not fetch the states of a bug type when bugs are not requirements', async () => {
  const { http, requested } = server(withBacklog({ bugsBehavior: 'asTasks' }))
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(Object.keys(config.doneStates), ['User Story'])
  assert.equal(requested.some(url => url.includes('/states')), true)
  assert.equal(requested.some(url => url.includes('/Bug/')), false)
})

test('uses the bug type the backlog declares', async () => {
  const routes = withBacklog({
    bugWorkItems: { name: 'Defects', workItemTypes: [{ name: 'Defect' }] },
    workItemTypeMappedStates: []
  })
  routes[statesRoute(PROJECT, 'Defect')] = fixture('states-bug')
  const config = await loadBoardConfig(server(routes).http, ARGS)
  assert.deepEqual(config.requirementTypes, ['User Story', 'Defect'])
  assert.deepEqual(Object.keys(config.doneStates), ['User Story', 'Defect'])
})

test('adds no bug type when the process maps none', async () => {
  const routes = withBacklog({ workItemTypeMappedStates: [{ workItemTypeName: 'User Story', states: { New: 'Proposed' } }] })
  const config = await loadBoardConfig(server(routes).http, ARGS)
  assert.deepEqual(config.requirementTypes, ['User Story'])
})

test('fetches the states of each type once even when a type is listed twice', async () => {
  const backlog = fixture('backlog-configuration')
  const routes = withBacklog({
    requirementBacklog: { ...(backlog.requirementBacklog as object), workItemTypes: [{ name: 'User Story' }, { name: 'Bug' }, { name: 'User Story' }] }
  })
  const { http, requested } = server(routes)
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(config.requirementTypes, ['User Story', 'Bug'])
  assert.equal(requested.filter(url => url.includes('/User%20Story/states')).length, 1)
  assert.equal(requested.filter(url => url.includes('/Bug/states')).length, 1)
})

test('collects Completed and Removed states per type', async () => {
  const { http } = server()
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(config.doneStates, { 'User Story': ['Closed', 'Removed'], Bug: ['Closed'] })
})

test('makes only the requests it needs, team-scoped and encoded once', async () => {
  const project = 'Fabrikam Web'
  const team = 'Platform Team'
  const board = STORIES_BOARD
  const routes = routesFor(encodeURIComponent(project), encodeURIComponent(team))
  const { http, requested } = server(routes)
  const config = await loadBoardConfig(http, { org: ORG, projectId: project, teamId: team })
  assert.deepEqual([config.projectId, config.teamId], [project, team])
  const work = `https://dev.azure.com/${ORG}/Fabrikam%20Web/Platform%20Team/_apis/work`
  assert.deepEqual([...requested].sort(), [
    `${work}/backlogconfiguration?api-version=7.1`,
    `${work}/boards?api-version=7.1`,
    `${work}/boards/${board}?api-version=7.1`,
    `${work}/teamsettings/teamfieldvalues?api-version=7.1`,
    `https://dev.azure.com/${ORG}/Fabrikam%20Web/_apis/wit/workitemtypes/Bug/states?api-version=7.1`,
    `https://dev.azure.com/${ORG}/Fabrikam%20Web/_apis/wit/workitemtypes/User%20Story/states?api-version=7.1`
  ].sort())
})

test('a board id that does not exist fails with not_found', async () => {
  const { http } = server()
  const error = await failure(loadBoardConfig(http, { ...ARGS, boardId: 'missing' }))
  assert.equal(error.code, 'not_found')
})

test('a team with no board for its requirement backlog fails with not_found', async () => {
  const routes = routesFor(PROJECT, TEAM)
  routes[`https://dev.azure.com/${ORG}/${PROJECT}/${TEAM}/_apis/work/boards`] = { value: [{ id: 'x', name: 'Epics', url: '' }] }
  const error = await failure(loadBoardConfig(server(routes).http, ARGS))
  assert.equal(error.code, 'not_found')
})

test('errors from ADO propagate as AdoError', async () => {
  const routes = routesFor(PROJECT, TEAM)
  delete routes[statesRoute(PROJECT, 'Bug')]
  const error = await failure(loadBoardConfig(server(routes).http, ARGS))
  assert.equal(error.code, 'not_found')
})

test('listTeamBoards returns the id and name of each board', async () => {
  const { http, requested } = server()
  const boards = await listTeamBoards(http, ARGS)
  assert.deepEqual(boards.map(board => board.name), ['Epics', 'Features', 'Stories'])
  assert.deepEqual(Object.keys(boards[2]).sort(), ['id', 'name'])
  assert.equal(boards[2].id, STORIES_BOARD)
  assert.deepEqual(requested, [`https://dev.azure.com/${ORG}/${PROJECT}/${TEAM}/_apis/work/boards?api-version=7.1`])
})

function config(boardId: string): BoardConfig {
  return {
    org: ORG, projectId: PROJECT, teamId: TEAM, boardId, boardName: 'Stories', requirementTypes: [],
    columns: [], lanes: [], fields: { column: '', columnDone: '', lane: '' }, areaPaths: [], doneStates: {}
  }
}

test('cache returns the same config within ttl', () => {
  let now = 1_000
  const cache = createBoardConfigCache(() => now, 500)
  const stored = config('a')
  cache.set('key', stored)
  now += 499
  assert(cache.get('key') === stored)
  assert.equal(cache.get('other'), undefined)
})

test('cache drops a config once its ttl has passed', () => {
  let now = 1_000
  const cache = createBoardConfigCache(() => now, 500)
  cache.set('key', config('a'))
  now += 500
  assert.equal(cache.get('key'), undefined)
})

test('cache ttl defaults to one hour', () => {
  let now = 0
  const cache = createBoardConfigCache(() => now)
  cache.set('key', config('a'))
  now = HOUR - 1
  assert.notEqual(cache.get('key'), undefined)
  now = HOUR
  assert.equal(cache.get('key'), undefined)
})

test('setting a key again restarts its ttl', () => {
  let now = 0
  const cache = createBoardConfigCache(() => now, 500)
  cache.set('key', config('a'))
  now = 400
  const fresh = config('b')
  cache.set('key', fresh)
  now = 800
  assert(cache.get('key') === fresh)
})

test('cache clear forgets everything', () => {
  const cache = createBoardConfigCache(() => 0)
  cache.set('a', config('a'))
  cache.set('b', config('b'))
  cache.clear()
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), undefined)
})

test('boardConfigKey names org, project, team and board, with default when no board is chosen', () => {
  assert.equal(boardConfigKey(ARGS), `${ORG}/${PROJECT}/${TEAM}/default`)
  assert.equal(boardConfigKey({ ...ARGS, boardId: STORIES_BOARD }), `${ORG}/${PROJECT}/${TEAM}/${STORIES_BOARD}`)
})
