import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { RunSummary } from '../../src/shared/pipelines'
import type { RunCommand, RunResult } from '../sys/run'
import type { HostCall, WorkspaceEntry } from '../workspace/focused'
import { fileInside, gitRemotes, openRunFile, type OpenFileDeps } from './open-file'
import type { AdoRemote } from './remote'

const WEB = { org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const API = { org: 'contoso', project: 'Fabrikam Web', repo: 'api' }
const MINUTE = 60_000
const NOT_A_FILE = "That isn't a file path Orca can open."
const AGENT = '/home/vsts/work/1/s'

function runOf(over: Partial<RunSummary> = {}): RunSummary {
  return {
    org: 'contoso',
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    buildId: 4512,
    projectName: 'Fabrikam Web',
    pipeline: { id: 7, name: 'web-app-ci' },
    runNumber: '20261105.3',
    url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4512',
    branch: 'main',
    prId: null,
    reason: 'individualCI',
    repository: { id: '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f', name: 'web-app' },
    requestedFor: { id: 'u1', name: 'Alex Contoso' },
    state: 'failed',
    queuedAt: 0,
    startedAt: null,
    finishedAt: null,
    stages: null,
    approvals: [],
    mine: true,
    watched: false,
    ...over
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-file-test-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function write(root: string, relative: string, text = 'text\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await fs.writeFile(path.join(root, relative), text)
}

function workspace(id: string, root: string, branch: string | null, hostId: string | null = null): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: root, branch, hostId }
}

function host(entries: WorkspaceEntry[], focused: WorkspaceEntry | null) {
  const calls: { method: string; params: unknown }[] = []
  const call: HostCall = async (method, params) => {
    calls.push({ method, params })
    if (method === 'workspace.list') return { workspaces: entries, truncated: false }
    if (method === 'workspace.readContext') return focused ? { branch: focused.branch, displayName: focused.name, terminals: [] } : null
    if (method === 'editor.open') return { opened: true }
    throw new Error(`unexpected host call ${method}`)
  }
  return { call, calls, opened: () => calls.filter(entry => entry.method === 'editor.open').map(entry => entry.params) }
}

function depsOf(call: HostCall, remotesAt: Record<string, AdoRemote[]> = {}) {
  const roots: string[] = []
  const inside = fileInside(fs)
  const deps: OpenFileDeps = {
    call,
    gitAvailable: true,
    remotes: async root => remotesAt[root] ?? [],
    isFileInside: async (root, relative) => {
      roots.push(root)
      return inside(root, relative)
    }
  }
  return { deps, roots }
}

const neverRun: RunCommand = async () => assert.fail('git must not run')

test('openRunFile never opens a path outside the workspace', async () => {
  await withTempDir(async base => {
    const root = path.join(base, 'ws')
    const outside = path.join(base, 'outside')
    const sibling = path.join(base, 'ws-evil')
    await write(root, 'src/app.ts')
    await write(outside, 'passwd')
    await write(sibling, 'secret.ts')
    await fs.symlink(outside, path.join(root, 'src', 'link'), 'dir')
    await fs.symlink('/etc', path.join(root, 'src', 'etc'), 'dir')
    await fs.symlink(path.join(outside, 'passwd'), path.join(root, 'src', 'passwd'), 'file')
    await fs.symlink(sibling, path.join(root, 'src', 'sibling'), 'dir')
    await fs.symlink(path.join(root, 'src', 'app.ts'), path.join(root, 'src', 'alias.ts'), 'file')

    const web = workspace('ws-web', root, 'main')
    const { call, opened } = host([web], web)
    const { deps } = depsOf(call, { [root]: [WEB] })
    const missing = (name: string) => `Couldn't find ${name} in your local workspaces of web-app.`
    const refused: [string, string][] = [
      ['../../etc/passwd', NOT_A_FILE],
      ['..\\..\\Windows\\win.ini', NOT_A_FILE],
      ['src/../../outside/passwd', NOT_A_FILE],
      ['/etc/hosts', missing('hosts')],
      ['C:\\Windows\\win.ini', missing('win.ini')],
      ['src/link/passwd', missing('passwd')],
      [`${AGENT}/src/etc/hosts`, missing('hosts')],
      ['src/passwd', missing('passwd')],
      ['src/sibling/secret.ts', missing('secret.ts')],
      ['src', missing('src')],
      ['src/', NOT_A_FILE],
      ['', NOT_A_FILE]
    ]
    for (const [input, message] of refused) {
      assert.deepEqual(await openRunFile(deps, { run: runOf(), path: input, line: 3 }), { opened: false, message }, input)
    }
    assert.deepEqual(opened(), [], 'no file was opened')

    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: `${AGENT}/src/app.ts`, line: 3 }), { opened: true, path: 'src/app.ts', line: 3 })
    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: 'src/alias.ts', line: null }), { opened: true, path: 'src/alias.ts', line: null })
    assert.deepEqual(opened(), [
      { workspaceId: 'ws-web', path: 'src/app.ts' },
      { workspaceId: 'ws-web', path: 'src/alias.ts' }
    ])
  })
})

test('fileInside is true only for a regular file whose real path is under the real root', async () => {
  await withTempDir(async base => {
    const root = path.join(base, 'ws')
    const outside = path.join(base, 'outside')
    const sibling = path.join(base, 'ws-evil')
    await write(root, 'src/app.ts')
    await write(outside, 'passwd')
    await write(sibling, 'secret.ts')
    await fs.symlink(outside, path.join(root, 'out'), 'dir')
    await fs.symlink(sibling, path.join(root, 'sibling'), 'dir')
    await fs.symlink(root, path.join(base, 'linked-root'), 'dir')
    const inside = fileInside(fs)

    assert.equal(await inside(root, 'src/app.ts'), true)
    assert.equal(await inside(path.join(base, 'linked-root'), 'src/app.ts'), true, 'a root reached through a symlink')
    assert.equal(await inside(root, 'src/missing.ts'), false)
    assert.equal(await inside(root, 'src'), false, 'a directory')
    assert.equal(await inside(root, ''), false, 'the root itself')
    assert.equal(await inside(root, 'out/passwd'), false, 'a symlink out')
    assert.equal(await inside(root, 'sibling/secret.ts'), false, 'a sibling whose name starts with the root name')
    assert.equal(await inside(path.join(base, 'missing-root'), 'src/app.ts'), false)
    assert.equal(await inside(root, 'src/app\u0000.ts'), false)
  })
})

test('fileInside answers false for any error and still works at the filesystem root', async () => {
  const unreadable = fileInside({
    realpath: async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
    stat: async () => assert.fail('nothing is read')
  } as unknown as Parameters<typeof fileInside>[0])
  assert.equal(await unreadable('/repo', 'a.ts'), false)

  const filesystemRoot = path.parse(process.cwd()).root
  const identity = fileInside({ realpath: async (target: string) => target, stat: async () => ({ isFile: () => true }) } as unknown as Parameters<typeof fileInside>[0])
  assert.equal(await identity(filesystemRoot, 'a.ts'), true)
})

test('openRunFile opens the deepest existing match in the workspace of the run repository, preferring its branch', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    for (const name of ['other', 'wrong', 'dev', 'main']) await write(dir(name), 'src/Api/Program.cs')
    await write(dir('main'), 'Program.cs')
    await write(dir('dev'), 'src/Api/Only.cs')
    const other = workspace('ws-other', dir('other'), 'main')
    const wrong = workspace('ws-wrong', dir('wrong'), 'main')
    const remote = workspace('ws-remote', dir('remote'), 'main', 'ssh:build-box')
    const dev = workspace('ws-dev', dir('dev'), 'develop')
    const main = workspace('ws-main', dir('main'), 'main')
    const { call, opened } = host([other, wrong, remote, dev, main], dev)
    const { deps, roots } = depsOf(call, {
      [dir('other')]: [API],
      [dir('wrong')]: [{ ...WEB, project: 'Other' }],
      [dir('remote')]: [WEB],
      [dir('dev')]: [WEB],
      [dir('main')]: [{ org: 'Contoso', project: 'FABRIKAM WEB', repo: 'Web-App' }]
    })

    const program = await openRunFile(deps, { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 42 })
    assert.deepEqual(program, { opened: true, path: 'src/Api/Program.cs', line: 42 })
    assert.deepEqual(opened(), [{ workspaceId: 'ws-main', path: 'src/Api/Program.cs' }])

    const only = await openRunFile(deps, { run: runOf(), path: `${AGENT}/src/Api/Only.cs`, line: null })
    assert.deepEqual(only, { opened: true, path: 'src/Api/Only.cs', line: null })
    assert.deepEqual(opened().at(-1), { workspaceId: 'ws-dev', path: 'src/Api/Only.cs' })
    assert.ok(roots.every(root => root === dir('dev') || root === dir('main')), 'other repositories, projects and hosts are never read')
  })
})

test('openRunFile tries the run branch, then the focused workspace, then the rest, and the longest path across them', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    for (const name of ['a', 'b', 'c']) await write(dir(name), 'src/Api/Program.cs')
    for (const name of ['a', 'c']) await write(dir(name), 'src/Api/Extra.cs')
    await write(dir('c'), 'src/Api/Main.cs')
    await write(dir('a'), 'Shallow.cs')
    await write(dir('b'), 'src/Shallow.cs')
    const a = workspace('ws-a', dir('a'), 'feature/a')
    const b = workspace('ws-b', dir('b'), 'develop')
    const c = workspace('ws-c', dir('c'), 'main')
    const { call, opened } = host([a, b, c], b)
    const { deps } = depsOf(call, { [dir('a')]: [WEB], [dir('b')]: [WEB], [dir('c')]: [WEB] })
    const openedIn = async (branch: string, file: string) => {
      const result = await openRunFile(deps, { run: runOf({ branch }), path: `${AGENT}/${file}`, line: 1 })
      assert.equal(result.opened, true, file)
      return (opened().at(-1) as { workspaceId: string }).workspaceId
    }

    assert.equal(await openedIn('main', 'src/Api/Program.cs'), 'ws-c', 'the workspace on the run branch')
    assert.equal(await openedIn('release/1', 'src/Api/Program.cs'), 'ws-b', 'the focused workspace')
    assert.equal(await openedIn('release/1', 'src/Api/Extra.cs'), 'ws-a', 'the first of the rest')
    assert.equal(await openedIn('main', 'src/Api/Extra.cs'), 'ws-c')
    assert.equal(await openedIn('main', 'src/Api/Main.cs'), 'ws-c')
    assert.equal(await openedIn('feature/a', 'src/Shallow.cs'), 'ws-b', 'a longer match in another workspace beats a shorter one in a preferred one')
  })
})

test("a run's repository without a local workspace says so", async () => {
  await withTempDir(async base => {
    await write(base, 'src/Api/Program.cs')
    const request = { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 1 }
    const message = 'Open a local workspace of web-app first.'
    const api = workspace('ws-api', base, 'main')
    const remote = workspace('ws-remote', base, 'main', 'ssh:build-box')

    const none = host([], null)
    assert.deepEqual(await openRunFile(depsOf(none.call).deps, request), { opened: false, message })

    const otherRepository = host([api], api)
    assert.deepEqual(await openRunFile(depsOf(otherRepository.call, { [base]: [API] }).deps, request), { opened: false, message }, 'a known remote that is another repository')

    const otherProject = host([api], api)
    assert.deepEqual(await openRunFile(depsOf(otherProject.call, { [base]: [{ ...WEB, project: 'Other' }] }).deps, request), { opened: false, message })

    const remoteHost = host([remote], remote)
    assert.deepEqual(await openRunFile(depsOf(remoteHost.call, { [base]: [WEB] }).deps, request), { opened: false, message }, 'a workspace on another host')

    for (const answered of [none, otherRepository, otherProject, remoteHost]) assert.deepEqual(answered.opened(), [])
  })
})

test('a missing file says so', async () => {
  await withTempDir(async base => {
    await write(base, 'src/Other.cs')
    await fs.mkdir(path.join(base, 'src', 'Program.cs'))
    const web = workspace('ws-web', base, 'main')
    const { call, opened } = host([web], web)
    const { deps } = depsOf(call, { [base]: [WEB] })
    const message = "Couldn't find Program.cs in your local workspaces of web-app."

    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 1 }), { opened: false, message })
    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: 'D:\\a\\1\\s\\src\\Api\\Program.cs', line: 1 }), { opened: false, message })
    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: 'src/Program.cs', line: 1 }), { opened: false, message }, 'a directory is not a file')
    assert.deepEqual(opened(), [])
  })
})

test('without git the focused workspace is used', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    await write(dir('other'), 'src/Api/Program.cs')
    await write(dir('web'), 'src/Api/Program.cs')
    await write(dir('bare'), 'src/Api/Other.cs')
    const other = workspace('ws-other', dir('other'), 'main')
    const web = workspace('ws-web', dir('web'), 'main')
    const bare = workspace('ws-bare', dir('bare'), 'main')
    const request = { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 7 }
    const withoutGit = (call: HostCall): OpenFileDeps => ({
      call,
      gitAvailable: false,
      remotes: gitRemotes(neverRun, null, Date.now),
      isFileInside: fileInside(fs)
    })

    const focused = host([other, web], web)
    assert.deepEqual(await openRunFile(withoutGit(focused.call), request), { opened: true, path: 'src/Api/Program.cs', line: 7 })
    assert.deepEqual(focused.opened(), [{ workspaceId: 'ws-web', path: 'src/Api/Program.cs' }])

    const lacking = host([other, bare], bare)
    assert.deepEqual(await openRunFile(withoutGit(lacking.call), request), {
      opened: false,
      message: "Couldn't find Program.cs in your local workspaces of web-app."
    })
    assert.deepEqual(lacking.opened(), [], 'the other workspaces are not searched')

    const unfocused = host([other, web], null)
    assert.deepEqual(await openRunFile(withoutGit(unfocused.call), request), { opened: false, message: 'Open a local workspace of web-app first.' })
  })
})

test('with git, a focused workspace of another repository is never searched', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    await write(dir('notes'), 'Program.cs')
    await write(dir('folder'), 'Program.cs')
    await write(dir('api'), 'Program.cs')
    const notes = workspace('ws-notes', dir('notes'), 'main')
    const folder = workspace('ws-folder', dir('folder'), 'main')
    const api = workspace('ws-api', dir('api'), 'main')
    const request = { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 42 }
    const message = 'Open a local workspace of web-app first.'

    const github = host([notes], notes)
    assert.deepEqual(await openRunFile(depsOf(github.call, { [dir('notes')]: [] }).deps, request), { opened: false, message }, 'a GitHub-hosted workspace reads as no Azure DevOps remotes')

    const plain = host([folder], folder)
    assert.deepEqual(await openRunFile(depsOf(plain.call).deps, request), { opened: false, message }, 'a folder that is not a repository')

    const another = host([api, notes], notes)
    assert.deepEqual(await openRunFile(depsOf(another.call, { [dir('api')]: [API] }).deps, request), { opened: false, message })

    for (const answered of [github, plain, another]) assert.deepEqual(answered.opened(), [])
  })
})

test('a remote that names no project matches a run of any project in its organization', async () => {
  await withTempDir(async base => {
    await write(base, 'src/Api/Program.cs')
    const web = workspace('ws-web', base, 'main')
    const { call, opened } = host([web], web)
    const noProject = { org: 'Contoso', project: '', repo: 'WEB-APP' }
    const request = { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 1 }

    assert.deepEqual(await openRunFile(depsOf(call, { [base]: [noProject] }).deps, request), { opened: true, path: 'src/Api/Program.cs', line: 1 })
    assert.deepEqual(opened(), [{ workspaceId: 'ws-web', path: 'src/Api/Program.cs' }])

    const otherOrg = { opened: false, message: 'Open a local workspace of web-app first.' }
    assert.deepEqual(await openRunFile(depsOf(call, { [base]: [{ ...noProject, org: 'fabrikam' }] }).deps, request), otherOrg)
    assert.equal(opened().length, 1)
  })
})

test('among workspaces on the run branch the focused one wins whatever the list order', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    for (const name of ['first', 'second', 'third']) await write(dir(name), 'src/Api/Program.cs')
    const first = workspace('ws-first', dir('first'), 'main')
    const second = workspace('ws-second', dir('second'), 'main')
    const third = workspace('ws-third', dir('third'), 'develop')
    const remotesAt = { [dir('first')]: [WEB], [dir('second')]: [WEB], [dir('third')]: [WEB] }
    const request = { run: runOf(), path: `${AGENT}/src/Api/Program.cs`, line: 1 }
    const openedIn = async (entries: WorkspaceEntry[], focused: WorkspaceEntry) => {
      const { call, opened } = host(entries, focused)
      assert.equal((await openRunFile(depsOf(call, remotesAt).deps, request)).opened, true)
      return (opened().at(-1) as { workspaceId: string }).workspaceId
    }

    assert.equal(await openedIn([first, second, third], second), 'ws-second')
    assert.equal(await openedIn([second, first, third], first), 'ws-first')
    assert.equal(await openedIn([first, second, third], third), 'ws-first', 'the run branch still beats focus')
  })
})

test('a run without an Azure Repos repository uses the focused local workspace only', async () => {
  await withTempDir(async base => {
    const dir = (name: string) => path.join(base, name)
    await write(dir('github'), 'src/app.ts')
    await write(dir('web'), 'src/app.ts')
    await write(dir('bare'), 'src/other.ts')
    const run = runOf({ repository: null })
    const request = { run, path: '/agent/s/src/app.ts', line: 2 }
    const github = workspace('ws-github', dir('github'), 'main')
    const web = workspace('ws-web', dir('web'), 'main')
    const bare = workspace('ws-bare', dir('bare'), 'main')
    const remote = workspace('ws-remote', dir('web'), 'main', 'ssh:build-box')
    const unread: OpenFileDeps['remotes'] = async () => assert.fail('remotes are not read')
    const depsFor = (call: HostCall): OpenFileDeps => ({ call, gitAvailable: true, remotes: unread, isFileInside: fileInside(fs) })

    const focused = host([github, web], web)
    assert.deepEqual(await openRunFile(depsFor(focused.call), request), { opened: true, path: 'src/app.ts', line: 2 })
    assert.deepEqual(focused.opened(), [{ workspaceId: 'ws-web', path: 'src/app.ts' }])

    const lacking = host([github, bare], bare)
    assert.deepEqual(await openRunFile(depsFor(lacking.call), request), {
      opened: false,
      message: "Couldn't find app.ts in your local workspaces of ws-bare."
    })

    const noFocus = { opened: false, message: 'Open a local workspace first.' }
    const unfocused = host([github, web], null)
    assert.deepEqual(await openRunFile(depsFor(unfocused.call), request), noFocus)
    const remoteFocus = host([remote], remote)
    assert.deepEqual(await openRunFile(depsFor(remoteFocus.call), request), noFocus)
    for (const answered of [lacking, unfocused, remoteFocus]) assert.deepEqual(answered.opened(), [])
  })
})

test('openRunFile refuses an over-long or non-text path before reading anything', async () => {
  const { call, calls } = host([], null)
  const { deps } = depsOf(call)
  const longest = `${'a'.repeat(997)}.cs`
  assert.equal(longest.length, 1_000)
  for (const input of [`${longest}x`, 'a/'.repeat(600), 'a'.repeat(5_000)]) {
    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: input, line: 1 }), { opened: false, message: NOT_A_FILE })
  }
  for (const input of [42, null, undefined, {}]) {
    assert.deepEqual(await openRunFile(deps, { run: runOf(), path: input as unknown as string, line: 1 }), { opened: false, message: NOT_A_FILE })
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(await openRunFile(deps, { run: runOf(), path: longest, line: 1 }), { opened: false, message: 'Open a local workspace of web-app first.' })
})

function fakeGit(answers: Record<string, RunResult | Error>) {
  const calls: { file: string; args: string[]; opts: Parameters<RunCommand>[2] }[] = []
  const run: RunCommand = async (file, args, opts) => {
    calls.push({ file, args, opts })
    const answer = answers[args[1]] ?? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    if (answer instanceof Error) throw answer
    return answer
  }
  return { run, calls }
}

const REMOTE_V = [
  'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)',
  'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (push)',
  'github\thttps://github.com/contoso/web-app.git (fetch)',
  ''
].join('\n')

test('gitRemotes runs git remote -v in the workspace with a timeout and no shell', async () => {
  const hostile = '/repos/web app; echo $(id)'
  const git = fakeGit({ [hostile]: { code: 0, stdout: REMOTE_V, stderr: '' } })
  const remotes = gitRemotes(git.run, '/usr/bin/git', () => 0)
  assert.deepEqual(await remotes(hostile), [WEB])
  assert.deepEqual(git.calls, [{ file: '/usr/bin/git', args: ['-C', hostile, 'remote', '-v'], opts: { timeoutMs: 5_000 } }])
})

test('gitRemotes caches per path for ten minutes', async () => {
  const git = fakeGit({ '/a': { code: 0, stdout: REMOTE_V, stderr: '' }, '/b': { code: 0, stdout: '', stderr: '' } })
  let now = 1_000
  const remotes = gitRemotes(git.run, '/usr/bin/git', () => now)
  assert.deepEqual(await remotes('/a'), [WEB])
  assert.deepEqual(await remotes('/b'), [])
  now += 10 * MINUTE - 1
  assert.deepEqual(await remotes('/a'), [WEB])
  assert.equal(git.calls.length, 2, 'both answers are still fresh')
  now += 1
  assert.deepEqual(await remotes('/a'), [WEB])
  assert.deepEqual(git.calls.map(call => call.args[1]), ['/a', '/b', '/a'])
  assert.deepEqual(await remotes('/b'), [])
  assert.deepEqual(git.calls.map(call => call.args[1]), ['/a', '/b', '/a', '/b'], 'a path that was not asked again expired too')
})

test('gitRemotes gives no remotes without git or outside a repository, and lets a failed run surface', async () => {
  const unused = fakeGit({})
  assert.deepEqual(await gitRemotes(unused.run, null, Date.now)('/a'), [])
  assert.deepEqual(unused.calls, [])

  const notRepo = fakeGit({ '/folder': { code: 128, stdout: '', stderr: 'fatal: not a git repository' } })
  const remotes = gitRemotes(notRepo.run, '/usr/bin/git', () => 0)
  assert.deepEqual(await remotes('/folder'), [])
  assert.deepEqual(await remotes('/folder'), [])
  assert.equal(notRepo.calls.length, 1)

  const failing = fakeGit({ '/slow': new Error('git timed out after 5000ms') })
  const flaky = gitRemotes(failing.run, '/usr/bin/git', () => 0)
  await assert.rejects(flaky('/slow'), /git timed out after 5000ms/)
  await assert.rejects(flaky('/slow'), /git timed out after 5000ms/)
  assert.equal(failing.calls.length, 2, 'a failure is not cached')
})
