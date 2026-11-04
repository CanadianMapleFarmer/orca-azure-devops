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

type Listing = { value: NamedItem[] }

const PAGE_SIZE = 500
const MAX_PAGES = 20

export async function listProjects(http: AdoHttp, org: string): Promise<NamedItem[]> {
  const items: NamedItem[] = []
  let continuationToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, headers } = await http.json<Listing>({ org, path: '/_apis/projects', query: { $top: PAGE_SIZE, continuationToken } })
    items.push(...data.value)
    continuationToken = headers.get('x-ms-continuationtoken') ?? undefined
    if (!continuationToken) break
  }
  return byName(items)
}

export async function listTeams(http: AdoHttp, org: string, projectId: string): Promise<NamedItem[]> {
  const path = `/_apis/projects/${encodeURIComponent(projectId)}/teams`
  const items: NamedItem[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await http.json<Listing>({ org, path, query: { $top: PAGE_SIZE, $skip: page * PAGE_SIZE } })
    items.push(...data.value)
    if (data.value.length < PAGE_SIZE) break
  }
  return byName(items)
}

function byName(items: NamedItem[]): NamedItem[] {
  return items
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
