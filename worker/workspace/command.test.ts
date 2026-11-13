import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { branchFor, DEFAULT_BRANCH_TEMPLATE } from './arm'
import { cloneCommand, createCommand, launchCommand, MAX_COMMAND_BYTES, MAX_PROMPT_BYTES, START_FILES_FOLDER, validAgent, type StartCommand } from './command'

const FAKE_ORCA = '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\0\' "$arg"; done > "$ORCA_ARGV_OUT"\n'
const ID = '0123456789abcdef01234567'
const FOLDER = `~/${START_FILES_FOLDER}`

const POSIX_SHELLS: { name: string; argv: string[]; typed?: boolean }[] = [
  { name: 'bash -c', argv: ['/bin/bash', '-c'] },
  { name: 'bash -i', argv: ['/bin/bash', '--noprofile', '--norc', '-i'], typed: true },
  { name: 'zsh -c', argv: ['/bin/zsh', '-f', '-c'] },
  { name: 'zsh -i', argv: ['/bin/zsh', '-f', '-i'], typed: true },
  { name: 'zsh rc_quotes -i', argv: ['/bin/zsh', '-f', '-o', 'rc_quotes', '-i'], typed: true },
  { name: 'sh -c', argv: ['/bin/sh', '-c'] },
  { name: 'dash -c', argv: ['/bin/dash', '-c'] },
  { name: 'ksh -c', argv: ['/bin/ksh', '-c'] }
]

const HOSTILE = [
  `[ADO Bug #12: it's "quoted"](https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/12)`,
  'Steps:\ntouch PWNED\nx\'; touch PWNED; echo \'\n',
  'run `touch PWNED` and $(touch PWNED) and ${PWNED:=x} and $HOME $0',
  "\\' '\\'' '' ' \\\\ ends with a backslash \\",
  "$'\\x27; touch PWNED; \\x27' $\"x\"",
  '!! !$ !-1 !# !?foo? \n^a^b',
  'one; touch PWNED && echo twice | cat > PWNED2 &',
  'unicode: 👍🏽 漢字 עברית é ‮evil next ＼ ＇ ​',
  '* ? [a] ~ # % { } < > = +x /x --help',
  '\u001b[201~touch PWNED\u001b[200~ \u009b2J'
]

const PROMPTS = { full: 'Full prompt', short: 'Short prompt' }

const sent = (text: string) => text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ').replace(/\n+$/, '')

function orcaTypes(command: string, bracketedPasteSafe: boolean): string {
  const body = command.replace(/\r\n$|\r$|\n$/, '')
  if (bracketedPasteSafe && (body.includes('\n') || body.includes('\r'))) return `\u001b[200~${body}\u001b[201~\r`
  return `${body.replace(/\r?\n/g, '\r')}\r`
}

function inShell(argv: string[], built: StartCommand, options: { typed?: boolean; withoutFiles?: boolean } = {}): { argv: string[] | null; pwned: boolean } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-test-'))
  try {
    const bin = path.join(root, 'bin')
    const home = path.join(root, 'home')
    const folder = path.join(home, ...START_FILES_FOLDER.split('/'))
    fs.mkdirSync(bin)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(bin, 'orca'), FAKE_ORCA, { mode: 0o755 })
    if (!options.withoutFiles) for (const [name, text] of Object.entries(built.files)) fs.writeFileSync(path.join(folder, name), text, { mode: 0o600 })
    const out = path.join(root, 'argv')
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCA_ARGV_OUT: out, TERM: 'dumb' }
    const [shell, ...flags] = argv
    const line = orcaTypes(built.command, true).replace(/\r$/, '\n')
    spawnSync(shell, options.typed ? flags : [...flags, line], { cwd: home, env, input: options.typed ? line : '', encoding: 'utf8' })
    const pwned = fs.readdirSync(home).some(name => name.startsWith('PWNED'))
    return { argv: fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\0').slice(0, -1) : null, pwned }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const create = (full: string) => createCommand({ fileId: ID, branch: 'feature/12-x', agent: 'claude', prompts: { full, short: 'short prompt' } })
const launch = (full: string) => launchCommand({ fileId: ID, workspaceId: "repo::/repos/it's here", agent: 'claude', prompts: { full, short: 'short prompt' } })

test('the command is one short line that holds no item text', () => {
  for (const full of [...HOSTILE, 'x '.repeat(40_000)]) {
    for (const built of [create(full), launch(full)]) {
      assert.ok(built)
      assert.match(built.command, /^[A-Za-z0-9 ._/=$()~&"-]+$/, JSON.stringify(full).slice(0, 80))
      assert.ok(Buffer.byteLength(built.command) <= 400, `${Buffer.byteLength(built.command)} bytes`)
    }
  }
})

test('Orca types the command as one raw line, never as a bracketed paste', () => {
  const built = create(HOSTILE[1])
  assert.ok(built)
  assert.equal(orcaTypes(built.command, true), `${built.command}\r`)
  assert.equal(orcaTypes(built.command, false), `${built.command}\r`)
})

test('createCommand reads the prompt from its start file, then creates the worktree and starts the agent', () => {
  assert.deepEqual(createCommand({ fileId: ID, branch: 'feature/1204-add-filters', agent: 'claude', prompts: PROMPTS }), {
    command:
      `ado_prompt=$(command cat ${FOLDER}/${ID}.prompt) && ` +
      'orca worktree create --name feature/1204-add-filters --branch feature/1204-add-filters --agent claude --prompt "$ado_prompt" --no-parent --activate && exit',
    files: { [`${ID}.prompt`]: 'Full prompt' },
    shortened: false
  })
})

test('launchCommand reads the worktree and the prompt from start files, by id or by identity as Orca lists it', () => {
  assert.deepEqual(launchCommand({ fileId: ID, workspaceId: 'repo-web::/repos/web-1204', agent: 'codex', prompts: PROMPTS }), {
    command:
      `ado_worktree=$(command cat ${FOLDER}/${ID}.worktree) && ado_prompt=$(command cat ${FOLDER}/${ID}.prompt) && ` +
      'orca agent launch --agent codex --worktree "$ado_worktree" --prompt "$ado_prompt" --focus && exit',
    files: { [`${ID}.worktree`]: 'id:repo-web::/repos/web-1204', [`${ID}.prompt`]: 'Full prompt' },
    shortened: false
  })
  assert.equal(launchCommand({ fileId: ID, workspaceId: 'identity:abc-123', agent: 'codex', prompts: PROMPTS })?.files[`${ID}.worktree`], 'identity:abc-123')
})

test('every POSIX shell, typed or run, hands the CLI the exact values, and no item text runs', () => {
  for (const shell of POSIX_SHELLS) {
    for (const full of HOSTILE) {
      const label = `${shell.name}: ${JSON.stringify(full)}`
      const created = create(full)
      const launched = launch(full)
      assert.ok(created && launched)
      assert.deepEqual(inShell(shell.argv, created, { typed: shell.typed }), {
        argv: ['worktree', 'create', '--name', 'feature/12-x', '--branch', 'feature/12-x', '--agent', 'claude', '--prompt', sent(full), '--no-parent', '--activate'],
        pwned: false
      }, label)
      assert.deepEqual(inShell(shell.argv, launched, { typed: shell.typed }), {
        argv: ['agent', 'launch', '--agent', 'claude', '--worktree', "id:repo::/repos/it's here", '--prompt', sent(full), '--focus'],
        pwned: false
      }, label)
    }
  }
})

test('a start file that is gone stops the command before the CLI runs', () => {
  for (const shell of POSIX_SHELLS) {
    for (const built of [create(HOSTILE[0]), launch(HOSTILE[0])]) {
      assert.ok(built)
      assert.deepEqual(inShell(shell.argv, built, { typed: shell.typed, withoutFiles: true }), { argv: null, pwned: false }, shell.name)
    }
  }
})

test('a shell without $(…), such as tcsh or csh, refuses the command before anything runs', () => {
  for (const shell of [['/bin/tcsh', '-f', '-c'], ['/bin/csh', '-f', '-c']]) {
    for (const full of HOSTILE) {
      for (const built of [create(full), launch(full)]) {
        assert.ok(built)
        assert.deepEqual(inShell(shell, built), { argv: null, pwned: false }, `${shell[0]}: ${JSON.stringify(full)}`)
      }
    }
  }
})

test('control characters, CSI included, become spaces in the file, and trailing newlines go', () => {
  const created = create('a\u0003b\u0015c\u001b[2Jd\te\rf\u007fg\u0085h\u009B2Ji\u0000j\nk\n\n')
  assert.deepEqual(created?.files, { [`${ID}.prompt`]: 'a b c [2Jd e f g h 2Ji j\nk' })
})

test('a branch or agent that is not a plain word goes through a file too, so no value is ever shell syntax', () => {
  const branch = "it's; touch PWNED"
  const created = createCommand({ fileId: ID, branch, agent: 'claude', prompts: PROMPTS })
  assert.ok(created)
  assert.ok(!created.command.includes("'") && !created.command.includes(';'))
  assert.deepEqual(inShell(['/bin/bash', '-c'], created).argv?.slice(2, 6), ['--name', branch, '--branch', branch])
})

test('every branch the template gives is a plain word, written into the command as it is', () => {
  for (const title of HOSTILE) {
    for (const template of ['feature/{id}-{slug}', '{slug}', "users/o'neil/{id} $(x)", '-x/{id}', '_{id}.lock']) {
      const branch = branchFor(template, { id: 12, title })
      const created = createCommand({ fileId: ID, branch, agent: 'claude', prompts: PROMPTS })
      assert.ok(created?.command.includes(` --branch ${branch} `), `${template} ${JSON.stringify(title)}`)
      assert.match(branch, /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
    }
  }
})

test('validAgent takes agent names only, never one that looks like a flag', () => {
  for (const agent of ['claude', 'codex', 'gemini-cli', 'open.code_2', 'a'.repeat(64), '9lives']) assert.equal(validAgent(agent), true, agent)
  for (const agent of ['', 'a'.repeat(65), '--json', '-x', '.hidden', '_x', 'claude code', 'claude;rm', '$(id)', '`id`', 'claude\n', '../bin', 'clåude', "o'neil"]) {
    assert.equal(validAgent(agent), false, JSON.stringify(agent))
  }
})

test('the prompt file holds up to 100,000 bytes, and a longer prompt is replaced by the short one', () => {
  const fits = 'é'.repeat(MAX_PROMPT_BYTES / 2)
  assert.deepEqual(create(fits)?.files, { [`${ID}.prompt`]: fits })
  assert.equal(create(fits)?.shortened, false)
  assert.deepEqual(create(`${fits}x`)?.files, { [`${ID}.prompt`]: 'short prompt' })
  assert.equal(create(`${fits}x`)?.shortened, true)
  assert.equal(create(`${fits}x`)?.command, create('a b')?.command, 'the prompt never changes the command')
})

test('a command of up to 1,000 bytes is built, and a longer one is not', () => {
  const base = createCommand({ fileId: ID, branch: 'b', agent: 'claude', prompts: PROMPTS })
  assert.ok(base)
  const room = MAX_COMMAND_BYTES - Buffer.byteLength(base.command)
  const branch = (extra: number) => `b${'x'.repeat(extra)}`
  const fits = createCommand({ fileId: ID, branch: branch(Math.floor(room / 2)), agent: 'claude', prompts: PROMPTS })
  assert.ok(fits && Buffer.byteLength(fits.command) <= MAX_COMMAND_BYTES && Buffer.byteLength(fits.command) >= MAX_COMMAND_BYTES - 1)
  assert.equal(createCommand({ fileId: ID, branch: branch(Math.floor(room / 2) + 1), agent: 'claude', prompts: PROMPTS }), null)
  assert.equal(launchCommand({ fileId: ID, workspaceId: 'w', agent: 'a'.repeat(64), prompts: PROMPTS }) !== null, true)
})

test('only a hex id names the start files', () => {
  for (const fileId of ['', 'ABC', '../x', 'a b', '0123456789abcdef0123456', '0123456789abcdef012345678', '0123456789ABCDEF01234567']) {
    assert.throws(() => createCommand({ fileId, branch: 'b', agent: 'claude', prompts: PROMPTS }), /start file id/)
  }
})

const F = 'f00000000000000000000001'
const READ = (field: string) => `ado_${field}=$(command cat ~/.orca-azure-devops/starts/${F}.${field}) && `
const CLONE_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'
const CREATE_IN_FOLDER = 'orca worktree create --repo "$ado_repo" --name feature/1204-x --branch feature/1204-x --agent claude --prompt "$ado_prompt" --setup skip --no-parent --activate && exit'
const CLONE_LINE = `${READ('url')}${READ('folder')}${READ('repo')}${READ('prompt')}GIT_ALLOW_PROTOCOL=https:ssh command git clone -- "$ado_url" "$ado_folder" && orca repo add --path "$ado_folder" && ${CREATE_IN_FOLDER}`

const clone = (values: Partial<{ url: string | null; folder: string; branch: string; agent: string }> = {}) =>
  cloneCommand({ fileId: F, url: CLONE_URL, folder: '/repos/web-app', branch: 'feature/1204-x', agent: 'claude', prompts: PROMPTS, ...values })

test('cloneCommand reads every value from start files, then clones with only https and ssh allowed, adds and creates without setup', () => {
  assert.deepEqual(clone(), {
    command: CLONE_LINE,
    files: { [`${F}.url`]: CLONE_URL, [`${F}.folder`]: '/repos/web-app', [`${F}.repo`]: 'path:/repos/web-app', [`${F}.prompt`]: 'Full prompt' },
    shortened: false
  })
})

test('with no url the folder is added without cloning', () => {
  assert.deepEqual(clone({ url: null }), {
    command: `${READ('folder')}${READ('repo')}${READ('prompt')}orca repo add --path "$ado_folder" && ${CREATE_IN_FOLDER}`,
    files: { [`${F}.folder`]: '/repos/web-app', [`${F}.repo`]: 'path:/repos/web-app', [`${F}.prompt`]: 'Full prompt' },
    shortened: false
  })
})

test('hostile urls and folders change only the files', () => {
  for (const hostile of [`it's "here"`, '$(touch PWNED)', '`touch PWNED`', '-rf', 'a;b', '‮evil', 'wеb-app']) {
    const built = clone({ url: hostile, folder: hostile })
    assert.equal(built?.command, CLONE_LINE, JSON.stringify(hostile))
    assert.equal(clone({ url: hostile })?.command, CLONE_LINE, JSON.stringify(hostile))
    assert.equal(clone({ folder: `/repos/${hostile}` })?.command, CLONE_LINE, JSON.stringify(hostile))
    assert.deepEqual(built?.files, { [`${F}.url`]: hostile, [`${F}.folder`]: hostile, [`${F}.repo`]: `path:${hostile}`, [`${F}.prompt`]: 'Full prompt' })
  }
})

test('a control character in the url or folder throws, newline included', () => {
  for (const control of ['\n', '\r', '\t', '\u0000', '\u001b', '\u007f', '\u0085', '\u009b']) {
    assert.throws(() => clone({ url: `${CLONE_URL}${control}` }), /control character/)
    assert.throws(() => clone({ folder: `/repos/web${control}app` }), /control character/)
    assert.throws(() => clone({ url: null, folder: `${control}/repos/web-app` }), /control character/)
  }
})

test('a clone line with the longest default-template branch and a 64-character agent fits in 1,000 bytes, and a longer one is null', () => {
  const branch = branchFor(DEFAULT_BRANCH_TEMPLATE, { id: 2_147_483_647, title: 'x'.repeat(200) })
  const agent = 'a'.repeat(64)
  assert.equal(branch, `feature/2147483647-${'x'.repeat(40)}`)
  const longest = clone({ branch, agent })
  assert.ok(longest && Buffer.byteLength(longest.command) <= MAX_COMMAND_BYTES)
  const room = MAX_COMMAND_BYTES - Buffer.byteLength(longest.command)
  assert.ok(clone({ branch: `${branch}${'x'.repeat(Math.floor(room / 2))}`, agent }))
  assert.equal(clone({ branch: `${branch}${'x'.repeat(Math.floor(room / 2) + 1)}`, agent }), null)
})
