import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { createStartFiles, START_FILE_MS } from './start-files'

const T0 = Date.parse('2026-11-11T09:00:00Z')
const UID = process.getuid?.() ?? -1
const OLD = new Date(T0 - START_FILE_MS - 1)
const id = (char: string) => char.repeat(24)

async function withHome(run: (home: string, dir: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'start-files-'))
  try {
    await run(home, path.join(home, '.orca-azure-devops', 'starts'))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

const modeOf = async (target: string) => (await fs.stat(target)).mode & 0o777

const filesAt = (home: string, uid = UID) => createStartFiles({ home, fs, now: () => T0, uid })

async function plant(target: string, text = 'mine', when = OLD): Promise<void> {
  await fs.writeFile(target, text)
  await fs.utimes(target, when, when)
}

test('files are written to a private folder, readable by their owner only', async () => {
  await withHome(async (home, dir) => {
    await filesAt(home).write({ [`${id('a')}.prompt`]: 'Fix it\nnow', [`${id('a')}.worktree`]: 'id:repo::/repos/web' })
    assert.equal(await fs.readFile(path.join(dir, `${id('a')}.prompt`), 'utf8'), 'Fix it\nnow')
    assert.equal(await fs.readFile(path.join(dir, `${id('a')}.worktree`), 'utf8'), 'id:repo::/repos/web')
    assert.equal(await modeOf(dir), 0o700)
    assert.equal(await modeOf(path.join(dir, `${id('a')}.prompt`)), 0o600)
  })
})

test('a folder left open to others is closed again before anything is written', async () => {
  await withHome(async (home, dir) => {
    await fs.mkdir(dir, { recursive: true, mode: 0o755 })
    await fs.chmod(dir, 0o755)
    await filesAt(home).write({ [`${id('c')}.prompt`]: 'x' })
    assert.equal(await modeOf(dir), 0o700)
  })
})

test('a folder that is a link, or a file already there, is refused', async () => {
  await withHome(async (home, dir) => {
    const elsewhere = path.join(home, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await fs.symlink(elsewhere, dir)
    await assert.rejects(filesAt(home).write({ [`${id('d')}.prompt`]: 'x' }))
    assert.deepEqual(await fs.readdir(elsewhere), [])
  })
  await withHome(async (home, dir) => {
    const files = filesAt(home)
    await files.write({ [`${id('e')}.prompt`]: 'first' })
    await assert.rejects(files.write({ [`${id('e')}.prompt`]: 'second' }))
    assert.equal(await fs.readFile(path.join(dir, `${id('e')}.prompt`), 'utf8'), 'first')
  })
})

test('a folder owned by someone else is never written, removed from or swept', async () => {
  await withHome(async (home, dir) => {
    await filesAt(home).write({ [`${id('a')}.prompt`]: 'x' })
    await fs.utimes(path.join(dir, `${id('a')}.prompt`), OLD, OLD)
    const stranger = filesAt(home, UID + 1)
    await assert.rejects(stranger.write({ [`${id('b')}.prompt`]: 'x' }))
    await assert.rejects(stranger.remove([`${id('a')}.prompt`]))
    assert.equal(await stranger.sweep(), 0)
    assert.deepEqual(await fs.readdir(dir), [`${id('a')}.prompt`])
  })
})

test('only the exact names the plugin makes are written or removed', async () => {
  await withHome(async home => {
    const files = filesAt(home)
    for (const name of ['../escape.prompt', 'a/b.prompt', '.prompt', `${id('a')}.sh`, `${id('A')}.prompt`, 'abc.prompt', `${id('a')}a.prompt`, '']) {
      await assert.rejects(files.write({ [name]: 'x' }), /Not a start file/)
      await assert.rejects(files.remove([name]), /Not a start file/)
    }
  })
})

test('remove deletes the files, a missing one is fine, and a folder that is a link is refused', async () => {
  await withHome(async (home, dir) => {
    const files = filesAt(home)
    await files.write({ [`${id('f')}.prompt`]: 'x', [`${id('f')}.worktree`]: 'y' })
    await files.remove([`${id('f')}.prompt`, `${id('f')}.worktree`, `${id('e')}.prompt`])
    assert.deepEqual(await fs.readdir(dir), [])
  })
  await withHome(async (home, dir) => {
    const elsewhere = path.join(home, 'elsewhere')
    await fs.mkdir(elsewhere)
    await plant(path.join(elsewhere, `${id('a')}.prompt`))
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await fs.symlink(elsewhere, dir)
    await assert.rejects(filesAt(home).remove([`${id('a')}.prompt`]))
    assert.deepEqual(await fs.readdir(elsewhere), [`${id('a')}.prompt`])
  })
})

test('the sweep never follows a folder that is a link, and leaves its files alone', async () => {
  await withHome(async (home, dir) => {
    const documents = path.join(home, 'Documents')
    await fs.mkdir(documents)
    for (const name of ['2024.csv', 'cafe.md', `${id('a')}.prompt`]) await plant(path.join(documents, name))
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await fs.symlink(documents, dir)
    assert.equal(await filesAt(home).sweep(), 0)
    assert.deepEqual((await fs.readdir(documents)).sort(), ['2024.csv', `${id('a')}.prompt`, 'cafe.md'])
  })
})

test('the sweep removes only old regular files with the exact generated name, and counts the start files it keeps', async () => {
  await withHome(async (home, dir) => {
    const outside = path.join(home, 'outside.txt')
    await plant(outside)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await plant(path.join(dir, `${id('a')}.prompt`))
    await plant(path.join(dir, `${id('b')}.worktree`))
    await plant(path.join(dir, `${id('c')}.prompt`), 'fresh', new Date(T0 - 1000))
    await plant(path.join(dir, `${id('9')}.prompt`), 'edge', new Date(T0 - START_FILE_MS))
    for (const name of ['abc.prompt', `${id('d')}.txt`, `${id('B')}.prompt`, 'notes.md']) await plant(path.join(dir, name))
    await fs.symlink(outside, path.join(dir, `${id('e')}.prompt`))
    await fs.mkdir(path.join(dir, `${id('f')}.prompt`))
    assert.equal(await filesAt(home).sweep(), 2)
    assert.deepEqual((await fs.readdir(dir)).sort(), [`${id('9')}.prompt`, `${id('B')}.prompt`, `${id('c')}.prompt`, `${id('d')}.txt`, `${id('e')}.prompt`, `${id('f')}.prompt`, 'abc.prompt', 'notes.md'].sort())
    assert.equal(await fs.readFile(outside, 'utf8'), 'mine')
  })
})

test('a missing folder sweeps nothing', async () => {
  await withHome(async home => {
    assert.equal(await filesAt(home).sweep(), 0)
  })
})

test('ids are 24 lower-case hex characters and differ each time', () => {
  const files = filesAt('/nowhere')
  const ids = new Set(Array.from({ length: 50 }, () => files.id()))
  assert.equal(ids.size, 50)
  for (const each of ids) assert.match(each, /^[0-9a-f]{24}$/)
})

test('url, folder and repo files are written 0600 and swept like the others', async () => {
  await withHome(async (home, dir) => {
    const files = filesAt(home)
    const old = ['url', 'folder', 'repo'].map(field => `${id('a')}.${field}`)
    const fresh = ['url', 'folder', 'repo'].map(field => `${id('b')}.${field}`)
    await files.write(Object.fromEntries([...old, ...fresh].map(name => [name, `/repos/${name}`])))
    for (const name of [...old, ...fresh]) {
      assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), `/repos/${name}`)
      assert.equal(await modeOf(path.join(dir, name)), 0o600)
    }
    for (const name of old) await fs.utimes(path.join(dir, name), OLD, OLD)
    for (const name of fresh) await fs.utimes(path.join(dir, name), new Date(T0 - 1000), new Date(T0 - 1000))
    assert.equal(await files.sweep(), 3)
    assert.deepEqual((await fs.readdir(dir)).sort(), fresh.sort())
  })
})

test('a name with any other field is still refused', async () => {
  await withHome(async (home, dir) => {
    const files = filesAt(home)
    for (const field of ['path', 'urls', 'URL', 'cmd', 'repo.sh', 'folder ', 'git']) {
      await assert.rejects(files.write({ [`${id('a')}.${field}`]: 'x' }), /Not a start file/)
      await assert.rejects(files.remove([`${id('a')}.${field}`]), /Not a start file/)
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await plant(path.join(dir, `${id('a')}.path`))
    assert.equal(await files.sweep(), 0)
    assert.deepEqual(await fs.readdir(dir), [`${id('a')}.path`])
  })
})
