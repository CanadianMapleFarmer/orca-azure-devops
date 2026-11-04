import type { AdoHttp } from './http'

export interface ConnectionData {
  authenticatedUser: { id: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } }
}

export async function getConnectionData(http: AdoHttp, org: string): Promise<ConnectionData> {
  const { data } = await http.json<ConnectionData>({ org, path: '/_apis/connectionData' })
  return data
}
