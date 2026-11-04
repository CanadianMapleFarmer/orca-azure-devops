import * as realFs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { RunCommand, RunResult } from '../sys/run'
import { ADO_RESOURCE, createAzCliProvider, createAzProfiles } from './azcli'

const HOME = '/home/ada'
const AZ = '/opt/homebrew/bin/az'
const JWT = 'eyJhbGciOiJub25lIn0.eyJvaWQiOiJvMSJ9.c2ln'
const TOKEN_JSON = '{"accessToken":"tok","expires_on":1793710000,"tokenType":"Bearer"}'

type RunOptions = Parameters<RunCommand>[2]
type FsPort = Parameters<typeof createAzCliProvider>[0]['fs']

function harness(reply: Partial<RunResult> | Error = {}, profile: 'directory' | 'file' | 'missing' = 'directory') {
  const events: string[] = []
  const runs: { file: string; args: string[]; opts: RunOptions }[] = []
  const run: RunCommand = async (file, args, opts) => {
    events.push('run')
    runs.push({ file, args, opts })
    if (reply instanceof Error) throw reply
    return { code: 0, stdout: '', stderr: '', ...reply }
  }
  const mkdirs: { dir: unknown; options: unknown }[] = []
  const chmods: { dir: unknown; mode: unknown }[] = []
  const fs: FsPort = {
    mkdir: async (dir: unknown, options: unknown) => {
      events.push('mkdir')
      mkdirs.push({ dir, options })
      return undefined
    },
    chmod: async (dir: unknown, mode: unknown) => {
      events.push('chmod')
      chmods.push({ dir, mode })
    },
    rm: async () => {
      events.push('rm')
    },
    stat: (async () => {
      events.push('stat')
      if (profile === 'missing') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      return { isDirectory: () => profile === 'directory' }
    }) as unknown as FsPort['stat']
  }
  const provider = createAzCliProvider({ azPath: AZ, run, home: HOME, fs })
  return { provider, runs, events, mkdirs, chmods }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof Error)
    return error
  }
  return assert.fail('expected the promise to reject')
}

test('profileDir lives under the home directory, one folder per org', () => {
  assert.equal(harness().provider.profileDir('contoso'), path.join(HOME, '.orca-azure-devops', 'az', 'contoso'))
})

test('profileDir refuses an org that could escape the profile root', () => {
  const { provider } = harness()
  const refused = (org: string) => {
    try {
      provider.profileDir(org)
      return false
    } catch {
      return true
    }
  }
  for (const org of ['', '../x', 'a/b', '.', '..', '-contoso', 'Contoso', 'con toso', 'a'.repeat(51)]) {
    assert.equal(refused(org), true, `org ${JSON.stringify(org)}`)
  }
  assert.equal(refused('a'.repeat(50)), false)
})

test('login runs az in the private profile', async () => {
  const { provider, runs, mkdirs } = harness()
  await provider.login('contoso', 't1')
  const dir = path.join(HOME, '.orca-azure-devops', 'az', 'contoso')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].file, AZ)
  assert.deepEqual(runs[0].args, ['login', '--tenant', 't1', '--allow-no-subscriptions', '--output', 'none'])
  assert.equal(runs[0].opts.env?.AZURE_CONFIG_DIR, dir)
  assert.equal(runs[0].opts.env?.AZURE_CORE_COLLECT_TELEMETRY, 'false')
  assert.equal(runs[0].opts.env?.AZURE_CORE_ONLY_SHOW_ERRORS, 'true')
  assert.deepEqual(mkdirs, [{ dir, options: { recursive: true, mode: 0o700 } }])
})

test('login without a tenant omits --tenant', async () => {
  const { provider, runs } = harness()
  await provider.login('contoso', null)
  assert.deepEqual(runs[0].args, ['login', '--allow-no-subscriptions', '--output', 'none'])
})

test('login creates the profile and locks its mode before az runs', async () => {
  const { provider, events, chmods } = harness()
  await provider.login('contoso', 't1')
  assert.deepEqual(events, ['mkdir', 'chmod', 'run'])
  assert.deepEqual(chmods, [{ dir: path.join(HOME, '.orca-azure-devops', 'az', 'contoso'), mode: 0o700 }])
})

test('login passes the abort signal to az', async () => {
  const { provider, runs } = harness()
  const controller = new AbortController()
  await provider.login('contoso', 't1', controller.signal)
  assert.equal(runs[0].opts.signal, controller.signal)
})

test('login does not start az for an invalid org', async () => {
  const { provider, events } = harness()
  await failure(provider.login('../escape', null))
  assert.deepEqual(events, [])
})

test('login failure reports the AADSTS or ERROR line with tokens redacted', async () => {
  const { provider } = harness({
    code: 1,
    stdout: 'SECRET-STDOUT',
    stderr: `WARNING: noise\nERROR: AADSTS50076 for ${JWT}\n`
  })
  const error = await failure(provider.login('contoso', 't1'))
  assert.equal(error.message, 'Azure CLI sign-in failed: ERROR: AADSTS50076 for [redacted]')
})

test('a failure reports the first AADSTS or ERROR line, never the az command az suggests', async () => {
  const { provider } = harness({
    code: 1,
    stderr: [
      'WARNING: noise',
      'AADSTS70043: The refresh token has expired due to sign-in frequency checks by conditional access.',
      'ERROR: second error line',
      'Interactive authentication is needed. Please run:',
      'az login --tenant t1 --scope 499b84ac-1321-427f-aa17-267ca6975798/.default',
      ''
    ].join('\n')
  })
  const error = await failure(provider.getToken('contoso', 't1'))
  assert.equal(
    error.message,
    'Azure CLI could not get an access token: AADSTS70043: The refresh token has expired due to sign-in frequency checks by conditional access.'
  )
})

test('a failure skips ERROR lines that tell the user to run az login', async () => {
  const stderrs = [
    "ERROR: Please run 'az login' to setup account.",
    'ERROR: az login --use-device-code',
    'az account get-access-token ERROR: refused'
  ]
  for (const stderr of stderrs) {
    const { provider } = harness({ code: 1, stderr })
    const error = await failure(provider.getToken('contoso', 't1'))
    assert.equal(error.message, 'Azure CLI could not get an access token', stderr)
  }
})

test('a failure with no AADSTS or ERROR line is only the fixed sentence', async () => {
  const { provider } = harness({ code: 1, stderr: 'Traceback (most recent call last):\n  File "x.py", line 1\nKeyError: home\n' })
  const error = await failure(provider.login('contoso', 't1'))
  assert.equal(error.message, 'Azure CLI sign-in failed')
})

test('getToken parses expires_on', async () => {
  const { provider, runs } = harness({ stdout: TOKEN_JSON })
  const result = await provider.getToken('contoso', 't1')
  assert.deepEqual(result, { token: 'tok', expiresAt: 1793710000000 })
  assert.equal(runs[0].file, AZ)
  assert.deepEqual(runs[0].args, ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--tenant', 't1', '--output', 'json'])
  assert.equal(runs[0].opts.env?.AZURE_CONFIG_DIR, path.join(HOME, '.orca-azure-devops', 'az', 'contoso'))
  assert.equal(runs[0].opts.env?.AZURE_CORE_ONLY_SHOW_ERRORS, 'true')
})

test('getToken without a tenant omits --tenant', async () => {
  const { provider, runs } = harness({ stdout: TOKEN_JSON })
  await provider.getToken('contoso', null)
  assert.deepEqual(runs[0].args, ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--output', 'json'])
})

test('getToken ignores the local-time expiresOn field', async () => {
  const { provider } = harness({ stdout: '{"accessToken":"tok","expiresOn":"2026-11-04 14:00:00.000000","expires_on":1793710000}' })
  assert.equal((await provider.getToken('contoso', 't1')).expiresAt, 1793710000000)
})

test('getToken failure never leaks stdout', async () => {
  const { provider } = harness({
    code: 1,
    stdout: `{"accessToken":"${JWT}"}`,
    stderr: `WARNING: noise\nERROR: AADSTS50173 grant revoked (was ${JWT} expired)\n\n`
  })
  const error = await failure(provider.getToken('contoso', 't1'))
  assert.equal(error.message, 'Azure CLI could not get an access token: ERROR: AADSTS50173 grant revoked (was [redacted] expired)')
  assert.ok(!error.message.includes('eyJ'))
  assert.ok(!error.message.includes('WARNING'))
})

test('getToken reports az failing to run or timing out as only the fixed sentence', async () => {
  for (const reply of [new Error('az timed out after 60000ms'), Object.assign(new Error('spawn /opt/homebrew/bin/az EACCES'), { code: 'EACCES' })]) {
    const { provider } = harness(reply)
    const error = await failure(provider.getToken('contoso', 't1'))
    assert.equal(error.message, 'Azure CLI could not get an access token', reply.message)
  }
})

test('getToken failure without stderr is only the fixed sentence', async () => {
  const { provider } = harness({ code: 2, stdout: JWT })
  const error = await failure(provider.getToken('contoso', 't1'))
  assert.equal(error.message, 'Azure CLI could not get an access token')
})

test('getToken rejects unparsable output without echoing it', async () => {
  const bodies = [`not json ${JWT}`, '{"accessToken":"tok"}', '{"expires_on":1793710000}', `{"accessToken":"${JWT}","expires_on":"soon"}`, 'null']
  for (const stdout of bodies) {
    const { provider } = harness({ stdout })
    const error = await failure(provider.getToken('contoso', 't1'))
    assert.equal(error.message, 'Azure CLI returned an unreadable token response', stdout)
  }
})

test('getToken does not start az for an invalid org', async () => {
  const { provider, events } = harness({ stdout: TOKEN_JSON })
  await failure(provider.getToken('a/b', null))
  assert.deepEqual(events, [])
})

test('getToken refuses without running az when the profile dir is missing', async () => {
  for (const profile of ['missing', 'file'] as const) {
    const { provider, events } = harness({ stdout: TOKEN_JSON }, profile)
    const error = await failure(provider.getToken('contoso', 't1'))
    assert.equal(error.message, 'Not signed in.', profile)
    assert.deepEqual(events, ['stat'], profile)
  }
})

test('getToken checks the profile dir before running az', async () => {
  const { provider, events } = harness({ stdout: TOKEN_JSON })
  await provider.getToken('contoso', 't1')
  assert.deepEqual(events, ['stat', 'run'])
})

test('createAzProfiles finds, checks and deletes a profile without an az binary', async () => {
  const removed: unknown[][] = []
  let kind: 'directory' | 'file' | 'missing' = 'directory'
  const fs = {
    rm: async (...args: unknown[]) => {
      removed.push(args)
    },
    stat: async () => {
      if (kind === 'missing') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      return { isDirectory: () => kind === 'directory' }
    }
  } as unknown as Pick<FsPort, 'rm' | 'stat'>
  const profiles = createAzProfiles({ home: HOME, fs })
  const dir = path.join(HOME, '.orca-azure-devops', 'az', 'contoso')
  assert.equal(profiles.profileDir('contoso'), dir)
  assert.equal(profiles.profileDir('contoso'), harness().provider.profileDir('contoso'))
  assert.equal(await profiles.hasProfile('contoso'), true)
  for (const absent of ['file', 'missing'] as const) {
    kind = absent
    assert.equal(await profiles.hasProfile('contoso'), false, absent)
  }
  assert.equal(await profiles.hasProfile('../x'), false)
  await profiles.signOut('contoso')
  assert.deepEqual(removed, [[dir, { recursive: true, force: true }]])
  await failure(profiles.signOut('../x'))
  assert.equal(removed.length, 1)
})

test('signOut deletes the profile dir and leaves the rest of home alone', async () => {
  const home = await realFs.mkdtemp(path.join(os.tmpdir(), 'azcli-home-'))
  try {
    const rmCalls: unknown[][] = []
    const fs: FsPort = {
      mkdir: realFs.mkdir,
      chmod: realFs.chmod,
      stat: realFs.stat,
      rm: async (...args: Parameters<typeof realFs.rm>) => {
        rmCalls.push(args)
        return realFs.rm(...args)
      }
    }
    const provider = createAzCliProvider({ azPath: AZ, run: async () => ({ code: 0, stdout: '', stderr: '' }), home, fs })
    const dir = provider.profileDir('contoso')
    await realFs.mkdir(path.join(dir, 'nested'), { recursive: true })
    await realFs.writeFile(path.join(dir, 'nested', 'msal_token_cache.json'), '{}')
    await realFs.mkdir(path.join(home, '.azure'))
    await realFs.writeFile(path.join(home, '.azure', 'keep.json'), '{}')

    await provider.signOut('contoso')

    assert.deepEqual(rmCalls, [[dir, { recursive: true, force: true }]])
    await assert.rejects(realFs.stat(dir), /ENOENT/)
    assert.equal(await realFs.readFile(path.join(home, '.azure', 'keep.json'), 'utf8'), '{}')
    await provider.signOut('contoso')
  } finally {
    await realFs.rm(home, { recursive: true, force: true })
  }
})

test('signOut refuses an invalid org before touching the disk', async () => {
  const { provider, events } = harness()
  await failure(provider.signOut('..'))
  assert.deepEqual(events, [])
})
