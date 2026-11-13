import type { Stats } from 'node:fs'
import * as path from 'node:path'
import { isValidOrgName } from '../ado/org'
import type { RepoRecord } from '../data/records'
import { cloneRootFailed, cloneRootUnsafe } from '../messages'
import { PATH_CONTROL } from './command'
import { parseAdoRemote, sameRepo, type AdoRemote, type AdoRepo } from './remotes'

export const DEFAULT_CLONE_FOLDER = '~/orca/repos'

const HOME = '~'
const HOME_PREFIX = '~/'
const ROOT_MODE = 0o755
const SHARED_WRITE = 0o022
const STICKY = 0o1000
const SUPERUSER = 0
const DOT_SEGMENT = /^\.\.?$/
const MAX_NAME_LENGTH = 64
const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\\/:*?"<>;#$`{},+=[\]|]/u
const SURROGATE = /[\uD800-\uDFFF]/
const UNSAFE_NAME_EDGE = /^[-_.]|\.$/
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|10)|LPT[1-9])$/i
const URL_SEGMENT = /^[A-Za-z0-9._~%-]+$/
const LEFT_BY_ENCODE_URI = /[!'()*]/g

export type FolderState = 'absent' | 'clone' | 'not-yours' | 'taken'

export interface RootDeps {
  fs: Pick<typeof import('node:fs/promises'), 'mkdir' | 'realpath' | 'lstat'>
  uid: number
}

export interface FolderDeps {
  fs: Pick<typeof import('node:fs/promises'), 'lstat' | 'readdir' | 'realpath'>
  uid: number
  topLevel: (folder: string) => Promise<string | null>
  hasHead: (folder: string) => Promise<boolean>
  remotes: (folder: string) => Promise<AdoRemote[]>
}

export function cloneRoot(setting: string, home: string): string | null {
  if (PATH_CONTROL.test(setting) || PATH_CONTROL.test(home)) return null
  const text = setting.trim() || DEFAULT_CLONE_FOLDER
  const expanded = text === HOME ? home : text.startsWith(HOME_PREFIX) ? path.join(home, text.slice(HOME_PREFIX.length)) : text
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null
}

export function shownPath(folder: string, home: string): string {
  const base = home.replace(/\/+$/, '')
  if (!base) return folder
  if (folder === base) return HOME
  return folder.startsWith(`${base}/`) ? `${HOME}${folder.slice(base.length)}` : folder
}

export function folderNameOf(repoName: string): string | null {
  const name = repoName.normalize('NFC')
  const refused =
    name === '' ||
    name.length > MAX_NAME_LENGTH ||
    UNSAFE_NAME_CHARACTER.test(name) ||
    SURROGATE.test(name) ||
    UNSAFE_NAME_EDGE.test(name) ||
    RESERVED_NAME.test(name)
  return refused ? null : name
}

export function folderKey(folder: string): string {
  return folder.normalize('NFC').toLowerCase()
}

export function prefersSsh(org: string, local: readonly { ado: readonly AdoRemote[] }[]): boolean {
  const remotes = local.flatMap(repo => repo.ado).filter(remote => remote.org.toLowerCase() === org.toLowerCase())
  return remotes.length > 0 && remotes.every(remote => remote.ssh === true)
}

export function cloneUrlOf(org: string, record: RepoRecord, ssh: boolean): string | null {
  if (!isValidOrgName(org)) return null
  const [orgSegment, project, repo] = [org, record.projectName, record.name].map(segmentOf)
  if (!orgSegment || !project || !repo) return null
  const url = ssh && record.ssh ? `git@ssh.dev.azure.com:v3/${orgSegment}/${project}/${repo}` : `https://dev.azure.com/${orgSegment}/${project}/_git/${repo}`
  const parsed = parseAdoRemote(url)
  return parsed?.org === org && parsed.project === record.projectName && parsed.repo === record.name ? url : null
}

export async function rootProblem(deps: RootDeps, root: string): Promise<string | null> {
  const state = await rootState(deps, root)
  return state && 'problem' in state ? state.problem : null
}

export async function readyRoot(deps: RootDeps, root: string): Promise<{ root: string } | { problem: string }> {
  const made = await deps.fs.mkdir(root, { recursive: true, mode: ROOT_MODE }).then(
    () => true,
    () => false
  )
  return (made && (await rootState(deps, root))) || { problem: cloneRootFailed(root) }
}

export async function folderState(deps: FolderDeps, folder: string, target: AdoRepo): Promise<FolderState> {
  let stat: Stats
  try {
    stat = await deps.fs.lstat(folder)
  } catch (error) {
    return isMissing(error) ? 'absent' : 'taken'
  }
  if (!stat.isDirectory()) return 'taken'
  if (stat.uid !== deps.uid) return 'not-yours'
  return contentsState(deps, folder, target).catch(() => 'taken' as const)
}

async function contentsState({ fs, topLevel, hasHead, remotes }: FolderDeps, folder: string, target: AdoRepo): Promise<FolderState> {
  if ((await fs.readdir(folder)).length === 0) return 'absent'
  if ((await topLevel(folder)) !== (await fs.realpath(folder)) || !(await hasHead(folder))) return 'taken'
  return (await remotes(folder)).some(remote => sameRepo(remote, target)) ? 'clone' : 'taken'
}

async function rootState({ fs, uid }: RootDeps, root: string): Promise<{ root: string } | { problem: string } | null> {
  let real: string
  try {
    real = await fs.realpath(root)
  } catch (error) {
    return isMissing(error) ? null : { problem: cloneRootFailed(root) }
  }
  const stat = await fs.lstat(real).catch(() => null)
  if (!stat?.isDirectory()) return { problem: cloneRootFailed(root) }
  const safe = stat.uid === uid && (stat.mode & SHARED_WRITE) === 0 && (await parentsSafe({ fs, uid }, real))
  return safe ? { root: real } : { problem: cloneRootUnsafe(root) }
}

async function parentsSafe({ fs, uid }: RootDeps, folder: string): Promise<boolean> {
  const parent = path.dirname(folder)
  if (parent === folder) return true
  const stat = await fs.lstat(parent).catch(() => null)
  const owned = stat !== null && (stat.uid === uid || stat.uid === SUPERUSER)
  return owned && ((stat.mode & SHARED_WRITE) === 0 || (stat.mode & STICKY) !== 0) && parentsSafe({ fs, uid }, parent)
}

function segmentOf(name: string): string | null {
  try {
    const segment = encodeURIComponent(name).replace(LEFT_BY_ENCODE_URI, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return URL_SEGMENT.test(segment) && !DOT_SEGMENT.test(segment) ? segment : null
  } catch {
    return null
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
