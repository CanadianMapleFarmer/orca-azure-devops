import { assert, test } from 'orca/testing'
import { focusSelectorOf } from './render'

function focusedIn(found: Record<string, Record<string, string>>) {
  return { closest: (selector: string) => (selector in found ? { dataset: found[selector] } : null) }
}

test('focusSelectorOf finds the focused card again after a repaint', () => {
  assert.equal(focusSelectorOf(focusedIn({ '.card': { id: '102' } })), '.card[data-id="102"]')
})

test('focusSelectorOf finds the focused lane header again after a repaint, its id escaped', () => {
  assert.equal(focusSelectorOf(focusedIn({ '.lane-head': { lane: '48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7' } })), '.lane-head[data-lane="48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7"]')
  assert.equal(focusSelectorOf(focusedIn({ '.lane-head': { lane: 'a"b c' } })), '.lane-head[data-lane="a\\22 b\\20 c"]')
})

test('focusSelectorOf names nothing for other focused elements', () => {
  assert.equal(focusSelectorOf(focusedIn({})), null)
})
