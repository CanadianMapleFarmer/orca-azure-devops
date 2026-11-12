import { assert, test } from 'orca/testing'
import { createEntities } from '../data/entities'
import { cachedCodeProjects } from './code-projects'
import type { AdoHttp, AdoRequest } from './http'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const REPOSITORIES = { value: [{ project: { id: 'p2', name: 'Web' } }, { project: { id: 'p1', name: 'Api' } }, { project: { id: 'p2', name: 'Web' } }] }

function countingHttp() {
  const requests: AdoRequest[] = []
  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      requests.push(req)
      await Promise.resolve()
      return { data: structuredClone(REPOSITORIES) as T, headers: new Headers() }
    }
  }
  return { http, requests }
}

test('PRs and pipelines share one code-project read per org', async () => {
  const { http, requests } = countingHttp()
  const entities = createEntities(() => T0)
  const forPrs = cachedCodeProjects(http, 'contoso', entities.of('contoso').projects)
  const forPipelines = cachedCodeProjects(http, 'contoso', entities.of('contoso').projects)

  const [prs, pipelines] = await Promise.all([forPrs('all'), forPipelines('all')])
  const expected = [{ id: 'p1', name: 'Api' }, { id: 'p2', name: 'Web' }]
  assert.deepEqual(prs, expected)
  assert.deepEqual(pipelines, expected)
  assert.deepEqual(await forPipelines('all'), expected)
  assert.deepEqual(requests.map(req => req.path), ['/_apis/git/repositories'])

  const other = cachedCodeProjects(http, 'fabrikam', entities.of('fabrikam').projects)
  await other('all')
  assert.equal(requests.length, 2, 'another org reads its own')
})
