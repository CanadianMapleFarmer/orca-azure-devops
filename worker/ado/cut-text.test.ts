import { assert, test } from 'orca/testing'
import { cutText } from './cut-text'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('cutText leaves text that fits and cuts longer text to the limit with an ellipsis', () => {
  assert.equal(cutText('abc', 3), 'abc')
  assert.equal(cutText('', 3), '')
  assert.equal(cutText('abcd', 3), 'ab…')
  assert.equal(cutText('x'.repeat(5000), 2000).length, 2000)
  assert(cutText('x'.repeat(5000), 2000).endsWith('x…'))
})

test('cutText never leaves half of a surrogate pair before the ellipsis', () => {
  const text = `${'a'.repeat(9)}😀tail`
  assert.equal(cutText(text, 11), `${'a'.repeat(9)}…`)
  assert.equal(cutText(text, 12), `${'a'.repeat(9)}😀…`)
  for (let max = 2; max < text.length; max += 1) {
    const cut = cutText(text, max)
    assert(cut.length <= max, `${max}: ${cut.length}`)
    assert(!LONE_SURROGATE.test(cut), `${max}: ${JSON.stringify(cut)}`)
  }
})
