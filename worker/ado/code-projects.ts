import type { OrgStatus } from '../../src/shared/types'
import type { NamedItem } from './core'
import { withSignal, type AdoHttp } from './http'
import { codeProjects } from './pullrequests'

const PROJECTS_TTL_MS = 60 * 60_000

export type CodeProjects = (setting: OrgStatus['codeProjects'], signal?: AbortSignal) => Promise<NamedItem[]>

export function cachedCodeProjects(http: AdoHttp, org: string, now: () => number): CodeProjects {
  let cached: { key: string; at: number; projects: NamedItem[] } | null = null
  return async (setting, signal) => {
    const key = JSON.stringify(setting)
    if (cached?.key === key && now() - cached.at < PROJECTS_TTL_MS) return cached.projects
    const projects = await codeProjects(withSignal(http, signal), org, setting)
    cached = { key, at: now(), projects }
    return projects
  }
}
