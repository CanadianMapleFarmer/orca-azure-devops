import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import type { OrgStatus } from '../../shared/types'
import type { WorkItemDetails, WorkItemSummary, WorkSnapshot } from '../../shared/work'
import { MAX_LABEL_BYTES, utf8Length } from '../label'
import { closeCleanly, countNodes, mountPanel, org as orgStatus, reloadPanel, requestsTo, type TestHost } from '../test-support'
import { board, BOARDS, item, LANES, largeWork, listOf, NOW, parentOf, pr, snapshotOf, task, workTask } from './fixtures'

const NO_BOARDS = "Pick a boards project and team in this org's settings."
const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const SOME_HIDDEN = 'Some items are hidden. Collapse a group to see others.'
const NO_SWIMLANES = 'This board has no swimlanes, so Lanes shows the columns.'
const VIEW_KEY = 'contoso/proj-web/team-web'
const IN_LANES = { plugin: { workViews: { [VIEW_KEY]: 'lanes' } } }

const org = (name: string, over: Partial<OrgStatus> = {}): OrgStatus => orgStatus(name, { boards: BOARDS, ...over })

function detailsOf(over: Partial<WorkItemDetails> = {}): WorkItemDetails {
  return {
    item: item(101, { title: 'Fix login redirect', parentId: 10, parentTitle: 'Checkout revamp' }),
    descriptionMd: 'Users land on the **wrong page** after signing in.',
    acceptanceMd: '- Redirects to the original page',
    comments: [{ id: 1, author: 'Grace Hopper', createdAt: NOW - 3_600_000, textMd: 'Reproduced on staging.' }],
    links: [
      { kind: 'parent', title: 'Checkout revamp', url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/10' },
      { kind: 'child', title: 'Add redirect test', url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/102' },
      { kind: 'related', title: 'Session timeout', url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/103' },
      { kind: 'pr', title: 'PR 55: Fix redirect', url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/55' }
    ],
    ...over
  }
}

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  visible?: boolean
  persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }
}

async function open(snapshot: MockRequests['work.snapshot'], more: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(options.orgs ?? [org('contoso')], { 'work.snapshot': snapshot, ...more }, options)
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const inside = (parent: TestElement, query: TestQuery) => panel.findAll(query).filter(each => each.path.startsWith(`${parent.path}/`))

const titleOf = (card: TestElement) => (inside(card, { type: 'Link' })[0] ?? inside(card, { type: 'Text' })[0])?.text

const titles = () => panel.findAll({ type: 'Card' }).map(titleOf)

const cardOf = (title: string): TestElement => {
  const card = panel.findAll({ type: 'Card' }).find(each => titleOf(each) === title)
  assert.ok(card, `${title} is drawn`)
  return card
}

const groupOf = (title: string): TestElement => {
  const group = panel.find({ type: 'Collapsible', label: title })
  assert.ok(group, `${title} is drawn`)
  return group
}

const cardsIn = (title: string) => inside(groupOf(title), { type: 'Card' }).map(titleOf)

const taskLines = (title: string) => {
  const card = cardOf(title)
  const block = card.path.slice(0, card.path.lastIndexOf('/'))
  return panel
    .findAll({ type: 'Row' })
    .filter(row => row.path.startsWith(`${block}/`) && !row.path.startsWith(`${card.path}/`))
    .map(row => row.text)
}

const tasksButton = (title: string) => inside(cardOf(title), { type: 'Button', text: /^Tasks / })[0]

function nodesOf(type: string): TreeSnapshot[] {
  const found: TreeSnapshot[] = []
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string') return
    if (node.type === type) found.push(node)
    node.children?.forEach(walk)
  }
  walk(panel.tree())
  return found
}

const groups = () => nodesOf('Collapsible').map(group => [group.props?.title, group.props?.description])

const groupStates = () => nodesOf('Collapsible').map(group => [group.props?.title, group.props?.open])

const columnIn = (lane: string, column: string): TestElement => {
  const found = inside(groupOf(lane), { type: 'Collapsible', label: column })[0]
  assert.ok(found, `${column} in ${lane} is drawn`)
  return found
}

const cardsAt = (lane: string, column: string) => inside(columnIn(lane, column), { type: 'Card' }).map(titleOf)

const columnsButton = () => panel.find({ type: 'Button', text: 'Columns' })

const lanesButton = () => panel.find({ type: 'Button', text: 'Lanes' })

const views = () => [columnsButton()?.props.variant, lanesButton()?.props.variant]

const noSwimlanes = () => panel.find({ type: 'Text', text: NO_SWIMLANES })

const openCard = (title = 'Story 101') => panel.press({ type: 'Link', text: title })

const movesIn = (parent: TestElement) => inside(parent, { type: 'Select', label: 'Move' })

const chips = (text: RegExp) => panel.findAll({ type: 'Badge', text }).map(badge => ({ text: badge.text, tone: badge.props.tone }))

const calloutTitled = (title: string) => panel.findAll({ type: 'Callout' }).find(callout => callout.props.title === title)

const shapeOf = (node: TreeSnapshot | string): unknown => (typeof node === 'string' ? node : [node.type, ...(node.children ?? []).map(shapeOf)])

function withinLimits(): void {
  const nodes = countNodes(panel.tree())
  const bytes = new TextEncoder().encode(JSON.stringify(panel.tree())).length
  assert.ok(nodes < 4_000, `${nodes} nodes`)
  assert.ok(bytes < 450 * 1024, `${bytes} bytes`)
}

const mineTask = (id: number, title: string, over: Parameters<typeof workTask>[1] = {}) => workTask(id, { title, mine: true, assignee: 'Ada Lovelace', ...over })

test('groups follow board order and count their cards', async () => {
  await open(
    snapshotOf({
      mine: [
        item(101, { title: 'Fix login redirect', column: 'Active' }),
        item(102, { title: 'Add export', column: 'New' }),
        item(103, { title: 'Cache invalidation', column: 'Active' }),
        item(104, { title: 'Legacy import', column: 'Archived' })
      ],
      other: [item(202, { type: 'Feature', title: 'Checkout revamp', column: null }), task(201, { title: 'Update runbook' })]
    })
  )
  assert.deepEqual(groups(), [
    ['New', '2 items'],
    ['Active', '2 items'],
    ['Not on this board', '1 item'],
    ['Feature', '1 item'],
    ['No parent', '1 task']
  ])
  assert.deepEqual(titles(), ['Add export', 'Legacy import', 'Fix login redirect', 'Cache invalidation', 'Checkout revamp'])
  assert.deepEqual(cardsIn('New'), ['Add export', 'Legacy import'])
  assert.deepEqual(inside(groupOf('No parent'), { type: 'Row' }).map(row => row.text), ['#201 Update runbook Active'])
  assert.deepEqual(
    [inside(cardOf('Add export'), { type: 'IconButton' })[0]?.label, inside(cardOf('Add export'), { type: 'Text' })[0]?.text],
    ['User Story', '#102']
  )
  assert.equal(panel.find({ type: 'RelativeTime' })?.props.at, NOW)
})

test('a column without items has no group and the snapshot is requested for the active org', async () => {
  const host = await open(snapshotOf({ mine: [item(101, { column: 'Done' })] }))
  assert.deepEqual(groups(), [['Done', '1 item']])
  assert.deepEqual(inputsTo(host, 'work.snapshot'), [{ org: 'contoso' }])
})

test('chips show merge and build state', async () => {
  await open(
    snapshotOf({
      mine: [
        item(101, { prs: [pr(1, { target: 'main', state: 'merged' }), pr(2, { target: 'release', state: 'open', build: 'running' })] }),
        item(102, { prs: [pr(3, { target: 'dev', state: 'open', build: 'failed' }), pr(4, { target: 'hotfix', state: 'open', build: 'succeeded' })] }),
        item(103, { prs: [pr(5, { target: 'next', state: 'open', build: 'none' }), pr(6, { target: 'old', state: 'abandoned', build: 'none' })] })
      ]
    })
  )
  assert.deepEqual(chips(/main|release|dev|hotfix|next|old/), [
    { text: 'main ✓', tone: 'success' },
    { text: 'release ● build', tone: 'warning' },
    { text: 'dev ✗ build', tone: 'danger' },
    { text: 'hotfix ·', tone: 'neutral' },
    { text: 'next ·', tone: 'neutral' },
    { text: 'old abandoned', tone: 'neutral' }
  ])
})

test('a card shows at most four chips and counts the rest', async () => {
  await open(
    snapshotOf({
      mine: [
        item(101, {
          prs: [
            pr(1, { target: 'main', state: 'merged' }),
            pr(2, { target: 'release', state: 'open', build: 'running' }),
            pr(3, { target: 'dev', state: 'open', build: 'failed' }),
            pr(4, { target: 'next', state: 'open', build: 'none' }),
            pr(5, { target: 'staging', state: 'merged' }),
            pr(6, { target: 'uat', state: 'abandoned' })
          ]
        }),
        item(102, { prs: [pr(7, { target: 'dev', state: 'merged' }), pr(8, { target: 'staging', state: 'merged' }), pr(9, { target: 'master', state: 'open' })] })
      ]
    })
  )
  assert.deepEqual(chips(/./).filter(chip => chip.text !== 'Web Team · Stories' && chip.text !== 'Connected'), [
    { text: 'main ✓', tone: 'success' },
    { text: 'release ● build', tone: 'warning' },
    { text: 'dev ✗ build', tone: 'danger' },
    { text: 'next ·', tone: 'neutral' },
    { text: '+2', tone: 'neutral' },
    { text: 'dev ✓', tone: 'success' },
    { text: 'staging ✓', tone: 'success' },
    { text: 'master ·', tone: 'neutral' }
  ])
})

test('300 items with four chips each and 25 nudges still render, with 10 nudges shown', async () => {
  const targets = ['dev', 'staging', 'master', 'main']
  const mine = Array.from({ length: 300 }, (_, index) =>
    item(index + 1, { prs: targets.map((target, number) => pr(index * 4 + number + 1, { target, state: 'merged' })) })
  )
  const nudges = Array.from({ length: 25 }, (_, index) => ({ itemId: index + 1, prId: index * 4 + 1, branch: 'main', toColumn: 'Done' }))
  await open(snapshotOf({ mine, nudges }))
  assert.deepEqual(groups(), [['Active', '300 items']])
  assert.equal(panel.findAll({ type: 'Card' }).length, 25)
  for (const target of targets) assert.equal(panel.findAll({ type: 'Badge', text: `${target} ✓` }).length, 25, target)
  assert.equal(panel.findAll({ type: 'Badge', text: /^\+/ }).length, 0)
  assert.ok(panel.find({ type: 'Button', text: 'Show 25 more' }))
  const shown = panel.findAll({ type: 'Callout' }).map(callout => callout.props.title)
  assert.deepEqual(
    shown,
    Array.from({ length: 10 }, (_, index) => `#${index + 1} — PR ${index * 4 + 1} merged into main`)
  )
  assert.ok(panel.find({ type: 'Text', text: '15 more suggestions not shown.' })?.props.muted)
  withinLimits()
})

test('the board label names the team and the board, and Refresh replaces the snapshot', async () => {
  const refreshed = snapshotOf({ mine: [item(105, { title: 'Newer story' })], updatedAt: NOW + 60_000 })
  const host = await open(snapshotOf({ mine: [item(101)] }), { 'work.refresh': refreshed })
  assert.ok(panel.find({ type: 'Badge', text: 'Web Team · Stories' }))
  assert.equal(panel.find({ type: 'Badge', text: 'Stories' }), null)
  const actions = ['Collapse all', 'Expand all', 'Refresh', 'Open board']
  assert.deepEqual(
    panel
      .findAll({ type: 'IconButton' })
      .filter(button => actions.includes(button.label ?? ''))
      .map(button => [button.label, button.props.icon]),
    [
      ['Collapse all', 'collapse'],
      ['Expand all', 'expand'],
      ['Refresh', 'refresh'],
      ['Open board', 'open-external']
    ]
  )
  assert.deepEqual(
    panel.findAll({ type: 'Button', text: /^(Columns|Lanes)$/ }).map(button => [button.text, button.props.size, button.props.variant]),
    [
      ['Columns', 'xs', 'outline'],
      ['Lanes', 'xs', 'ghost']
    ]
  )
  assert.deepEqual(titles(), ['Story 101'])
  await panel.press({ label: 'Refresh' })
  assert.deepEqual(inputsTo(host, 'work.refresh'), [{ org: 'contoso' }])
  assert.deepEqual(titles(), ['Newer story'])
  assert.equal(panel.find({ type: 'RelativeTime' })?.props.at, NOW + 60_000)
})

test('a refresh that fails shows the message and keeps the items', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.refresh': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await panel.press({ label: 'Refresh' })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  assert.equal(callout?.text, 'Azure DevOps is unreachable.')
  assert.deepEqual(titles(), ['Story 101'])
})

test('Open board shows its message when nothing was opened', async () => {
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.openBoard': { opened: false, message: 'Focus a workspace first, then open the board.' }
  })
  await panel.press({ label: 'Open board' })
  assert.deepEqual(inputsTo(host, 'work.openBoard'), [{ org: 'contoso' }])
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Focus a workspace first, then open the board.')
})

test('Open board is quiet when the board opened', async () => {
  await open(snapshotOf({ mine: [item(101)] }), { 'work.openBoard': { opened: true } })
  await panel.press({ label: 'Open board' })
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('Move sends work.move with the item rev from the compact control', async () => {
  const sent: unknown[] = []
  await open(snapshotOf({ mine: [item(101, { rev: 12 })], other: [item(201, { type: 'Bug', title: 'Broken export', column: null, rev: 4, targets: { columns: [], states: ['New', 'Active', 'Closed'] } })] }), {
    'work.move': input => {
      sent.push(input)
      return item(input.id)
    }
  })
  const [onBoard, off] = panel.findAll({ type: 'Select', label: 'Move' })
  assert.deepEqual(
    (onBoard?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Done']
  )
  assert.deepEqual(
    (off?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Closed']
  )
  assert.deepEqual([onBoard?.props.labelHidden, onBoard?.props.placeholder], [true, 'Move'])
  const box = panel.findAll({ type: 'Box' }).find(each => onBoard?.path.startsWith(`${each.path}/`) && each.props.width === 112)
  assert.equal(box?.props.shrink, false)
  assert.equal(panel.find({ type: 'Select', label: 'Move to' }), null)

  await panel.select(onBoard!, 'Done')
  await panel.select(panel.findAll({ type: 'Select', label: 'Move' })[1]!, 'Closed')
  assert.deepEqual(sent, [
    { org: 'contoso', id: 101, rev: 12, to: { column: 'Done' } },
    { org: 'contoso', id: 201, rev: 4, to: { state: 'Closed' } }
  ])
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a refused move shows the message and the list follows the worker post', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.move': () => {
      throw hostError('action_failed', CONFLICT)
    }
  })
  await panel.select({ type: 'Select', label: 'Move' }, 'Done')
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  assert.equal(callout?.text, CONFLICT)
  assert.equal(panel.valueOf({ type: 'Select', label: 'Move' }), '')

  await panel.post('work.changed', snapshotOf({ mine: [item(101, { rev: 8, column: 'Done', state: 'Done' })] }))
  assert.deepEqual(groups(), [['Done', '1 item']])
})

test('nudge Move and Dismiss call the right requests', async () => {
  const nudge = { itemId: 101, prId: 55, branch: 'main', toColumn: 'Done' }
  const host = await open(snapshotOf({ mine: [item(101, { rev: 12 }), item(102)], nudges: [nudge] }), {
    'work.move': input => item(input.id),
    'work.dismissNudge': { ok: true }
  })
  const callout = calloutTitled('#101 — PR 55 merged into main')
  assert.equal(callout?.props.tone, 'accent')
  assert.equal(panel.find({ type: 'Button', text: 'Dismiss' })?.props.variant, 'ghost')

  await panel.press({ text: 'Move to Done' })
  assert.deepEqual(inputsTo(host, 'work.move'), [{ org: 'contoso', id: 101, rev: 12, to: { column: 'Done' } }])

  await panel.press({ text: 'Dismiss' })
  assert.deepEqual(inputsTo(host, 'work.dismissNudge'), [{ org: 'contoso', itemId: 101, prId: 55 }])

  await panel.post('work.changed', snapshotOf({ mine: [item(101, { rev: 13, column: 'Done' }), item(102)], nudges: [] }))
  assert.equal(calloutTitled('#101 — PR 55 merged into main'), undefined)
})

test('one nudge over ten says one more suggestion is not shown', async () => {
  const mine = Array.from({ length: 11 }, (_, index) => item(index + 1))
  const nudges = mine.map(entry => ({ itemId: entry.id, prId: entry.id, branch: 'main', toColumn: 'Done' }))
  await open(snapshotOf({ mine, nudges }))
  assert.equal(panel.findAll({ type: 'Callout' }).length, 10)
  assert.ok(panel.find({ type: 'Text', text: '1 more suggestion not shown.' })?.props.muted)
})

test('a card is a pressable title, then the type, id, chips, Tasks n/m and a compact Move', async () => {
  const long = 'Load the basket and the prices faster on slow connections '.repeat(3)
  await open(
    snapshotOf({
      mine: [
        item(101, {
          title: long,
          parentId: 10,
          parentTitle: 'Checkout revamp',
          prs: [pr(1, { state: 'merged' }), pr(2, { target: 'release', build: 'running' })]
        })
      ],
      families: { parents: [], lists: [listOf(101, [workTask(301, { state: 'Closed', done: true }), workTask(302), workTask(303)])] }
    })
  )
  const cut = `${[...long].slice(0, 90).join('')}…`
  assert.deepEqual(
    nodesOf('Card').map(shapeOf),
    [['Card', ['Link', cut], ['Row', ['IconButton'], ['Text', '#101'], ['Badge', 'main ✓'], ['Badge', 'release ● build'], ['Button', 'Tasks 1/3'], ['Box', ['Select']]]]]
  )
  const card = cardOf(cut)
  assert.deepEqual([card.props.title, card.props.description], [undefined, undefined])
  const [row] = inside(card, { type: 'Row' })
  assert.deepEqual([row?.props.gap, row?.props.align, row?.props.wrap], ['xs', 'center', true])
  const [type] = inside(card, { type: 'IconButton' })
  assert.deepEqual([type?.label, type?.props.icon, type?.props.variant, type?.props.size], ['User Story', 'book', 'ghost', 'xs'])
  const [id] = inside(card, { type: 'Text' })
  assert.deepEqual([id?.text, id?.props.size, id?.props.muted], ['#101', 'sm', true])
  const toggle = tasksButton(cut)
  assert.deepEqual([toggle?.props.variant, toggle?.props.size, toggle?.props.tooltip], ['ghost', 'xs', '1 of 3 tasks done'])
  const [box] = inside(card, { type: 'Box' })
  assert.deepEqual([box?.props.width, box?.props.shrink], [112, false])
  const [move] = movesIn(card)
  assert.deepEqual([move?.props.labelHidden, move?.props.placeholder], [true, 'Move'])
  assert.equal(panel.find({ type: 'Button', text: 'Details' }), null)
  assert.equal(panel.find({ text: /Checkout revamp/ }), null)
})

test("pressing a card's title or type opens its details", async () => {
  const host = await open(
    snapshotOf({ mine: [item(101, { title: 'Fix login redirect' })], other: [item(201, { type: 'Bug', title: 'Broken export', column: null })] }),
    { 'work.details': input => detailsOf({ item: input.id === 101 ? item(101, { title: 'Fix login redirect' }) : item(201, { type: 'Bug', title: 'Broken export' }) }) }
  )
  await openCard('Fix login redirect')
  assert.deepEqual(inputsTo(host, 'work.details'), [{ org: 'contoso', id: 101 }])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Fix login redirect')
  await panel.press({ label: 'Back' })

  const [type] = inside(cardOf('Broken export'), { type: 'IconButton' })
  assert.deepEqual([type?.label, type?.props.icon], ['Bug', 'bug'])
  await panel.press(type!)
  assert.deepEqual(inputsTo(host, 'work.details'), [
    { org: 'contoso', id: 101 },
    { org: 'contoso', id: 201 }
  ])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Broken export')
})

test("Tasks n/m opens the tasks under the story with state and other people's names, Unassigned for nobody, done ones muted, and + N more", async () => {
  const host = await open(
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' })],
      families: {
        parents: [],
        lists: [
          listOf(
            101,
            [
              workTask(301, { title: 'Write the tests' }),
              workTask(302, { title: 'Update the copy', assignee: null }),
              workTask(303, { title: 'Draft the plan', state: 'Closed', done: true, assignee: 'Alan Turing' })
            ],
            { total: 5, done: 2 }
          )
        ]
      }
    }),
    { 'work.details': detailsOf({ item: item(301, { type: 'Task', title: 'Write the tests' }) }) }
  )
  assert.deepEqual(taskLines('Checkout revamp'), [])
  const toggle = tasksButton('Checkout revamp')
  assert.deepEqual([toggle?.text, toggle?.props.tooltip], ['Tasks 2/5', '2 of 5 tasks done'])

  await panel.press(toggle!)
  assert.deepEqual(taskLines('Checkout revamp'), [
    '#301 Write the tests Active Grace Hopper',
    '#302 Update the copy Active Unassigned',
    '#303 Draft the plan Closed Alan Turing'
  ])
  assert.ok(panel.find({ type: 'Link', text: '#301 Write the tests' }))
  assert.equal(panel.find({ type: 'Link', text: '#303 Draft the plan' }), null)
  const done = panel.find({ type: 'Text', text: '#303 Draft the plan' })
  assert.deepEqual([done?.props.size, done?.props.muted], ['sm', true])
  const nobody = panel.find({ type: 'Text', text: 'Unassigned' })
  assert.deepEqual([nobody?.props.size, nobody?.props.muted], ['sm', true])
  const more = panel.find({ type: 'Text', text: '+ 2 more' })
  assert.deepEqual([more?.props.size, more?.props.muted], ['sm', true])
  const box = panel.findAll({ type: 'Box' }).find(each => more?.path.startsWith(`${each.path}/`))
  assert.deepEqual([box?.props.paddingX, box?.props.gap], ['sm', 'xs'])
  assert.equal(movesIn(box!).length, 0)

  await panel.press({ type: 'Link', text: '#301 Write the tests' })
  assert.deepEqual(inputsTo(host, 'work.details'), [{ org: 'contoso', id: 301 }])
  await panel.press({ label: 'Back' })
  await panel.press(tasksButton('Checkout revamp')!)
  assert.deepEqual(taskLines('Checkout revamp'), [])
})

test('your task under a story keeps its Move', async () => {
  const sent: unknown[] = []
  await open(
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' })],
      other: [task(301, { title: 'Write the tests', parentId: 101, parentTitle: 'Checkout revamp', rev: 5 })],
      families: { parents: [], lists: [listOf(101, [mineTask(301, 'Write the tests'), workTask(302, { title: 'Update the copy' })])] }
    }),
    {
      'work.move': input => {
        sent.push(input)
        return task(input.id)
      }
    }
  )
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active', '#302 Update the copy Active Grace Hopper'])
  assert.deepEqual(groups(), [['Active', '1 item']])
  assert.equal(panel.findAll({ type: 'Link', text: /^#301 / }).length, 1)
  const moves = panel.findAll({ type: 'Select', label: 'Move' })
  assert.equal(moves.length, 2)
  assert.deepEqual(
    (moves[1]?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Closed']
  )
  await panel.select(moves[1]!, 'Closed')
  assert.deepEqual(sent, [{ org: 'contoso', id: 301, rev: 5, to: { state: 'Closed' } }])
})

test("a task whose story isn't yours shows under that story, dimmed, in the story's column", async () => {
  await open(
    snapshotOf({
      mine: [item(101, { column: 'New' })],
      other: [task(301, { title: 'Write the tests', parentId: 150, parentTitle: 'Checkout revamp' })],
      families: {
        parents: [parentOf(150, { title: 'Checkout revamp', column: 'Done' })],
        lists: [listOf(150, [mineTask(301, 'Write the tests'), workTask(302, { title: 'Update the copy', state: 'Closed', done: true })])]
      }
    })
  )
  assert.deepEqual(groups(), [
    ['New', '1 item'],
    ['Done', '1 item']
  ])
  assert.deepEqual(cardsIn('Done'), ['#150 Checkout revamp'])
  const dimmed = cardOf('#150 Checkout revamp')
  const [label] = inside(dimmed, { type: 'Text' })
  assert.deepEqual([label?.props.muted, label?.props.weight], [true, 'medium'])
  assert.deepEqual([inside(dimmed, { type: 'Link' }).length, movesIn(dimmed).length], [0, 0])
  assert.equal(tasksButton('#150 Checkout revamp')?.text, 'Tasks 1/2')
  assert.deepEqual(taskLines('#150 Checkout revamp'), ['#301 Write the tests Active', '#302 Update the copy Closed Grace Hopper'])
  assert.equal(panel.findAll({ type: 'Select', label: 'Move' }).length, 2)
  assert.equal(panel.find({ type: 'Collapsible', label: 'No parent' }), null)
})

test('a task-level parent shows in Not on this board under its type, with its tasks nested one level', async () => {
  await open(
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' })],
      other: [
        task(301, { title: 'Split the payment step', parentId: 101 }),
        task(302, { title: 'Move the card form', parentId: 301 }),
        task(303, { title: 'Plan the rollout' }),
        task(304, { title: 'Check the flags', parentId: 303 })
      ],
      families: {
        parents: [],
        lists: [listOf(301, [mineTask(302, 'Move the card form'), workTask(305, { title: 'Pair on the form' })]), listOf(303, [mineTask(304, 'Check the flags')])]
      }
    })
  )
  assert.deepEqual(groups(), [
    ['Active', '1 item'],
    ['Not on this board', '2 items'],
    ['Task', '2 items']
  ])
  assert.deepEqual(cardsIn('Task'), ['#301 Split the payment step', 'Plan the rollout'])
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Split the payment step Active'])
  assert.deepEqual(taskLines('#301 Split the payment step'), ['#302 Move the card form Active', '#305 Pair on the form Active Grace Hopper'])
  assert.deepEqual(taskLines('Plan the rollout'), ['#304 Check the flags Active'])
  assert.equal(movesIn(cardOf('#301 Split the payment step')).length, 0)
  assert.equal(movesIn(cardOf('Plan the rollout')).length, 1)
  assert.equal(panel.findAll({ type: 'Select', label: 'Move' }).length, 5)
  assert.equal(panel.findAll({ type: 'Link', text: /^#302 / }).length, 1)
})

test('Not on this board groups items that move by state by type, with their tasks nested', async () => {
  const states = { columns: [], states: ['New', 'Active', 'Closed'] }
  await open(
    snapshotOf({
      other: [
        item(201, { type: 'Feature', title: 'Checkout revamp', column: null, targets: states }),
        item(202, { type: 'Bug', title: 'Broken export', column: null, targets: states }),
        item(203, { type: 'Epic', title: 'Payments', column: null, targets: states }),
        item(204, { title: 'Story with no column', column: null, targets: states }),
        task(301, { title: 'Write the tests', parentId: 201 })
      ],
      families: { parents: [], lists: [listOf(201, [mineTask(301, 'Write the tests'), workTask(302, { title: 'Update the copy' })])] }
    })
  )
  assert.deepEqual(groups(), [
    ['Not on this board', '4 items'],
    ['Bug', '1 item'],
    ['Epic', '1 item'],
    ['Feature', '1 item'],
    ['User Story', '1 item']
  ])
  assert.deepEqual(
    ['Broken export', 'Payments', 'Checkout revamp', 'Story with no column'].map(title => inside(cardOf(title), { type: 'IconButton' })[0]?.props.icon),
    ['bug', 'flag', 'layers', 'book']
  )
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active', '#302 Update the copy Active Grace Hopper'])
  assert.deepEqual(
    (movesIn(cardOf('Broken export'))[0]?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Closed']
  )
})

test("a task whose parent can't be read shows under a dimmed #id header in Unknown type", async () => {
  await open(snapshotOf({ mine: [item(101)], other: [task(301, { title: 'Write the tests', parentId: 999 })] }))
  assert.deepEqual(groups(), [
    ['Active', '1 item'],
    ['Not on this board', '1 item'],
    ['Unknown type', '1 item']
  ])
  assert.deepEqual(cardsIn('Unknown type'), ['#999'])
  const [label] = inside(cardOf('#999'), { type: 'Text' })
  assert.deepEqual([label?.props.muted, label?.props.weight], [true, 'medium'])
  assert.deepEqual(taskLines('#999'), ['#301 Write the tests Active'])
  assert.equal(panel.findAll({ type: 'Select', label: 'Move' }).length, 2)
})

test('No parent lists only tasks with no parent', async () => {
  await open(
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' })],
      other: [task(301, { title: 'Update the runbook' }), task(302, { title: 'Write the tests', parentId: 101 }), task(303, { title: 'Plan the rollout' })],
      families: { parents: [], lists: [listOf(303, [workTask(304, { title: 'Check the flags' })])] }
    })
  )
  assert.deepEqual(groups(), [
    ['Active', '1 item'],
    ['Not on this board', '1 item'],
    ['Task', '1 item'],
    ['No parent', '1 task']
  ])
  const noParent = groupOf('No parent')
  assert.deepEqual(
    inside(noParent, { type: 'Row' }).map(row => row.text),
    ['#301 Update the runbook Active']
  )
  assert.equal(movesIn(noParent).length, 1)
  assert.deepEqual(taskLines('Checkout revamp'), ['#302 Write the tests Active'])
})

test('Collapse all and Expand all act on every group and every task list', async () => {
  await open(
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' }), item(102, { title: 'Add export', column: 'New' })],
      other: [item(201, { type: 'Feature', title: 'Payments', column: null }), task(301, { title: 'Write the tests', parentId: 101 }), task(305, { title: 'Update the runbook' })],
      families: { parents: [], lists: [listOf(101, [mineTask(301, 'Write the tests')]), listOf(102, [workTask(302, { title: 'Review the export' })])] }
    })
  )
  assert.deepEqual([taskLines('Checkout revamp').length, taskLines('Add export').length], [1, 0])

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(groupStates(), [
    ['New', false],
    ['Active', false],
    ['Not on this board', false],
    ['No parent', false]
  ])
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|work'], { all: 'closed', open: [], closed: [] })

  await panel.toggle({ type: 'Collapsible', label: 'Active' })
  assert.deepEqual(taskLines('Checkout revamp'), [])

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(groupStates(), [
    ['New', true],
    ['Active', true],
    ['Not on this board', true],
    ['Feature', true],
    ['No parent', true]
  ])
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active'])
  assert.deepEqual(taskLines('Add export'), ['#302 Review the export Active Grace Hopper'])
})

test('open groups and task lists survive a reload', async () => {
  const snapshot = snapshotOf({
    mine: [item(101, { title: 'Checkout revamp' }), item(102, { title: 'Add export', column: 'New' })],
    families: { parents: [], lists: [listOf(101, [workTask(301, { title: 'Write the tests' })])] }
  })
  await open(snapshot)
  await panel.toggle({ type: 'Collapsible', label: 'New' })
  await panel.press(tasksButton('Checkout revamp')!)
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active Grace Hopper'])

  const reloaded = await reloadPanel(panel, [org('contoso')], { 'work.snapshot': snapshot })
  panel = reloaded.panel
  assert.deepEqual(groupStates(), [
    ['New', false],
    ['Active', true]
  ])
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active Grace Hopper'])
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|work'], { all: null, open: ['tasks:101'], closed: ['column:New'] })
})

test('a task list closed by hand stays closed after your last task in it is done', async () => {
  const listed = (done: boolean) =>
    snapshotOf({
      mine: [item(101, { title: 'Checkout revamp' })],
      other: [task(301, { title: 'Write the tests', parentId: 101, state: done ? 'Closed' : 'Active' })],
      families: { parents: [], lists: [listOf(101, [mineTask(301, 'Write the tests', { done, state: done ? 'Closed' : 'Active' })])] }
    })
  await open(listed(false))
  assert.deepEqual(taskLines('Checkout revamp'), ['#301 Write the tests Active'])
  await panel.press(tasksButton('Checkout revamp')!)
  assert.deepEqual(taskLines('Checkout revamp'), [])

  await panel.post('work.changed', listed(true))
  assert.equal(tasksButton('Checkout revamp')?.text, 'Tasks 1/1')
  assert.deepEqual(taskLines('Checkout revamp'), [])
  await panel.post('work.changed', listed(false))
  assert.deepEqual(taskLines('Checkout revamp'), [])
})

const laneBoard = (over: Parameters<typeof board>[1] = {}) => board('contoso', { lanes: LANES, ...over })

const laneSnapshot = () =>
  snapshotOf({
    board: laneBoard(),
    mine: [
      item(101, { title: 'Fix login redirect', column: 'Active', lane: null }),
      item(102, { title: 'Add export', column: 'New', lane: '' }),
      item(103, { title: 'Cache invalidation', column: 'Active', lane: 'Expedite' }),
      item(104, { title: 'Legacy import', column: 'Done', lane: 'Gone' }),
      item(105, { title: 'Hotfix the header', column: 'New', lane: 'Expedite' })
    ],
    other: [item(201, { type: 'Feature', title: 'Checkout revamp', column: null }), task(301, { title: 'Update the runbook' })]
  })

const showLanes = () => panel.press({ type: 'Button', text: 'Lanes' })

test('Lanes shows one group per swimlane in board order with a group per column inside', async () => {
  await open(laneSnapshot())
  assert.deepEqual(groups(), [
    ['New', '2 items'],
    ['Active', '2 items'],
    ['Done', '1 item'],
    ['Not on this board', '1 item'],
    ['Feature', '1 item'],
    ['No parent', '1 task']
  ])

  await showLanes()
  assert.deepEqual(groups(), [
    ['Default lane', '3 items'],
    ['New', '1 item'],
    ['Active', '1 item'],
    ['Done', '1 item'],
    ['Expedite', '2 items'],
    ['New', '1 item'],
    ['Active', '1 item'],
    ['Not on this board', '1 item'],
    ['Feature', '1 item'],
    ['No parent', '1 task']
  ])
  assert.deepEqual(
    [cardsAt('Default lane', 'New'), cardsAt('Default lane', 'Active'), cardsAt('Default lane', 'Done'), cardsAt('Expedite', 'New'), cardsAt('Expedite', 'Active')],
    [['Add export'], ['Fix login redirect'], ['Legacy import'], ['Hotfix the header'], ['Cache invalidation']]
  )
  assert.deepEqual(cardsIn('Feature'), ['Checkout revamp'])
  assert.deepEqual(inside(groupOf('No parent'), { type: 'Row' }).map(row => row.text), ['#301 Update the runbook Active'])
  assert.equal(noSwimlanes(), null)
  assert.equal(panel.findAll({ type: 'Select', label: 'Move' }).length, 7)
})

test('a swimlane without items keeps its group, with nothing inside', async () => {
  await open(snapshotOf({ board: laneBoard(), mine: [item(101, { title: 'Fix login redirect', column: 'Active', lane: null })] }), {}, { persisted: IN_LANES })
  assert.deepEqual(groups(), [
    ['Default lane', '1 item'],
    ['Active', '1 item'],
    ['Expedite', '0 items']
  ])
  assert.deepEqual(inside(groupOf('Expedite'), { type: 'Card' }), [])
})

test('a dimmed parent sits in its own lane and column, with its tasks under it', async () => {
  await open(
    snapshotOf({
      board: laneBoard(),
      mine: [item(101, { title: 'Fix login redirect', column: 'Active', lane: null })],
      other: [task(301, { title: 'Write the tests', parentId: 150 })],
      families: { parents: [parentOf(150, { title: 'Show the delivery estimate', column: 'New', lane: 'Expedite' })], lists: [] }
    }),
    {},
    { persisted: IN_LANES }
  )
  assert.deepEqual(groups(), [
    ['Default lane', '1 item'],
    ['Active', '1 item'],
    ['Expedite', '1 item'],
    ['New', '1 item']
  ])
  assert.deepEqual(cardsAt('Expedite', 'New'), ['#150 Show the delivery estimate'])
  assert.deepEqual(taskLines('#150 Show the delivery estimate'), ['#301 Write the tests Active'])
})

test('a board without swimlanes shows the columns under Lanes with a note', async () => {
  const columns = [['New', '1 item'], ['Active', '2 items']]
  const snapshot = (lanes: { id: string; name: string }[]) =>
    snapshotOf({
      board: board('contoso', { lanes }),
      mine: [item(101, { column: 'Active', lane: 'Expedite' }), item(102, { column: 'New' }), item(103, { column: 'Active', lane: null })]
    })
  await open(snapshot([]))
  assert.equal(noSwimlanes(), null)
  assert.deepEqual(groups(), columns)

  await showLanes()
  assert.deepEqual(groups(), columns)
  const note = noSwimlanes()
  assert.deepEqual([note?.props.size, note?.props.muted], ['sm', true])
  assert.deepEqual(views(), ['ghost', 'outline'])

  await panel.post('work.changed', snapshot([{ id: 'lane-default', name: '' }]))
  assert.deepEqual(groups(), columns)
  assert.ok(noSwimlanes())

  await panel.post('work.changed', snapshot(LANES))
  assert.equal(noSwimlanes(), null)
  assert.deepEqual(groups(), [
    ['Default lane', '2 items'],
    ['New', '1 item'],
    ['Active', '1 item'],
    ['Expedite', '1 item'],
    ['Active', '1 item']
  ])

  await panel.press({ type: 'Button', text: 'Columns' })
  assert.deepEqual(groups(), columns)
  assert.equal(noSwimlanes(), null)
})

test('the Columns and Lanes buttons switch the view, and the chosen one is outline', async () => {
  await open(laneSnapshot())
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.deepEqual(
    [columnsButton(), lanesButton()].map(button => [button?.text, button?.props.size]),
    [
      ['Columns', 'xs'],
      ['Lanes', 'xs']
    ]
  )
  const label = nodesOf('Row').find(row => row.children?.some(child => typeof child !== 'string' && child.type === 'Badge' && child.children?.includes('Web Team · Stories')))
  assert.deepEqual(shapeOf(label!), ['Row', ['Badge', 'Web Team · Stories'], ['Box', ['Toolbar', ['Button', 'Columns'], ['Button', 'Lanes']]]])

  await showLanes()
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.equal(groupOf('Default lane').props.title, 'Default lane')
  await showLanes()
  assert.deepEqual(views(), ['ghost', 'outline'])

  await panel.press({ type: 'Button', text: 'Columns' })
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.equal(panel.find({ type: 'Collapsible', label: 'Default lane' }), null)
  assert.equal(panel.find({ type: 'Collapsible', label: 'Expedite' }), null)
})

test('the chosen view is remembered per board and survives a reload', async () => {
  const snapshot = laneSnapshot()
  await open(snapshot)
  await showLanes()
  assert.deepEqual(panel.persisted.plugin.workViews, { [VIEW_KEY]: 'lanes' })

  const reloaded = await reloadPanel(panel, [org('contoso')], { 'work.snapshot': snapshot })
  panel = reloaded.panel
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.deepEqual(
    groups().slice(0, 2),
    [
      ['Default lane', '3 items'],
      ['New', '1 item']
    ]
  )

  const otherBoard = { ...BOARDS, teamId: 'team-other', teamName: 'Other Team' }
  const elsewhere = await reloadPanel(panel, [org('contoso', { boards: otherBoard })], { 'work.snapshot': snapshot })
  panel = elsewhere.panel
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.equal(panel.find({ type: 'Collapsible', label: 'Default lane' }), null)
  await showLanes()
  assert.deepEqual(panel.persisted.plugin.workViews, { [VIEW_KEY]: 'lanes', 'contoso/proj-web/team-other': 'lanes' })

  const back = await reloadPanel(panel, [org('contoso')], { 'work.snapshot': snapshot })
  panel = back.panel
  await panel.press({ type: 'Button', text: 'Columns' })
  assert.deepEqual(panel.persisted.plugin.workViews, { [VIEW_KEY]: 'columns', 'contoso/proj-web/team-other': 'lanes' })
})

test('a remembered view that is neither columns nor lanes falls back to Columns', async () => {
  await open(laneSnapshot(), {}, { persisted: { plugin: { workViews: { [VIEW_KEY]: 'sideways' } } } })
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.equal(panel.find({ type: 'Collapsible', label: 'Default lane' }), null)
})

test('open lanes and column groups survive a reload', async () => {
  const snapshot = laneSnapshot()
  await open(snapshot, {}, { persisted: IN_LANES })
  await panel.toggle({ type: 'Collapsible', label: 'Expedite' })
  await panel.toggle(columnIn('Default lane', 'Done'))
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|work'], {
    all: null,
    open: [],
    closed: ['lane:lane-expedite', 'lane:lane-default/column:Done']
  })

  const reloaded = await reloadPanel(panel, [org('contoso')], { 'work.snapshot': snapshot })
  panel = reloaded.panel
  assert.deepEqual(groupStates().slice(0, 6), [
    ['Default lane', true],
    ['New', true],
    ['Active', true],
    ['Done', false],
    ['Expedite', false],
    ['Not on this board', true]
  ])
})

test('Collapse all closes the lanes and their column groups too', async () => {
  await open(laneSnapshot())
  await showLanes()
  assert.deepEqual(
    groupStates().filter(([title]) => title !== 'Not on this board' && title !== 'Feature' && title !== 'No parent'),
    [
      ['Default lane', true],
      ['New', true],
      ['Active', true],
      ['Done', true],
      ['Expedite', true],
      ['New', true],
      ['Active', true]
    ]
  )

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(groupStates(), [
    ['Default lane', false],
    ['Expedite', false],
    ['Not on this board', false],
    ['No parent', false]
  ])
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|work'], { all: 'closed', open: [], closed: [] })

  await panel.toggle({ type: 'Collapsible', label: 'Default lane' })
  assert.deepEqual(groupStates().slice(0, 5), [
    ['Default lane', true],
    ['New', false],
    ['Active', false],
    ['Done', false],
    ['Expedite', false]
  ])
  assert.deepEqual(cardsAt('Default lane', 'New'), [])

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(
    groupStates().filter(([title]) => title !== 'Not on this board' && title !== 'Feature' && title !== 'No parent'),
    [
      ['Default lane', true],
      ['New', true],
      ['Active', true],
      ['Done', true],
      ['Expedite', true],
      ['New', true],
      ['Active', true]
    ]
  )
  assert.deepEqual(cardsAt('Expedite', 'Active'), ['Cache invalidation'])
})

test('a lane name over 1 KiB is cut to the label limit, and the fold keys use the lane id', async () => {
  const long = '界'.repeat(400)
  await open(
    snapshotOf({
      board: laneBoard({ lanes: [{ id: 'lane-default', name: '' }, { id: 'lane-long', name: long }] }),
      mine: [item(101, { title: 'Fix login redirect', column: 'Active', lane: long }), item(102, { title: 'Add export', column: 'Active', lane: null })]
    }),
    {},
    { persisted: IN_LANES }
  )
  const [, , cut] = nodesOf('Collapsible').map(group => String(group.props?.title))
  assert.ok(utf8Length(cut!) <= MAX_LABEL_BYTES && cut!.endsWith('…'), `${utf8Length(cut!)} bytes`)
  assert.deepEqual(cardsAt('Default lane', 'Active'), ['Add export'])
  const longLane = panel.find({ type: 'Collapsible', label: cut! })!
  assert.deepEqual(inside(inside(longLane, { type: 'Collapsible', label: 'Active' })[0]!, { type: 'Card' }).map(titleOf), ['Fix login redirect'])
  await panel.toggle(columnIn('Default lane', 'Active'))
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|work'], { all: null, open: [], closed: ['lane:lane-default/column:Active'] })
  assert.deepEqual(cardsAt('Default lane', 'Active'), [])
  assert.equal(inside(longLane, { type: 'Card' }).length, 1)
})

test('ten nudges are all shown without a note', async () => {
  const mine = Array.from({ length: 10 }, (_, index) => item(index + 1))
  const nudges = mine.map(entry => ({ itemId: entry.id, prId: entry.id, branch: 'main', toColumn: 'Done' }))
  await open(snapshotOf({ mine, nudges }))
  assert.equal(panel.findAll({ type: 'Callout' }).length, 10)
  assert.equal(panel.find({ type: 'Text', text: /not shown/ }), null)
})

test('a failed nudge move shows the message', async () => {
  await open(snapshotOf({ mine: [item(101)], nudges: [{ itemId: 101, prId: 55, branch: 'main', toColumn: 'Done' }] }), {
    'work.move': () => {
      throw hostError('action_failed', CONFLICT)
    }
  })
  await panel.press({ text: 'Move to Done' })
  assert.ok(panel.findAll({ type: 'Callout' }).some(callout => callout.props.tone === 'danger' && callout.text === CONFLICT))
})

test('a nudge for an item that is not listed is not shown', async () => {
  await open(snapshotOf({ mine: [item(101)], nudges: [{ itemId: 999, prId: 55, branch: 'main', toColumn: 'Done' }] }))
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('details shows description, acceptance and comments, and Comment posts', async () => {
  const comment = { id: 2, author: 'Ada Lovelace', createdAt: NOW, textMd: 'Fixed in the next build.' }
  const host = await open(snapshotOf({ mine: [item(101, { title: 'Fix login redirect' })] }), {
    'work.details': detailsOf(),
    'work.comment': comment
  })
  await openCard('Fix login redirect')
  assert.deepEqual(inputsTo(host, 'work.details'), [{ org: 'contoso', id: 101 }])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Fix login redirect')
  assert.deepEqual(panel.find({ type: 'KeyValue' })?.props.items, [
    { label: 'Type', value: 'User Story' },
    { label: 'State', value: 'Active' },
    { label: 'Column', value: 'Active' },
    { label: 'Assigned', value: 'Ada Lovelace' },
    { label: 'Parent', value: '#10 Checkout revamp' }
  ])
  assert.deepEqual(
    panel.findAll({ type: 'Markdown' }).map(markdown => markdown.props.content),
    ['Users land on the **wrong page** after signing in.', '- Redirects to the original page', 'Reproduced on staging.']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['Acceptance criteria', 'Comments (1)']
  )

  await panel.type({ label: 'Add a comment' }, 'Fixed in the next build.')
  await panel.press({ type: 'Button', text: 'Comment' })
  assert.deepEqual(inputsTo(host, 'work.comment'), [{ org: 'contoso', id: 101, text: 'Fixed in the next build.' }])
  assert.deepEqual(
    panel.findAll({ type: 'Markdown' }).map(markdown => markdown.props.content),
    ['Users land on the **wrong page** after signing in.', '- Redirects to the original page', 'Fixed in the next build.', 'Reproduced on staging.']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['Acceptance criteria', 'Comments (2)']
  )
  assert.equal(panel.valueOf({ label: 'Add a comment' }), '')
})

test('details show a chip for every target branch of the item', async () => {
  const prs = ['dev', 'staging', 'master', 'main', 'uat'].map((target, index) => pr(index + 1, { target, state: 'merged' }))
  await open(snapshotOf({ mine: [item(101)] }), { 'work.details': detailsOf({ item: item(101, { prs }) }) })
  await openCard()
  assert.deepEqual(chips(/✓/), ['dev ✓', 'staging ✓', 'master ✓', 'main ✓', 'uat ✓'].map(text => ({ text, tone: 'success' })))
})

test('a comment that fails shows the message and keeps the typed text', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.comment': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await openCard()
  await panel.type({ label: 'Add a comment' }, 'Draft')
  await panel.press({ type: 'Button', text: 'Comment' })
  assert.ok(panel.findAll({ type: 'Callout' }).some(callout => callout.props.tone === 'danger' && callout.text === 'Azure DevOps is unreachable.'))
  assert.equal(panel.valueOf({ label: 'Add a comment' }), 'Draft')
  assert.equal(panel.findAll({ type: 'Markdown' }).length, 3)
})

test('Comment stays disabled until something is typed', async () => {
  await open(snapshotOf({ mine: [item(101)] }), { 'work.details': detailsOf() })
  await openCard()
  assert.equal(panel.find({ type: 'Button', text: 'Comment' })?.disabled, true)
  await panel.type({ label: 'Add a comment' }, 'Hello')
  assert.equal(panel.find({ type: 'Button', text: 'Comment' })?.disabled, false)
})

test('links are listed by kind and Link posts the pull request then reloads the details', async () => {
  let loads = 0
  const linked = detailsOf({
    links: [...detailsOf().links, { kind: 'pr', title: 'PR 56: Second fix', url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/56' }]
  })
  const host = await open(snapshotOf({ mine: [item(101, { rev: 12 })] }), {
    'work.details': () => (++loads === 1 ? detailsOf({ item: item(101, { rev: 12 }) }) : linked),
    'work.linkPr': item(101, { rev: 13 })
  })
  await openCard()
  assert.deepEqual(
    panel.findAll({ type: 'List' }).map(list => list.label),
    ['Parent', 'Children', 'Related', 'Pull requests']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => link.props.href),
    [
      'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/10',
      'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/102',
      'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/103',
      'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/55',
      'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/101'
    ]
  )
  assert.equal(panel.find({ label: 'Link a pull request' })?.props.placeholder, 'https://dev.azure.com/your-org/project/_git/repo/pullrequest/1')
  assert.equal(panel.find({ type: 'Button', text: 'Link' })?.disabled, true)

  await panel.type({ label: 'Link a pull request' }, 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/56')
  await panel.press({ type: 'Button', text: 'Link' })
  assert.deepEqual(inputsTo(host, 'work.linkPr'), [
    { org: 'contoso', id: 101, rev: 12, prUrl: 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/56' }
  ])
  assert.equal(requestsTo(host, 'work.details').length, 2)
  assert.equal(panel.valueOf({ label: 'Link a pull request' }), '')
  assert.ok(panel.find({ type: 'Link', text: 'PR 56: Second fix' }))
})

test('a link the worker refuses shows its message', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.linkPr': () => {
      throw hostError('action_failed', "That isn't a pull request link for this organization.")
    }
  })
  await openCard()
  await panel.type({ label: 'Link a pull request' }, 'nope')
  await panel.press({ type: 'Button', text: 'Link' })
  assert.ok(
    panel
      .findAll({ type: 'Callout' })
      .some(callout => callout.props.tone === 'danger' && callout.text === "That isn't a pull request link for this organization.")
  )
  assert.equal(panel.valueOf({ label: 'Link a pull request' }), 'nope')
})

test('a failed Link reloads the details and keeps the typed link', async () => {
  let loads = 0
  const prUrl = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/56'
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': () => (++loads === 1 ? detailsOf() : detailsOf({ item: item(101, { title: 'Fix login redirect', rev: 9, state: 'Resolved' }) })),
    'work.linkPr': () => {
      throw hostError('action_failed', CONFLICT)
    }
  })
  await openCard()
  await panel.type({ label: 'Link a pull request' }, prUrl)
  await panel.press({ type: 'Button', text: 'Link' })
  assert.equal(requestsTo(host, 'work.details').length, 2)
  assert.deepEqual((panel.find({ type: 'KeyValue' })?.props.items as { label: string; value: unknown }[])[1], { label: 'State', value: 'Resolved' })
  assert.equal(panel.valueOf({ label: 'Link a pull request' }), prUrl)
  assert.ok(panel.findAll({ type: 'Callout' }).some(callout => callout.props.tone === 'danger' && callout.text === CONFLICT))
})

test('Start a workspace names the branch to create', async () => {
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startWorkspace': { branch: 'feature/101-fix-login-redirect', armedUntil: NOW + 600_000 }
  })
  await openCard()
  await panel.press({ type: 'Button', text: 'Start a workspace' })
  assert.deepEqual(inputsTo(host, 'work.startWorkspace'), [{ org: 'contoso', id: 101 }])
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'accent')
  assert.ok(panel.find({ type: 'Text', text: 'Create a new workspace in Orca now. Its branch will be named feature/101-fix-login-redirect.' }))
})

test('Cancel in the start callout disarms the branch and closes the callout', async () => {
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startWorkspace': { branch: 'feature/101-fix-login-redirect', armedUntil: NOW + 600_000 },
    'work.cancelWorkspace': { ok: true }
  })
  await openCard()
  await panel.press({ type: 'Button', text: 'Start a workspace' })
  await panel.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(inputsTo(host, 'work.cancelWorkspace'), [{ org: 'contoso', itemId: 101 }])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.find({ type: 'Button', text: 'Start a workspace' })?.disabled, false)
})

test('the start callout shows only while the posted arm is this item', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startWorkspace': { branch: 'feature/101-fix-login-redirect', armedUntil: NOW + 600_000 }
  })
  const shown = () => panel.find({ type: 'Text', text: 'Create a new workspace in Orca now. Its branch will be named feature/101-fix-login-redirect.' }) !== null
  await openCard()
  for (const other of [null, { org: 'contoso', prId: 4110 }, { org: 'contoso', itemId: 102 }, { org: 'fabrikam', itemId: 101 }]) {
    await panel.press({ type: 'Button', text: 'Start a workspace' })
    await panel.post('workspace.armChanged', { org: 'contoso', itemId: 101 })
    assert.equal(shown(), true, 'the worker posted this item')
    await panel.post('workspace.armChanged', other)
    assert.equal(shown(), false, JSON.stringify(other))
    assert.equal(panel.find({ type: 'Button', text: 'Cancel' }), null)
    assert.equal(panel.find({ type: 'Callout' }), null)
  }
})

test('Start an agent shows the message only when nothing launched', async () => {
  let launched = false
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startAgent': () => ({ launched, message: 'Start a workspace for this item first.' })
  })
  await openCard()
  await panel.press({ type: 'Button', text: 'Start an agent' })
  assert.deepEqual(inputsTo(host, 'work.startAgent'), [{ org: 'contoso', id: 101 }])
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Start a workspace for this item first.')

  launched = true
  await panel.press({ type: 'Button', text: 'Start an agent' })
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a failed start shows the message', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startWorkspace': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await openCard()
  await panel.press({ type: 'Button', text: 'Start a workspace' })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
})

test('details offers Open in Azure DevOps and Back returns to the list', async () => {
  await open(snapshotOf({ mine: [item(101, { title: 'Fix login redirect' })] }), { 'work.details': detailsOf() })
  await openCard('Fix login redirect')
  assert.equal(panel.find({ type: 'Link', text: 'Open in Azure DevOps' })?.props.href, 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/101')
  await panel.press({ label: 'Back' })
  assert.deepEqual(titles(), ['Fix login redirect'])
  assert.equal(panel.find({ type: 'Heading' }), null)
})

test('details that cannot load show the message and still offer Back', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': () => {
      throw hostError('action_failed', "That work item no longer exists, or you can't see it.")
    }
  })
  await openCard()
  assert.equal(panel.find({ type: 'Callout' })?.text, "That work item no longer exists, or you can't see it.")
  await panel.press({ label: 'Back' })
  assert.deepEqual(titles(), ['Story 101'])
})

test('a details view without acceptance criteria omits that section', async () => {
  await open(snapshotOf({ mine: [item(101)] }), { 'work.details': detailsOf({ acceptanceMd: '', descriptionMd: '', links: [] }) })
  await openCard()
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['Comments (1)']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Markdown' }).map(markdown => markdown.props.content),
    ['Reproduced on staging.']
  )
  assert.equal(panel.findAll({ type: 'List' }).length, 0)
})

test('a long group shows 25 cards and Show N more reveals the next ones', async () => {
  const many = (from: number, count: number, over: Partial<WorkItemSummary>) => Array.from({ length: count }, (_, index) => item(from + index, over))
  await open(snapshotOf({ mine: [...many(1000, 60, { column: 'Active' }), ...many(2000, 25, { column: 'New' })] }))
  const showIn = (title: string) => inside(groupOf(title), { type: 'Button', text: /^Show \d+ more$/ })
  assert.deepEqual(groups(), [
    ['New', '25 items'],
    ['Active', '60 items']
  ])
  assert.deepEqual(cardsIn('New'), Array.from({ length: 25 }, (_, index) => `Story ${2000 + index}`))
  assert.equal(showIn('New').length, 0)
  assert.deepEqual(cardsIn('Active'), Array.from({ length: 25 }, (_, index) => `Story ${1000 + index}`))
  const [more] = showIn('Active')
  assert.deepEqual([more?.text, more?.props.variant, more?.props.size], ['Show 25 more', 'ghost', 'sm'])

  await panel.press(more!)
  assert.equal(cardsIn('Active').length, 50)
  assert.equal(showIn('Active')[0]?.text, 'Show 10 more')
  await panel.press(showIn('Active')[0]!)
  assert.deepEqual(cardsIn('Active'), Array.from({ length: 60 }, (_, index) => `Story ${1000 + index}`))
  assert.equal(showIn('Active').length, 0)
  assert.equal(cardsIn('New').length, 25)
  assert.equal(panel.find({ type: 'Text', text: SOME_HIDDEN }), null)
})

test('in Lanes, Show more pages one lane and column without touching the same column in another lane', async () => {
  const many = (from: number, count: number, lane: string | null) => Array.from({ length: count }, (_, index) => item(from + index, { column: 'Active', lane }))
  await open(snapshotOf({ board: laneBoard(), mine: [...many(1000, 30, null), ...many(2000, 30, 'Expedite')] }), {}, { persisted: IN_LANES })
  const showIn = (lane: string) => inside(columnIn(lane, 'Active'), { type: 'Button', text: /^Show \d+ more$/ })
  const storyIds = (lane: string) => cardsAt(lane, 'Active').map(title => title?.replace('Story ', ''))
  assert.deepEqual([cardsAt('Default lane', 'Active').length, cardsAt('Expedite', 'Active').length], [25, 25])
  assert.deepEqual([showIn('Default lane')[0]?.text, showIn('Expedite')[0]?.text], ['Show 5 more', 'Show 5 more'])

  await panel.press(showIn('Expedite')[0]!)
  assert.deepEqual(storyIds('Expedite'), Array.from({ length: 30 }, (_, index) => String(2000 + index)))
  assert.equal(showIn('Expedite').length, 0)
  assert.deepEqual(storyIds('Default lane'), Array.from({ length: 25 }, (_, index) => String(1000 + index)))
  assert.equal(showIn('Default lane')[0]?.text, 'Show 5 more')
})

test("150 items with 300 tasks, all expanded, stay within Orca's limits and say when some are hidden", async () => {
  const large = largeWork()
  assert.deepEqual(
    [
      large.mine.length + large.other.length,
      large.families.lists.flatMap(list => list.tasks).length,
      large.families.parents.length,
      large.board?.columns.length,
      large.board?.lanes.length
    ],
    [150, 300, 10, 5, 2]
  )
  assert.deepEqual([...new Set(large.other.map(each => each.type))], ['Feature', 'Bug', 'Task'])
  await open(large)
  assert.equal(panel.find({ type: 'Text', text: SOME_HIDDEN }), null)
  withinLimits()

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  withinLimits()
  const note = panel.find({ type: 'Text', text: SOME_HIDDEN })
  assert.deepEqual([note?.props.size, note?.props.muted], ['sm', true])
  assert.equal(cardsIn('New').length, 25)
  const showMoreIn = (title: string) => inside(groupOf(title), { type: 'Button', text: /^Show \d+ more$/ })
  assert.equal(showMoreIn('Active').length, 1)
  assert.deepEqual(groups().find(([title]) => title === 'Done'), ['Done', '28 items'])
  assert.equal(showMoreIn('Done').length, 0)
  assert.ok(panel.findAll({ type: 'Link', text: /^#\d+ Review the copy/ }).length > 0)

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.equal(panel.find({ type: 'Text', text: SOME_HIDDEN }), null)
  withinLimits()
})

test("150 items with 300 tasks in Lanes, all expanded, stay within Orca's limits", async () => {
  await open(largeWork(), {}, { persisted: IN_LANES })
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.deepEqual(groups().filter(([title]) => title === 'Default lane' || title === 'Expedite'), [
    ['Default lane', '70 items'],
    ['Expedite', '70 items']
  ])
  withinLimits()

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  withinLimits()
  const note = panel.find({ type: 'Text', text: SOME_HIDDEN })
  assert.deepEqual([note?.props.size, note?.props.muted], ['sm', true])
  assert.deepEqual(groups().filter(([title]) => title === 'Default lane' || title === 'Expedite'), [
    ['Default lane', '70 items'],
    ['Expedite', '70 items']
  ])
  assert.equal(cardsAt('Default lane', 'New').length, 14)
  assert.ok(panel.findAll({ type: 'Link', text: /^#\d+ Review the copy/ }).length > 0)

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.equal(panel.find({ type: 'Text', text: SOME_HIDDEN }), null)
  withinLimits()
  await panel.toggle({ type: 'Collapsible', label: 'Expedite' })
  withinLimits()
})

test('many lanes and columns with every chip stay within the node budget, expanded or not', async () => {
  const columns = Array.from({ length: 8 }, (_, index) => `Column ${index + 1}`)
  const lanes = [{ id: 'lane-default', name: '' }, ...Array.from({ length: 11 }, (_, index) => ({ id: `lane-${index + 1}`, name: `Lane ${index + 1}` }))]
  const mine = Array.from({ length: 360 }, (_, index) =>
    item(1000 + index, {
      column: columns[index % columns.length]!,
      lane: lanes[index % lanes.length]!.name,
      targets: { columns, states: [] },
      prs: ['dev', 'qa', 'staging', 'uat', 'main', 'hotfix'].map((target, number) => pr(index * 10 + number, { target, state: 'merged' }))
    })
  )
  const lists = mine.map(each => listOf(each.id, [workTask(each.id * 10), workTask(each.id * 10 + 1, { state: 'Closed', done: true })]))
  await open(snapshotOf({ board: board('contoso', { lanes }, columns), mine, families: { parents: [], lists } }), {}, { persisted: IN_LANES })
  assert.ok(panel.find({ type: 'Text', text: SOME_HIDDEN }))
  withinLimits()
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.ok(panel.find({ type: 'Text', text: SOME_HIDDEN }))
  withinLimits()
})

test('cards with every chip in many columns stay within the node budget, with task lists closed or open', async () => {
  const columns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`)
  const mine = Array.from({ length: 360 }, (_, index) =>
    item(1000 + index, {
      column: columns[index % columns.length]!,
      targets: { columns, states: [] },
      prs: ['dev', 'qa', 'staging', 'uat', 'main', 'hotfix'].map((target, number) => pr(index * 10 + number, { target, state: 'merged' }))
    })
  )
  const lists = mine.map(each => listOf(each.id, [workTask(each.id * 10), workTask(each.id * 10 + 1, { state: 'Closed', done: true })]))
  const nudges = mine.slice(0, 12).map(each => ({ itemId: each.id, prId: each.id, branch: 'main', toColumn: 'Column 12' }))
  await open(snapshotOf({ board: board('contoso', {}, columns), mine, nudges, families: { parents: [], lists } }))
  assert.equal(panel.findAll({ type: 'Badge', text: '+2' }).length > 100, true)
  assert.ok(panel.find({ type: 'Text', text: SOME_HIDDEN }))
  withinLimits()
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.ok(panel.find({ type: 'Text', text: SOME_HIDDEN }))
  withinLimits()
})

test('stale snapshot shows the warning but keeps the items', async () => {
  const message = 'Azure DevOps is rate limiting requests. Showing the last data.'
  await open(snapshotOf({ mine: [item(101)], stale: true, message }))
  assert.equal(panel.find({ type: 'Text', text: message })?.props.tone, 'warning')
  assert.deepEqual(titles(), ['Story 101'])
  assert.ok(panel.find({ type: 'RelativeTime' }))
})

test('a note on a fresh snapshot is shown without the warning tone', async () => {
  const message = 'Linked PR status needs Code (Read) access.'
  await open(snapshotOf({ mine: [item(101)], message }))
  const note = panel.find({ type: 'Text', text: message })
  assert.ok(note)
  assert.notEqual(note?.props.tone, 'warning')
})

test('work.changed post replaces the list', async () => {
  await open(snapshotOf({ mine: [item(101)] }))
  assert.deepEqual(titles(), ['Story 101'])
  await panel.post('work.changed', snapshotOf({ mine: [item(102, { title: 'Posted story', column: 'New' })], updatedAt: NOW + 1000 }))
  assert.deepEqual(titles(), ['Posted story'])
  assert.deepEqual(groups(), [['New', '1 item']])
})

test('work.changed for another org is ignored', async () => {
  await open(snapshotOf({ mine: [item(101)] }))
  await panel.post('work.changed', snapshotOf({ org: 'fabrikam', mine: [item(102, { org: 'fabrikam', title: 'Elsewhere' })] }))
  assert.deepEqual(titles(), ['Story 101'])
})

test('nothing assigned shows the empty state under the header', async () => {
  await open(snapshotOf())
  assert.equal(panel.find({ type: 'EmptyState' })?.label, 'Nothing assigned to you on this board')
  assert.ok(panel.find({ label: 'Refresh' }))
})

test('an org without a board shows the settings message and opens the settings', async () => {
  const host = await open(snapshotOf(), { 'ado.projects': [], 'ado.teams': [] }, { orgs: [org('contoso', { boards: null })] })
  assert.equal(panel.find({ type: 'EmptyState' })?.label, NO_BOARDS)
  assert.deepEqual(requestsTo(host, 'work.snapshot'), [])
  await panel.press({ type: 'Button', text: 'Open settings' })
  assert.ok(panel.find({ type: 'Heading', text: 'contoso settings' }))
})

test('a snapshot that cannot load shows the message and Try again loads it', async () => {
  let failing = true
  const host = await open(() => {
    if (failing) throw hostError('action_failed', "Couldn't load work items.")
    return snapshotOf({ mine: [item(101)] })
  })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, "Couldn't load work items.")
  assert.equal(panel.findAll({ type: 'Card' }).length, 0)
  failing = false
  await panel.press({ text: 'Try again' })
  assert.deepEqual(titles(), ['Story 101'])
  assert.equal(requestsTo(host, 'work.snapshot').length, 2)
})

test('switching organization loads that org and drops the old list', async () => {
  const host = await open(
    input => snapshotOf({ org: input.org, mine: [item(input.org === 'contoso' ? 101 : 301, { title: `${input.org} story` })] }),
    {},
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  const column = () => panel.find({ type: 'Collapsible', label: 'Active' })?.props.open
  assert.deepEqual(titles(), ['contoso story'])
  assert.equal(column(), true)
  await panel.toggle({ type: 'Collapsible', label: 'Active' })
  assert.equal(column(), false)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(titles(), ['fabrikam story'])
  assert.equal(column(), true)
  assert.deepEqual(inputsTo(host, 'work.snapshot'), [{ org: 'contoso' }, { org: 'fabrikam' }])
  await panel.post('work.changed', snapshotOf({ org: 'contoso', mine: [item(102, { title: 'Late contoso post' })] }))
  assert.deepEqual(titles(), ['fabrikam story'])
})

const later = <T,>(ms: number, run: () => T): Promise<T> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(run())
      } catch (error) {
        reject(error)
      }
    }, ms)
  )

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('a slow snapshot for the org that was left never replaces the new list', async () => {
  await open(
    input =>
      later(input.org === 'contoso' ? 120 : 5, () =>
        snapshotOf({ org: input.org, mine: [item(input.org === 'contoso' ? 101 : 301, { title: `${input.org} story` })] })
      ),
    {},
    { orgs: [org('contoso'), org('fabrikam')], persisted: { plugin: { activeOrg: 'fabrikam' } } }
  )
  assert.deepEqual(titles(), ['fabrikam story'])
  const toContoso = panel.select({ label: 'Organization' }, 'contoso')
  await pause(20)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  await toContoso
  assert.deepEqual(titles(), ['fabrikam story'])
  assert.equal(panel.find({ type: 'Skeleton' }), null)
})

test('a slow failure for the org that was left does not replace the message for the new org', async () => {
  let fabrikamLoads = 0
  await open(
    input => {
      if (input.org === 'contoso') return later<WorkSnapshot>(100, () => Promise.reject(hostError('action_failed', 'Contoso is unreachable.')) as never)
      fabrikamLoads += 1
      if (fabrikamLoads === 1) return snapshotOf({ org: 'fabrikam', mine: [item(301, { title: 'fabrikam story' })] })
      return later<WorkSnapshot>(30, () => Promise.reject(hostError('action_failed', 'Fabrikam is unreachable.')) as never)
    },
    {},
    { orgs: [org('contoso'), org('fabrikam')], persisted: { plugin: { activeOrg: 'fabrikam' } } }
  )
  assert.deepEqual(titles(), ['fabrikam story'])
  const toContoso = panel.select({ label: 'Organization' }, 'contoso')
  await pause(10)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  await toContoso
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Fabrikam is unreachable.')
  assert.ok(panel.find({ type: 'Button', text: 'Try again' }))
})

test('the snapshot and visibility do not depend on queueMicrotask', async () => {
  const original = globalThis.queueMicrotask
  globalThis.queueMicrotask = () => {
    throw new Error('queueMicrotask is not available')
  }
  try {
    const host = await open(snapshotOf({ mine: [item(101)] }))
    assert.deepEqual(titles(), ['Story 101'])
    assert.deepEqual(inputsTo(host, 'ui.visibility'), [{ surface: 'work', org: 'contoso', visible: true }])
  } finally {
    globalThis.queueMicrotask = original
  }
})

test('switching organization closes an open details view', async () => {
  await open(input => snapshotOf({ org: input.org, mine: [item(101)] }), { 'work.details': detailsOf() }, { orgs: [org('contoso'), org('fabrikam')] })
  await openCard()
  assert.ok(panel.find({ type: 'Heading' }))
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.deepEqual(titles(), ['Story 101'])
})

test('leaving the Work tab and coming back keeps the open item, its draft and the collapsed sections', async () => {
  const host = await open(snapshotOf({ mine: [item(101), item(102, { column: 'New' })] }), { 'work.details': detailsOf() })
  const calls = () => inputsTo(host, 'ui.visibility').map(input => input as { surface: string; visible: boolean })
  const since = (count: number) => calls().slice(count).sort((a, b) => a.surface.localeCompare(b.surface))
  const column = (title: string) => panel.find({ type: 'Collapsible', label: title })
  await panel.toggle({ type: 'Collapsible', label: 'New' })
  assert.equal(column('New')?.props.open, false)
  await openCard()
  await panel.toggle({ type: 'Collapsible', label: 'Acceptance criteria' })
  await panel.type({ label: 'Add a comment' }, 'Half-written reply')

  const before = calls().length
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.deepEqual(since(before), [
    { surface: 'prs', org: 'contoso', visible: true },
    { surface: 'work', org: 'contoso', visible: false }
  ])
  assert.equal(panel.find({ type: 'Heading' }), null)

  const afterSwitch = calls().length
  await panel.select({ type: 'Tabs' }, 'work')
  assert.deepEqual(since(afterSwitch), [
    { surface: 'prs', org: 'contoso', visible: false },
    { surface: 'work', org: 'contoso', visible: true }
  ])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Fix login redirect')
  assert.equal(panel.valueOf({ label: 'Add a comment' }), 'Half-written reply')
  assert.equal(panel.find({ type: 'Collapsible', label: 'Acceptance criteria' })?.props.open, false)
  assert.equal(requestsTo(host, 'work.details').length, 1)

  await panel.press({ label: 'Back' })
  assert.equal(column('New')?.props.open, false)
  assert.equal(column('Active')?.props.open, true)
})

test('visibility changes call ui.visibility', async () => {
  const host = await open(input => snapshotOf({ org: input.org }), {}, { orgs: [org('contoso'), org('fabrikam')] })
  const calls = () => inputsTo(host, 'ui.visibility').filter(input => (input as { surface: string }).surface === 'work')
  assert.deepEqual(calls(), [{ surface: 'work', org: 'contoso', visible: true }])

  await panel.rerender()
  assert.equal(calls().length, 1)

  await panel.setVisible(false)
  await panel.setVisible(false)
  assert.deepEqual(calls().slice(1), [{ surface: 'work', org: 'contoso', visible: false }])

  await panel.setVisible(true)
  await panel.select({ type: 'Tabs' }, 'pipelines')
  await panel.select({ type: 'Tabs' }, 'work')
  assert.deepEqual(calls().slice(2), [
    { surface: 'work', org: 'contoso', visible: true },
    { surface: 'work', org: 'contoso', visible: false },
    { surface: 'work', org: 'contoso', visible: true }
  ])

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(calls().slice(5), [
    { surface: 'work', org: 'contoso', visible: false },
    { surface: 'work', org: 'fabrikam', visible: true }
  ])
})

test('a panel that starts hidden reports nothing until it is shown', async () => {
  const host = await open(snapshotOf(), {}, { visible: false })
  assert.deepEqual(requestsTo(host, 'ui.visibility'), [])
  await panel.setVisible(true)
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [{ surface: 'work', org: 'contoso', visible: true }])
})

test('settings and the setup view hide the Work surface', async () => {
  const host = await open(snapshotOf(), { 'ado.projects': [], 'ado.teams': [] })
  await panel.press({ label: 'Organization settings' })
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [
    { surface: 'work', org: 'contoso', visible: true },
    { surface: 'work', org: 'contoso', visible: false }
  ])
  await panel.press({ text: 'Back' })
  assert.equal(inputsTo(host, 'ui.visibility').length, 3)
})

test('closing the panel hides the Work surface', async () => {
  const host = await open(snapshotOf())
  await panel.unmount()
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [
    { surface: 'work', org: 'contoso', visible: true },
    { surface: 'work', org: 'contoso', visible: false }
  ])
})
