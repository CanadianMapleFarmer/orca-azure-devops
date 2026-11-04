import { assert, test } from 'orca/testing'
import { discoverTenant, parseOrgInput } from './org'

test('parseOrgInput accepts the common forms', () => {
  for (const input of ['contoso', ' Contoso ', 'https://dev.azure.com/contoso', 'https://dev.azure.com/Contoso/',
    'https://dev.azure.com/contoso/Web/_git/api', 'https://user@dev.azure.com/contoso/Web/_git/api',
    'https://contoso.visualstudio.com', 'contoso.visualstudio.com/DefaultCollection/Web'])
    assert.deepEqual(parseOrgInput(input), { org: 'contoso', url: 'https://dev.azure.com/contoso' })
})

test('parseOrgInput rejects other hosts and junk', () => {
  for (const input of ['', 'https://github.com/contoso', 'https://dev.azure.com/', 'not a url/with spaces'])
    assert.equal(parseOrgInput(input), null)
})

test('discoverTenant reads x-vss-resourcetenant from an anonymous HEAD', async () => {
  const calls: Request[] = []
  const fake = async (input: RequestInfo, init?: RequestInit) => {
    calls.push(new Request(input, init))
    return new Response(null, { status: 404, headers: { 'x-vss-resourcetenant': '11111111-2222-3333-4444-555555555555' } })
  }
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), '11111111-2222-3333-4444-555555555555')
  assert.equal(calls[0].method, 'HEAD')
  assert.equal(calls[0].url, 'https://vssps.dev.azure.com/contoso')
  assert.equal(calls[0].headers.get('authorization'), null)
})

test('discoverTenant returns null when the header is missing', async () => {
  const fake = async () => new Response(null, { status: 404 })
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), null)
})

test('discoverTenant returns null for the all-zero tenant of an MSA-backed org', async () => {
  const fake = async () =>
    new Response(null, { status: 404, headers: { 'x-vss-resourcetenant': '00000000-0000-0000-0000-000000000000' } })
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), null)
})

test('discoverTenant returns null when the request fails', async () => {
  const fake = async () => {
    throw new TypeError('fetch failed')
  }
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), null)
})
