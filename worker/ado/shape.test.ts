import { assert, test } from 'orca/testing'
import { AdoError } from './http'
import { expectList, expectText, malformed, shaped } from './shape'

const MESSAGE = 'Azure DevOps returned something unexpected.'
const isTypeError = (error: unknown): boolean => error instanceof TypeError

function failure(run: () => unknown): AdoError {
  try {
    run()
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('expectText returns text and rejects everything else', () => {
  assert.equal(expectText('Active'), 'Active')
  assert.equal(expectText(''), '')
  for (const value of [undefined, null, 4, {}, ['a']]) assert.throws(() => expectText(value), isTypeError)
})

test('expectList returns lists and rejects everything else', () => {
  const list = [1, 2]
  assert.equal(expectList<number>(list), list)
  for (const value of [undefined, null, 'a', { length: 1 }]) assert.throws(() => expectList(value), isTypeError)
})

test('shaped passes a built value through and turns any failure into a server error with the message', () => {
  assert.equal(shaped(() => 7, MESSAGE), 7)
  const error = failure(() => shaped(() => expectText(undefined), MESSAGE))
  assert.deepEqual([error.code, error.status, error.message], ['server', 200, MESSAGE])
})

test('malformed throws the server error', () => {
  const error = failure(() => malformed(MESSAGE))
  assert.deepEqual([error.code, error.status, error.message], ['server', 200, MESSAGE])
})
