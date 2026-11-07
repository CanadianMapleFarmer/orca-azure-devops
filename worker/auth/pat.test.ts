import { assert, test } from 'orca/testing'
import { memorySecrets } from '../test-support'
import { basicAuth, createPatProvider, patKey } from './pat'

const PAT = 'pat-fixture-not-a-real-token'

test('basicAuth encodes an empty user and the PAT as Basic credentials', () => {
  assert.equal(basicAuth('abc'), 'Basic OmFiYw==')
})

test('patKey namespaces the secret by org', () => {
  assert.equal(patKey('contoso'), 'pat:contoso')
})

test('patKey rejects an invalid org name', () => {
  for (const org of ['', 'Contoso', '../x', 'a:b', 'a/b', '-lead']) {
    assert.throws(() => patKey(org), /Invalid organisation name/)
  }
})

test('save then header round-trips through the secrets port', async () => {
  const provider = createPatProvider(memorySecrets().secrets)
  await provider.save('contoso', PAT)
  assert((await provider.header('contoso')) === basicAuth(PAT), 'header should be the Basic auth of the saved PAT')
})

test('save stores the PAT under pat:<org> and nowhere else', async () => {
  const { data, secrets } = memorySecrets()
  await createPatProvider(secrets).save('contoso', PAT)
  assert.deepEqual([...data.keys()], ['pat:contoso'])
  assert(data.get('pat:contoso') === PAT, 'the raw PAT should be what is stored')
})

test('header is null when no PAT is stored', async () => {
  assert((await createPatProvider(memorySecrets().secrets).header('contoso')) === null, 'header should be null when nothing is stored')
})

test('header does not leak a PAT saved for another org', async () => {
  const provider = createPatProvider(memorySecrets().secrets)
  await provider.save('contoso', PAT)
  assert((await provider.header('fabrikam')) === null, 'header should be null for an org with no saved PAT')
})

test('forget deletes pat:contoso', async () => {
  const { data, secrets } = memorySecrets()
  const provider = createPatProvider(secrets)
  await provider.save('contoso', PAT)
  await provider.forget('contoso')
  assert.equal(data.has('pat:contoso'), false)
  assert((await provider.header('contoso')) === null, 'header should be null after forget')
})

test('save trims surrounding whitespace before storing', async () => {
  const { data, secrets } = memorySecrets()
  await createPatProvider(secrets).save('contoso', `  ${PAT}\n`)
  assert(data.get('pat:contoso') === PAT, 'the stored PAT should be trimmed')
})

test('save refuses an empty or whitespace-only PAT without storing anything', async () => {
  const { data, secrets } = memorySecrets()
  const provider = createPatProvider(secrets)
  for (const pat of ['', '   ', '\t\n']) {
    await assert.rejects(provider.save('contoso', pat), (error) => error instanceof Error && error.message === 'Paste a personal access token.')
  }
  assert.equal(data.size, 0)
})

test('save, header and forget refuse an invalid org before touching secrets', async () => {
  const { data, secrets } = memorySecrets()
  const provider = createPatProvider(secrets)
  await assert.rejects(provider.save('../evil', PAT), /Invalid organisation name/)
  await assert.rejects(provider.header('../evil'), /Invalid organisation name/)
  await assert.rejects(provider.forget('../evil'), /Invalid organisation name/)
  assert.equal(data.size, 0)
})
