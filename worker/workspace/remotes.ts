import { isGuid, isValidOrgName } from '../ado/org'

export interface AdoRemote {
  remote: string
  org: string
  project: string
  repo: string
  ssh?: true
}

export type AdoRepo = { org: string; project: string; repo: string }

export interface OtherRemote {
  remote: string
  key: string
  name: string
  host: string
}

export interface RemoteSet {
  ado: AdoRemote[]
  other: OtherRemote | null
}

export type RemoteSets = (workspacePath: string, options?: { fresh?: boolean }) => Promise<RemoteSet>

const AZURE_HOST = 'dev.azure.com'
const LEGACY_HOST_SUFFIX = '.visualstudio.com'
const LEGACY_DEFAULT_COLLECTION = 'defaultcollection'
const GIT_SEGMENT = '_git'
const ORIGIN = 'origin'
const SSH_HOSTS: ReadonlySet<string> = new Set(['ssh.dev.azure.com', 'vs-ssh.visualstudio.com'])
const ADO_DOMAINS = [AZURE_HOST, 'visualstudio.com']
const SSH_USER = '[A-Za-z0-9][A-Za-z0-9._-]*'
const SCP_REMOTE = new RegExp(`^${SSH_USER}@([^@/:]+):(.+)$`)
const SSH_URL_REMOTE = new RegExp(`^ssh://${SSH_USER}@([^@/:]+)(?::(\\d+))?/(.+)$`, 'i')
const SSH_PATH = /^v3\/(.+)$/i
const SSH_PORT = '22'
const REMOTE_LINE = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)(?:\s+\[[^\]]*\])?$/
const UNSAFE_TEXT = /[\s\\\u0000-\u001F\u007F-\u009F]/
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
const PULL_REQUEST_SUFFIX = /\/pullrequest\/\d+$/
const OTHER_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'ssh:', 'git:'])
const GIT_SUFFIX = /\.git$/i

export function parseAdoRemote(url: string): AdoRepo | null {
  return adoRemoteOf(url)?.repo ?? null
}

export function remotesOf(gitRemoteVerbose: string): AdoRemote[] {
  const found = new Map<string, AdoRemote>()
  for (const { name, url } of remoteLines(gitRemoteVerbose)) {
    const parsed = adoRemoteOf(url)
    if (!parsed) continue
    const { repo, ssh } = parsed
    const key = `${repo.org}/${repo.project}/${repo.repo}`.toLowerCase()
    if (!found.has(key)) found.set(key, ssh ? { remote: name, ...repo, ssh } : { remote: name, ...repo })
  }
  return [...found.values()]
}

export function otherRemoteOf(gitRemoteVerbose: string): OtherRemote | null {
  let first: OtherRemote | null = null
  for (const { name, url } of remoteLines(gitRemoteVerbose)) {
    const other = otherOf(name, url)
    if (other?.remote === ORIGIN) return other
    first ??= other
  }
  return first
}

export function repoOfPullRequestUrl(url: string): AdoRepo | null {
  if (UNSAFE_TEXT.test(url) || !PULL_REQUEST_SUFFIX.test(url)) return null
  const repo = httpsRemote(url.replace(PULL_REQUEST_SUFFIX, ''))
  if (!repo) return null
  const named = { ...repo, project: repo.project || repo.repo }
  return isGuid(named.project) || isGuid(named.repo) ? null : named
}

export function sameRepo(remote: AdoRemote, target: AdoRepo): boolean {
  return sameName(remote.org, target.org) && sameName(remote.repo, target.repo) && sameName(remote.project || remote.repo, target.project)
}

export function sameProject(remote: AdoRemote, target: { org: string; project: string }): boolean {
  return sameName(remote.org, target.org) && sameName(remote.project || remote.repo, target.project)
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function* remoteLines(gitRemoteVerbose: string): Generator<{ name: string; url: string }> {
  for (const line of gitRemoteVerbose.split('\n')) {
    const [, name, url] = REMOTE_LINE.exec(line.trim()) ?? []
    if (name && url) yield { name, url }
  }
}

function adoRemoteOf(url: string): { repo: AdoRepo; ssh: boolean } | null {
  if (UNSAFE_TEXT.test(url)) return null
  const ssh = sshPlace(url)
  if (ssh) {
    const path = SSH_PATH.exec(ssh.path)
    const repo = SSH_HOSTS.has(ssh.host.toLowerCase()) && path ? remoteOf(path[1].split('/')) : null
    return repo && { repo, ssh: true }
  }
  const repo = httpsRemote(url)
  return repo && { repo, ssh: false }
}

function sshPlace(url: string): { host: string; path: string } | null {
  const scp = SCP_REMOTE.exec(url)
  if (scp) return { host: scp[1], path: scp[2] }
  const ssh = SSH_URL_REMOTE.exec(url)
  if (!ssh || (ssh[2] !== undefined && ssh[2] !== SSH_PORT)) return null
  return { host: ssh[1], path: ssh[3] }
}

function httpsRemote(text: string): AdoRepo | null {
  const url = urlOf(text)
  if (url?.protocol !== 'https:') return null
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

function otherOf(remote: string, text: string): OtherRemote | null {
  if (UNSAFE_TEXT.test(text)) return null
  const place = otherPlace(text)
  if (!place || isAdoHost(place.host)) return null
  const segments = decoded(place.path.replace(/\/+$/, '').replace(GIT_SUFFIX, '').split('/').filter(Boolean))
  const name = segments?.at(-1)
  if (!segments || !name) return null
  return { remote, key: `git:${place.host}/${segments.join('/')}`.toLowerCase(), name, host: place.host }
}

function otherPlace(text: string): { host: string; path: string } | null {
  const scp = SCP_REMOTE.exec(text)
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] }
  const url = urlOf(text)
  if (!url || !OTHER_PROTOCOLS.has(url.protocol) || !url.hostname) return null
  return { host: url.hostname.toLowerCase(), path: url.pathname }
}

function isAdoHost(host: string): boolean {
  return ADO_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
}

function urlOf(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function decoded(segments: string[]): string[] | null {
  try {
    const values = segments.map(decodeURIComponent)
    return values.every(value => value !== '' && !CONTROL.test(value)) ? values : null
  } catch {
    return null
  }
}
