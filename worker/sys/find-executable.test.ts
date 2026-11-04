import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { DEFAULT_EXTRA_DIRS, findExecutable } from './find-executable'

const executableOnly =
  (...paths: string[]) =>
  (candidate: string) =>
    paths.includes(candidate)

test('findExecutable falls back to Homebrew dirs when PATH is empty', () => {
  const found = findExecutable('az', { pathEnv: '', isExecutable: executableOnly('/opt/homebrew/bin/az') })
  assert.equal(found, '/opt/homebrew/bin/az')
})

test('DEFAULT_EXTRA_DIRS lists the Homebrew and system locations', () => {
  assert.deepEqual(DEFAULT_EXTRA_DIRS, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
})

test('findExecutable searches PATH entries before the extra dirs', () => {
  const pathEnv = ['/custom/bin', '/other/bin'].join(path.delimiter)
  const found = findExecutable('az', {
    pathEnv,
    isExecutable: executableOnly('/opt/homebrew/bin/az', '/other/bin/az')
  })
  assert.equal(found, '/other/bin/az')
})

test('findExecutable searches custom extraDirs instead of the defaults', () => {
  const found = findExecutable('az', {
    pathEnv: '',
    extraDirs: ['/tools/bin'],
    isExecutable: executableOnly('/opt/homebrew/bin/az', '/tools/bin/az')
  })
  assert.equal(found, '/tools/bin/az')
})

test('a non-empty override wins whenever it is executable', () => {
  const found = findExecutable('az', {
    override: '/custom/az',
    pathEnv: '/usr/bin',
    isExecutable: executableOnly('/custom/az', '/usr/bin/az')
  })
  assert.equal(found, '/custom/az')
})

test('an override that is not executable falls through to the search', () => {
  const found = findExecutable('az', {
    override: '/custom/az',
    pathEnv: '',
    isExecutable: executableOnly('/opt/homebrew/bin/az')
  })
  assert.equal(found, '/opt/homebrew/bin/az')
})

test('a blank override is ignored', () => {
  const found = findExecutable('az', {
    override: '  ',
    pathEnv: '',
    isExecutable: executableOnly('/usr/local/bin/az')
  })
  assert.equal(found, '/usr/local/bin/az')
})

test('findExecutable returns null when nothing is executable', () => {
  assert.equal(findExecutable('az', { pathEnv: '/usr/bin', isExecutable: () => false }), null)
})

test('the default isExecutable accepts executable files only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-exec-'))
  try {
    await fs.writeFile(path.join(dir, 'runnable'), '#!/bin/sh\n', { mode: 0o755 })
    await fs.writeFile(path.join(dir, 'plain'), 'data', { mode: 0o644 })
    await fs.mkdir(path.join(dir, 'folder'), { mode: 0o755 })
    const search = (name: string) => findExecutable(name, { pathEnv: dir, extraDirs: [] })
    assert.equal(search('runnable'), path.join(dir, 'runnable'))
    assert.equal(search('plain'), null)
    assert.equal(search('folder'), null)
    assert.equal(search('missing'), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
