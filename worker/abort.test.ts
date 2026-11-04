import { assert, test } from 'orca/testing'
import { linkedAbort } from './abort'

test('a linked signal aborts with its parent, with the same reason', () => {
  const parent = new AbortController()
  const link = linkedAbort(parent.signal)
  parent.abort(new Error('gone'))
  assert.equal(link.signal.aborted, true)
  assert.equal((link.signal.reason as Error).message, 'gone')
})

test('a linked signal starts aborted when its parent already is', () => {
  const parent = new AbortController()
  parent.abort()
  assert.equal(linkedAbort(parent.signal).signal.aborted, true)
})

test('a released link no longer follows its parent', () => {
  const parent = new AbortController()
  const link = linkedAbort(parent.signal)
  link.release()
  parent.abort()
  assert.equal(link.signal.aborted, false)
})
