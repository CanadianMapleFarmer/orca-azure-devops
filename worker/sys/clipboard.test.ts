import { spawnSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { COPY_FAILED, COPY_NEEDS_TOOL } from '../messages'
import {
  cfHtml,
  type ClipboardDeps,
  createClipboard,
  linuxDisplayEnv,
  SpawnTimeoutError,
  spawnWithInput,
  type SpawnWithInput
} from './clipboard'

const CONTENT = {
  html: '<p><a href="https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/41">Pull Request 41</a>: Fix é login — 🚀</p>',
  plain: 'Pull Request 41: Fix é login — 🚀'
}

interface Call {
  file: string
  args: string[]
  input: string
  env: Record<string, string>
  timeoutMs: number
}

function recorder(outcome: { code: number } | Error = { code: 0 }): { calls: Call[]; spawn: SpawnWithInput } {
  const calls: Call[] = []
  const spawn: SpawnWithInput = async (file, args, opts) => {
    calls.push({ file, args, ...opts })
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { calls, spawn }
}

function depsFor(spawn: SpawnWithInput, overrides: Partial<ClipboardDeps> = {}): ClipboardDeps {
  return {
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/me', TMPDIR: '/tmp', ELECTRON_RUN_AS_NODE: '1' },
    find: () => null,
    spawn,
    uid: 1000,
    home: '/home/me',
    exists: () => false,
    list: () => [],
    log: () => {},
    ...overrides
  }
}

const findOnly =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name) ? `/usr/bin/${name}` : null

const failsWith = (message: string) => (error: unknown) => error instanceof Error && error.message === message

function running(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern]).status === 0
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

test('macOS writes html and plain through osascript stdin', async () => {
  const { calls, spawn } = recorder()
  const result = await createClipboard(depsFor(spawn)).write(CONTENT)
  assert.equal(result, 'rich')
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.file, '/usr/bin/osascript')
  assert.deepEqual(call.args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.equal(call.args.length, 4)
  assert.ok(call.args[3].includes('public.html') && call.args[3].includes('public.utf8-plain-text'))
  assert.deepEqual(JSON.parse(call.input), CONTENT)
  assert.deepEqual(call.env, { PATH: '/usr/bin:/bin', HOME: '/home/me', TMPDIR: '/tmp' })
  assert.equal(call.timeoutMs, 10_000)
})

test('the content never appears in argv', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const { calls, spawn } = recorder()
    await createClipboard(depsFor(spawn, { platform })).write(CONTENT)
    assert.ok(!calls[0].args.join(' ').includes('Pull Request 41'))
  }
})

test('the stdin JSON is ASCII on macOS and Windows, so no console code page can garble it', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const { calls, spawn } = recorder()
    await createClipboard(depsFor(spawn, { platform })).write(CONTENT)
    const codePoints = Array.from(calls[0].input, char => char.codePointAt(0) ?? 0)
    assert.ok(codePoints.length > 0 && codePoints.every(codePoint => codePoint < 0x80), `${platform} stdin is pure ASCII`)
  }
})

test('the macOS script fails the run when a pasteboard write is refused', async () => {
  const { calls, spawn } = recorder()
  await createClipboard(depsFor(spawn)).write(CONTENT)
  assert.ok(calls[0].args[3].includes('if (!wroteHtml || !wrotePlain) throw'))
})

test('cfHtml offsets are UTF-8 byte offsets', () => {
  const fragment = '<p>é — <a href="https://example.com/é">link</a></p>'
  const document = cfHtml(fragment)
  const offset = (name: string): number => {
    const match = new RegExp(`${name}:(\\d{10})`).exec(document)
    assert.ok(match, `${name} is a 10-digit field`)
    return Number(match[1])
  }
  const bytes = Buffer.from(document, 'utf8')
  assert.ok(document.startsWith('Version:0.9'))
  assert.equal(bytes.subarray(offset('StartFragment'), offset('EndFragment')).toString('utf8'), fragment)
  const whole = bytes.subarray(offset('StartHTML'), offset('EndHTML')).toString('utf8')
  assert.equal(whole, `<html><body><!--StartFragment-->${fragment}<!--EndFragment--></body></html>`)
  assert.equal(offset('EndHTML'), bytes.length)
})

test('Windows runs powershell -STA with an encoded command', async () => {
  const env = { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }
  const { calls, spawn } = recorder()
  const result = await createClipboard(depsFor(spawn, { platform: 'win32', env })).write(CONTENT)
  assert.equal(result, 'rich')
  const [call] = calls
  assert.equal(call.file, 'powershell.exe')
  assert.deepEqual(call.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand'])
  assert.equal(call.args.length, 5)
  const script = Buffer.from(call.args[4], 'base64').toString('utf16le')
  assert.ok(script.includes('SetDataObject'))
  assert.ok(script.includes('HTML Format'))
  assert.ok(script.includes('UnicodeText'))
  assert.deepEqual(JSON.parse(call.input), { html: cfHtml(CONTENT.html), plain: CONTENT.plain })
  assert.deepEqual(call.env, env)
  assert.equal(call.timeoutMs, 10_000)
})

test('Linux finds a Wayland socket and uses wl-copy', async () => {
  const listed: string[] = []
  const { calls, spawn } = recorder()
  const clipboard = createClipboard(
    depsFor(spawn, {
      platform: 'linux',
      find: findOnly('wl-copy', 'xclip'),
      list: dir => {
        listed.push(dir)
        return ['bus', 'wayland-1', 'wayland-0.lock', 'wayland-0']
      }
    })
  )
  const result = await clipboard.write(CONTENT)
  assert.equal(result, 'html')
  assert.deepEqual(listed, ['/run/user/1000'])
  const [call] = calls
  assert.equal(call.file, '/usr/bin/wl-copy')
  assert.deepEqual(call.args, ['--type', 'text/html'])
  assert.equal(call.input, CONTENT.html)
  assert.deepEqual(call.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/me',
    TMPDIR: '/tmp',
    ELECTRON_RUN_AS_NODE: '1',
    XDG_RUNTIME_DIR: '/run/user/1000',
    WAYLAND_DISPLAY: 'wayland-0'
  })
  assert.equal(call.timeoutMs, 10_000)
})

test('Linux falls back to xclip on :0 with XAUTHORITY', async () => {
  const present = new Set(['/tmp/.X11-unix/X0', '/home/me/.Xauthority'])
  const { calls, spawn } = recorder()
  const clipboard = createClipboard(
    depsFor(spawn, { platform: 'linux', find: findOnly('xclip'), exists: path => present.has(path) })
  )
  assert.equal(await clipboard.write(CONTENT), 'html')
  const [call] = calls
  assert.equal(call.file, '/usr/bin/xclip')
  assert.deepEqual(call.args, ['-selection', 'clipboard', '-t', 'text/html'])
  assert.equal(call.input, CONTENT.html)
  assert.equal(call.env.DISPLAY, ':0')
  assert.equal(call.env.XAUTHORITY, '/home/me/.Xauthority')
  assert.ok(!('WAYLAND_DISPLAY' in call.env))
})

test('Linux without either tool gives the install message', async () => {
  const { calls, spawn } = recorder()
  const clipboard = createClipboard(depsFor(spawn, { platform: 'linux', list: () => ['wayland-0'] }))
  await assert.rejects(clipboard.write(CONTENT), failsWith(COPY_NEEDS_TOOL))
  assert.equal(calls.length, 0)
  assert.equal(COPY_NEEDS_TOOL, 'Copying needs wl-clipboard or xclip.')
})

test('Linux on Wayland with only xclip gives the install message', async () => {
  const { calls, spawn } = recorder()
  const clipboard = createClipboard(depsFor(spawn, { platform: 'linux', find: findOnly('xclip'), list: () => ['wayland-0'] }))
  await assert.rejects(clipboard.write(CONTENT), failsWith(COPY_NEEDS_TOOL))
  assert.equal(calls.length, 0)
})

test('Linux with no display fails with the fixed failure message', async () => {
  const { calls, spawn } = recorder()
  const clipboard = createClipboard(depsFor(spawn, { platform: 'linux', find: findOnly('wl-copy', 'xclip') }))
  await assert.rejects(clipboard.write(CONTENT), failsWith(COPY_FAILED))
  assert.equal(calls.length, 0)
})

test('linuxDisplayEnv prefers Wayland, then X11, else nothing', () => {
  const base = { uid: 1000, home: '/home/me' }
  const wayland = linuxDisplayEnv({ ...base, exists: () => true, list: () => ['wayland-0'] })
  assert.deepEqual(wayland, { kind: 'wayland', env: { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0' } })

  const x11 = linuxDisplayEnv({ ...base, exists: path => path === '/tmp/.X11-unix/X0', list: () => [] })
  assert.deepEqual(x11, { kind: 'x11', env: { DISPLAY: ':0' } })

  const noSocket = linuxDisplayEnv({
    ...base,
    exists: path => path === '/home/me/.Xauthority',
    list: () => {
      throw new Error('ENOENT')
    }
  })
  assert.equal(noSocket, null)
})

test('linuxDisplayEnv orders Wayland sockets numerically and skips lock files', () => {
  const found = linuxDisplayEnv({
    uid: 1000,
    home: '/home/me',
    exists: () => false,
    list: () => ['wayland-10', 'wayland-2', 'wayland-2.lock', 'wayland']
  })
  assert.equal(found?.env.WAYLAND_DISPLAY, 'wayland-2')
})

test('ambient display variables win over derived ones', async () => {
  const { calls, spawn } = recorder()
  const listed: string[] = []
  const env = { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-9', XDG_RUNTIME_DIR: '/run/custom' }
  const clipboard = createClipboard(
    depsFor(spawn, {
      platform: 'linux',
      env,
      find: findOnly('wl-copy'),
      list: dir => {
        listed.push(dir)
        return ['wayland-0']
      }
    })
  )
  await clipboard.write(CONTENT)
  assert.equal(calls[0].env.WAYLAND_DISPLAY, 'wayland-9')
  assert.equal(calls[0].env.XDG_RUNTIME_DIR, '/run/custom')
  assert.deepEqual(listed, [])
})

test('linuxDisplayEnv only fills in what the environment is missing', () => {
  const base = { uid: 1000, home: '/home/me', exists: () => false }
  const runtimeOnly = linuxDisplayEnv({ ...base, env: { XDG_RUNTIME_DIR: '/run/custom' }, list: dir => (dir === '/run/custom' ? ['wayland-3'] : []) })
  assert.deepEqual(runtimeOnly, { kind: 'wayland', env: { XDG_RUNTIME_DIR: '/run/custom', WAYLAND_DISPLAY: 'wayland-3' } })

  const displayOnly = linuxDisplayEnv({ ...base, env: { WAYLAND_DISPLAY: 'wayland-5' }, list: () => [] })
  assert.deepEqual(displayOnly, { kind: 'wayland', env: { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-5' } })

  const x11 = linuxDisplayEnv({
    ...base,
    env: { DISPLAY: ':1' },
    exists: path => path === '/home/me/.Xauthority',
    list: () => []
  })
  assert.deepEqual(x11, { kind: 'x11', env: { DISPLAY: ':1', XAUTHORITY: '/home/me/.Xauthority' } })

  const ownAuthority = linuxDisplayEnv({ ...base, env: { DISPLAY: ':2', XAUTHORITY: '/custom/auth' }, list: () => [] })
  assert.deepEqual(ownAuthority, { kind: 'x11', env: { DISPLAY: ':2', XAUTHORITY: '/custom/auth' } })

  const emptyValues = linuxDisplayEnv({ ...base, env: { DISPLAY: '', WAYLAND_DISPLAY: '' }, list: () => [] })
  assert.equal(emptyValues, null)
})

test('a failure is logged as the tool and a cause, never the content', async () => {
  const cases: { outcome: { code: number } | Error; logged: string }[] = [
    { outcome: { code: 1 }, logged: 'clipboard: osascript exited 1' },
    { outcome: new SpawnTimeoutError(`timed out: ${CONTENT.plain}`), logged: 'clipboard: osascript timeout' },
    { outcome: Object.assign(new Error(`spawn failed: ${CONTENT.html}`), { code: 'ENOENT' }), logged: 'clipboard: osascript ENOENT' },
    { outcome: new Error(CONTENT.plain), logged: 'clipboard: osascript failed' },
    { outcome: Object.assign(new Error('x'), { code: CONTENT.plain }), logged: 'clipboard: osascript failed' }
  ]
  for (const { outcome, logged } of cases) {
    const lines: string[] = []
    const { spawn } = recorder(outcome)
    await assert.rejects(createClipboard(depsFor(spawn, { log: line => lines.push(line) })).write(CONTENT), failsWith(COPY_FAILED))
    assert.deepEqual(lines, [logged])
    assert.ok(!lines.join('\n').includes('Pull Request'))
  }
})

test('failures before a spawn are logged without content too', async () => {
  const lines: string[] = []
  const { spawn } = recorder()
  const log = (line: string) => lines.push(line)
  await assert.rejects(createClipboard(depsFor(spawn, { platform: 'freebsd', log })).write(CONTENT), failsWith(COPY_FAILED))
  await assert.rejects(createClipboard(depsFor(spawn, { platform: 'linux', find: findOnly('xclip'), log })).write(CONTENT), failsWith(COPY_FAILED))
  assert.deepEqual(lines, ['clipboard: unsupported platform freebsd', 'clipboard: no display found'])
})

test('a successful write and a missing tool log nothing', async () => {
  const lines: string[] = []
  const { spawn } = recorder()
  const log = (line: string) => lines.push(line)
  await createClipboard(depsFor(spawn, { log })).write(CONTENT)
  await assert.rejects(createClipboard(depsFor(spawn, { platform: 'linux', log })).write(CONTENT), failsWith(COPY_NEEDS_TOOL))
  assert.deepEqual(lines, [])
})

test('a non-zero exit or a timeout gives the fixed failure message', async () => {
  assert.equal(COPY_FAILED, "Couldn't copy to the clipboard.")
  const failed = recorder({ code: 1 })
  await assert.rejects(createClipboard(depsFor(failed.spawn)).write(CONTENT), failsWith(COPY_FAILED))
  const timedOut = recorder(new SpawnTimeoutError(`osascript timed out after 10000ms: ${CONTENT.plain}`))
  await assert.rejects(createClipboard(depsFor(timedOut.spawn)).write(CONTENT), failsWith(COPY_FAILED))
})

test('an unsupported platform gives the fixed failure message', async () => {
  const { calls, spawn } = recorder()
  await assert.rejects(createClipboard(depsFor(spawn, { platform: 'freebsd' })).write(CONTENT), failsWith(COPY_FAILED))
  assert.equal(calls.length, 0)
})

test('spawnWithInput hands the child its stdin and env, and returns the exit code', async () => {
  const opts = { input: 'héllo', env: { PATH: '/usr/bin:/bin', ONLY: 'yes' }, timeoutMs: 5_000 }
  const ok = await spawnWithInput('/bin/sh', ['-c', '[ "$(cat)" = "héllo" ] && [ "$ONLY" = yes ]'], opts)
  assert.deepEqual(ok, { code: 0 })
  const failed = await spawnWithInput('/bin/sh', ['-c', 'cat >/dev/null; exit 3'], opts)
  assert.deepEqual(failed, { code: 3 })
})

test('spawnWithInput survives a child that exits without reading its input', async () => {
  const input = 'x'.repeat(4 * 1024 * 1024)
  const result = await within(spawnWithInput('/bin/sh', ['-c', 'exit 0'], { input, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 }), 4_000)
  assert.deepEqual(result, { code: 0 })
})

test('spawnWithInput rejects when the executable cannot be spawned', async () => {
  await assert.rejects(spawnWithInput('/nonexistent/clip', [], { input: '', env: {}, timeoutMs: 5_000 }), /ENOENT/)
})

test('spawnWithInput settles when the child exits even if a forked process keeps running', async () => {
  try {
    const result = await within(
      spawnWithInput('/bin/sh', ['-c', 'cat >/dev/null; (sleep 30.731 &); exit 0'], { input: 'x', env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 }),
      2_000
    )
    assert.deepEqual(result, { code: 0 })
  } finally {
    spawnSync('pkill', ['-f', 'sleep 30.731'])
  }
})

test('spawnWithInput kills a child that outlives the timeout', async () => {
  try {
    await assert.rejects(
      spawnWithInput('/bin/sh', ['-c', 'sleep 30.732'], { input: '', env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200 }),
      /timed out after 200ms/
    )
    assert.equal(running('sleep 30.732'), false)
  } finally {
    spawnSync('pkill', ['-f', 'sleep 30.732'])
  }
})
