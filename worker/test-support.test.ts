import { assert, test } from 'orca/testing'
import { withWorker } from './test-support'

function counted() {
  const seen = { deactivated: 0 }
  return { seen, module: { default: () => {}, deactivate: () => void (seen.deactivated += 1) } }
}

test('withWorker deactivates the worker after the run', async () => {
  const { seen, module } = counted()
  await withWorker(module, {}, async () => assert.equal(seen.deactivated, 0))
  assert.equal(seen.deactivated, 1)
})

test('withWorker deactivates the worker when the run throws, and rethrows', async () => {
  const { seen, module } = counted()
  await assert.rejects(
    withWorker(module, {}, async () => {
      throw new Error('the test failed')
    }),
    /the test failed/
  )
  assert.equal(seen.deactivated, 1)
})
