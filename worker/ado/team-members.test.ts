import { assert, test } from 'orca/testing'
import { fakeAdo, json, ORG, PROJECT, TEAM, type AdoCall } from '../boards/fake-ado'
import { AdoError, createAdoHttp } from './http'
import { loadTeamMembers } from './team-members'

const MALFORMED_IDENTITY = 'Azure DevOps returned an unexpected identity response.'
const isMembers = (call: AdoCall) => call.method === 'GET' && call.path === `/${ORG}/_apis/projects/${PROJECT}/teams/${TEAM}/members`

function setup() {
  const ado = fakeAdo()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

test('team members are read from value[].identity, leave out groups, appear once and are sorted by name', async () => {
  const { ado, http } = setup()
  assert.deepEqual(await loadTeamMembers(http, ORG, PROJECT, TEAM), [
    { displayName: 'Alex Contoso', uniqueName: 'alex@contoso.example' },
    { displayName: 'Barbara Liskov', uniqueName: 'barbara@contoso.example' },
    { displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example' },
    { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }
  ])
  assert.equal(ado.calls.length, 1)
  const [call] = ado.calls
  assert.ok(isMembers(call), call.path)
  assert.equal(call.host, 'dev.azure.com')
  assert.equal(call.query.get('$top'), '200')
  assert.equal(call.query.get('api-version'), '7.1')
})

test('team members without both names are left out, and an answer without a list is refused', async () => {
  const { ado, http } = setup()
  ado.on(isMembers, () =>
    json(200, {
      value: [
        { identity: { displayName: 'Dennis Ritchie', uniqueName: '' } },
        { identity: { uniqueName: 'barbara@contoso.example' } },
        { isTeamAdmin: false },
        { identity: { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', isContainer: false } }
      ],
      count: 4
    })
  )
  assert.deepEqual(await loadTeamMembers(http, ORG, PROJECT, TEAM), [{ displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }])

  ado.on(isMembers, () => json(200, { count: 0 }))
  const error = await loadTeamMembers(http, ORG, PROJECT, TEAM).then(
    () => assert.fail('expected a refusal'),
    (failure: unknown) => failure
  )
  assert(error instanceof AdoError)
  assert.equal(error.message, MALFORMED_IDENTITY)
})
