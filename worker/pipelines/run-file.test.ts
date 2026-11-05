import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import type { HostCall } from '../workspace/focused'
import { openRun, RUN_FILE_MAX_AGE_MS, runFileName, type RunFileFs } from './run-file'

const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const NOW = Date.parse('2026-11-05T10:00:00Z')
const DAY = 24 * 60 * 60_000
const CONTEXT = { branch: 'main', displayName: 'web-app', terminals: [] }
const NO_WORKSPACE = 'Open a local workspace first; runs open in a tab there.'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-file-test-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function workspace(dir: string, over: Record<string, unknown> = {}) {
  return { id: 'ws-1', kind: 'worktree', name: 'web-app', path: dir, branch: 'main', hostId: null, ...over }
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

function focusedOn(dir: string) {
  return host({ 'workspace.readContext': CONTEXT, 'workspace.list': { workspaces: [workspace(dir)], truncated: false }, 'editor.open': { opened: true } })
}

const untouched = {
  mkdir: async () => assert.fail('nothing is written'),
  writeFile: async () => assert.fail('nothing is written'),
  readFile: async () => assert.fail('nothing is read'),
  readdir: async () => assert.fail('nothing is listed'),
  stat: async () => assert.fail('nothing is read'),
  unlink: async () => assert.fail('nothing is deleted')
} as unknown as RunFileFs

function refusedRun(error: unknown): boolean {
  assert.ok(error instanceof AdoError)
  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, "That run can't be opened."])
  return true
}

async function aged(file: string, ageMs: number, text = '{}\n'): Promise<void> {
  await fs.writeFile(file, text)
  const at = new Date(NOW - ageMs)
  await fs.utimes(file, at, at)
}

test('openRun writes the run file into the focused local workspace and opens it', async () => {
  await withTempDir(async dir => {
    const { call, calls } = focusedOn(dir)
    assert.deepEqual(await openRun({ call, fs, now: () => NOW }, { org: 'contoso', projectId: PROJECT, buildId: 4512 }), { opened: true })
    assert.deepEqual(calls.at(-1), { method: 'editor.open', params: { workspaceId: 'ws-1', path: '.orca-ado/contoso.4512.adorun' } })
    const text = await fs.readFile(path.join(dir, '.orca-ado', 'contoso.4512.adorun'), 'utf8')
    assert.equal(text, `${JSON.stringify({ org: 'contoso', projectId: PROJECT, buildId: 4512 }, null, 2)}\n`)
    assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n')
    assert.equal(runFileName('contoso', 4512), 'contoso.4512.adorun')
  })
})

test('openRun refuses without a focused local workspace', async () => {
  const remote = { workspaces: [workspace('/srv/web-app', { hostId: 'ssh:build-box' })], truncated: false }
  for (const answers of [{ 'workspace.readContext': null }, { 'workspace.readContext': CONTEXT, 'workspace.list': remote }]) {
    const { call, calls } = host(answers)
    assert.deepEqual(await openRun({ call, fs: untouched, now: () => NOW }, { org: 'contoso', projectId: PROJECT, buildId: 4512 }), {
      opened: false,
      message: NO_WORKSPACE
    })
    assert.equal(calls.some(entry => entry.method === 'editor.open'), false)
  }
})

test('old run files are pruned, the new one never', async () => {
  await withTempDir(async dir => {
    const folder = path.join(dir, '.orca-ado')
    await fs.mkdir(folder)
    const text = `${JSON.stringify({ org: 'contoso', projectId: PROJECT, buildId: 4512 }, null, 2)}\n`
    await aged(path.join(folder, 'contoso.4512.adorun'), 30 * DAY, text)
    await aged(path.join(folder, 'contoso.4400.adorun'), 8 * DAY)
    await aged(path.join(folder, 'contoso.4401.adorun'), RUN_FILE_MAX_AGE_MS + 1)
    await aged(path.join(folder, 'contoso.4500.adorun'), RUN_FILE_MAX_AGE_MS - 1)
    await aged(path.join(folder, `contoso.board.adoboard`), 30 * DAY)
    await aged(path.join(folder, 'notes.md'), 30 * DAY)

    const { call } = focusedOn(dir)
    assert.deepEqual(await openRun({ call, fs, now: () => NOW }, { org: 'contoso', projectId: PROJECT, buildId: 4512 }), { opened: true })
    assert.deepEqual((await fs.readdir(folder)).sort(), ['.gitignore', 'contoso.4500.adorun', 'contoso.4512.adorun', 'contoso.board.adoboard', 'notes.md'])
  })
})

test('run files are pruned at most fifty at a time and a failed delete is skipped', async () => {
  await withTempDir(async dir => {
    const folder = path.join(dir, '.orca-ado')
    await fs.mkdir(folder)
    for (let id = 1000; id < 1060; id += 1) await aged(path.join(folder, `contoso.${id}.adorun`), 10 * DAY)
    const deleted: string[] = []
    const failing: RunFileFs = {
      ...fs,
      unlink: (async (file: string) => {
        deleted.push(path.basename(file))
        if (deleted.length === 1) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
        return fs.unlink(file)
      }) as RunFileFs['unlink']
    }

    const { call } = focusedOn(dir)
    assert.deepEqual(await openRun({ call, fs: failing, now: () => NOW }, { org: 'contoso', projectId: PROJECT, buildId: 4512 }), { opened: true })
    assert.equal(deleted.length, 50, 'at most fifty deletes per open')
    const left = (await fs.readdir(folder)).filter(name => name.endsWith('.adorun') && name !== 'contoso.4512.adorun')
    assert.equal(left.length, 11, 'ten beyond the cap and the one that failed')
    assert.ok(left.includes(deleted[0]), 'the failed delete is skipped and the rest go ahead')
  })
})

test('an invalid org or build id is refused', async () => {
  for (const [org, buildId] of [
    ['../x', 4512],
    ['Contoso', 4512],
    ['contoso/x', 4512],
    ['contoso', 0],
    ['contoso', -1],
    ['contoso', 1.5],
    ['contoso', Number.NaN]
  ] as const) {
    assert.throws(() => runFileName(org, buildId), refusedRun)
    const { call, calls } = host({})
    await assert.rejects(openRun({ call, fs: untouched, now: () => NOW }, { org, projectId: PROJECT, buildId }), refusedRun)
    assert.deepEqual(calls, [])
  }
})
