import { assert, mountWorker, test } from 'orca/testing'
import * as worker from './main'

test('ping answers with the plugin version', async () => {
  const w = await mountWorker(worker)
  const out = await w.request('plugin.ping', {})
  assert.match(out.version, /^\d+\.\d+\.\d+$/)
  assert.equal(w.refusals.length, 0)
})
