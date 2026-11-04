import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import type { HostCall } from '../workspace/focused'
import { boardFilePath, openBoard, writeBoardFile } from './board-file'

const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const BOARD = { projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d', teamId: TEAM, boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091' }
const NO_WORKSPACE = 'Open a local workspace first, or use + → Azure DevOps board.'
const NO_BOARDS = "Pick a boards project and team in this org's settings."
const CONTEXT = { branch: 'feature/1204-search', displayName: 'web-app', terminals: [] }

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-file-test-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function workspace(over: Record<string, unknown> = {}) {
  return { id: 'ws-1', kind: 'worktree', name: 'web-app', path: '/repos/web-app', branch: 'feature/1204-search', hostId: null, ...over }
}

function host(answers: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = []
  const call: HostCall = async (method, params) => {
    calls.push({ method, params })
    if (!(method in answers)) throw new Error(`unexpected host call ${method}`)
    return answers[method]
  }
  return { call, calls }
}

const untouchedFs = {
  mkdir: async () => assert.fail('nothing is written'),
  writeFile: async () => assert.fail('nothing is written'),
  readFile: async () => assert.fail('nothing is read')
} as unknown as Parameters<typeof openBoard>[0]['fs']

test('boardFilePath names the file after the org and team inside .orca-ado', () => {
  assert.equal(boardFilePath('/repos/web-app', 'contoso', TEAM), `/repos/web-app/.orca-ado/contoso.${TEAM}.adoboard`)
})

const ESCAPES = ['../x', 'a/b']

function refusedBoard(error: unknown): boolean {
  assert.ok(error instanceof AdoError)
  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, "That board can't be opened."])
  return true
}

test('boardFilePath refuses an org or team that would leave .orca-ado', () => {
  for (const bad of ESCAPES) {
    assert.throws(() => boardFilePath('/repos/web-app', bad, TEAM), refusedBoard)
    assert.throws(() => boardFilePath('/repos/web-app', 'contoso', bad), refusedBoard)
  }
})

test('writeBoardFile writes nothing for an org or team that would leave .orca-ado', async () => {
  await withTempDir(async dir => {
    const workspace = path.join(dir, 'web-app')
    await fs.mkdir(workspace)
    for (const bad of ESCAPES) {
      await assert.rejects(writeBoardFile(fs, workspace, { org: bad, ...BOARD }), refusedBoard)
      await assert.rejects(writeBoardFile(fs, workspace, { org: 'contoso', ...BOARD, teamId: bad }), refusedBoard)
    }
    assert.deepEqual(await fs.readdir(dir), ['web-app'])
    assert.deepEqual(await fs.readdir(workspace), [])
  })
})

test('writeBoardFile writes the file and a self-ignoring .gitignore', async () => {
  await withTempDir(async dir => {
    const file = await writeBoardFile(fs, dir, { org: 'contoso', ...BOARD })
    assert.equal(file, path.join(dir, '.orca-ado', `contoso.${TEAM}.adoboard`))
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { org: 'contoso', ...BOARD })
    assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n')
  })
})

test('writeBoardFile keeps an existing .gitignore and rewrites a changed board', async () => {
  await withTempDir(async dir => {
    await fs.mkdir(path.join(dir, '.orca-ado'))
    await fs.writeFile(path.join(dir, '.orca-ado', '.gitignore'), '*\n!keep.md\n')
    await writeBoardFile(fs, dir, { org: 'contoso', ...BOARD })
    const file = await writeBoardFile(fs, dir, { org: 'contoso', ...BOARD, boardId: 'features' })
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).boardId, 'features')
    assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n!keep.md\n')
  })
})

test('openBoard refuses remote or missing workspaces with the message', async () => {
  const cases: Record<string, unknown>[] = [
    { 'workspace.readContext': null },
    { 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [workspace({ hostId: 'ssh:build-box' })], truncated: false } },
    { 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [workspace({ branch: 'main' })], truncated: false } },
    { 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [workspace(), workspace({ id: 'ws-2', path: '/other/web-app' })], truncated: false } }
  ]
  for (const answers of cases) {
    const { call, calls } = host(answers)
    const boardOf = async () => assert.fail('the board is not looked up')
    assert.deepEqual(await openBoard({ call, fs: untouchedFs, boardOf }, 'contoso'), { opened: false, message: NO_WORKSPACE })
    assert.equal(calls.some(entry => entry.method === 'editor.open'), false)
  }
})

test('openBoard asks for a boards team when the org has none', async () => {
  const { call, calls } = host({ 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [workspace()], truncated: false } })
  assert.deepEqual(await openBoard({ call, fs: untouchedFs, boardOf: async () => null }, 'contoso'), { opened: false, message: NO_BOARDS })
  assert.equal(calls.some(entry => entry.method === 'editor.open'), false)
})

test('openBoard writes the board file in the focused workspace and opens it by its relative path', async () => {
  await withTempDir(async dir => {
    const others = [workspace({ id: 'ws-0', name: 'api', path: '/repos/api' }), workspace({ id: 'ws-9', branch: 'main', path: '/repos/main' })]
    const { call, calls } = host({
      'workspace.readContext': CONTEXT,
      'workspace.list': { workspaces: [...others, workspace({ path: dir })], truncated: false },
      'editor.open': { opened: true }
    })
    const asked: string[] = []
    const boardOf = async (org: string) => {
      asked.push(org)
      return BOARD
    }
    assert.deepEqual(await openBoard({ call, fs, boardOf }, 'contoso'), { opened: true })
    assert.deepEqual(asked, ['contoso'])
    assert.deepEqual(calls.at(-1), { method: 'editor.open', params: { workspaceId: 'ws-1', path: `.orca-ado/contoso.${TEAM}.adoboard` } })
    assert.deepEqual(JSON.parse(await fs.readFile(boardFilePath(dir, 'contoso', TEAM), 'utf8')), { org: 'contoso', ...BOARD })
  })
})

test('openBoard refuses a detached worktree whose branch it cannot match', async () => {
  const detached = workspace({ branch: null })
  const { call, calls } = host({ 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [detached], truncated: false } })
  const boardOf = async () => assert.fail('the board is not looked up')
  assert.deepEqual(await openBoard({ call, fs: untouchedFs, boardOf }, 'contoso'), { opened: false, message: NO_WORKSPACE })
  assert.equal(calls.some(entry => entry.method === 'editor.open'), false)
})

test('openBoard matches a folder workspace by name alone', async () => {
  await withTempDir(async dir => {
    const { call, calls } = host({
      'workspace.readContext': { branch: '', displayName: 'notes', terminals: [] },
      'workspace.list': { workspaces: [workspace({ id: 'ws-f', kind: 'folder', name: 'notes', path: dir, branch: null })], truncated: false },
      'editor.open': { opened: true }
    })
    assert.deepEqual(await openBoard({ call, fs, boardOf: async () => BOARD }, 'contoso'), { opened: true })
    assert.deepEqual(calls.at(-1)?.params, { workspaceId: 'ws-f', path: `.orca-ado/contoso.${TEAM}.adoboard` })
  })
})
