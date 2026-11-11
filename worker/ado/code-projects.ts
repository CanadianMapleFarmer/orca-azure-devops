import type { OrgStatus } from '../../src/shared/types'
import type { Table } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import type { NamedItem } from './core'
import { withSignal, type AdoHttp } from './http'
import { codeProjects } from './pullrequests'

export type CodeProjects = (setting: OrgStatus['codeProjects'], signal?: AbortSignal) => Promise<NamedItem[]>

export function cachedCodeProjects(http: AdoHttp, org: string, table: Table<NamedItem[]>): CodeProjects {
  return (setting, signal) =>
    table.read(JSON.stringify(setting), FRESHNESS.projects, scoped => codeProjects(withSignal(http, scoped), org, setting), signal)
}
