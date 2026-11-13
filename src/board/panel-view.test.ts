import { assert, test } from 'orca/testing'
import { DETAILS_FAILED, LOADING_DETAILS, NEWEST_COMMENTS, NO_ACCEPTANCE, NO_CHILDREN, NO_COMMENTS, NO_DESCRIPTION, NO_PRS, NO_TASKS, OFF_BOARD, REFRESHING, TASKS_UNREAD } from './copy'
import { busyWith, createDrafts, failed, loaded, opened, refreshing, type PanelState } from './details-state'
import { comment, details, detailPr, detailTask, item } from './fixtures'
import { find, findAll, fire, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { ageText } from './age'
import { fill, paintPanel, panelSkeleton, type PanelHandlers, type PanelSkeleton, type ViewContext } from './panel-view'

const NOW = Date.parse('2026-11-11T09:00:00Z')
const MINUTE = 60_000
const WIKI = 'https://dev.azure.com/contoso/Fabrikam%20Web/_wiki/wikis/Fabrikam-Web.wiki/12/Vehicle-search'

const fake = (node: HTMLElement) => node as unknown as FakeNode
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const classes = (node: FakeNode) => node.className.split(' ')
const byLabel = (root: FakeNode, label: string) => find(root, node => node.attributes.get('aria-label') === label)
const byText = (root: FakeNode, tag: string, text: string) => find(root, node => node.tagName === tag && textOf(node) === text)

function shown(node: FakeNode, root: FakeNode): boolean {
  for (let at: FakeNode | null = node; at && at !== root; at = at.parent) if (at.hidden) return false
  return true
}

function ready(value = details(), extra: Partial<PanelState> = {}): PanelState {
  return { ...loaded(refreshing(opened(value.item.id, 1), 2), 2, value), ...extra }
}

function context(overrides: Partial<ViewContext> = {}): ViewContext {
  return { card: null, now: NOW, locale: 'en', closed: new Set(), drafts: createDrafts(), start: { lookup: { status: 'loading' }, busy: false, notice: null, shortened: false, setupSkipped: false, picker: null, waiting: null }, ...overrides }
}

function painted(state: PanelState, view: ViewContext = context()) {
  const calls: string[] = []
  const handlers: PanelHandlers = {
    close: () => calls.push('close'),
    refresh: () => calls.push('refresh'),
    retry: () => calls.push('retry'),
    open: url => calls.push(`open ${url}`),
    toggle: section => calls.push(`toggle ${section}`),
    move: value => calls.push(`move ${value}`),
    choose: () => calls.push('choose'),
    assign: person => calls.push(`assign ${person?.uniqueName ?? 'nobody'}`),
    assignees: () => Promise.resolve({ me: null, members: [] }),
    people: () => Promise.resolve([]),
    pickerClosed: () => calls.push('pickerClosed'),
    draft: (field, text) => {
      calls.push(`draft ${field}`)
      view.drafts.set(state.id, field, text)
    },
    send: () => calls.push('send'),
    toggleTask: task => calls.push(`toggleTask ${task.id}`),
    addTask: () => calls.push('addTask'),
    startWork: () => calls.push('startWork'),
    startAgent: () => calls.push('startAgent'),
    showWorkspace: workspace => calls.push(`showWorkspace ${workspace.id}`),
    changeRepo: () => calls.push('changeRepo'),
    chooseRepo: value => calls.push(`chooseRepo ${value}`),
    chooseProject: id => calls.push(`chooseProject ${id}`),
    chooseCloneRepo: id => calls.push(`chooseCloneRepo ${id}`),
  }
  const skeleton = panelSkeleton(handlers)
  paintPanel(skeleton, state, view, handlers)
  const repaint = (next: PanelState, nextView: ViewContext = view) => paintPanel(skeleton, next, nextView, handlers)
  return { skeleton, root: fake(skeleton.node), calls, repaint, view }
}

const optionTexts = (select: FakeNode) => select.children.filter(node => node.tagName === 'option').map(textOf)

function section(skeleton: PanelSkeleton, name: keyof PanelSkeleton['sections']): FakeNode {
  return fake(skeleton.sections[name])
}

test('the panel is a labelled landmark, not a modal dialog', () => {
  withFakeDom(() => {
    const { skeleton, root } = painted(ready())
    assert.equal(root.tagName, 'aside')
    assert.equal(root.id, 'item-panel')
    assert.equal(root.attributes.get('aria-labelledby'), 'panel-title')
    assert.equal(root.hidden, true, 'hidden until opened')
    assert.equal(findAll(root, node => node.attributes.get('role') === 'dialog' || node.attributes.has('aria-modal')).length, 0)
    assert.equal(root.attributes.has('role'), false)

    const title = fake(skeleton.title)
    assert.equal(title.tagName, 'h2')
    assert.equal(title.id, 'panel-title')
    assert.equal(title.attributes.get('tabindex'), '-1')
    assert.equal(textOf(title), 'Add vehicle search filters')

    for (const label of ['Refresh', 'Open in Azure DevOps', 'Close']) assert.ok(byLabel(fake(skeleton.sections.head), label), label)
    const parts = findAll(root, node => node.tagName === 'section')
    assert.equal(parts.length, 5)
    for (const part of parts) {
      const head = find(part, node => classes(node).includes('section-head'))
      assert.ok(head)
      assert.equal(part.attributes.get('aria-labelledby'), head.id)
      assert.equal(head.attributes.get('aria-expanded'), 'true')
    }
  })
})

test('the skeleton is built once and repaints replace only the read-only parts', () => {
  withFakeDom(() => {
    const { skeleton, repaint } = painted(ready())
    const nodes = [skeleton.node, skeleton.title, ...Object.values(skeleton.sections), ...Object.values(skeleton.slots).flatMap(group => Object.values(group))].map(fake)
    const parents = nodes.map(node => node.parent)

    repaint(ready(details({ item: item(4211, { rev: 4, title: 'Add vehicle search and sort' }), descriptionMd: 'Sort by price too.' })))
    repaint(ready(details({ item: item(4211, { rev: 5, title: 'Add vehicle search and sort' }), descriptionMd: 'Sort by price and year.' })))

    assert.deepEqual([skeleton.node, skeleton.title, ...Object.values(skeleton.sections), ...Object.values(skeleton.slots).flatMap(group => Object.values(group))].map(fake), nodes)
    assert.deepEqual(nodes.map(node => node.parent), parents)
    assert.ok(nodes.slice(1).every(node => node.parent !== null), 'every part is still attached')
    assert.equal(textOf(section(skeleton, 'description')).includes('Sort by price and year.'), true)
    assert.equal(textOf(fake(skeleton.title)), 'Add vehicle search and sort')
  })
})

test("loading shows the card's own title and a busy skeleton", () => {
  withFakeDom(() => {
    const card = item(4211, { type: 'User Story', title: 'Add vehicle search filters' })
    const { skeleton, root } = painted(refreshing(opened(4211, 1), 2), context({ card }))
    assert.equal(textOf(fake(skeleton.slots.meta.kicker)), 'User Story 4211')
    assert.equal(textOf(fake(skeleton.title)), 'Add vehicle search filters')
    assert.equal(textOf(fake(skeleton.slots.meta.read)), LOADING_DETAILS)

    const busy = find(root, node => node.attributes.get('aria-busy') === 'true')
    assert.ok(busy)
    assert.equal(shown(busy, root), true)
    const spoken = find(busy, node => classes(node).includes('visually-hidden'))
    assert.equal(spoken && textOf(spoken), LOADING_DETAILS)
    assert.equal(shown(section(skeleton, 'fields'), root), false)
    assert.equal(shown(section(skeleton, 'description'), root), false)
  })
})

test('a failed read says so, gives the reason and offers Try again', () => {
  withFakeDom(() => {
    const card = item(4211, { title: 'Add vehicle search filters' })
    const { skeleton, root, calls } = painted(failed(refreshing(opened(4211, 1), 2), 2, 'Azure DevOps did not respond in time.'), context({ card }))
    const alert = find(root, node => node.attributes.get('role') === 'alert')
    assert.ok(alert)
    assert.equal(shown(alert, root), true)
    assert.match(textOf(alert), /^Couldn't load this item\. Azure DevOps did not respond in time\./)
    assert.equal(textOf(alert).startsWith(DETAILS_FAILED), true)

    const retry = byText(alert, 'button', 'Try again')
    assert.ok(retry)
    fire(retry, 'click')
    assert.deepEqual(calls, ['retry'])

    assert.equal(shown(section(skeleton, 'fields'), root), false)
    const close = byLabel(root, 'Close')
    assert.ok(close && shown(close, root), 'Close is always there')
    assert.equal(find(root, node => node.attributes.get('aria-busy') === 'true'), undefined)
  })
})

test('empty sections say so', () => {
  withFakeDom(() => {
    const empty = details({ descriptionMd: '', acceptanceMd: '  \n', tasks: [], prs: [], comments: [] })
    const { skeleton, repaint } = painted(ready(empty))
    assert.equal(textOf(section(skeleton, 'description')).includes(NO_DESCRIPTION), true)
    assert.equal(textOf(section(skeleton, 'acceptance')).includes(NO_ACCEPTANCE), true)
    assert.equal(textOf(section(skeleton, 'children')).includes(NO_TASKS), true)
    assert.equal(textOf(section(skeleton, 'prs')).includes(NO_PRS), true)
    assert.equal(textOf(section(skeleton, 'comments')).includes(NO_COMMENTS), true)

    repaint(ready({ ...empty, taskType: null, taskTypes: [] }))
    assert.equal(textOf(section(skeleton, 'children')).includes(NO_CHILDREN), true)

    repaint(ready({ ...empty, tasksRead: false }))
    assert.equal(textOf(section(skeleton, 'children')).includes(TASKS_UNREAD), true)
    assert.equal(textOf(section(skeleton, 'children')).includes(NO_TASKS), false)

    const fifty = Array.from({ length: 50 }, (_, index) => comment(900 - index))
    repaint(ready({ ...empty, comments: fifty }))
    assert.equal(textOf(section(skeleton, 'comments')).includes(NEWEST_COMMENTS), true)
    repaint(ready({ ...empty, comments: fifty.slice(1) }))
    assert.equal(textOf(section(skeleton, 'comments')).includes(NEWEST_COMMENTS), false)
  })
})

test('a Features board item lists its children read-only under Children', () => {
  withFakeDom(() => {
    const feature = details({
      item: item(4100, { type: 'Feature', title: 'Vehicle search' }),
      taskType: null,
      taskTypes: [],
      tasks: [
        detailTask(4211, { type: 'User Story', title: 'Add vehicle search filters', state: 'Active', assignedTo: 'Grace Hopper' }),
        detailTask(4219, { type: 'Bug', title: 'Search results jump when filters load', state: 'New' }),
      ],
    })
    const { skeleton, calls } = painted(ready(feature))
    const children = section(skeleton, 'children')
    const head = find(children, node => classes(node).includes('section-head'))
    assert.ok(head)
    assert.match(textOf(head), /^Children/)

    const rows = findAll(children, node => node.tagName === 'li')
    assert.equal(rows.length, 2)
    assert.equal(findAll(children, node => node.tagName === 'input').length, 0, 'no checkboxes')
    assert.equal(findAll(children, node => node.tagName === 'form').length, 0, 'no add form')
    assert.equal(textOf(rows[0]), 'User StoryAdd vehicle search filtersGHActive')
    const who = find(rows[0], node => classes(node).includes('who'))
    assert.equal(who?.title, 'Grace Hopper')
    assert.equal(find(rows[0], node => classes(node).includes('badge'))?.text, 'Active')
    assert.equal(textOf(rows[1]), 'BugSearch results jump when filters load–New')

    const open = byLabel(rows[1], 'Open 4219 in Azure DevOps')
    assert.ok(open)
    fire(open, 'click')
    assert.deepEqual(calls, ['open https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4219'])

    const story = details({ tasks: [detailTask(5001, { title: 'Write the filter tests' }), detailTask(5004, { type: 'Bug', title: 'Fix the filter reset' })] })
    const tasks = painted(ready(story))
    const taskRows = findAll(section(tasks.skeleton, 'children'), node => node.tagName === 'li')
    assert.match(textOf(find(section(tasks.skeleton, 'children'), node => classes(node).includes('section-head'))!), /^Tasks/)
    assert.equal(find(taskRows[0], node => classes(node).includes('type')), undefined, "the team's task type isn't repeated")
    assert.equal(find(taskRows[1], node => classes(node).includes('type'))?.text, 'Bug')
  })
})

test('each pull request row shows one chip, as the PRs tab would', () => {
  withFakeDom(() => {
    const prs = [
      detailPr(812, { title: 'Add vehicle search filters', build: 'running', policies: 'pending' }),
      detailPr(790, { state: 'merged', target: 'develop', build: 'failed' }),
      detailPr(780, { state: 'abandoned' }),
      detailPr(770, { build: 'succeeded', policies: 'rejected' }),
      detailPr(760, { policies: 'pending' }),
      detailPr(750, { build: 'succeeded' }),
      detailPr(745, {}),
      detailPr(740, { title: null, target: null, state: null, build: null, policies: null }),
    ]
    const { skeleton, calls } = painted(ready(details({ prs })))
    const rows = findAll(section(skeleton, 'prs'), node => node.tagName === 'li')
    const chips = rows.map(row => findAll(row, node => classes(node)[0] === 'chip').map(chip => `${classes(chip)[1]} ${textOf(chip)}`))
    assert.deepEqual(chips, [['warning building'], ['success merged'], ['neutral abandoned'], ['danger ✗ policies'], ['neutral · policies'], ['success ✓ build'], [], []])

    assert.equal(textOf(rows[0]), '!812Add vehicle search filtersinto mainbuilding')
    const link = find(rows[0], node => node.attributes.get('role') === 'link')
    assert.ok(link)
    assert.equal(link.attributes.get('aria-label'), 'Pull request 812: Add vehicle search filters, into main, building')
    fire(link, 'click')
    assert.deepEqual(calls, ['open https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812'])

    assert.equal(textOf(rows[7]), 'Pull request 740')
    assert.equal(find(rows[7], node => node.attributes.get('role') === 'link')?.attributes.get('aria-label'), 'Pull request 740')
  })
})

test('the read age says just now under a minute, then uses ageText', () => {
  withFakeDom(() => {
    const { skeleton, repaint } = painted(ready(details({ readAt: NOW - 30_000 })))
    const meta = fake(skeleton.slots.meta.read)
    assert.equal(textOf(meta), 'Read just now')
    repaint(ready(details({ readAt: NOW - 3 * MINUTE })))
    assert.equal(textOf(meta), 'Read 3 minutes ago')
    repaint(refreshing(ready(details({ readAt: NOW - 3 * MINUTE })), 3))
    assert.equal(textOf(meta), REFRESHING)
  })
})

test('every URL in the panel goes through linkTo', () => {
  withFakeDom(() => {
    const full = details({
      descriptionMd: `The design is on the [Vehicle search page](${WIKI}).`,
      tasks: [detailTask(5001)],
      moreTasks: 3,
      prs: [detailPr(812)],
      comments: [comment(31, { textMd: `See [the page](${WIKI}).` })],
    })
    const { root, calls } = painted(ready(full))
    assert.equal(findAll(root, node => node.attributes.has('href')).length, 0)
    const links = findAll(root, node => node.attributes.get('role') === 'link')
    assert.equal(links.length, 7, 'header, description, task, more tasks, pull request, comment and footer')
    assert.ok(links.every(node => node.tagName === 'a'))

    const footer = byText(root, 'a', 'Open in Azure DevOps')
    assert.ok(footer)
    fire(footer, 'keydown', { key: 'Enter' })
    assert.deepEqual(calls, ['open https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4211'])
    assert.ok(byText(root, 'a', '3 more in Azure DevOps'))
  })
})

test('the fields show the column, the assignee and the parent', () => {
  withFakeDom(() => {
    const { skeleton, repaint } = painted(ready(), context({ card: item(4211, { column: 'Resolved', state: 'Resolved', assignedTo: 'Grace Hopper', parentId: 4100, parentTitle: 'Vehicle search' }) }))
    const fields = section(skeleton, 'fields')
    const select = fake(skeleton.controls.move)
    const assignee = fake(skeleton.controls.assignee)
    assert.equal(textOf(fake(skeleton.slots.meta.move)), 'Column')
    assert.equal(select.value, 'Resolved')
    assert.equal(textOf(assignee), 'GHGrace Hopper')
    assert.equal(textOf(fake(skeleton.slots.body.parent)), '#4100 Vehicle search')
    assert.equal(textOf(fields).includes('Assigned to'), true)

    const byState = item(4211, { targets: { columns: [], states: ['New', 'Closed'] }, column: null, state: 'Active', assignedTo: null, parentId: null, parentTitle: null })
    repaint(ready(details({ item: byState })), context())
    assert.equal(textOf(fake(skeleton.slots.meta.move)), 'State')
    assert.equal(select.value, 'Active')
    assert.equal(textOf(assignee), 'Unassigned')
    const parent = find(fields, node => textOf(node) === 'Parent')
    assert.equal(parent?.hidden, true, 'no parent, no Parent row')
  })
})

test("the column select offers the item's move targets with the current one selected", () => {
  withFakeDom(() => {
    const { skeleton, calls, repaint } = painted(ready(), context({ card: item(4211, { column: 'Resolved', state: 'Resolved' }) }))
    const select = fake(skeleton.controls.move)
    assert.equal(select.tagName, 'select')
    assert.equal(select.attributes.get('aria-labelledby'), fake(skeleton.slots.meta.move).id)
    assert.deepEqual(optionTexts(select), ['Resolved', 'New', 'Active', 'In Review', 'Closed'])
    assert.equal(select.value, 'Resolved')
    assert.equal(select.disabled, false)

    const options = [...select.children]
    repaint(ready(), context({ card: item(4211, { column: 'Resolved', state: 'Resolved', title: 'Add vehicle search and sort' }) }))
    assert.deepEqual(select.children, options, 'the same targets keep their options')

    select.value = 'Closed'
    fire(select, 'change')
    assert.deepEqual(calls, ['move Closed'])

    skeleton.controls.move.focus()
    repaint(ready(), context({ card: item(4211, { column: 'Active', state: 'Active' }) }))
    assert.equal(select.value, 'Closed', 'a focused select keeps its value')
    assert.deepEqual(select.children, options)

    skeleton.title.focus()
    repaint(ready(), context({ card: item(4211, { column: 'Active', state: 'Active' }) }))
    assert.deepEqual(optionTexts(select), ['Active', 'New', 'In Review', 'Resolved', 'Closed'])
    assert.equal(select.value, 'Active')

    repaint(busyWith(ready(), 'move', true), context({ card: item(4211, { column: 'Active', state: 'Active' }) }))
    assert.equal(select.disabled, true, 'off while the move runs')
    repaint(ready(details(), { offBoard: true }))
    assert.equal(select.disabled, true, 'off when the item left the board')
  })
})

test('an item that moves by state offers states under State', () => {
  withFakeDom(() => {
    const byState = item(4211, { targets: { columns: [], states: ['New', 'Active', 'Closed'] }, column: null, state: 'Active' })
    const { skeleton, calls } = painted(ready(details({ item: byState })))
    const select = fake(skeleton.controls.move)
    assert.equal(textOf(fake(skeleton.slots.meta.move)), 'State')
    assert.deepEqual(optionTexts(select), ['Active', 'New', 'Closed'])
    assert.equal(select.value, 'Active')
    select.value = 'Closed'
    fire(select, 'change')
    assert.deepEqual(calls, ['move Closed'])
  })
})

test('Comment is off until there is text', () => {
  withFakeDom(() => {
    const { skeleton, repaint, view } = painted(ready())
    const comments = section(skeleton, 'comments')
    const box = find(comments, node => node.tagName === 'textarea')
    assert.ok(box)
    assert.equal(box.attributes.get('aria-label'), 'Add a comment')
    const send = fake(skeleton.controls.send)
    assert.equal(textOf(send), 'Comment')
    assert.equal(send.disabled, true)

    view.drafts.set(4211, 'comment', '   ')
    repaint(ready())
    assert.equal(send.disabled, true, 'blank is not text')

    view.drafts.set(4211, 'comment', 'Looks right on staging.')
    repaint(ready())
    assert.equal(send.disabled, false)
    assert.equal(box.value, 'Looks right on staging.')

    repaint(busyWith(ready(), 'comment', true))
    assert.equal(send.disabled, true, 'off while a comment is sending')
  })
})

test('a repaint keeps the comment box, its value and its focus', () => {
  withFakeDom(() => {
    const { skeleton, repaint, calls, view } = painted(ready())
    const box = fake(skeleton.controls.comment)
    const parent = box.parent
    skeleton.controls.comment.focus()
    box.value = 'Filters look right on'
    fire(box, 'input')
    assert.deepEqual(calls, ['draft comment'])
    assert.equal(view.drafts.get(4211, 'comment'), 'Filters look right on')

    box.value = 'Filters look right on staging'
    repaint(ready(details({ item: item(4211, { rev: 4, title: 'Add vehicle search and sort' }), descriptionMd: 'Sort by price too.' })))
    assert.equal(fake(skeleton.controls.comment), box)
    assert.equal(box.parent, parent)
    assert.ok(parent && parent.parent, 'still attached')
    assert.equal(document.activeElement, skeleton.controls.comment)
    assert.equal(box.value, 'Filters look right on staging', 'a focused box keeps what was typed')

    skeleton.title.focus()
    view.drafts.set(4211, 'comment', 'Filters look right on staging.')
    repaint(ready(details({ item: item(4211, { rev: 5 }) })))
    assert.equal(box.value, 'Filters look right on staging.', 'an unfocused box shows the draft')
  })
})

test("a repaint keeps the picker's input and its query", async () => {
  await withFakeDom(async () => {
    const { skeleton, repaint, calls } = painted(ready())
    fire(fake(skeleton.controls.assignee), 'click')
    assert.deepEqual(calls, ['choose'])
    assert.equal(skeleton.controls.assignee.getAttribute('aria-haspopup'), 'listbox')

    skeleton.controls.picker.open(null)
    await settle()
    const input = fake(skeleton.controls.picker.input)
    const parent = input.parent
    input.value = 'gr'
    fire(input, 'input')
    repaint(ready(details({ item: item(4211, { rev: 4, assignedTo: 'Dennis Ritchie' }) })))
    assert.equal(fake(skeleton.controls.picker.input), input)
    assert.equal(input.parent, parent)
    assert.equal(input.value, 'gr')
    assert.equal(document.activeElement, skeleton.controls.picker.input)
    assert.equal(skeleton.controls.picker.isOpen(), true)
    assert.equal(textOf(fake(skeleton.controls.assignee)), 'DRDennis Ritchie')
  })
})

test('an item that left the board shows a muted note', () => {
  withFakeDom(() => {
    const { root, repaint } = painted(ready(details(), { offBoard: true }))
    const note = find(root, node => textOf(node) === OFF_BOARD && node.tagName === 'p')
    assert.ok(note && shown(note, root))
    assert.equal(classes(note).includes('muted'), true)
    repaint(ready())
    assert.equal(shown(note, root), false)
  })
})

test('a closed section keeps its heading and hides its body', () => {
  withFakeDom(() => {
    const { skeleton, root, calls, repaint } = painted(ready())
    const description = section(skeleton, 'description')
    const head = find(description, node => classes(node).includes('section-head'))
    assert.ok(head)
    fire(head, 'click')
    assert.deepEqual(calls, ['toggle description'])

    repaint(ready(), context({ closed: new Set(['description']) }))
    assert.equal(head.attributes.get('aria-expanded'), 'false')
    assert.equal(shown(head, root), true)
    const body = find(description, node => textOf(node).includes('Buyers need') && node !== description && classes(node).includes('section-body'))
    assert.ok(body)
    assert.equal(shown(body, root), false)
  })
})

const checkboxes = (root: FakeNode) => findAll(root, node => node.tagName === 'input' && node.type === 'checkbox')
const taskBox = (root: FakeNode) => find(root, node => node.attributes.get('aria-label') === 'Add a task')

test('a Features board item has no add form and no checkboxes', () => {
  withFakeDom(() => {
    const feature = details({
      item: item(4100, { type: 'Feature', title: 'Vehicle search' }),
      taskType: null,
      taskTypes: [],
      tasks: [detailTask(4211, { type: 'User Story', title: 'Add vehicle search filters', state: 'Active' }), detailTask(4198, { type: 'User Story', done: true, state: 'Closed' })],
    })
    const { skeleton, repaint } = painted(ready(feature))
    const children = section(skeleton, 'children')
    assert.equal(checkboxes(children).length, 0)
    assert.equal(taskBox(children), undefined)
    assert.equal(find(children, node => classes(node).includes('progress')), undefined)
    assert.equal(textOf(find(children, node => classes(node).includes('section-head'))!), 'Children(2)')

    repaint(ready(details({ tasks: [detailTask(5001)] })))
    const box = taskBox(children)
    assert.ok(box, 'a requirement board item has the form')
    assert.equal(box, fake(skeleton.controls.task))
    assert.equal(box.placeholder, 'Task title')
    assert.equal(checkboxes(children).length, 1)

    repaint(ready(feature))
    assert.equal(taskBox(children), undefined)
    assert.equal(checkboxes(children).length, 0)
  })
})

test('the Tasks heading shows how many are done, with a progress bar', () => {
  withFakeDom(() => {
    const tasks = [detailTask(5001), detailTask(5002), detailTask(5003, { done: true, state: 'Done' })]
    const { skeleton, repaint } = painted(ready(details({ tasks, moreTasks: 1 })))
    const head = find(section(skeleton, 'children'), node => classes(node).includes('section-head'))
    assert.ok(head)
    assert.equal(textOf(head), 'Tasks1 of 4 done')
    const bar = find(head, node => classes(node).includes('progress'))
    assert.ok(bar)
    assert.equal(bar.attributes.get('aria-hidden'), 'true')
    assert.equal(bar.children[0]?.style.width, '25%')

    repaint(ready(details({ tasks: [] })))
    assert.equal(textOf(head), 'Tasks')
    assert.equal(find(head, node => classes(node).includes('progress')), undefined)
  })
})

test('a repaint keeps the task box, its value and its focus', () => {
  withFakeDom(() => {
    const { skeleton, repaint, calls, view } = painted(ready(details({ tasks: [detailTask(5001)] })))
    const box = fake(skeleton.controls.task)
    const add = fake(skeleton.controls.add)
    const parent = box.parent
    assert.equal(textOf(add), 'Add')
    assert.equal(add.disabled, true, 'off until there is a title')

    skeleton.controls.task.focus()
    box.value = 'Add filter'
    fire(box, 'input')
    assert.deepEqual(calls, ['draft task'])
    assert.equal(view.drafts.get(4211, 'task'), 'Add filter')

    box.value = 'Add filter analytics'
    repaint(ready(details({ item: item(4211, { rev: 4 }), tasks: [detailTask(5001, { done: true, state: 'Done' }), detailTask(5002)] })))
    assert.equal(fake(skeleton.controls.task), box)
    assert.equal(box.parent, parent)
    assert.ok(parent && parent.parent, 'still attached')
    assert.equal(document.activeElement, skeleton.controls.task)
    assert.equal(box.value, 'Add filter analytics', 'a focused box keeps what was typed')
    assert.equal(add.disabled, false)

    repaint(busyWith(ready(), 'task:new', true))
    assert.equal(box.readOnly, true, 'it keeps focus and caret while the task is added')
    assert.equal(add.disabled, true, 'off while the task is added')
    assert.equal(document.activeElement, skeleton.controls.task)

    skeleton.title.focus()
    view.drafts.set(4211, 'task', 'Add filter analytics events')
    repaint(ready(details({ item: item(4211, { rev: 5 }) })))
    assert.equal(box.value, 'Add filter analytics events', 'an unfocused box shows the draft')
    assert.equal(box.readOnly, false)
  })
})

test('Enter in the task box adds the task', () => {
  withFakeDom(() => {
    const { skeleton, calls } = painted(ready())
    const box = fake(skeleton.controls.task)
    fire(box, 'keydown', { key: 'a' })
    assert.deepEqual(calls, [])
    const sent = fire(box, 'keydown', { key: 'Enter' })
    assert.equal(sent.defaultPrevented, true)
    fire(fake(skeleton.controls.add), 'click')
    assert.deepEqual(calls, ['addTask', 'addTask'])
  })
})

test('a focused checkbox keeps focus when its rows are rebuilt', () => {
  withFakeDom(() => {
    const tasks = [detailTask(5001, { title: 'Review the filter copy' }), detailTask(5002, { title: 'Write the filter tests' })]
    const { skeleton, repaint, calls } = painted(ready(details({ tasks })))
    const children = section(skeleton, 'children')
    const before = checkboxes(children)[1]
    fire(before, 'change')
    assert.deepEqual(calls, ['toggleTask 5002'])
    ;(before as unknown as HTMLElement).focus()

    repaint(busyWith(ready(details({ tasks })), 'task:5001', true))
    const after = checkboxes(children)[1]
    assert.notEqual(after, before, 'the rows were rebuilt')
    assert.equal(document.activeElement, after as unknown as Element)
  })
})

test("a slot whose build throws says its text couldn't be shown, and the next paint can fill it", () => {
  withFakeDom(() => {
    const slot = document.createElement('div')
    fill(slot, 'first', () => ['Buyers filter by make.'])
    fill(slot, 'second', () => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    assert.equal(textOf(fake(slot)), "This text couldn't be shown.")
    fill(slot, 'first', () => ['Buyers filter by make.'])
    assert.equal(textOf(fake(slot)), 'Buyers filter by make.')
  })
})

test("the minute repaint changes each comment's age but keeps its body, so a selection or a focused link stays", () => {
  withFakeDom(() => {
    const value = details({
      comments: [comment(31, { createdAt: NOW - 2 * MINUTE, textMd: 'See [the spec](https://x.test/spec).' }), comment(30, { createdAt: NOW - 3 * MINUTE })],
    })
    const { skeleton, repaint, view } = painted(ready(value))
    const comments = fake(skeleton.slots.body.comments)
    const bodies = findAll(comments, node => node.className === 'rich')
    const link = find(comments, node => node.tagName === 'a')
    assert.ok(link)

    repaint(ready(value), { ...view, now: NOW + 10 * MINUTE })
    const after = findAll(comments, node => node.className === 'rich')
    assert.equal(after.length, 2)
    assert.ok(after.every((node, index) => node === bodies[index]), 'the same bodies')
    assert.equal(find(comments, node => node === link), link, 'the link is still in place')
    assert.deepEqual(
      findAll(comments, node => node.className === 'by').map(textOf),
      [`Dennis Ritchie · ${ageText(NOW - 2 * MINUTE, NOW + 10 * MINUTE, 'en')}`, `Dennis Ritchie · ${ageText(NOW - 3 * MINUTE, NOW + 10 * MINUTE, 'en')}`]
    )

    const edited = details({ comments: [comment(31, { createdAt: NOW - 2 * MINUTE, textMd: 'See the spec.' }), comment(30, { createdAt: NOW - 3 * MINUTE })] })
    repaint(ready(edited), { ...view, now: NOW + 10 * MINUTE })
    assert.equal(textOf(findAll(comments, node => node.className === 'rich')[0]), 'See the spec.')
  })
})
