import { ONLY_BASH_AND_ZSH, ONLY_MAC_AND_LINUX, NOT_ON_WINDOWS, yourShellIs } from '../messages'

export interface ShellHost { platform: string; shell: string | undefined }

const SYSTEMS: ReadonlySet<string> = new Set(['darwin', 'linux'])
const SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh'])
const ORCA_DEFAULT_SHELL = '/bin/zsh'
const PROGRAM_NAME = /^[a-z0-9._+-]{1,32}$/

export function unsupportedShell({ platform, shell }: ShellHost): string | null {
  if (platform === 'win32') return NOT_ON_WINDOWS
  if (!SYSTEMS.has(platform)) return ONLY_MAC_AND_LINUX
  const name = (shell?.trim() || ORCA_DEFAULT_SHELL).split('/').pop()?.toLowerCase() ?? ''
  if (SHELLS.has(name)) return null
  return PROGRAM_NAME.test(name) ? yourShellIs(name) : ONLY_BASH_AND_ZSH
}
