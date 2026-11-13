import { assert, test } from 'orca/testing'
import { unsupportedShell } from './shell'

const ON_WINDOWS = "Starting a workspace or an agent from an item isn't supported on Windows yet."
const OTHER_SYSTEM = 'Starting a workspace or an agent from an item works on macOS and Linux only for now.'
const ONLY_BASH_ZSH = 'Starting a workspace or an agent from an item works with the bash and zsh shells only for now.'

test('bash and zsh on macOS and Linux are supported, wherever they are installed', () => {
  for (const shell of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/zsh', '/usr/local/bin/bash', ' /bin/zsh\n', '/usr/bin/ZSH']) {
    assert.equal(unsupportedShell({ platform: 'darwin', shell }), null, shell)
    assert.equal(unsupportedShell({ platform: 'linux', shell }), null, shell)
  }
})

test('without SHELL the terminal gets zsh, as in Orca', () => {
  assert.equal(unsupportedShell({ platform: 'darwin', shell: undefined }), null)
  assert.equal(unsupportedShell({ platform: 'linux', shell: '  ' }), null)
})

test('Windows and other systems are not supported, whatever the shell', () => {
  assert.equal(unsupportedShell({ platform: 'win32', shell: '/bin/bash' }), ON_WINDOWS)
  assert.equal(unsupportedShell({ platform: 'win32', shell: undefined }), ON_WINDOWS)
  assert.equal(unsupportedShell({ platform: 'freebsd', shell: '/bin/zsh' }), OTHER_SYSTEM)
})

test('any other shell is not supported and is named', () => {
  for (const [shell, name] of [['/opt/homebrew/bin/fish', 'fish'], ['/bin/sh', 'sh'], ['/bin/dash', 'dash'], ['/bin/tcsh', 'tcsh'], ['/usr/bin/nu', 'nu'], ['/bin/bash5', 'bash5']]) {
    assert.equal(unsupportedShell({ platform: 'darwin', shell }), `${ONLY_BASH_ZSH} Yours is ${name}.`, shell)
  }
})

test('a SHELL value that is not a plain program name is not supported and not repeated', () => {
  for (const shell of ['/bin/zsh; rm -rf ~', '/bin/$(id)', '/bin/zsh/', 'zsh -l', '/bin/`id`', `/bin/${'z'.repeat(40)}`, '/bin/zsh\u0000', '/bin/zsh\u001b[2J']) {
    assert.equal(unsupportedShell({ platform: 'linux', shell }), ONLY_BASH_ZSH, JSON.stringify(shell))
  }
})
