import { assert, test } from 'orca/testing'
import { AdoError } from './http'
import { assignPatch, identityValue } from './assign'

const BAD_ASSIGNEE = 'Choose someone from the list.'
const grace = { displayName: 'Grace Hopper', uniqueName: 'grace@fabrikam.com' }

function refusal(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected a refusal')
}

test('identityValue uses the distinct display name form, and an empty value to unassign', () => {
  assert.equal(identityValue(grace), 'Grace Hopper<grace@fabrikam.com>')
  assert.equal(identityValue({ displayName: '  Grace Hopper ', uniqueName: ' grace@fabrikam.com  ' }), 'Grace Hopper<grace@fabrikam.com>')
  assert.equal(identityValue(null), '')
})

test('identityValue refuses a name with angle brackets', () => {
  for (const to of [
    { displayName: 'Grace <Hopper>', uniqueName: 'grace@fabrikam.com' },
    { displayName: 'Grace Hopper', uniqueName: 'grace@fabrikam.com>' },
    { displayName: 'Grace Hopper', uniqueName: '<grace@fabrikam.com' },
    { displayName: 'Grace\nHopper', uniqueName: 'grace@fabrikam.com' },
    { displayName: 'Grace Hopper', uniqueName: 'grace@fabrikam.com\u0000' },
    { displayName: 'Grace Hopper', uniqueName: '   ' }
  ]) {
    const error = refusal(() => identityValue(to))
    assert.deepEqual([error.code, error.message], ['bad_request', BAD_ASSIGNEE], JSON.stringify(to))
  }
})

test('assignPatch tests the rev first', () => {
  assert.deepEqual(assignPatch(9, grace), [
    { op: 'test', path: '/rev', value: 9 },
    { op: 'add', path: '/fields/System.AssignedTo', value: 'Grace Hopper<grace@fabrikam.com>' }
  ])
  assert.deepEqual(assignPatch(12, null)[1], { op: 'add', path: '/fields/System.AssignedTo', value: '' })
})
