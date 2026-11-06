import { isValidOrgName } from '../ado/org'

export interface AdoRemote {
  remote: string
  org: string
  project: string
  repo: string
}

type AdoRepo = Omit<AdoRemote, 'remote'>

const AZURE_HOST = 'dev.azure.com'
const LEGACY_HOST_SUFFIX = '.visualstudio.com'
const LEGACY_DEFAULT_COLLECTION = 'defaultcollection'
const GIT_SEGMENT = '_git'
const SSH_HOSTS: ReadonlySet<string> = new Set(['ssh.dev.azure.com', 'vs-ssh.visualstudio.com'])
const SSH_REMOTE = /^[^@\s/:]+@([^@\s/:]+):v3\/(.+)$/i
const REMOTE_LINE = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)(?:\s+\[[^\]]*\])?$/

export function parseAdoRemote(url: string): AdoRepo | null {
  const text = url.trim()
  const ssh = SSH_REMOTE.exec(text)
  if (ssh) return SSH_HOSTS.has(ssh[1].toLowerCase()) ? remoteOf(ssh[2].split('/')) : null
  return httpsRemote(text)
}

export function remotesOf(gitRemoteVerbose: string): AdoRemote[] {
  const found = new Map<string, AdoRemote>()
  for (const line of gitRemoteVerbose.split('\n')) {
    const [, name, url] = REMOTE_LINE.exec(line.trim()) ?? []
    const repo = url ? parseAdoRemote(url) : null
    const key = repo ? `${repo.org}/${repo.project}/${repo.repo}`.toLowerCase() : ''
    if (repo && !found.has(key)) found.set(key, { remote: name, ...repo })
  }
  return [...found.values()]
}

export function sameRepo(remote: AdoRemote, target: { org: string; project: string; repo: string }): boolean {
  return (
    sameName(remote.org, target.org) &&
    sameName(remote.repo, target.repo) &&
    (remote.project === '' || sameName(remote.project, target.project))
  )
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function httpsRemote(text: string): AdoRepo | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const parts = url.pathname.split('/').slice(1)
  if (url.hostname === AZURE_HOST) return gitRemoteOf(parts[0], parts.slice(1))
  if (!url.hostname.endsWith(LEGACY_HOST_SUFFIX)) return null
  const org = url.hostname.slice(0, -LEGACY_HOST_SUFFIX.length)
  if (!isValidOrgName(org)) return null
  return gitRemoteOf(org, parts[0]?.toLowerCase() === LEGACY_DEFAULT_COLLECTION ? parts.slice(1) : parts)
}

function gitRemoteOf(org: string, rest: string[]): AdoRepo | null {
  if (rest.length === 2 && rest[0].toLowerCase() === GIT_SEGMENT) return defaultProjectRemoteOf(org, rest[1])
  if (rest.length !== 3 || rest[1].toLowerCase() !== GIT_SEGMENT) return null
  return remoteOf([org, rest[0], rest[2]])
}

function remoteOf(segments: string[]): AdoRepo | null {
  const values = segments.length === 3 ? decoded(segments) : null
  return values && { org: values[0], project: values[1], repo: values[2] }
}

function defaultProjectRemoteOf(org: string, repo: string): AdoRepo | null {
  const values = decoded([org, repo])
  return values && { org: values[0], project: '', repo: values[1] }
}

function decoded(segments: string[]): string[] | null {
  try {
    const values = segments.map(decodeURIComponent)
    return values.every(Boolean) ? values : null
  } catch {
    return null
  }
}
