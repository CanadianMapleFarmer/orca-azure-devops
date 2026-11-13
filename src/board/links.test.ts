import { assert, test } from 'orca/testing'
import { fire, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { linkTo } from './links'

const URL_42 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/42'

function linked(url: string, label: string | Node[], options?: { className?: string; ariaLabel?: string }) {
  const opened: string[] = []
  const node = linkTo(url, label, target => opened.push(target), options) as unknown as FakeNode
  return { node, opened }
}

test('a link has no href and opens synchronously on click or Enter', () => {
  withFakeDom(() => {
    const { node, opened } = linked(URL_42, 'Open in Azure DevOps')
    assert.equal(node.tagName, 'a')
    assert.equal(node.attributes.has('href'), false)
    assert.equal(node.attributes.get('role'), 'link')
    assert.equal(node.attributes.get('tabindex'), '0')
    assert.equal(node.attributes.get('title'), URL_42)
    assert.equal(textOf(node), 'Open in Azure DevOps')

    const click = fire(node, 'click')
    assert.deepEqual(opened, [URL_42])
    assert.equal(click.defaultPrevented, true)

    const enter = fire(node, 'keydown', { key: 'Enter' })
    assert.deepEqual(opened, [URL_42, URL_42])
    assert.equal(enter.defaultPrevented, true)

    const other = fire(node, 'keydown', { key: 'a' })
    assert.equal(opened.length, 2)
    assert.equal(other.defaultPrevented, false)
  })
})

test('a middle click does nothing', () => {
  withFakeDom(() => {
    const { node, opened } = linked(URL_42, 'PR 812')
    const middle = fire(node, 'auxclick', { button: 1 })
    assert.deepEqual(opened, [])
    assert.equal(middle.defaultPrevented, true)
  })
})

test('an unsafe URL renders as plain text', () => {
  withFakeDom(() => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/_workitems/edit/42']) {
      const { node, opened } = linked(url, 'click me', { className: 'title', ariaLabel: 'Open' })
      assert.equal(node.tagName, 'span', url)
      assert.equal(textOf(node), 'click me')
      assert.equal(node.className, 'title')
      assert.deepEqual([...node.attributes.keys()], [])
      fire(node, 'click')
      fire(node, 'keydown', { key: 'Enter' })
      assert.deepEqual(opened, [])
    }
  })
})

test('a link takes nodes as its label, a class and an accessible name', () => {
  withFakeDom(() => {
    const label = [document.createTextNode('#'), document.createTextNode('42')]
    const { node } = linked(URL_42, label, { className: 'item-link', ariaLabel: 'Open work item 42' })
    assert.equal(textOf(node), '#42')
    assert.equal(node.className, 'item-link')
    assert.equal(node.attributes.get('aria-label'), 'Open work item 42')
  })
})
