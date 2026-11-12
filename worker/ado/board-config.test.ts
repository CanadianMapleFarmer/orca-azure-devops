import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { boardConfigKey, listTeamBoards, loadBoardConfig, loadTypeStates } from './board-config'
import { AdoError, createAdoHttp } from './http'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const STORIES_BOARD = 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091'

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

const WORK = `https://dev.azure.com/${ORG}/${PROJECT}/${TEAM}/_apis/work`

function withRoute(path: string, body: unknown): Record<string, unknown> {
  return { ...routesFor(PROJECT, TEAM), [`${WORK}/${path}`]: body }
}

function storiesBoard(mappingFor: (index: number) => Record<string, string>): Record<string, unknown> {
  const board = fixture('board-stories')
  const columns = (board.columns as Record<string, unknown>[]).map((column, index) => ({ ...column, stateMappings: mappingFor(index) }))
  return { ...board, columns }
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

test('loads the board named by boardId without the backlog configuration or the board list', async () => {
  const { http, requested } = server()
  const config = await loadBoardConfig(http, { ...ARGS, boardId: STORIES_BOARD })
  assert.equal(config.boardId, STORIES_BOARD)
  assert.equal(requested.some(url => url.includes('/backlogconfiguration')), false)
  assert.equal(requested.some(url => url.endsWith('/_apis/work/boards?api-version=7.1')), false)
})

test("the default board carries the task backlog's types; a board named by id leaves them out", async () => {
  const byDefault = await loadBoardConfig(server().http, ARGS)
  assert.deepEqual(byDefault.taskTypes, ['Task'])
  const named = await loadBoardConfig(server().http, { ...ARGS, boardId: STORIES_BOARD })
  assert.equal('taskTypes' in named, false)
})

test("bugs managed as tasks add the bug category's types to the task types, from the same read", async () => {
  const bugs = { id: 'Microsoft.BugCategory', name: 'Bugs', workItemTypes: [{ name: 'Bug', url: 'https://dev.azure.com/contoso/_apis/wit/workItemTypes/Bug' }] }
  const asTasks = { ...fixture('backlog-configuration'), bugsBehavior: 'asTasks', bugWorkItems: bugs }
  const { http, requested } = server(withRoute('backlogconfiguration', asTasks))
  assert.deepEqual((await loadBoardConfig(http, ARGS)).taskTypes, ['Task', 'Bug'])
  assert.equal(requested.length, 6, 'the same six requests as without bugs')
  const asRequirements = server(withRoute('backlogconfiguration', { ...asTasks, bugsBehavior: 'asRequirements' }))
  assert.deepEqual((await loadBoardConfig(asRequirements.http, ARGS)).taskTypes, ['Task'])
})

test('a backlog configuration without a task backlog still loads the board, with no task types', async () => {
  const { taskBacklog: _, ...withoutTasks } = fixture('backlog-configuration')
  const config = await loadBoardConfig(server(withRoute('backlogconfiguration', withoutTasks)).http, ARGS)
  assert.equal(config.boardId, STORIES_BOARD)
  assert.deepEqual(config.taskTypes, [])
})

test('matches the default board by name exactly before ignoring case', async () => {
  const boards = { value: [{ id: 'lower', name: 'stories', url: '' }, { id: STORIES_BOARD, name: 'Stories', url: '' }] }
  const config = await loadBoardConfig(server(withRoute('boards', boards)).http, ARGS)
  assert.equal(config.boardId, STORIES_BOARD)
})

test('falls back to a case-insensitive name match for the default board', async () => {
  const boards = { value: [{ id: 'other', name: 'Epics', url: '' }, { id: STORIES_BOARD, name: 'STORIES', url: '' }] }
  const config = await loadBoardConfig(server(withRoute('boards', boards)).http, ARGS)
  assert.equal(config.boardId, STORIES_BOARD)
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

test('takes requirementTypes from the board state mappings in first-seen column order', async () => {
  const mappings: Record<string, string>[] = [{ 'User Story': 'New' }, { Defect: 'Active', 'User Story': 'Active' }]
  const board = storiesBoard(index => mappings[Math.min(index, 1)])
  const routes = withRoute(`boards/${STORIES_BOARD}`, board)
  routes[statesRoute(PROJECT, 'Defect')] = fixture('states-bug')
  const config = await loadBoardConfig(server(routes).http, ARGS)
  assert.deepEqual(config.requirementTypes, ['User Story', 'Defect'])
  assert.deepEqual(Object.keys(config.doneStates), ['User Story', 'Defect'])
  assert.deepEqual(config.doneStates.Defect, ['Closed'])
})

test('does not fetch the states of a type the board does not map', async () => {
  const board = storiesBoard(() => ({ 'User Story': 'Active' }))
  const { http, requested } = server(withRoute(`boards/${STORIES_BOARD}`, board))
  const config = await loadBoardConfig(http, ARGS)
  assert.deepEqual(config.requirementTypes, ['User Story'])
  assert.equal(requested.some(url => url.includes('/Bug/')), false)
})

test('a portfolio board chosen by id yields its own types', async () => {
  const featuresId = 'd1b2c3d4-4444-4d5e-8f6a-3b4c5d6e7f80'
  const epics: Record<string, unknown> = { ...fixture('board-features'), id: 'epics', name: 'Epics' }
  epics.columns = (epics.columns as Record<string, unknown>[]).map(column => ({ ...column, stateMappings: { Epic: 'Active' } }))
  const routes = routesFor(PROJECT, TEAM)
  routes[`${WORK}/boards/${featuresId}`] = fixture('board-features')
  routes[`${WORK}/boards/epics`] = epics
  routes[statesRoute(PROJECT, 'Feature')] = fixture('states-user-story')
  routes[statesRoute(PROJECT, 'Epic')] = fixture('states-bug')
  const features = await loadBoardConfig(server(routes).http, { ...ARGS, boardId: featuresId })
  assert.equal(features.boardName, 'Features')
  assert.deepEqual(features.requirementTypes, ['Feature'])
  assert.deepEqual(features.doneStates, { Feature: ['Closed', 'Removed'] })
  const epicConfig = await loadBoardConfig(server(routes).http, { ...ARGS, boardId: 'epics' })
  assert.deepEqual(epicConfig.requirementTypes, ['Epic'])
})

test('fetches the states of each type once however many columns map it', async () => {
  const { http, requested } = server()
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
  const boards = { value: [{ id: 'x', name: 'Epics', url: '' }] }
  const error = await failure(loadBoardConfig(server(withRoute('boards', boards)).http, ARGS))
  assert.equal(error.code, 'not_found')
})

test('errors from ADO propagate as AdoError', async () => {
  const routes = routesFor(PROJECT, TEAM)
  delete routes[statesRoute(PROJECT, 'Bug')]
  const error = await failure(loadBoardConfig(server(routes).http, ARGS))
  assert.equal(error.code, 'not_found')
})

test('malformed or empty responses fail with a server error, not a TypeError', async () => {
  const malformed = {
    'an empty board': withRoute(`boards/${STORIES_BOARD}`, undefined),
    'a board without columns': withRoute(`boards/${STORIES_BOARD}`, { ...fixture('board-stories'), columns: undefined }),
    'a board without fields': withRoute(`boards/${STORIES_BOARD}`, { ...fixture('board-stories'), fields: undefined }),
    'a board field without a reference name': withRoute(`boards/${STORIES_BOARD}`, { ...fixture('board-stories'), fields: { columnField: {}, rowField: {}, doneField: {} } }),
    'an empty backlog configuration': withRoute('backlogconfiguration', undefined),
    'a board list without values': withRoute('boards', {}),
    'empty team field values': withRoute('teamsettings/teamfieldvalues', undefined),
    'states without values': { ...routesFor(PROJECT, TEAM), [statesRoute(PROJECT, 'Bug')]: {} }
  }
  for (const [label, routes] of Object.entries(malformed)) {
    const error = await failure(loadBoardConfig(server(routes).http, ARGS))
    assert.deepEqual([error.code, error.status, error.message], ['server', 200, 'Azure DevOps returned an unexpected board configuration.'], label)
  }
})

test('listTeamBoards returns the id and name of each board', async () => {
  const { http, requested } = server()
  const boards = await listTeamBoards(http, ARGS)
  assert.deepEqual(boards.map(board => board.name), ['Epics', 'Stories', 'Features'])
  assert.deepEqual(Object.keys(boards[1]).sort(), ['id', 'name'])
  assert.equal(boards[1].id, STORIES_BOARD)
  assert.deepEqual(requested, [`${WORK}/boards?api-version=7.1`])
})

test('listTeamBoards rejects an empty response with a server error', async () => {
  const error = await failure(listTeamBoards(server(withRoute('boards', undefined)).http, ARGS))
  assert.equal(error.code, 'server')
})

test('boardConfigKey names org, project, team and board, with default when no board is chosen', () => {
  assert.equal(boardConfigKey(ARGS), `${ORG}/${PROJECT}/${TEAM}/default`)
  assert.equal(boardConfigKey({ ...ARGS, boardId: STORIES_BOARD }), `${ORG}/${PROJECT}/${TEAM}/${STORIES_BOARD}`)
})

test('loadTypeStates lists every state of a type with its category', async () => {
  const { http, requested } = server()
  assert.deepEqual(await loadTypeStates(http, { org: ORG, projectId: PROJECT }, 'Bug'), [
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    { name: 'Resolved', category: 'Resolved' },
    { name: 'Closed', category: 'Completed' }
  ])
  assert.deepEqual(requested, [`${statesRoute(PROJECT, 'Bug')}?api-version=7.1`])
  const malformed = server({ [statesRoute(PROJECT, 'Bug')]: { value: [{ name: 'New' }] } })
  assert.equal((await failure(loadTypeStates(malformed.http, { org: ORG, projectId: PROJECT }, 'Bug'))).message, 'Azure DevOps returned an unexpected board configuration.')
})
