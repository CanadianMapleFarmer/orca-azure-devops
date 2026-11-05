import { isValidOrgName } from '../ado/org'

export interface AdoRemote {
  org: string
  project: string
  repo: string
}

const AZURE_HOST = 'dev.azure.com'
const LEGACY_HOST_SUFFIX = '.visualstudio.com'
const LEGACY_DEFAULT_COLLECTION = 'defaultcollection'
const GIT_SEGMENT = '_git'
const SSH_HOSTS: ReadonlySet<string> = new Set(['ssh.dev.azure.com', 'vs-ssh.visualstudio.com'])
const SSH_REMOTE = /^[^@\s/:]+@([^@\s/:]+):v3\/(.+)$/i
const REMOTE_LINE = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/

export function parseAdoRemote(url: string): AdoRemote | null {
  const text = url.trim()
  const ssh = SSH_REMOTE.exec(text)
  if (ssh) return SSH_HOSTS.has(ssh[1].toLowerCase()) ? remoteOf(ssh[2].split('/')) : null
  return httpsRemote(text)
}

export function remotesOf(gitRemoteVerbose: string): AdoRemote[] {
  const found = new Map<string, AdoRemote>()
  for (const line of gitRemoteVerbose.split('\n')) {
    const url = REMOTE_LINE.exec(line.trim())?.[1]
    const remote = url ? parseAdoRemote(url) : null
    const key = remote ? `${remote.org}/${remote.project}/${remote.repo}`.toLowerCase() : ''
    if (remote && !found.has(key)) found.set(key, remote)
  }
  return [...found.values()]
}

function httpsRemote(text: string): AdoRemote | null {
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

function gitRemoteOf(org: string, rest: string[]): AdoRemote | null {
  if (rest.length !== 3 || rest[1].toLowerCase() !== GIT_SEGMENT) return null
  return remoteOf([org, rest[0], rest[2]])
}

function remoteOf(segments: string[]): AdoRemote | null {
  if (segments.length !== 3) return null
  try {
    const [org, project, repo] = segments.map(decodeURIComponent)
    return org && project && repo ? { org, project, repo } : null
  } catch {
    return null
  }
}
