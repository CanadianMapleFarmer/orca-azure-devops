import { assert, test } from 'orca/testing'
import { createTask, createTaskPatch, TASK_TITLE_MAX } from './create-task'
import { AdoError, type AdoHttp, type AdoRequest } from './http'

const EMPTY_TASK_TITLE = 'Write a title for the task first.'
const TASK_TITLE_TOO_LONG = 'A task title can be at most 255 characters.'
const MALFORMED_WORK_ITEM = 'Azure DevOps returned an unexpected work item response.'
const PARENT_URL = 'https://dev.azure.com/contoso/4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d/_apis/wit/workItems/1204'
const INPUT = { title: '  Write the filter docs ', areaPath: 'Fabrikam Web\\Platform', iterationPath: 'Fabrikam Web\\Sprint 12', parentUrl: PARENT_URL }

function refusal(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected a refusal')
}

function recording(answer: unknown): { http: AdoHttp; requests: AdoRequest[] } {
  const requests: AdoRequest[] = []
  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      requests.push(req)
      return { data: answer as T, headers: new Headers() }
    }
  }
  return { http, requests }
}

test('createTaskPatch sets title, area, iteration and the parent link', () => {
  assert.deepEqual(createTaskPatch(INPUT), [
    { op: 'add', path: '/fields/System.Title', value: 'Write the filter docs' },
    { op: 'add', path: '/fields/System.AreaPath', value: 'Fabrikam Web\\Platform' },
    { op: 'add', path: '/fields/System.IterationPath', value: 'Fabrikam Web\\Sprint 12' },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: PARENT_URL } }
  ])
})

test('a blank or too-long title is refused', () => {
  for (const title of ['', '   ', '\n\t']) {
    const error = refusal(() => createTaskPatch({ ...INPUT, title }))
    assert.deepEqual([error.code, error.message], ['bad_request', EMPTY_TASK_TITLE], JSON.stringify(title))
  }
  const longest = '🚗'.repeat(TASK_TITLE_MAX)
  assert.equal(createTaskPatch({ ...INPUT, title: longest })[0].value, longest, '255 code points fit even as 510 UTF-16 units')
  const error = refusal(() => createTaskPatch({ ...INPUT, title: 'a'.repeat(TASK_TITLE_MAX + 1) }))
  assert.deepEqual([error.code, error.message], ['bad_request', TASK_TITLE_TOO_LONG])
})

test("createTask posts to the type's create URL with relations expanded", async () => {
  const created = { id: 6001, rev: 1, url: PARENT_URL.replace('1204', '6001'), fields: { 'System.Title': 'Write the filter docs' }, relations: [] }
  const { http, requests } = recording(created)
  const ops = createTaskPatch(INPUT)

  assert.deepEqual(await createTask(http, 'contoso', 'Fabrikam Web', 'Task', ops), created)
  assert.deepEqual(requests, [
    {
      org: 'contoso',
      project: 'Fabrikam Web',
      path: '/_apis/wit/workitems/$Task',
      method: 'POST',
      query: { $expand: 'relations' },
      body: ops,
      contentType: 'application/json-patch+json'
    }
  ])

  const spaced = recording(created)
  await createTask(spaced.http, 'contoso', 'Fabrikam Web', 'Product Backlog Item', ops)
  assert.equal(spaced.requests[0].path, '/_apis/wit/workitems/$Product%20Backlog%20Item')
})

test('a created item without a numeric id and rev is malformed', async () => {
  for (const answer of [undefined, {}, { id: '6001', rev: 1, url: 'u', fields: {} }, { id: 6001, url: 'u', fields: {} }, { id: 6001, rev: 1, url: 'u' }]) {
    try {
      await createTask(recording(answer).http, 'contoso', 'Fabrikam Web', 'Task', createTaskPatch(INPUT))
      assert.fail(`expected ${JSON.stringify(answer)} to be refused`)
    } catch (error) {
      assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
      assert.deepEqual([error.code, error.message], ['server', MALFORMED_WORK_ITEM], JSON.stringify(answer))
    }
  }
})
