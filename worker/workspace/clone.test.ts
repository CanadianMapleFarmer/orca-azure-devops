import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { RepoRecord } from '../data/records'
import { cloneRootFailed, cloneRootUnsafe } from '../messages'
import { cloneRoot, cloneUrlOf, folderKey, folderNameOf, folderState, prefersSsh, readyRoot, rootProblem, shownPath, type FolderDeps } from './clone'
import type { AdoRemote } from './remotes'

const HOME = '/home/ada'
const UID = process.getuid?.() ?? -1
const SOMEONE_ELSE = UID + 1
const WEB = { org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const WEB_REMOTE: AdoRemote = { remote: 'origin', ...WEB }
const RECORD: RepoRecord = { id: 'r1', name: 'web-app', projectId: 'p1', projectName: 'Fabrikam Web', ssh: true, disabled: false }

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-'))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false
  )
}

function folderDeps(overrides: Partial<FolderDeps> = {}): FolderDeps {
  return { fs, uid: UID, topLevel: folder => fs.realpath(folder), hasHead: async () => true, remotes: async () => [WEB_REMOTE], ...overrides }
}

async function cloneAt(folder: string): Promise<string> {
  await fs.mkdir(path.join(folder, '.git'), { recursive: true })
  return folder
}

test('cloneRoot expands ~ and ~/, keeps absolute paths, uses the default when empty, and refuses relative paths and control characters, newline included', () => {
  assert.equal(cloneRoot('', HOME), '/home/ada/orca/repos')
  assert.equal(cloneRoot('   ', HOME), '/home/ada/orca/repos')
  assert.equal(cloneRoot('~', HOME), '/home/ada')
  assert.equal(cloneRoot('~/code/', HOME), '/home/ada/code')
  assert.equal(cloneRoot(' ~/code ', HOME), '/home/ada/code')
  assert.equal(cloneRoot('/srv/repos', HOME), '/srv/repos')
  assert.equal(cloneRoot('/srv/web app/../repos/', HOME), '/srv/repos')
  for (const setting of ['repos', './repos', '~ada/repos', '/srv/re\npos', '/srv/repos\n', '/srv/re\u0007pos', '~/a\u0085b', '/srv/\u007f']) {
    assert.equal(cloneRoot(setting, HOME), null, JSON.stringify(setting))
  }
  assert.equal(cloneRoot('~/repos', '/home/a\nda'), null)
})

test('shownPath shows the home folder as ~', () => {
  assert.equal(shownPath('/home/ada/orca/repos', HOME), '~/orca/repos')
  assert.equal(shownPath('/home/ada', HOME), '~')
  assert.equal(shownPath('/home/ada/orca/repos', '/home/ada/'), '~/orca/repos')
  assert.equal(shownPath('/home/adam/repos', HOME), '/home/adam/repos')
  assert.equal(shownPath('/srv/repos', HOME), '/srv/repos')
})

test('folderNameOf keeps names Azure DevOps allows', () => {
  for (const name of ['web app', "it's", 'w\u0435b-app', '漢字', 'a(b)&c!', 'web-app', 'a'.repeat(64)]) {
    assert.equal(folderNameOf(name), name, JSON.stringify(name))
  }
  assert.equal(folderNameOf('cafe\u0301'), 'caf\u00e9')
})

test('folderNameOf refuses what Azure DevOps refuses, a leading dash, a backtick and format characters', () => {
  for (const name of [
    '',
    '$(touch x)',
    '`x`',
    'a`b',
    'a"b',
    'a\nb',
    'a\u0085b',
    'a;b',
    'a:b',
    'a*b',
    'a?b',
    'a<b',
    'a>b',
    'a#b',
    'a{b}',
    'a,b',
    'a+b',
    'a=b',
    'a[b]',
    'a|b',
    '-rf',
    '.git',
    '_x',
    'x.',
    'a/b',
    'a\\b',
    '..',
    'CON',
    'nul',
    'Prn',
    'aux',
    'COM1',
    'com10',
    'LPT9',
    '\u202eevil',
    'a\u200bb',
    '\uD800',
    'a\uDC00b',
    'a'.repeat(65)
  ]) {
    assert.equal(folderNameOf(name), null, JSON.stringify(name))
  }
})

test('folderKey is the same for folders that differ only in case or Unicode form', () => {
  assert.equal(folderKey('/home/ada/orca/repos/Web-App'), folderKey('/home/ada/orca/repos/web-app'))
  assert.equal(folderKey('/home/ada/orca/repos/Cafe\u0301'), '/home/ada/orca/repos/caf\u00e9')
  assert.notEqual(folderKey('/home/ada/orca/repos/w\u0435b-app'), folderKey('/home/ada/orca/repos/web-app'))
})

test('cloneUrlOf rebuilds the url from the names over https, and over ssh only when preferred and offered', () => {
  assert.equal(cloneUrlOf('contoso', RECORD, false), 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app')
  assert.equal(cloneUrlOf('contoso', RECORD, true), 'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app')
  assert.equal(cloneUrlOf('contoso', { ...RECORD, ssh: false }, true), 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app')
})

test("cloneUrlOf encodes every character outside [A-Za-z0-9._~-], and refuses an org that isn't valid or a name with a control character", () => {
  assert.equal(cloneUrlOf('contoso', { ...RECORD, name: "it's (new)" }, false), 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/it%27s%20%28new%29')
  assert.equal(cloneUrlOf('contoso', { ...RECORD, name: 'a!b*~c' }, true), 'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/a%21b%2A~c')
  assert.equal(cloneUrlOf('contoso', { ...RECORD, projectName: 'Caf\u00e9' }, false), 'https://dev.azure.com/contoso/Caf%C3%A9/_git/web-app')
  for (const org of ['contoso evil', 'Contoso', '-contoso', '']) assert.equal(cloneUrlOf(org, RECORD, false), null, org)
  for (const ssh of [false, true]) {
    assert.equal(cloneUrlOf('contoso', { ...RECORD, name: 'web\napp' }, ssh), null)
    assert.equal(cloneUrlOf('contoso', { ...RECORD, projectName: 'Fabrikam\u0000Web' }, ssh), null)
    assert.equal(cloneUrlOf('contoso', { ...RECORD, name: '' }, ssh), null)
    assert.equal(cloneUrlOf('contoso', { ...RECORD, name: '\uD800' }, ssh), null)
  }
})

test('cloneUrlOf refuses a . or .. project or repository, over https and ssh alike', () => {
  for (const ssh of [false, true]) {
    for (const name of ['.', '..']) {
      assert.equal(cloneUrlOf('contoso', { ...RECORD, name }, ssh), null, `${name} over ${ssh ? 'ssh' : 'https'}`)
      assert.equal(cloneUrlOf('contoso', { ...RECORD, projectName: name }, ssh), null, `project ${name} over ${ssh ? 'ssh' : 'https'}`)
    }
  }
  assert.equal(cloneUrlOf('contoso', { ...RECORD, name: '.web' }, true), 'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/.web')
})

test('prefersSsh only when every remote of the organisation is ssh, and there is one', () => {
  const ssh = (org: string): AdoRemote => ({ remote: 'origin', org, project: 'Fabrikam Web', repo: 'web-app', ssh: true })
  const https = (org: string): AdoRemote => ({ remote: 'origin', org, project: 'Fabrikam Web', repo: 'api' })
  assert.equal(prefersSsh('contoso', []), false)
  assert.equal(prefersSsh('contoso', [{ ado: [] }]), false)
  assert.equal(prefersSsh('contoso', [{ ado: [ssh('fabrikam')] }]), false)
  assert.equal(prefersSsh('contoso', [{ ado: [ssh('contoso')] }, { ado: [ssh('Contoso'), https('fabrikam')] }]), true)
  assert.equal(prefersSsh('contoso', [{ ado: [ssh('contoso')] }, { ado: [https('contoso')] }]), false)
})

test('readyRoot creates the folder and answers its realpath; a root owned by someone else, or writable by the group or others, is refused', async () => {
  await withDir(async dir => {
    const root = path.join(dir, 'orca', 'repos')
    const ready = await readyRoot({ fs, uid: UID }, root)
    const real = await fs.realpath(root)
    assert.deepEqual(ready, { root: real })
    assert.equal((await fs.lstat(root)).mode & 0o022, 0)
    const link = path.join(dir, 'link')
    await fs.symlink(root, link)
    assert.deepEqual(await readyRoot({ fs, uid: UID }, link), { root: real })
    assert.deepEqual(await readyRoot({ fs, uid: SOMEONE_ELSE }, root), { problem: cloneRootUnsafe(root) })
    await fs.chmod(root, 0o775)
    assert.deepEqual(await readyRoot({ fs, uid: UID }, root), { problem: cloneRootUnsafe(root) })
    await fs.chmod(root, 0o757)
    assert.deepEqual(await readyRoot({ fs, uid: UID }, link), { problem: cloneRootUnsafe(link) })
  })
})

test('a root under a folder the group or others can write to is refused, unless that folder is sticky like /tmp', async () => {
  await withDir(async dir => {
    const shared = path.join(dir, 'shared')
    await fs.mkdir(shared)
    await fs.chmod(shared, 0o777)
    const root = path.join(shared, 'orca', 'repos')
    assert.deepEqual(await readyRoot({ fs, uid: UID }, root), { problem: cloneRootUnsafe(root) })
    assert.equal(await rootProblem({ fs, uid: UID }, root), cloneRootUnsafe(root))
    await fs.chmod(shared, 0o775)
    assert.equal(await rootProblem({ fs, uid: UID }, root), cloneRootUnsafe(root))

    await fs.chmod(shared, 0o1777)
    assert.equal(await rootProblem({ fs, uid: UID }, root), null)
    assert.deepEqual(await readyRoot({ fs, uid: UID }, root), { root: await fs.realpath(root) })
    const link = path.join(dir, 'link')
    await fs.symlink(path.join(shared, 'orca'), link)
    assert.equal(await rootProblem({ fs, uid: UID }, path.join(link, 'repos')), null)
    await fs.chmod(shared, 0o777)
    assert.equal(await rootProblem({ fs, uid: UID }, path.join(link, 'repos')), cloneRootUnsafe(path.join(link, 'repos')), 'the real parents are checked, not the link')
  })
})

test("readyRoot says it couldn't create a root that a file is in the way of", async () => {
  await withDir(async dir => {
    const file = path.join(dir, 'file')
    await fs.writeFile(file, 'x')
    assert.deepEqual(await readyRoot({ fs, uid: UID }, file), { problem: cloneRootFailed(file) })
    assert.deepEqual(await readyRoot({ fs, uid: UID }, path.join(file, 'repos')), { problem: cloneRootFailed(path.join(file, 'repos')) })
  })
})

test("rootProblem creates nothing, accepts an absent root, and refuses an existing one that isn't yours or is writable by others", async () => {
  await withDir(async dir => {
    const absent = path.join(dir, 'orca', 'repos')
    assert.equal(await rootProblem({ fs, uid: UID }, absent), null)
    assert.equal(await exists(path.join(dir, 'orca')), false)
    const root = path.join(dir, 'repos')
    await fs.mkdir(root, { mode: 0o755 })
    assert.equal(await rootProblem({ fs, uid: UID }, root), null)
    assert.equal(await rootProblem({ fs, uid: SOMEONE_ELSE }, root), cloneRootUnsafe(root))
    await fs.chmod(root, 0o757)
    assert.equal(await rootProblem({ fs, uid: UID }, root), cloneRootUnsafe(root))
    const file = path.join(dir, 'file')
    await fs.writeFile(file, 'x')
    assert.equal(await rootProblem({ fs, uid: UID }, file), cloneRootFailed(file))
    assert.equal(await rootProblem({ fs, uid: UID }, path.join(file, 'repos')), cloneRootFailed(path.join(file, 'repos')))
  })
})

test('folderState: an absent folder, or an empty one of yours, is absent; a clone of the repository with a HEAD is a clone', async () => {
  await withDir(async dir => {
    await fs.mkdir(path.join(dir, 'real'))
    await fs.symlink(path.join(dir, 'real'), path.join(dir, 'root'))
    const folder = path.join(dir, 'root', 'web-app')
    assert.equal(await folderState(folderDeps(), folder, WEB), 'absent')
    await fs.mkdir(folder)
    assert.equal(await folderState(folderDeps(), folder, WEB), 'absent')
    await cloneAt(folder)
    assert.equal(await folderState(folderDeps(), folder, WEB), 'clone')
    const caseOnly = folderDeps({ remotes: async () => [{ remote: 'upstream', org: 'Contoso', project: 'fabrikam web', repo: 'Web-App' }] })
    assert.equal(await folderState(caseOnly, folder, WEB), 'clone')
  })
})

test('folderState: a folder without HEAD, a subfolder of another repository, a same-named repository of another project, a file and a link are taken', async () => {
  await withDir(async dir => {
    const folder = await cloneAt(path.join(dir, 'web-app'))
    assert.equal(await folderState(folderDeps({ hasHead: async () => false }), folder, WEB), 'taken')
    assert.equal(await folderState(folderDeps({ topLevel: async () => fs.realpath(dir) }), folder, WEB), 'taken')
    assert.equal(await folderState(folderDeps({ topLevel: async () => null }), folder, WEB), 'taken')
    assert.equal(await folderState(folderDeps({ remotes: async () => [] }), folder, WEB), 'taken')
    const toolsRemote = { remote: 'origin', org: 'contoso', project: 'Tools', repo: 'Web-App' }
    assert.equal(await folderState(folderDeps({ remotes: async () => [toolsRemote] }), folder, WEB), 'taken')
    assert.equal(await folderState(folderDeps({ remotes: async () => [WEB_REMOTE] }), folder, { org: 'contoso', project: 'Tools', repo: 'Web-App' }), 'taken')
    const file = path.join(dir, 'api')
    await fs.writeFile(file, 'x')
    assert.equal(await folderState(folderDeps(), file, { ...WEB, repo: 'api' }), 'taken')
    const link = path.join(dir, 'tools')
    await fs.symlink(folder, link)
    assert.equal(await folderState(folderDeps(), link, WEB), 'taken')
    await fs.symlink(path.join(dir, 'nowhere'), path.join(dir, 'dangling'))
    assert.equal(await folderState(folderDeps(), path.join(dir, 'dangling'), WEB), 'taken')
  })
})

test('folderState: a folder another user owns is not yours, even when it is a clone of the repository', async () => {
  await withDir(async dir => {
    const folder = await cloneAt(path.join(dir, 'web-app'))
    assert.equal(await folderState(folderDeps({ uid: SOMEONE_ELSE }), folder, WEB), 'not-yours')
    const empty = path.join(dir, 'api')
    await fs.mkdir(empty)
    assert.equal(await folderState(folderDeps({ uid: SOMEONE_ELSE }), empty, { ...WEB, repo: 'api' }), 'not-yours')
  })
})
