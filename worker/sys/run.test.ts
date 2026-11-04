import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { runCommand, stopAllCommands } from './run'

const NO_ENV = { PATH: '/usr/bin:/bin' }

function uniqueSleep(): string {
  return `sleep 30.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
}

function running(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern]).status === 0
}

async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return condition()
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, limit])
  } finally {
    clearTimeout(timer)
  }
}

async function withWrapper(lines: string[], patterns: string[], run: (file: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-test-'))
  const file = path.join(dir, 'az')
  await fs.writeFile(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 })
  try {
    await run(file)
  } finally {
    for (const pattern of patterns) spawnSync('pkill', ['-9', '-f', pattern])
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

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

test('runCommand rejects output past 16 MiB', async () => {
  await assert.rejects(
    runCommand('/bin/sh', ['-c', 'head -c 17000000 /dev/zero'], { env: NO_ENV }),
    /stdout maxBuffer length exceeded/
  )
})

test('runCommand rejects at once when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runCommand('/bin/sh', ['-c', 'exit 0'], { env: NO_ENV, signal: controller.signal }), isAbort)
})

test('aborting stops the child of a wrapper that does not exec, and settles once it has', async () => {
  const sleep = uniqueSleep()
  await withWrapper([sleep], [sleep], async az => {
    const controller = new AbortController()
    const pending = runCommand(az, [], { env: NO_ENV, signal: controller.signal })
    assert.ok(await until(() => running(sleep)), 'the wrapper started its child')
    controller.abort()
    await assert.rejects(within(pending, 2_000), isAbort)
    assert.equal(running(sleep), false, 'nothing from the wrapper is left running')
  })
})

test('a timeout stops the child of a wrapper that does not exec, and settles once it has', async () => {
  const sleep = uniqueSleep()
  await withWrapper([sleep], [sleep], async az => {
    const pending = runCommand(az, [], { env: NO_ENV, timeoutMs: 1_500 })
    pending.catch(() => {})
    assert.ok(await until(() => running(sleep)), 'the wrapper started its child')
    await assert.rejects(within(pending, 4_000), /^Error: az timed out after 1500ms$/)
    assert.equal(running(sleep), false, 'nothing from the wrapper is left running')
  })
})

test('a process group that ignores SIGTERM is killed after three seconds', async () => {
  const sleep = uniqueSleep()
  await withWrapper(["trap '' TERM", sleep], [sleep], async az => {
    const controller = new AbortController()
    const pending = runCommand(az, [], { env: NO_ENV, signal: controller.signal })
    assert.ok(await until(() => running(sleep)), 'the wrapper started its child')
    const aborted = Date.now()
    controller.abort()
    await assert.rejects(within(pending, 6_000), isAbort)
    assert.ok(Date.now() - aborted >= 2_900, 'SIGKILL waits for the grace period')
    assert.equal(running(sleep), false, 'nothing from the wrapper is left running')
  })
})

const SHUTDOWN = { killAfterMs: 1_500, withinMs: 1_900 }

test('stopAllCommands stops every running command group and resolves once they are gone', async () => {
  const first = uniqueSleep()
  const second = uniqueSleep()
  await withWrapper([first], [first], async one => {
    await withWrapper([second], [second], async two => {
      const pending = [runCommand(one, [], { env: NO_ENV }), runCommand(two, [], { env: NO_ENV })]
      for (const command of pending) command.catch(() => {})
      assert.ok(await until(() => running(first) && running(second)), 'both wrappers started their children')
      const started = Date.now()
      await stopAllCommands(SHUTDOWN)
      assert.ok(Date.now() - started < 1_000, 'SIGTERM was enough')
      assert.equal(running(first), false)
      assert.equal(running(second), false)
      for (const command of pending) await assert.rejects(within(command, 1_000), /was terminated by SIGTERM/)
    })
  })
})

test('stopAllCommands kills a group that ignores SIGTERM at the kill time, within the budget', async () => {
  const sleep = uniqueSleep()
  await withWrapper(["trap '' TERM", sleep], [sleep], async az => {
    runCommand(az, [], { env: NO_ENV }).catch(() => {})
    assert.ok(await until(() => running(sleep)), 'the wrapper started its child')
    const started = Date.now()
    await stopAllCommands(SHUTDOWN)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 1_400 && elapsed < 1_900, `resolved after ${elapsed}ms`)
    assert.equal(running(sleep), false, 'nothing from the wrapper is left running')
  })
})

test('stopAllCommands has nothing to stop once commands have finished', async () => {
  await runCommand('/bin/sh', ['-c', 'exit 0'], { env: NO_ENV })
  await runCommand('/bin/sh', ['-c', 'exit 4'], { env: NO_ENV })
  await assert.rejects(runCommand('/nonexistent/az', [], { env: NO_ENV }), /ENOENT/)
  const started = Date.now()
  await stopAllCommands(SHUTDOWN)
  assert.ok(Date.now() - started < 100)
})

test('a group member that outlives the wrapper is still killed after the grace period', async () => {
  const survivor = uniqueSleep()
  const sleep = uniqueSleep()
  await withWrapper([`(trap '' TERM; exec ${survivor}) </dev/null >/dev/null 2>&1 &`, sleep], [survivor, sleep], async az => {
    const controller = new AbortController()
    const pending = runCommand(az, [], { env: NO_ENV, signal: controller.signal })
    assert.ok(await until(() => running(sleep) && running(survivor)), 'the wrapper started both children')
    controller.abort()
    await assert.rejects(within(pending, 2_000), isAbort)
    assert.equal(running(sleep), false)
    assert.equal(running(survivor), true, 'it ignored SIGTERM and holds no output pipe')
    assert.ok(await until(() => !running(survivor), 5_000), 'SIGKILL reached it')
  })
})
