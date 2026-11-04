import type { AdoHttp } from './http'

export interface ConnectionData {
  authenticatedUser: { id: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } }
}

export async function getConnectionData(http: AdoHttp, org: string): Promise<ConnectionData> {
  const { data } = await http.json<ConnectionData>({ org, path: '/_apis/connectionData' })
  return data
}

export interface NamedItem {
  id: string
  name: string
}

const PAGE_SIZE = 500
const MAX_PAGES = 20

export function listProjects(http: AdoHttp, org: string): Promise<NamedItem[]> {
  return listAll(http, org, '/_apis/projects')
}

export function listTeams(http: AdoHttp, org: string, projectId: string): Promise<NamedItem[]> {
  return listAll(http, org, `/_apis/projects/${encodeURIComponent(projectId)}/teams`)
}

async function listAll(http: AdoHttp, org: string, path: string): Promise<NamedItem[]> {
  const items: NamedItem[] = []
  let continuationToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, headers } = await http.json<{ value: NamedItem[] }>({ org, path, query: { $top: PAGE_SIZE, continuationToken } })
    items.push(...data.value.map(({ id, name }) => ({ id, name })))
    continuationToken = headers.get('x-ms-continuationtoken') ?? undefined
    if (!continuationToken) break
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
