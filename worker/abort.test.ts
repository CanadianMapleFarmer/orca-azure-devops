import { assert, test } from 'orca/testing'
import { linkedAbort, untilAborted } from './abort'
import { drain } from './test-support'

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

test('untilAborted settles with the work when it finishes first', async () => {
  const parent = new AbortController()
  assert.equal(await untilAborted(Promise.resolve(7), parent.signal), 7)
  await assert.rejects(untilAborted(Promise.reject(new Error('boom')), parent.signal), /boom/)
})

test('untilAborted rejects with the abort reason when the signal fires first, and at once when it already has', async () => {
  const parent = new AbortController()
  const pending = untilAborted(new Promise<number>(() => {}), parent.signal)
  parent.abort(new Error('gone'))
  await assert.rejects(pending, /gone/)
  await assert.rejects(untilAborted(Promise.resolve(1), parent.signal), /gone/)
})

test('untilAborted stops listening once the work is over', async () => {
  const signal = new AbortController().signal
  let removed = 0
  const remove = signal.removeEventListener.bind(signal)
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    removed += 1
    return remove(...args)
  }) as typeof remove
  await untilAborted(Promise.resolve(), signal)
  await drain(1)
  assert.equal(removed, 1)
})
