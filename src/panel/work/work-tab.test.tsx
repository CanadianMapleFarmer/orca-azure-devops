import { afterEach, assert, hostError, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { OrgStatus } from '../../shared/types'
import type { BoardConfig, PrChip, WorkItemDetails, WorkItemSummary, WorkSnapshot } from '../../shared/work'
import { closeCleanly, mountPanel, org as orgStatus, requestsTo, type TestHost } from '../test-support'

const NOW = 1_700_000_000_000
const NO_BOARDS = "Pick a boards project and team in this org's settings."
const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const BOARDS = { projectId: 'proj-web', projectName: 'Fabrikam Web', teamId: 'team-web', teamName: 'Web Team' }

const org = (name: string, over: Partial<OrgStatus> = {}): OrgStatus => orgStatus(name, { boards: BOARDS, ...over })

const COLUMN_NAMES = ['New', 'Active', 'Done']

function board(name = 'contoso'): BoardConfig {
  return {
    org: name,
    projectId: BOARDS.projectId,
    teamId: BOARDS.teamId,
    boardId: 'board-stories',
    boardName: 'Stories',
    requirementTypes: ['User Story'],
    columns: COLUMN_NAMES.map((column, index) => ({
      id: `col-${index}`,
      name: column,
      isSplit: false,
      columnType: index === 0 ? 'incoming' : index === 2 ? 'outgoing' : 'inProgress',
      stateMappings: { 'User Story': column }
    })),
    lanes: [],
    fields: { column: 'WEF_1_Kanban.Column', columnDone: 'WEF_1_Kanban.Column.Done', lane: 'WEF_1_Kanban.Lane' },
    areaPaths: [],
    doneStates: {}
  }
}

function item(id: number, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    org: 'contoso',
    id,
    rev: 7,
    type: 'User Story',
    title: `Story ${id}`,
    state: 'Active',
    column: 'Active',
    columnDone: false,
    lane: null,
    assignedTo: 'Ada Lovelace',
    parentId: null,
    parentTitle: null,
    changedAt: NOW,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/${id}`,
    prs: [],
    targets: { columns: COLUMN_NAMES, states: [] },
    ...over
  }
}

function task(id: number, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return item(id, { type: 'Task', title: `Task ${id}`, column: null, targets: { columns: [], states: ['New', 'Active', 'Closed'] }, ...over })
}

function pr(prId: number, over: Partial<PrChip> = {}): PrChip {
  return {
    prId,
    repoId: 'repo-web',
    projectId: BOARDS.projectId,
    target: 'main',
    state: 'open',
    build: 'none',
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/${prId}`,
    ...over
  }
}

function snapshotOf(over: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return { org: 'contoso', board: board(), mine: [], other: [], nudges: [], updatedAt: NOW, stale: false, ...over }
}

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

const titles = () => panel.findAll({ type: 'Card' }).map(card => card.label)

const chips = (text: RegExp) => panel.findAll({ type: 'Badge', text }).map(badge => ({ text: badge.text, tone: badge.props.tone }))

const calloutTitled = (title: string) => panel.findAll({ type: 'Callout' }).find(callout => callout.props.title === title)

test('groups items by column in board order with an Other group', async () => {
  await open(
    snapshotOf({
      mine: [
        item(101, { title: 'Fix login redirect', column: 'Active' }),
        item(102, { title: 'Add export', column: 'New' }),
        item(103, { title: 'Cache invalidation', column: 'Active' }),
        item(104, { title: 'Legacy import', column: 'Archived' })
      ],
      other: [task(201, { title: 'Update runbook' })]
    })
  )
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['New (2)', 'Active (2)', 'Other (1)']
  )
  assert.deepEqual(titles(), ['Add export', 'Legacy import', 'Fix login redirect', 'Cache invalidation', 'Update runbook'])
  assert.equal(panel.findAll({ type: 'Card' })[0]?.props.description, 'User Story #102')
  assert.equal(panel.findAll({ type: 'Card' })[4]?.props.description, 'Task #201')
  assert.ok(panel.find({ type: 'Badge', text: 'Stories' }))
  assert.equal(panel.find({ type: 'RelativeTime' })?.props.at, NOW)
})

test('a column without items has no group and the snapshot is requested for the active org', async () => {
  const host = await open(snapshotOf({ mine: [item(101, { column: 'Done' })] }))
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['Done (1)']
  )
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
  assert.deepEqual(chips(/./).filter(chip => chip.text !== 'Stories' && chip.text !== 'Connected'), [
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

test('300 cards with four chips each and 25 nudges still render, with 10 nudges shown', async () => {
  const targets = ['dev', 'staging', 'master', 'main']
  const mine = Array.from({ length: 300 }, (_, index) =>
    item(index + 1, { prs: targets.map((target, number) => pr(index * 4 + number + 1, { target, state: 'merged' })) })
  )
  const nudges = Array.from({ length: 25 }, (_, index) => ({ itemId: index + 1, prId: index * 4 + 1, branch: 'main', toColumn: 'Done' }))
  await open(snapshotOf({ mine, nudges }))
  assert.equal(panel.findAll({ type: 'Card' }).length, 300)
  for (const target of targets) assert.equal(panel.findAll({ type: 'Badge', text: `${target} ✓` }).length, 300, target)
  assert.equal(panel.findAll({ type: 'Badge', text: /^\+/ }).length, 0)
  const shown = panel.findAll({ type: 'Callout' }).map(callout => callout.props.title)
  assert.deepEqual(
    shown,
    Array.from({ length: 10 }, (_, index) => `#${index + 1} — PR ${index * 4 + 1} merged into main`)
  )
  assert.ok(panel.find({ type: 'Text', text: '15 more suggestions not shown.' })?.props.muted)
})

test('the header shows the board name and a refresh that replaces the snapshot', async () => {
  const refreshed = snapshotOf({ mine: [item(105, { title: 'Newer story' })], updatedAt: NOW + 60_000 })
  const host = await open(snapshotOf({ mine: [item(101)] }), { 'work.refresh': refreshed })
  assert.ok(panel.find({ type: 'Badge', text: 'Stories' }))
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

test('Move to sends work.move with the item rev', async () => {
  const sent: unknown[] = []
  await open(snapshotOf({ mine: [item(101, { rev: 12 })], other: [task(201, { rev: 4 })] }), {
    'work.move': input => {
      sent.push(input)
      return item(input.id)
    }
  })
  const [onBoard, off] = panel.findAll({ type: 'Select', label: 'Move to' })
  assert.deepEqual(
    (onBoard?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Done']
  )
  assert.deepEqual(
    (off?.props.options as { value: string }[]).map(option => option.value),
    ['New', 'Closed']
  )
  assert.equal(onBoard?.props.labelHidden, true)

  await panel.select(onBoard!, 'Done')
  await panel.select(panel.findAll({ type: 'Select', label: 'Move to' })[1]!, 'Closed')
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
  await panel.select({ type: 'Select', label: 'Move to' }, 'Done')
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  assert.equal(callout?.text, CONFLICT)
  assert.equal(panel.valueOf({ type: 'Select', label: 'Move to' }), '')

  await panel.post('work.changed', snapshotOf({ mine: [item(101, { rev: 8, column: 'Done', state: 'Done' })] }))
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['Done (1)']
  )
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

test('a card names its parent after the type and id', async () => {
  await open(
    snapshotOf({
      mine: [item(101, { parentId: 10, parentTitle: 'Checkout revamp' }), item(102, { parentId: 11 }), item(103)]
    })
  )
  assert.deepEqual(
    panel.findAll({ type: 'Card' }).map(card => card.props.description),
    ['User Story #101 · ↑ Checkout revamp', 'User Story #102 · ↑ #11', 'User Story #103']
  )
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
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
  assert.deepEqual(chips(/✓/), ['dev ✓', 'staging ✓', 'master ✓', 'main ✓', 'uat ✓'].map(text => ({ text, tone: 'success' })))
})

test('a comment that fails shows the message and keeps the typed text', async () => {
  await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.comment': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await panel.press({ type: 'Button', text: 'Details' })
  await panel.type({ label: 'Add a comment' }, 'Draft')
  await panel.press({ type: 'Button', text: 'Comment' })
  assert.ok(panel.findAll({ type: 'Callout' }).some(callout => callout.props.tone === 'danger' && callout.text === 'Azure DevOps is unreachable.'))
  assert.equal(panel.valueOf({ label: 'Add a comment' }), 'Draft')
  assert.equal(panel.findAll({ type: 'Markdown' }).length, 3)
})

test('Comment stays disabled until something is typed', async () => {
  await open(snapshotOf({ mine: [item(101)] }), { 'work.details': detailsOf() })
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
  await panel.press({ type: 'Button', text: 'Start a workspace' })
  await panel.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(inputsTo(host, 'work.cancelWorkspace'), [{}])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.find({ type: 'Button', text: 'Start a workspace' })?.disabled, false)
})

test('Start an agent shows the message only when nothing launched', async () => {
  let launched = false
  const host = await open(snapshotOf({ mine: [item(101)] }), {
    'work.details': detailsOf(),
    'work.startAgent': () => ({ launched, message: 'Start a workspace for this item first.' })
  })
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
  await panel.press({ type: 'Button', text: 'Start a workspace' })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
})

test('details offers Open in Azure DevOps and Back returns to the list', async () => {
  await open(snapshotOf({ mine: [item(101, { title: 'Fix login redirect' })] }), { 'work.details': detailsOf() })
  await panel.press({ type: 'Button', text: 'Details' })
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
  await panel.press({ type: 'Button', text: 'Details' })
  assert.equal(panel.find({ type: 'Callout' })?.text, "That work item no longer exists, or you can't see it.")
  await panel.press({ label: 'Back' })
  assert.deepEqual(titles(), ['Story 101'])
})

test('a details view without acceptance criteria omits that section', async () => {
  await open(snapshotOf({ mine: [item(101)] }), { 'work.details': detailsOf({ acceptanceMd: '', descriptionMd: '', links: [] }) })
  await panel.press({ type: 'Button', text: 'Details' })
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

test('a long list renders 300 cards, board groups first, and says how many are not shown', async () => {
  const many = (from: number, count: number, over: Partial<WorkItemSummary>) =>
    Array.from({ length: count }, (_, index) => item(from + index, { title: `Story ${from + index}`, ...over }))
  const mine = [...many(1000, 150, { column: 'Active' }), ...many(2000, 200, { column: 'New' })]
  await open(snapshotOf({ mine, other: many(3000, 250, { type: 'Task', column: null, targets: { columns: [], states: ['Closed'] } }) }))
  const cards = panel.findAll({ type: 'Card' })
  assert.equal(cards.length, 300)
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['New (200)', 'Active (150)', 'Other (250)']
  )
  assert.equal(cards[0]?.label, 'Story 2000')
  assert.equal(cards[199]?.label, 'Story 2199')
  assert.equal(cards[200]?.label, 'Story 1000')
  assert.equal(cards[299]?.label, 'Story 1099')
  assert.ok(panel.find({ type: 'Text', text: 'Showing 300 of 600 items. Open the board to see the rest.' })?.props.muted)
})

test('exactly 300 items are all shown without a note', async () => {
  await open(snapshotOf({ mine: Array.from({ length: 300 }, (_, index) => item(index + 1)) }))
  assert.equal(panel.findAll({ type: 'Card' }).length, 300)
  assert.equal(panel.find({ type: 'Text', text: /Showing 300 of/ }), null)
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
  assert.deepEqual(
    panel.findAll({ type: 'Collapsible' }).map(group => group.props.title),
    ['New (1)']
  )
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
  assert.deepEqual(titles(), ['contoso story'])
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(titles(), ['fabrikam story'])
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
  await panel.press({ type: 'Button', text: 'Details' })
  assert.ok(panel.find({ type: 'Heading' }))
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.deepEqual(titles(), ['Story 101'])
})

test('visibility changes call ui.visibility', async () => {
  const host = await open(input => snapshotOf({ org: input.org }), {}, { orgs: [org('contoso'), org('fabrikam')] })
  const calls = () => inputsTo(host, 'ui.visibility')
  assert.deepEqual(calls(), [{ surface: 'work', org: 'contoso', visible: true }])

  await panel.rerender()
  assert.equal(calls().length, 1)

  await panel.setVisible(false)
  await panel.setVisible(false)
  assert.deepEqual(calls().slice(1), [{ surface: 'work', org: 'contoso', visible: false }])

  await panel.setVisible(true)
  await panel.select({ type: 'Tabs' }, 'prs')
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
