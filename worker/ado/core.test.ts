import { assert, test } from 'orca/testing'
import { getConnectionData } from './core'
import { createAdoHttp } from './http'

const DATA = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace' } }

test('getConnectionData reads GET /_apis/connectionData, falling back to the preview api-version', async () => {
  const calls: Request[] = []
  const replies = [
    new Response(JSON.stringify({ typeKey: 'VssInvalidPreviewVersionException', message: 'Preview only.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    }),
    new Response(JSON.stringify(DATA), { status: 200, headers: { 'content-type': 'application/json' } })
  ]
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    return replies[calls.length - 1].clone()
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer t' })
  assert.deepEqual(await getConnectionData(http, 'contoso'), DATA)
  assert.deepEqual(calls.map(c => c.method), ['GET', 'GET'])
  assert.deepEqual(calls.map(c => c.url), [
    'https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1',
    'https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1-preview'
  ])
})
