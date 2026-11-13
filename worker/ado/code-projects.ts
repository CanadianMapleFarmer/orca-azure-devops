import type { OrgStatus } from '../../src/shared/types'
import type { OrgEntities, Table } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import type { RepoRecord } from '../data/records'
import { byName, listProjects, type NamedItem } from './core'
import { AdoError, withSignal, type AdoHttp } from './http'
import { listRepositories } from './pullrequests'

export const CODE_REPOS_KEY = 'all'
export const UNLISTED_MS = 600_000

export type CodeProjects = (setting: OrgStatus['codeProjects'], signal?: AbortSignal) => Promise<NamedItem[]>
export type CodeRepos = (signal?: AbortSignal) => Promise<RepoRecord[]>

export function cachedCodeProjects(http: AdoHttp, org: string, tables: Pick<OrgEntities, 'projects' | 'codeRepos'>): CodeProjects {
  const load = async (signal: AbortSignal): Promise<NamedItem[]> => {
    try {
      return projectsOf(await readRepos(http, org, tables.codeRepos, signal))
    } catch (error) {
      if (isUnlisted(error)) return listProjects(withSignal(http, signal), org)
      throw error
    }
  }
  return async (setting, signal) =>
    setting === 'all' ? tables.projects.read(JSON.stringify(setting), FRESHNESS.projects, load, signal) : setting
}

export function cachedCodeRepos(http: AdoHttp, org: string, table: Table<RepoRecord[]>, now: () => number): CodeRepos {
  let unlisted: { error: AdoError; at: number } | null = null
  return async signal => {
    if (unlisted && now() - unlisted.at < UNLISTED_MS) throw unlisted.error
    try {
      return await readRepos(http, org, table, signal)
    } catch (error) {
      if (isUnlisted(error)) unlisted = { error, at: now() }
      throw error
    }
  }
}

function readRepos(http: AdoHttp, org: string, table: Table<RepoRecord[]>, signal?: AbortSignal): Promise<RepoRecord[]> {
  return table.read(CODE_REPOS_KEY, FRESHNESS.projects, scoped => listRepositories(withSignal(http, scoped), org), signal)
}

function projectsOf(repos: RepoRecord[]): NamedItem[] {
  return byName([...new Map(repos.map(repo => [repo.projectId, { id: repo.projectId, name: repo.projectName }])).values()])
}

export function isUnlisted(error: unknown): error is AdoError {
  return error instanceof AdoError && (error.code === 'not_found' || error.code === 'bad_request')
}
