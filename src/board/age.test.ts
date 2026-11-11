import { assert, test } from 'orca/testing'
import { ageText } from './age'

const NOW = Date.parse('2026-11-11T09:00:00Z')
const SECOND = 1000
const HOUR = 3600 * SECOND

test('ageText uses the largest whole unit', () => {
  assert.equal(ageText(NOW, NOW, 'en'), 'now')
  assert.equal(ageText(NOW - 90 * SECOND, NOW, 'en'), '1 minute ago')
  assert.equal(ageText(NOW - 2 * HOUR, NOW, 'en'), '2 hours ago')
  assert.equal(ageText(NOW - 26 * HOUR, NOW, 'en'), 'yesterday')
})
