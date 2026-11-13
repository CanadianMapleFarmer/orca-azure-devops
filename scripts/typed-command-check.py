import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CASES_JS = r"""
const { cloneCommand, createCommand, launchCommand, NEW_REPO_SETUP, START_FILES_FOLDER } = await import('./worker/workspace/command.ts')
const hostile = [
  `[ADO Bug #12: it's "quoted"](https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/12)\n\n## Description\n\nSteps:\ntouch PWNED`,
  "x'; touch PWNED; echo '\n\\' '\\'' trailing \\",
  'run `touch PWNED` and $(touch PWNED) and !! !$ !-1 \n^a^b',
  "$'\\x27; touch PWNED; \\x27' \u001b[201~touch PWNED\u001b[200~ \u009b2J",
  'unicode: 👍🏽 漢字 \u202Eevil\u2028next ＼ ＇ * ? [a] ~ # --help',
  'long: ' + 'word '.repeat(3000)
]
const sent = text => text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ').replace(/\n+$/, '')
const fileId = n => `c${String(n).padStart(23, '0')}`
const folder = "/tmp/it's \"here\" $(touch PWNED) `touch PWNED`/-rf"
const url = 'https://dev.azure.com/contoso/Fab%27x/_git/%24%28touch%20PWNED%29'
const setup = NEW_REPO_SETUP === 'skip' ? ['--setup', 'skip'] : []
const orca = (...args) => ['orca', '', ...args]
const createdIn = full => orca('worktree', 'create', '--repo', `path:${folder}`, '--name', 'feature/12-x', '--branch', 'feature/12-x', '--agent', 'claude', '--prompt', sent(full), ...setup, '--no-parent', '--activate')
const cases = hostile.flatMap((full, index) => [
  {
    built: createCommand({ fileId: fileId(index * 4), branch: 'feature/12-x', agent: 'claude', prompts: { full, short: 's' } }),
    expected: [orca('worktree', 'create', '--name', 'feature/12-x', '--branch', 'feature/12-x', '--agent', 'claude', '--prompt', sent(full), '--no-parent', '--activate')]
  },
  {
    built: launchCommand({ fileId: fileId(index * 4 + 1), workspaceId: "repo::/repos/it's here", agent: 'claude', prompts: { full, short: 's' } }),
    expected: [orca('agent', 'launch', '--agent', 'claude', '--worktree', "id:repo::/repos/it's here", '--prompt', sent(full), '--focus')]
  },
  {
    built: cloneCommand({ fileId: fileId(index * 4 + 2), url, folder, branch: 'feature/12-x', agent: 'claude', prompts: { full, short: 's' } }),
    expected: [['git', 'https:ssh', 'clone', '--', url, folder], orca('repo', 'add', '--path', folder), createdIn(full)]
  },
  {
    built: cloneCommand({ fileId: fileId(index * 4 + 3), url: null, folder, branch: 'feature/12-x', agent: 'claude', prompts: { full, short: 's' } }),
    expected: [orca('repo', 'add', '--path', folder), createdIn(full)]
  }
])
const transport = cloneCommand({ fileId: fileId(99), url: 'set later', folder: 'set later', branch: 'feature/12-x', agent: 'claude', prompts: { full: 'p q', short: 's' } })
console.log(JSON.stringify({ folder: START_FILES_FOLDER, cases, transport }))
"""

SLOW_RC = 'sleep 3\n'
CONTROL_LINE = 'orca control ' + 'x' * 1100

RECORDER = '''#!/bin/sh
i=0
while [ -e "$CALLS_OUT/$i" ]; do i=$((i + 1)); done
{ printf '%s\\0' "${0##*/}" "$GIT_ALLOW_PROTOCOL"; for arg in "$@"; do printf '%s\\0' "$arg"; done; } > "$CALLS_OUT/$i"
'''
REAL_GIT = shutil.which('git')
TRANSPORTS = ('file://', 'plain path', 'ext::')

RUNS = [
    ('/bin/bash', ['--noprofile', '--norc', '-i'], True),
    ('/bin/zsh', ['-f', '-i'], True),
    ('/bin/sh', ['-i'], True),
    ('/bin/dash', ['-i'], True),
    ('/bin/ksh', ['-i'], True),
    ('/bin/tcsh', ['-f', '-i'], False),
    ('/bin/csh', ['-f', '-i'], False),
    ('/opt/homebrew/bin/bash', ['--noprofile', '--norc', '-i'], True),
    ('/opt/homebrew/bin/fish', ['--no-config', '-i'], None),
    ('/opt/homebrew/bin/pwsh', ['-NoProfile', '-NoLogo'], None),
    ('/opt/homebrew/bin/nu', ['--no-config-file'], None),
]


def orca_types(command, bracketed_paste_safe):
    body = command
    for ending in ('\r\n', '\r', '\n'):
        if body.endswith(ending):
            body = body[: -len(ending)]
            break
    if bracketed_paste_safe and ('\n' in body or '\r' in body):
        return '\x1b[200~' + body + '\x1b[201~\r'
    return body.replace('\r\n', '\r').replace('\n', '\r') + '\r'


def read_until_quiet(fd, quiet, limit):
    out = b''
    started = last = time.time()
    while time.time() - started < limit:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            last = time.time()
        elif time.time() - last > quiet:
            break
    return out


def slow_start(shell, flags, work):
    name = os.path.basename(shell)
    rc = os.path.join(work, '.zshrc' if name == 'zsh' else 'slow-rc')
    with open(rc, 'w') as handle:
        handle.write(SLOW_RC)
    if name == 'bash':
        return ['--noprofile', '--rcfile', rc, '-i'], {}
    if name == 'zsh':
        return ['-i'], {'ZDOTDIR': work}
    return None


def install(work, folder, files, programs):
    bindir = os.path.join(work, 'bin')
    os.mkdir(bindir)
    for program in programs:
        with open(os.path.join(bindir, program), 'w') as fake:
            fake.write(RECORDER)
        os.chmod(os.path.join(bindir, program), 0o755)
    starts = os.path.join(work, *folder.split('/'))
    os.makedirs(starts, mode=0o700)
    for name, text in files.items():
        fd = os.open(os.path.join(starts, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, text.encode('utf-8'))
        os.close(fd)
    calls = os.path.join(work, 'calls')
    os.mkdir(calls)
    return bindir, calls


def recorded(calls):
    return [open(os.path.join(calls, name), 'rb').read().decode('utf-8').split('\0')[:-1] for name in sorted(os.listdir(calls), key=int)]


def session(shell, flags, env, work, ready, lines, quiet, limit):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execve(shell, [shell] + flags, env)
    if ready:
        read_until_quiet(fd, 0.5, 5.0)
    transcript = b''
    for line in lines:
        try:
            os.write(fd, line.encode('utf-8'))
        except OSError:
            break
        transcript += read_until_quiet(fd, quiet, limit)
    try:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    except OSError:
        pass
    os.close(fd)
    return transcript


def type_into(shell, flags, typed, folder, files, mode):
    work = tempfile.mkdtemp(prefix='typed-command-')
    bindir, calls = install(work, folder, files, ('orca', 'git'))
    env = {'PATH': bindir + ':/usr/bin:/bin', 'HOME': work, 'CALLS_OUT': calls, 'TERM': 'xterm-256color', 'PS1': '$ '}
    if mode == 'slow rc':
        flags, extra = slow_start(shell, flags, work)
        env.update(extra)
    transcript = session(shell, flags, env, work, mode in ('ready', 'no files'), [typed], 4.0 if mode == 'slow rc' else 0.8, 12.0)
    made = recorded(calls)
    pwned = any(name.startswith('PWNED') for name in os.listdir(work))
    shutil.rmtree(work, ignore_errors=True)
    return made, pwned, transcript


def transport_url(kind, repo):
    return {'file://': 'file://' + repo, 'plain path': repo, 'ext::': 'ext::sh -c touch% PWNED'}[kind]


def git_env(gitdir, work):
    return {'PATH': gitdir + ':/usr/bin:/bin', 'HOME': work, 'TERM': 'xterm-256color', 'PS1': '$ '}


def transport_work():
    work = tempfile.mkdtemp(prefix='typed-transport-')
    gitdir = os.path.join(work, 'git-bin')
    os.mkdir(gitdir)
    os.symlink(REAL_GIT, os.path.join(gitdir, 'git'))
    repo = os.path.join(work, 'bare.git')
    subprocess.run([REAL_GIT, 'init', '--bare', '-q', repo], env=git_env(gitdir, work), check=True)
    return work, gitdir, repo


def clones_without_limit(kind):
    work, gitdir, repo = transport_work()
    target = os.path.join(work, 'target')
    done = subprocess.run(['git', 'clone', '-q', '--', transport_url(kind, repo), target], cwd=work, env=git_env(gitdir, work), capture_output=True)
    cloned = done.returncode == 0 and os.path.isdir(os.path.join(target, '.git'))
    shutil.rmtree(work, ignore_errors=True)
    return cloned


def refuses_transport(shell, flags, typed, folder, files, kind):
    work, gitdir, repo = transport_work()
    target = os.path.join(work, 'target')
    overrides = {'.url': transport_url(kind, repo), '.folder': target, '.repo': 'path:' + target}
    files = {name: next((text for ending, text in overrides.items() if name.endswith(ending)), value) for name, value in files.items()}
    bindir, calls = install(work, folder, files, ('orca',))
    env = git_env(gitdir, work)
    env.update({'PATH': bindir + ':' + env['PATH'], 'CALLS_OUT': calls})
    transcript = session(shell, flags, env, work, True, [typed, 'echo "status=$?"\r'], 1.5, 15.0).decode('utf-8', 'replace')
    statuses = [int(found) for found in re.findall(r'status=(\d+)', transcript)]
    outcome = {
        'status': statuses[-1] if statuses else None,
        'target': os.path.lexists(target),
        'calls': recorded(calls),
        'pwned': any(name.startswith('PWNED') for name in os.listdir(work)),
    }
    shutil.rmtree(work, ignore_errors=True)
    return outcome, transcript


def main():
    generated = json.loads(subprocess.check_output(['node', '--no-warnings', '--input-type=module', '-e', CASES_JS], cwd=ROOT))
    folder, cases, transport = generated['folder'], generated['cases'], generated['transport']
    sizes = sorted(len(case['built']['command'].encode('utf-8')) for case in cases)
    print(f'{len(cases)} commands, {sizes[0]} to {sizes[-1]} bytes each')
    failures = 0
    if REAL_GIT:
        for kind in TRANSPORTS[:2]:
            cloned = clones_without_limit(kind)
            failures += 0 if cloned else 1
            print(f'real git control: without GIT_ALLOW_PROTOCOL, a {kind} clone {"works" if cloned else "FAILS, so the refusals below prove nothing"}')
    else:
        print('skip real git: not installed')
    for shell, flags, runs in RUNS:
        if not os.path.exists(shell):
            print(f'skip {shell}: not installed')
            continue
        paste_safe = os.path.basename(shell) in ('bash', 'zsh')
        if paste_safe and os.path.dirname(shell) == '/bin':
            made, _, _ = type_into(shell, flags, orca_types(CONTROL_LINE, True), folder, {}, 'slow rc')
            kept = 'kept' if made == [['orca', '', 'control', 'x' * 1100]] else 'cut off'
            print(f'{shell} slow rc control: a {len(CONTROL_LINE)}-byte line typed early is {kept}')
        modes = ('ready', 'early', 'slow rc', 'no files') if paste_safe and os.path.dirname(shell) == '/bin' else ('ready', 'early', 'no files')
        for mode in modes:
            passed = 0
            for case in cases:
                typed = orca_types(case['built']['command'], paste_safe)
                files = {} if mode == 'no files' else case['built']['files']
                made, pwned, transcript = type_into(shell, flags, typed, folder, files, mode)
                expected = case['expected'] if runs and mode != 'no files' else []
                ok = not pwned and (made == expected if runs is not None else made in ([], case['expected']))
                if ok:
                    passed += 1
                else:
                    failures += 1
                    print(f'FAIL {shell} {mode}: calls={made!r:.160} pwned={pwned}')
                    print('     ' + transcript.decode('utf-8', 'replace')[-300:].replace('\r', '\\r').replace('\n', '\\n'))
            outcome = 'runs' if runs and mode != 'no files' else 'refuses' if runs is not None else 'runs or refuses'
            print(f'{shell} {mode} ({outcome}): {passed} of {len(cases)}')
        if runs and REAL_GIT:
            refused = 0
            for kind in TRANSPORTS:
                result, transcript = refuses_transport(shell, flags, orca_types(transport['command'], paste_safe), folder, transport['files'], kind)
                if result['status'] not in (None, 0) and not result['target'] and not result['calls'] and not result['pwned']:
                    refused += 1
                else:
                    failures += 1
                    print(f'FAIL {shell} real git {kind}: {result}')
                    print('     ' + transcript[-300:].replace('\r', '\\r').replace('\n', '\\n'))
            print(f'{shell} real git refuses other transports: {refused} of {len(TRANSPORTS)}')
    sys.exit(1 if failures else 0)


main()
