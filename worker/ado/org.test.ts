import { assert, test } from 'orca/testing'
import { discoverTenant, entraAuthorizeUrl, entraTokenUrl, isValidOrgName, orgSearchUrl, orgVsspsUrl, parseOrgInput } from './org'

test('isValidOrgName accepts lower-case names up to 50 characters and nothing else', () => {
  for (const name of ['contoso', 'a', '0abc', 'fab-rikam', 'a'.repeat(50)]) assert.equal(isValidOrgName(name), true, name)
  for (const name of ['', '-contoso', 'Contoso', 'con toso', 'a/b', '../x', '..', 'a.b', 'a'.repeat(51)])
    assert.equal(isValidOrgName(name), false, JSON.stringify(name))
})

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

test('discoverTenant asks the vssps host from orgVsspsUrl', async () => {
  assert.equal(orgVsspsUrl('contoso'), 'https://vssps.dev.azure.com/contoso')
  assert.equal(orgVsspsUrl('a/b'), 'https://vssps.dev.azure.com/a%2Fb')
  const urls: string[] = []
  const fake = async (input: RequestInfo) => {
    urls.push(String(input))
    return new Response(null, { status: 404 })
  }
  await discoverTenant('a/b', fake as typeof fetch)
  assert.deepEqual(urls, [orgVsspsUrl('a/b')])
})

test('orgSearchUrl encodes the org', () => {
  assert.equal(orgSearchUrl('contoso'), 'https://almsearch.dev.azure.com/contoso')
  assert.equal(orgSearchUrl('a/b?c'), 'https://almsearch.dev.azure.com/a%2Fb%3Fc')
})

test('entra URLs encode the authority', () => {
  for (const authority of ['contoso.onmicrosoft.com', '0f0e0d0c-0b0a-4908-8706-050403020100', 'organizations']) {
    assert.equal(entraAuthorizeUrl(authority), `https://login.microsoftonline.com/${authority}/oauth2/v2.0/authorize`)
    assert.equal(entraTokenUrl(authority), `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`)
  }
  assert.equal(entraAuthorizeUrl('a/../b?c#d'), 'https://login.microsoftonline.com/a%2F..%2Fb%3Fc%23d/oauth2/v2.0/authorize')
  assert.equal(entraTokenUrl('a/../b?c#d'), 'https://login.microsoftonline.com/a%2F..%2Fb%3Fc%23d/oauth2/v2.0/token')
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

test('discoverTenant returns null when the header is not a GUID', async () => {
  const fake = async () => new Response(null, { status: 404, headers: { 'x-vss-resourcetenant': 'not-a-guid' } })
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), null)
})

test('discoverTenant accepts an upper-case GUID', async () => {
  const fake = async () =>
    new Response(null, { status: 404, headers: { 'x-vss-resourcetenant': 'ABCDEF01-2222-3333-4444-555555555555' } })
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), 'ABCDEF01-2222-3333-4444-555555555555')
})

test('discoverTenant returns null when the request fails', async () => {
  const fake = async () => {
    throw new TypeError('fetch failed')
  }
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), null)
})

test('discoverTenant returns null when the request outlives the timeout', async () => {
  const hanging = (_input: RequestInfo, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
  assert.equal(await discoverTenant('contoso', hanging as typeof fetch, 20), null)
})
