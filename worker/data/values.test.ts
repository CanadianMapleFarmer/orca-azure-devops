import { assert, test } from 'orca/testing'
import { isRecord, sameApartFromTime } from './values'

test('isRecord accepts plain objects and rejects null, arrays and primitives', () => {
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord({}), true)
  for (const value of [null, undefined, [], [1], 'text', 7, true]) assert.equal(isRecord(value), false, JSON.stringify(value))
})

test('sameApartFromTime ignores only the top-level updatedAt', () => {
  const snapshot = { org: 'contoso', items: [{ id: 1, updatedAt: 5 }], updatedAt: 100 }
  assert.equal(sameApartFromTime(snapshot, { ...snapshot, updatedAt: 200 }), true)
  assert.equal(sameApartFromTime(snapshot, { ...snapshot, org: 'fabrikam' }), false)
  assert.equal(sameApartFromTime(snapshot, { ...snapshot, items: [{ id: 1, updatedAt: 6 }] }), false, 'a nested updatedAt is content')
})
