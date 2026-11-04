import { assert, test } from 'orca/testing'
import { runCommand } from './run'

const NO_ENV = { PATH: '/usr/bin:/bin' }

test('runCommand resolves stdout and a zero exit code', async () => {
  const result = await runCommand('/bin/sh', ['-c', 'printf out'], { env: NO_ENV })
  assert.deepEqual(result, { code: 0, stdout: 'out', stderr: '' })
})

test('runCommand resolves a non-zero exit with its code and stderr', async () => {
  const result = await runCommand('/bin/sh', ['-c', 'printf out; printf err >&2; exit 3'], { env: NO_ENV })
  assert.deepEqual(result, { code: 3, stdout: 'out', stderr: 'err' })
})

test('runCommand never interprets arguments through a shell', async () => {
  const result = await runCommand('/bin/echo', ['a;b', '$HOME', '`id`'], { env: NO_ENV })
  assert.equal(result.stdout, 'a;b $HOME `id`\n')
})

test('runCommand hands the given env to the child and nothing else', async () => {
  const result = await runCommand('/usr/bin/env', [], { env: { ONLY_VAR: 'yes' } })
  assert.equal(result.stdout, 'ONLY_VAR=yes\n')
})

test('runCommand rejects when the executable cannot be spawned', async () => {
  await assert.rejects(runCommand('/nonexistent/az', [], { env: NO_ENV }), /ENOENT/)
})

test('runCommand kills the child and rejects when the signal aborts', async () => {
  const controller = new AbortController()
  const pending = runCommand('/bin/sh', ['-c', 'exec sleep 30'], { env: NO_ENV, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError')
})

test('runCommand kills the child and rejects after the timeout', async () => {
  const started = Date.now()
  await assert.rejects(
    runCommand('/bin/sh', ['-c', 'exec sleep 30'], { env: NO_ENV, timeoutMs: 100 }),
    /timed out after 100ms/
  )
  assert.ok(Date.now() - started < 10_000)
})
