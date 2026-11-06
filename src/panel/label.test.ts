import { assert, test } from 'orca/testing'
import { cutLabel, MAX_LABEL_BYTES, utf8Length } from './label'

const bytes = (text: string) => new TextEncoder().encode(text).length

test('utf8Length counts the UTF-8 bytes of a text', () => {
  for (const text of ['', 'line 12', 'é', '界', '😀', 'a界😀é\n']) assert.equal(utf8Length(text), bytes(text), JSON.stringify(text))
})

test('cutLabel leaves a label that fits and cuts one that does not at a whole character', () => {
  assert.equal(cutLabel(''), '')
  assert.equal(cutLabel('Harden the login redirect'), 'Harden the login redirect')
  const exact = 'a'.repeat(MAX_LABEL_BYTES)
  assert.equal(cutLabel(exact), exact)

  const ascii = cutLabel('a'.repeat(MAX_LABEL_BYTES + 1))
  assert.equal(ascii, `${'a'.repeat(MAX_LABEL_BYTES - 3)}…`)
  assert.equal(bytes(ascii), MAX_LABEL_BYTES)

  const wide = cutLabel('界'.repeat(400))
  assert.equal(wide, `${'界'.repeat(340)}…`)
  assert.ok(bytes(wide) <= MAX_LABEL_BYTES)

  const emoji = cutLabel('😀'.repeat(300))
  assert.ok(bytes(emoji) <= MAX_LABEL_BYTES)
  assert.equal(emoji.slice(0, -1), '😀'.repeat(255))
  assert.equal(emoji.endsWith('…'), true)
})
