import { assert, test } from 'orca/testing'
import type { DetailTask } from '../shared/work'
import { NO_CHILDREN, SAVING } from './copy'
import { find, findAll, fire, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { detailTask } from './fixtures'
import { taskList, taskSummary, tickable, toggleTarget } from './task-list'

const ITEM_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4211'

const fake = (node: HTMLElement) => node as unknown as FakeNode
const classes = (node: FakeNode) => node.className.split(' ')
const byLabel = (root: FakeNode, label: string) => find(root, node => node.attributes.get('aria-label') === label)
const checkboxes = (root: FakeNode) => findAll(root, node => node.tagName === 'input' && node.type === 'checkbox')

function listed(tasks: DetailTask[], overrides: Partial<Parameters<typeof taskList>[0]> = {}) {
  const calls: string[] = []
  const node = taskList(
    { tasks, more: 0, tasksRead: true, taskTypes: ['Task'], taskType: 'Task', busy: new Set(), itemUrl: ITEM_URL, ...overrides },
    { toggle: task => calls.push(`toggle ${task.id}`), open: url => calls.push(`open ${url}`) }
  )
  const root = fake(node)
  return { root, calls, rows: findAll(root, entry => entry.tagName === 'li') }
}

test('a row is tickable only for a task type with a state to move to, on a requirement board', () => {
  const types = ['Task', 'Bug']
  assert.equal(tickable(detailTask(5001), types, 'Task'), true)
  assert.equal(tickable(detailTask(5002, { type: 'Bug' }), types, 'Task'), true, 'a bug handled as a task')
  assert.equal(tickable(detailTask(5003, { done: true, state: 'Done' }), types, 'Task'), true, 'a done task reopens')
  assert.equal(tickable(detailTask(5004, { type: 'User Story' }), types, 'Task'), false, 'not a task type')
  assert.equal(tickable(detailTask(5005, { doneState: null }), types, 'Task'), false, 'no done state')
  assert.equal(tickable(detailTask(5006, { done: true, state: 'Done', openState: null }), types, 'Task'), false, 'no open state')
  assert.equal(tickable(detailTask(5001), [], null), false, 'a Features board')
  assert.equal(tickable(detailTask(5001), types, null), false, "an item that isn't one of the board's types")
})

test('taskSummary counts done tasks out of all tasks, the unread ones included', () => {
  const tasks = [detailTask(5001), detailTask(5002), detailTask(5003, { done: true, state: 'Done' })]
  assert.deepEqual(taskSummary(tasks, 1), { done: 1, total: 4, percent: 25, text: '1 of 4 done' })
  assert.deepEqual(taskSummary(tasks.slice(1), 0), { done: 1, total: 2, percent: 50, text: '1 of 2 done' })
  assert.equal(taskSummary([detailTask(5001, { done: true }), detailTask(5002, { done: true }), detailTask(5003)], 0).percent, 67)
  assert.deepEqual(taskSummary([], 0), { done: 0, total: 0, percent: 0, text: '0 of 0 done' })
})

test('toggleTarget moves an open task to its done state and a done one to its open state, or nowhere when the type has none', () => {
  assert.equal(toggleTarget(detailTask(5001, { state: 'To Do' })), 'Done')
  assert.equal(toggleTarget(detailTask(5002, { done: true, state: 'Done' })), 'In Progress')
  assert.equal(toggleTarget(detailTask(5003, { doneState: null })), null)
  assert.equal(toggleTarget(detailTask(5004, { done: true, state: 'Done', openState: null })), null)
})

test('a tickable row has a labelled checkbox, the initials, the state and a link', () => {
  withFakeDom(() => {
    const { rows, calls } = listed([
      detailTask(5001, { title: 'Review the filter copy', state: 'In Progress', assignedTo: 'Grace Hopper' }),
      detailTask(5003, { title: 'Write the filter tests', state: 'Done', done: true }),
    ])
    assert.equal(rows.length, 2)
    const [open, done] = rows
    assert.equal(textOf(open), 'Review the filter copyGHIn Progress')
    const box = checkboxes(open)[0]
    assert.ok(box)
    assert.equal(box.attributes.get('aria-label'), 'Done: Review the filter copy')
    assert.equal(box.checked, false)
    assert.equal(box.disabled, false)
    assert.equal(find(open, node => classes(node).includes('who'))?.title, 'Grace Hopper')
    assert.equal(find(open, node => classes(node).includes('state'))?.text, 'In Progress')
    assert.equal(open.attributes.has('aria-busy'), false)

    assert.equal(classes(done).includes('done'), true)
    assert.equal(checkboxes(done)[0]?.checked, true)
    assert.equal(find(done, node => classes(node).includes('who'))?.title, 'Unassigned')

    fire(box, 'change')
    const link = byLabel(open, 'Open 5001 in Azure DevOps')
    assert.ok(link)
    fire(link, 'click')
    assert.deepEqual(calls, ['toggle 5001', 'open https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/5001'])
  })
})

test('a busy row is marked and its checkbox is off', () => {
  withFakeDom(() => {
    const { rows } = listed([detailTask(5001, { title: 'Wire the filters into the URL' }), detailTask(5002, { title: 'Review the filter copy' })], { busy: new Set(['task:5001', 'comment']) })
    const [busy, idle] = rows
    assert.equal(busy.attributes.get('aria-busy'), 'true')
    assert.equal(classes(busy).includes('busy'), true)
    const box = checkboxes(busy)[0]
    assert.equal(box?.disabled, true)
    assert.equal(box?.checked, true, 'it shows where it is going')
    assert.equal(find(busy, node => classes(node).includes('state'))?.text, SAVING)

    assert.equal(idle.attributes.has('aria-busy'), false)
    assert.equal(checkboxes(idle)[0]?.disabled, false)
    assert.equal(find(idle, node => classes(node).includes('state'))?.text, 'To Do')
  })
})

test("children that aren't tickable show a state badge and a link", () => {
  withFakeDom(() => {
    const feature = listed([detailTask(4211, { type: 'User Story', title: 'Add vehicle search filters', state: 'Active' })], { taskTypes: [], taskType: null, more: 2 })
    assert.equal(checkboxes(feature.root).length, 0)
    assert.equal(find(feature.rows[0], node => classes(node).includes('badge'))?.text, 'Active')
    const link = byLabel(feature.rows[0], 'Open 4211 in Azure DevOps')
    assert.ok(link)
    fire(link, 'keydown', { key: 'Enter' })
    const more = find(feature.root, node => textOf(node) === '2 more in Azure DevOps' && node.attributes.get('role') === 'link')
    assert.ok(more)
    fire(more, 'click')
    assert.deepEqual(feature.calls, ['open https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4211', `open ${ITEM_URL}`])

    const stuck = listed([detailTask(5005, { title: 'Ask legal about the copy', state: 'Blocked', doneState: null })])
    assert.equal(checkboxes(stuck.root).length, 0)
    assert.equal(find(stuck.rows[0], node => classes(node).includes('badge'))?.text, 'Blocked')

    assert.equal(textOf(listed([], { taskTypes: [], taskType: null }).root), NO_CHILDREN)
  })
})

test('a task of another type shows its type', () => {
  withFakeDom(() => {
    const { rows } = listed([detailTask(5001, { title: 'Review the filter copy' }), detailTask(5004, { type: 'Bug', title: 'Fix the filter reset' })], { taskTypes: ['Task', 'Bug'] })
    assert.equal(find(rows[0], node => classes(node).includes('type')), undefined)
    const title = find(rows[1], node => classes(node).includes('task-title'))
    assert.ok(title)
    assert.equal(textOf(title), 'BugFix the filter reset')
    assert.equal(find(title, node => classes(node).includes('type'))?.text, 'Bug')
    assert.equal(checkboxes(rows[1]).length, 1, 'a bug handled as a task is ticked like one')
  })
})
