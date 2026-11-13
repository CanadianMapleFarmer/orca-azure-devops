import { assert, test } from 'orca/testing'
import { fakeAdo, fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { createEntities } from '../data/entities'
import { cachedCodeProjects, cachedCodeRepos, CODE_REPOS_KEY, UNLISTED_MS } from './code-projects'
import { AdoError, createAdoHttp } from './http'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const HOUR = 3_600_000
const WEB = { id: PROJECT, name: 'Fabrikam Web' }
const PLATFORM = { id: '2b3c4d5e-7777-4f8a-9b0c-1d2e3f4a5b6c', name: 'Fabrikam Platform' }
const MOBILE = { id: 'e5f6a7b8-8888-4a9b-8c0d-2e3f4a5b6c7d', name: 'Contoso Mobile' }

const isRepositories = (call: AdoCall) => call.path.endsWith('/_apis/git/repositories')
const isProjects = (call: AdoCall) => call.path.endsWith('/_apis/projects')

function setup() {
  let at = T0
  const ado = fakeAdo()
  ado.on(isRepositories, () => json(200, fixture('repositories')))
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const entities = createEntities(() => at)
  const tables = entities.of(ORG)
  return {
    ado,
    http,
    entities,
    tables,
    projects: cachedCodeProjects(http, ORG, tables),
    repos: cachedCodeRepos(http, ORG, tables.codeRepos, () => at),
    moveTo: (time: number) => {
      at = time
    }
  }
}

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('PRs and pipelines share one code-project read per org', async () => {
  const { ado, http, entities } = setup()
  const forPrs = cachedCodeProjects(http, ORG, entities.of(ORG))
  const forPipelines = cachedCodeProjects(http, ORG, entities.of(ORG))

  const [prs, pipelines] = await Promise.all([forPrs('all'), forPipelines('all')])
  assert.deepEqual(prs, [PLATFORM, WEB])
  assert.deepEqual(pipelines, [PLATFORM, WEB])
  assert.deepEqual(await forPipelines('all'), [PLATFORM, WEB])
  assert.equal(ado.count(isRepositories), 1)

  const other = cachedCodeProjects(http, 'fabrikam', entities.of('fabrikam'))
  await other('all')
  assert.equal(ado.count(isRepositories), 2, 'another org reads its own')
})

test('all code projects come from the repository cache, so the clone list costs no extra request', async () => {
  const { ado, projects, repos } = setup()
  const listed = fixture('repositories').value
  const tools = { ...listed[0], id: '0a1b2c3d-3333-4f8a-9b9c-6d7e8f9a0b12', name: 'tools', project: MOBILE, isDisabled: true }
  ado.on(isRepositories, () => json(200, { count: 4, value: [...listed, tools] }))

  assert.deepEqual(await projects('all'), [MOBILE, PLATFORM, WEB])
  const records = await repos()
  assert.deepEqual(records.map(repo => `${repo.projectName}/${repo.name}`), ['Fabrikam Web/web-app', 'Fabrikam Web/api', 'Fabrikam Platform/infra', 'Contoso Mobile/tools'])
  assert.equal(ado.calls.length, 1)
})

test('a repository list under an hour old answers without a request, and an older one is read once', async () => {
  const { ado, repos, moveTo } = setup()
  await repos()
  moveTo(T0 + HOUR - 1)
  await repos()
  assert.equal(ado.count(isRepositories), 1)

  moveTo(T0 + HOUR)
  await repos()
  await repos()
  assert.equal(ado.count(isRepositories), 2)
})

test('concurrent reads of projects and repositories share one request', async () => {
  const projectsFirst = setup()
  const [listed, records] = await Promise.all([projectsFirst.projects('all'), projectsFirst.repos()])
  assert.deepEqual(listed, [PLATFORM, WEB])
  assert.equal(records.length, 3)
  assert.equal(projectsFirst.ado.count(isRepositories), 1)

  const reposFirst = setup()
  await Promise.all([reposFirst.repos(), reposFirst.projects('all')])
  assert.equal(reposFirst.ado.count(isRepositories), 1)
})

test('a 404 or 400 from the repository list still falls back to the project list', async () => {
  for (const status of [404, 400]) {
    const { ado, projects } = setup()
    ado.on(isRepositories, () => json(status, { message: 'refused' }))
    ado.on(isProjects, () => json(200, { count: 3, value: [WEB, PLATFORM, MOBILE] }))

    assert.deepEqual(await projects('all'), [MOBILE, PLATFORM, WEB])
    assert.deepEqual(await projects('all'), [MOBILE, PLATFORM, WEB])
    assert.deepEqual([ado.count(isRepositories), ado.count(isProjects)], [1, 1])
  }
})

test('other failures from the repository list are not hidden behind the fallback', async () => {
  const { ado, projects } = setup()
  ado.on(isRepositories, () => json(403, { message: 'no access' }))
  assert.equal((await failure(projects('all'))).code, 'forbidden')
  assert.equal(ado.count(isProjects), 0)
})

test('cachedCodeRepos remembers a 404 or 400 for 10 minutes and asks again after', async () => {
  for (const [status, code] of [[404, 'not_found'], [400, 'bad_request']] as const) {
    const { ado, repos, moveTo } = setup()
    ado.on(isRepositories, () => json(status, { message: 'refused' }))

    const first = await failure(repos())
    assert.equal(first.code, code)
    moveTo(T0 + UNLISTED_MS - 1)
    assert.equal(await failure(repos()), first)
    assert.equal(ado.count(isRepositories), 1)

    ado.on(isRepositories, () => json(200, fixture('repositories')))
    moveTo(T0 + UNLISTED_MS)
    assert.equal((await repos()).length, 3)
    assert.equal(ado.count(isRepositories), 2)
  }

  const { ado, repos } = setup()
  ado.on(isRepositories, () => json(500, { message: 'unavailable' }))
  assert.equal((await failure(repos())).code, 'server')
  assert.equal((await failure(repos())).code, 'server')
  assert.equal(ado.count(isRepositories), 2, 'a 500 is not remembered')
})

test('a project list setting reads nothing and leaves the repository cache empty', async () => {
  const { ado, projects, tables } = setup()
  const chosen = [WEB]
  assert.equal(await projects(chosen), chosen)
  assert.equal(ado.calls.length, 0)
  assert.equal(tables.codeRepos.get(CODE_REPOS_KEY), undefined)
})
