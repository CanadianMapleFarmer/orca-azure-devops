import { assert, test } from 'orca/testing'
import { checkChip, failedCheck, openCheck } from './checks'

test('failures come first, then running and pending, then passed', () => {
  assert.deepEqual(checkChip({ build: 'failed', policies: 'pending' }), { tone: 'danger', text: '✗ build' })
  assert.deepEqual(checkChip({ build: 'running', policies: 'rejected' }), { tone: 'danger', text: '✗ policies' })
  assert.deepEqual(checkChip({ build: 'running', policies: 'pending' }), { tone: 'warning', text: 'building' })
  assert.deepEqual(checkChip({ build: 'none', policies: 'pending' }), { tone: 'neutral', text: '· policies' })
  assert.deepEqual(checkChip({ build: 'none', policies: 'approved' }), { tone: 'success', text: '✓ build' })
  assert.deepEqual(checkChip({ build: 'succeeded', policies: 'none' }), { tone: 'success', text: '✓ build' })
  assert.equal(failedCheck({ build: 'running', policies: 'approved' }), null)
  assert.equal(openCheck({ build: 'failed', policies: 'rejected' }), null)
})

test('no checks show no chip', () => {
  assert.equal(checkChip(null), null)
  assert.equal(checkChip({ build: 'none', policies: 'none' }), null)
})
