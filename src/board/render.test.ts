import { assert, test } from 'orca/testing'
import { createToolbar, focusSelectorOf } from './render'

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

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  className = ''
  textContent = ''
  type = ''
  value = ''
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  addEventListener(): void {}
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }
}

function withFakeDocument(run: () => void): void {
  const saved = { document: globalThis.document, Option: globalThis.Option }
  globalThis.document = { createElement: () => new FakeElement() } as unknown as Document
  globalThis.Option = FakeElement as unknown as typeof Option
  try {
    run()
  } finally {
    Object.assign(globalThis, saved)
  }
}

test("the toolbar presses neither filter until the board's filter is known", () => {
  withFakeDocument(() => {
    const toolbar = createToolbar({ everyone: () => {}, parent: () => {} })
    const buttons = (toolbar.node as unknown as FakeElement).children.flatMap(node => node.children)
    const pressed = () => Object.fromEntries(buttons.map(node => [node.textContent, node.attributes.get('aria-pressed')]))
    const update = (everyone: boolean | null) => toolbar.update({ title: 'Stories', loading: true, everyone, parents: [], parent: null })

    update(null)
    assert.deepEqual(pressed(), { Me: 'false', Everyone: 'false' })
    update(false)
    assert.deepEqual(pressed(), { Me: 'true', Everyone: 'false' })
    update(true)
    assert.deepEqual(pressed(), { Me: 'false', Everyone: 'true' })
  })
})
