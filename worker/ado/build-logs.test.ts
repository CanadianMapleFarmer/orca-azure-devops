import { assert, test } from 'orca/testing'
import { fileRefOf } from '../../src/shared/file-ref'
import { LOG_FIRST_LINE, MAX_LINE_CHARS } from '../../src/shared/pipelines'
import { fakeAdo, fixture, json, ORG, PROJECT, type AdoCall } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { getLogLines, listLogs } from './build-logs'
import { AdoError, createAdoHttp } from './http'

const isLogs = (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/build/builds/4512/logs`
const isLog = (logId: number) => (call: AdoCall) => call.path === `/${ORG}/${PROJECT}/_apis/build/builds/4512/logs/${logId}`

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
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

function isFixedError(error: AdoError): boolean {
  return error.code === 'server' && error.message === MALFORMED.log
}

test('listLogs maps ids to line counts', async () => {
  const { ado, http } = setup()
  ado.on(isLogs, () => json(200, fixture('logs-4512')))
  const counts = await listLogs(http, ORG, PROJECT, 4512)
  assert.deepEqual([...counts], [[1, 14], [2, 38], [3, 61], [4, 112], [5, 22], [6, 18], [7, 41], [8, 29], [9, 240], [10, 24]])
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/build/builds/4512/logs`)
  assert.equal(call.query.get('api-version'), '7.1')
})

test('listLogs reads a run without logs as an empty map', async () => {
  const { ado, http } = setup()
  ado.on(isLogs, () => json(200, { count: 0, value: [] }))
  assert.equal((await listLogs(http, ORG, PROJECT, 4512)).size, 0)
})

test('getLogLines asks for an inclusive range and cuts long lines', async () => {
  const { ado, http } = setup()
  const long = 'x'.repeat(MAX_LINE_CHARS + 1)
  const exact = 'y'.repeat(MAX_LINE_CHARS)
  ado.on(isLog(9), () => json(200, { count: 4, value: ['first', long, exact, '<script>alert(1)</script> &amp;'] }))
  const lines = await getLogLines(http, ORG, PROJECT, 4512, 9, LOG_FIRST_LINE, 4)
  assert.equal(lines.length, 4)
  assert.equal(lines[0], 'first')
  assert.equal(lines[1], `${'x'.repeat(MAX_LINE_CHARS - 1)}…`)
  assert.equal(lines[1].length, MAX_LINE_CHARS)
  assert.equal(lines[2], exact)
  assert.equal(lines[3], '<script>alert(1)</script> &amp;')
  const [call] = ado.calls
  assert.equal(call.method, 'GET')
  assert.equal(call.path, `/${ORG}/${PROJECT}/_apis/build/builds/4512/logs/9`)
  assert.equal(call.query.get('startLine'), '1')
  assert.equal(call.query.get('endLine'), '4')
  assert.equal(call.query.get('api-version'), '7.1')
})

test('getLogLines reads the lines of the fixture log', async () => {
  const { ado, http } = setup()
  ado.on(isLog(9), () => json(200, fixture('log-4512-9')))
  const lines = await getLogLines(http, ORG, PROJECT, 4512, 9, 228, 240)
  assert.equal(lines.length, 13)
  assert(lines[0].includes('##[section]Starting: Build and push image'))
  assert(lines.at(-1)?.includes('##[section]Finishing: Build and push image'))
  assert.equal(ado.calls[0].query.get('startLine'), '228')
  assert.equal(ado.calls[0].query.get('endLine'), '240')
})

test('the fixture log has one line that points at a file and one that does not', async () => {
  const { ado, http } = setup()
  ado.on(isLog(9), () => json(200, fixture('log-4512-9')))
  const lines = await getLogLines(http, ORG, PROJECT, 4512, 9, 228, 240)
  const refs = lines.map(line => [line, fileRefOf(line)] as const).filter(([, found]) => found !== null)
  assert.equal(refs.length, 1)
  assert(refs[0][0].includes('error CS1002'))
  assert.deepEqual(refs[0][1], { path: '/home/vsts/work/1/s/src/Api/Program.cs', line: 42, column: 17 })
  const docker = lines.find(line => line.includes('ERROR: failed to solve'))
  assert(docker !== undefined)
  assert.equal(fileRefOf(docker), null)
})

test('getLogLines returns no lines for an empty range', async () => {
  const { ado, http } = setup()
  ado.on(isLog(2), () => json(200, { count: 0, value: [] }))
  assert.deepEqual(await getLogLines(http, ORG, PROJECT, 4512, 2, 1, 1000), [])
})

test('a malformed log response becomes the fixed error', async () => {
  const { ado, http } = setup()
  const lists = [
    { value: 'nope' },
    { count: 1 },
    null,
    { value: [null] },
    { value: [{ id: 1 }] },
    { value: [{ lineCount: 3 }] },
    { value: [{ id: '1', lineCount: 3 }] },
    { value: [{ id: 1, lineCount: '3' }] },
    { value: [{ id: 1.5, lineCount: 3 }] },
    { value: [{ id: 1, lineCount: -1 }] }
  ]
  for (const body of lists) {
    ado.on(isLogs, () => json(200, body))
    assert(isFixedError(await failure(listLogs(http, ORG, PROJECT, 4512))), JSON.stringify(body))
  }
  ado.on(isLogs, () => new Response(null, { status: 204 }))
  assert(isFixedError(await failure(listLogs(http, ORG, PROJECT, 4512))))

  const lines = [{ value: 'nope' }, { count: 1 }, null, { value: ['ok', 3] }, { value: [{ text: 'a' }] }]
  for (const body of lines) {
    ado.on(isLog(9), () => json(200, body))
    assert(isFixedError(await failure(getLogLines(http, ORG, PROJECT, 4512, 9, 1, 10))), JSON.stringify(body))
  }
  ado.on(isLog(9), () => new Response(null, { status: 204 }))
  assert(isFixedError(await failure(getLogLines(http, ORG, PROJECT, 4512, 9, 1, 10))))
})

test('the log reads stop when their signal aborts and ADO errors pass through', async () => {
  const { ado, http } = setup()
  ado.on(isLogs, () => json(200, fixture('logs-4512')))
  ado.on(isLog(9), () => json(200, fixture('log-4512-9')))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(listLogs(http, ORG, PROJECT, 4512, controller.signal))
  await assert.rejects(getLogLines(http, ORG, PROJECT, 4512, 9, 1, 10, controller.signal))
  assert.equal(ado.calls.length, 0)

  ado.on(isLogs, () => json(404, { message: 'Build 4512 does not exist.' }))
  const gone = await failure(listLogs(http, ORG, PROJECT, 4512))
  assert.deepEqual([gone.code, gone.message], ['not_found', 'Build 4512 does not exist.'])
  ado.on(isLog(9), () => json(403, { message: 'No access to logs.' }))
  const forbidden = await failure(getLogLines(http, ORG, PROJECT, 4512, 9, 1, 10))
  assert.deepEqual([forbidden.code, forbidden.message], ['forbidden', 'No access to logs.'])
})
