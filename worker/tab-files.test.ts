import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { openTabFile, TAB_FOLDER, writeTabFile, type TabFileFs } from './tab-files'
import type { HostCall } from './workspace/focused'

const CONTEXT = { branch: 'main', displayName: 'web-app', terminals: [] }
const NO_WORKSPACE = 'Open a local workspace first.'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-files-test-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function recording(): { fs: TabFileFs; writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    fs: {
      mkdir: fs.mkdir,
      readFile: fs.readFile,
      writeFile: (async (file: string, data: string, options?: { flag?: string }) => {
        writes.push(path.basename(file))
        return fs.writeFile(file, data, options)
      }) as TabFileFs['writeFile']
    }
  }
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

test('writeTabFile creates the folder and its gitignore once and rewrites only on change', async () => {
  await withTempDir(async dir => {
    const { fs: recorded, writes } = recording()
    const file = await writeTabFile(recorded, dir, 'contoso.4512.adorun', 'first\n')
    assert.equal(file, path.join(dir, TAB_FOLDER, 'contoso.4512.adorun'))
    assert.equal(TAB_FOLDER, '.orca-ado')
    assert.equal(await fs.readFile(file, 'utf8'), 'first\n')
    assert.equal(await fs.readFile(path.join(dir, TAB_FOLDER, '.gitignore'), 'utf8'), '*\n')
    assert.deepEqual(writes, ['.gitignore', 'contoso.4512.adorun'])

    await fs.writeFile(path.join(dir, TAB_FOLDER, '.gitignore'), '*\n!notes.md\n')
    writes.length = 0
    await writeTabFile(recorded, dir, 'contoso.4512.adorun', 'first\n')
    assert.deepEqual(writes, ['.gitignore'], 'the same text is not written again')
    assert.equal(await fs.readFile(path.join(dir, TAB_FOLDER, '.gitignore'), 'utf8'), '*\n!notes.md\n', 'an existing gitignore is kept')

    writes.length = 0
    await writeTabFile(recorded, dir, 'contoso.4512.adorun', 'second\n')
    assert.deepEqual(writes, ['.gitignore', 'contoso.4512.adorun'])
    assert.equal(await fs.readFile(file, 'utf8'), 'second\n')
    assert.deepEqual((await fs.readdir(path.join(dir, TAB_FOLDER))).sort(), ['.gitignore', 'contoso.4512.adorun'])
  })
})

test('openTabFile writes the file into the focused local workspace and opens it by its relative path', async () => {
  await withTempDir(async dir => {
    const { call, calls } = host({
      'workspace.readContext': CONTEXT,
      'workspace.list': { workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'web-app', path: dir, branch: 'main', hostId: null }], truncated: false },
      'editor.open': { opened: true }
    })
    const file = path.join(dir, TAB_FOLDER, 'contoso.4512.adorun')
    assert.deepEqual(await openTabFile({ call, fs }, 'contoso.4512.adorun', 'text\n', NO_WORKSPACE), { opened: true, file })
    assert.deepEqual(calls.at(-1), { method: 'editor.open', params: { workspaceId: 'ws-1', path: '.orca-ado/contoso.4512.adorun' } })
    assert.equal(await fs.readFile(file, 'utf8'), 'text\n')
  })
})

test('openTabFile refuses a missing or remote workspace with the given message and writes nothing', async () => {
  const untouched = {
    mkdir: async () => assert.fail('nothing is written'),
    writeFile: async () => assert.fail('nothing is written'),
    readFile: async () => assert.fail('nothing is read')
  } as unknown as TabFileFs
  const remote = { id: 'ws-1', kind: 'worktree', name: 'web-app', path: '/srv/web-app', branch: 'main', hostId: 'ssh:build-box' }
  for (const answers of [{ 'workspace.readContext': null }, { 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [remote], truncated: false } }]) {
    const { call, calls } = host(answers)
    assert.deepEqual(await openTabFile({ call, fs: untouched }, 'contoso.4512.adorun', 'text\n', NO_WORKSPACE), { opened: false, message: NO_WORKSPACE })
    assert.equal(calls.some(entry => entry.method === 'editor.open'), false)
  }
})
