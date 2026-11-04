import { assert, test } from 'orca/testing'
import type { Identity } from '../../src/shared/types'
import { fakeAdo, fixture, json, ORG, type AdoCall } from '../boards/fake-ado'
import { FIND_PEOPLE_NEEDS_ACCESS, MALFORMED } from '../messages'
import { AdoError, createAdoHttp } from './http'
import { searchIdentities } from './identities'

const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
const DENNIS = 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e'
const TEAM = 'c3d4e5f6-5555-4c8d-8e9f-1a2b3c4d5e6f'

const isSubjectQuery = (call: AdoCall) => call.method === 'POST' && call.path === `/${ORG}/_apis/graph/subjectquery`
const isIdentities = (call: AdoCall) => call.method === 'GET' && call.path === `/${ORG}/_apis/identities`

function setup() {
  const ado = fakeAdo()
  ado.on(isSubjectQuery, call => {
    const wantsGroups = (call.body.subjectKind as string[]).includes('Group')
    const subjects = fixture<{ value: { subjectKind: string }[] }>('subject-query').value
    return json(200, { value: subjects.filter(subject => wantsGroups || subject.subjectKind === 'user') })
  })
  ado.on(isIdentities, call => {
    const wanted = new Set((call.query.get('subjectDescriptors') ?? '').split(','))
    const identities = fixture<{ value: { subjectDescriptor: string }[] }>('identities').value
    return json(200, { value: identities.filter(identity => wanted.has(identity.subjectDescriptor)) })
  })
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

const grace: Identity = { id: GRACE, displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', kind: 'user' }
const dennis: Identity = { id: DENNIS, displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example', kind: 'user' }
const team: Identity = { id: TEAM, displayName: 'Fabrikam Web Team', uniqueName: '[Fabrikam Web]\\Fabrikam Web Team', kind: 'group' }

test('searchIdentities queries subjects, resolves ids and skips short queries', async () => {
  const { ado, http } = setup()
  assert.deepEqual(await searchIdentities(http, ORG, 'a', true), [])
  assert.deepEqual(await searchIdentities(http, ORG, '   a  ', true), [])
  assert.deepEqual(await searchIdentities(http, ORG, '', true), [])
  assert.equal(ado.calls.length, 0)

  assert.deepEqual(await searchIdentities(http, ORG, ' ho ', false), [grace, dennis])
  const [subjects, identities] = ado.calls
  assert.equal(subjects.host, 'vssps.dev.azure.com')
  assert.equal(subjects.query.get('api-version'), '7.1-preview.1')
  assert.deepEqual(subjects.body, { query: 'ho', subjectKind: ['User'] })
  assert.equal(identities.host, 'vssps.dev.azure.com')
  assert.equal(identities.query.get('subjectDescriptors'), 'aad.Z3JhY2UtaG9wcGVy,aad.ZGVubmlzLXJpdGNoaWU,aad.YmFyYmFyYS1saXNrb3Y')
  assert.equal(identities.query.get('queryMembership'), 'None')
  assert.equal(ado.calls.length, 2)
})

test('searchIdentities adds groups when asked and drops subjects without an id', async () => {
  const { ado, http } = setup()
  assert.deepEqual(await searchIdentities(http, ORG, 'fab', true), [grace, dennis, team])
  assert.deepEqual(ado.calls[0].body, { query: 'fab', subjectKind: ['User', 'Group'] })
})

test('searchIdentities keeps the first 20 subjects', async () => {
  const { ado, http } = setup()
  const subjects = Array.from({ length: 25 }, (_, index) => ({
    subjectKind: 'user',
    displayName: `Person ${index}`,
    mailAddress: `person${index}@contoso.example`,
    descriptor: `aad.person${index}`
  }))
  ado.on(isSubjectQuery, () => json(200, { value: subjects }))
  ado.on(isIdentities, call => {
    const descriptors = (call.query.get('subjectDescriptors') ?? '').split(',')
    return json(200, { value: descriptors.map(descriptor => ({ id: `id-${descriptor}`, subjectDescriptor: descriptor })) })
  })
  const found = await searchIdentities(http, ORG, 'person', false)
  assert.equal(found.length, 20)
  assert.equal(found[0].id, 'id-aad.person0')
  assert.equal(found[19].id, 'id-aad.person19')
  assert.equal(ado.calls[1].query.get('subjectDescriptors')?.split(',').length, 20)
})

test('searchIdentities makes no identities call when nothing matched', async () => {
  const { ado, http } = setup()
  ado.on(isSubjectQuery, () => json(200, { count: 0, value: [] }))
  assert.deepEqual(await searchIdentities(http, ORG, 'zzz', true), [])
  assert.equal(ado.count(isIdentities), 0)
})

test('a forbidden search gives the access message', async () => {
  for (const denied of [isSubjectQuery, isIdentities]) {
    const { ado, http } = setup()
    ado.on(denied, () => json(403, { message: 'VS403283: not allowed.' }))
    const error = await failure(searchIdentities(http, ORG, 'grace', true))
    assert.deepEqual([error.code, error.status, error.message], ['forbidden', 403, FIND_PEOPLE_NEEDS_ACCESS])
  }
})

test('other failures keep their own message', async () => {
  const { ado, http } = setup()
  ado.on(isSubjectQuery, () => json(500, {}))
  const error = await failure(searchIdentities(http, ORG, 'grace', true))
  assert.equal(error.code, 'server')
  assert.notEqual(error.message, FIND_PEOPLE_NEEDS_ACCESS)
})

test('malformed answers become the fixed identity error', async () => {
  const { ado, http } = setup()
  const expectMalformed = async () => {
    const error = await failure(searchIdentities(http, ORG, 'grace', false))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.identity])
  }

  for (const body of [{ value: 'not a list' }, undefined]) {
    ado.on(isSubjectQuery, () => json(200, body))
    await expectMalformed()
  }

  ado.on(isSubjectQuery, () => json(200, { value: [{ subjectKind: 'user', descriptor: 'aad.nameless' }] }))
  ado.on(isIdentities, () => json(200, { value: [{ id: 'id-1', subjectDescriptor: 'aad.nameless' }] }))
  await expectMalformed()

  ado.on(isSubjectQuery, () => json(200, { value: fixture<{ value: unknown[] }>('subject-query').value.slice(0, 1) }))
  ado.on(isIdentities, () => json(200, { value: 'not a list' }))
  await expectMalformed()
})
