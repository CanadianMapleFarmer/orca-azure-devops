import { assert, test } from 'orca/testing'
import { NO_FAMILIES } from '../../shared/work'
import { board, item, LANES, listOf, parentOf, snapshotOf, task, workTask } from './fixtures'
import { byColumn, byLane, DEFAULT_LANE, planWork, tasksOpenByDefault, typeIcon, type WorkCard, type WorkPlan } from './plan'

const rowsOf = (card: WorkCard) => card.tasks.map(row => `${row.id}${row.item ? '*' : ''}`).join(' ')

const describe = (card: WorkCard) => `${card.key} ${card.done}/${card.total}${card.more > 0 ? ` +${card.more}` : ''} [${rowsOf(card)}]`

const offBoardOf = (plan: WorkPlan) => plan.offBoard.map(group => [group.type, group.cards.map(describe)])

const everyCard = (plan: WorkPlan) => [...plan.board, ...plan.offBoard.flatMap(group => group.cards), ...plan.unknown]

test('planWork puts board items in their columns, dimmed parents beside them and the rest by type off the board', () => {
  const plan = planWork(
    snapshotOf({
      mine: [item(101, { column: 'Active' }), item(102, { column: 'New' }), item(103, { column: 'Archived' })],
      other: [
        item(201, { type: 'Feature', column: null }),
        item(202, { type: 'Bug', column: null }),
        item(203, { type: 'User Story', column: null }),
        task(301, { parentId: 150 }),
        task(302, { parentId: 160 }),
        task(303, { parentId: 170 })
      ],
      families: {
        parents: [parentOf(150, { column: 'Done', lane: 'Expedite' }), parentOf(160, { type: 'Feature', column: null }), parentOf(170, { column: 'Archived' })],
        lists: []
      }
    })
  )
  assert.deepEqual(plan.board.map(describe), ['item:101 0/0 []', 'item:102 0/0 []', 'item:103 0/0 []', 'parent:150 0/1 [301*]'])
  assert.deepEqual(
    byColumn(plan.board, board()).map(column => [column.name, column.cards.map(card => card.key)]),
    [
      ['New', ['item:102', 'item:103']],
      ['Active', ['item:101']],
      ['Done', ['parent:150']]
    ]
  )
  const dimmed = plan.board[3]!
  assert.deepEqual([dimmed.item, dimmed.parent?.title, dimmed.column, dimmed.lane], [null, 'Story 150', 'Done', 'Expedite'])
  assert.deepEqual(offBoardOf(plan), [
    ['Bug', ['item:202 0/0 []']],
    ['Feature', ['item:201 0/0 []', 'parent:160 0/1 [302*]']],
    ['User Story', ['item:203 0/0 []', 'parent:170 0/1 [303*]']]
  ])
  assert.deepEqual([plan.unknown, plan.noParent], [[], []])
})

test('byColumn keeps board order, skips empty columns and sends unknown columns to the first', () => {
  const cards = planWork(snapshotOf({ mine: [item(101, { column: 'Done' }), item(102, { column: null }), item(103, { column: 'Gone' })] })).board
  assert.deepEqual(
    byColumn(cards, board()).map(column => [column.name, column.cards.map(card => card.id)]),
    [
      ['New', [102, 103]],
      ['Done', [101]]
    ]
  )
  assert.deepEqual(
    byColumn(cards, board('contoso', {}, [])).map(column => [column.name, column.cards.map(card => card.id)]),
    [
      ['Done', [101]],
      ['No column', [102]],
      ['Gone', [103]]
    ]
  )
})

test('your tasks go under their parent of any type, listed, dimmed or unreadable, and only parentless ones in No parent', () => {
  const snapshot = snapshotOf({
    mine: [item(101)],
    other: [
      item(201, { type: 'Feature', column: null }),
      task(301, { parentId: 101 }),
      task(302, { parentId: 101 }),
      task(303, { parentId: 201 }),
      task(304, { parentId: 150 }),
      task(305, { parentId: 999 }),
      task(306),
      task(307)
    ],
    families: {
      parents: [parentOf(150, { type: 'Bug', column: null })],
      lists: [
        listOf(101, [workTask(301, { mine: true, assignee: 'Ada Lovelace' }), workTask(310), workTask(311, { state: 'Closed', done: true, assignee: null })]),
        listOf(307, [workTask(312)])
      ]
    }
  })
  const plan = planWork(snapshot)
  assert.deepEqual(plan.board.map(describe), ['item:101 1/4 [301* 310 311 302*]'])
  assert.deepEqual(offBoardOf(plan), [
    ['Bug', ['parent:150 0/1 [304*]']],
    ['Feature', ['item:201 0/1 [303*]']],
    ['Task', ['item:307 0/1 [312]']]
  ])
  assert.deepEqual(plan.unknown.map(describe), ['unknown:999 0/1 [305*]'])
  assert.deepEqual(
    plan.noParent.map(row => [row.id, row.item?.id]),
    [[306, 306]]
  )

  const [mineRow, other, done, extra] = plan.board[0]!.tasks
  assert.equal(mineRow?.item, snapshot.other[1])
  assert.deepEqual(other, { id: 310, title: 'Task 310', state: 'Active', done: false, assignee: 'Grace Hopper', mine: false, item: null })
  assert.deepEqual([done?.done, done?.assignee, done?.item], [true, null, null])
  assert.deepEqual(extra, { id: 302, title: 'Task 302', state: 'Active', done: false, assignee: 'Ada Lovelace', mine: true, item: snapshot.other[2] })
  const unknown = plan.unknown[0]!
  assert.deepEqual([unknown.item, unknown.parent, unknown.column, unknown.lane], [null, null, null, null])

  const open = (key: string) => tasksOpenByDefault(everyCard(plan).find(card => card.key === key)!)
  assert.deepEqual(
    ['item:101', 'item:201', 'item:307', 'parent:150', 'unknown:999'].map(open),
    [true, true, false, true, true]
  )
  const allDone = planWork(snapshotOf({ mine: [item(101)], families: { parents: [], lists: [listOf(101, [workTask(301, { mine: true, done: true, state: 'Closed' })])] } }))
  assert.equal(tasksOpenByDefault(allDone.board[0]!), false)
})

test('every task of mine appears exactly once, wherever its parent is', () => {
  const snapshot = snapshotOf({
    mine: [item(101)],
    other: [
      task(401, { parentId: 900 }),
      task(402),
      task(403, { parentId: 402 }),
      task(404, { parentId: 101 }),
      task(405, { parentId: 404 }),
      task(406, { parentId: 160 }),
      task(407, { parentId: 101 })
    ],
    families: {
      parents: [parentOf(101), parentOf(160, { type: 'Task', title: 'Task 160', column: null })],
      lists: [
        listOf(101, [workTask(410)], { total: 5, done: 1 }),
        listOf(402, [workTask(403, { mine: true, assignee: 'Ada Lovelace' })]),
        listOf(160, [workTask(406, { mine: true, assignee: 'Ada Lovelace' }), workTask(411, { state: 'Closed', done: true })])
      ]
    }
  })
  const plan = planWork(snapshot)
  assert.deepEqual(plan.board.map(describe), ['item:101 1/5 +2 [410 404* 407*]'])
  assert.deepEqual(offBoardOf(plan), [['Task', ['parent:160 1/2 [406* 411]', 'item:402 0/1 [403*]', 'parent:404 0/1 [405*]']]])
  assert.deepEqual(plan.unknown.map(describe), ['unknown:900 0/1 [401*]'])
  assert.equal(plan.noParent.length, 0)

  const cards = everyCard(plan)
  const withMove = [
    ...cards.flatMap(card => (card.item ? [card.item.id] : [])),
    ...cards.flatMap(card => card.tasks.flatMap(row => (row.item ? [row.item.id] : []))),
    ...plan.noParent.map(row => row.id)
  ]
  const mineIds = snapshot.other.map(each => each.id)
  assert.deepEqual(
    mineIds.map(id => [id, withMove.filter(each => each === id).length]),
    mineIds.map(id => [id, 1])
  )
  for (const card of cards.filter(each => each.key.startsWith('parent:') || each.key.startsWith('unknown:'))) assert.equal(card.item, null, card.key)
  assert.equal(cards.filter(card => card.id === 101).length, 1)
})

test('a board without task types lists every other item as a card by type', () => {
  const plan = planWork(snapshotOf({ board: board('contoso', { taskTypes: undefined }), other: [task(301), task(302, { parentId: 101 })], families: NO_FAMILIES }))
  assert.deepEqual(offBoardOf(plan), [['Task', ['item:301 0/0 []', 'item:302 0/0 []']]])
  assert.deepEqual([plan.unknown, plan.noParent], [[], []])
})

test('typeIcon maps the process types and falls back to a page', () => {
  assert.deepEqual(
    ['User Story', 'Product Backlog Item', 'Requirement', 'Bug', 'Task', 'Feature', 'Epic', 'Impediment', 'Risk', 'Test Case', 'Issue', 'Change Request'].map(typeIcon),
    ['book', 'book', 'book', 'bug', 'check', 'layers', 'flag', 'warning', 'warning', 'activity', 'file-text', 'file-text']
  )
})

const laneCards = (cards: WorkCard[], lanes: { id: string; name: string }[], columns?: readonly string[]) =>
  byLane(cards, board('contoso', { lanes }, columns)).map(lane => [lane.id, lane.name, lane.columns.map(column => [column.name, column.cards.map(card => card.id)])])

test('byLane puts cards in their lanes in board order, and the rest in Default lane', () => {
  const cards = planWork(
    snapshotOf({
      mine: [
        item(101, { column: 'Active', lane: 'Expedite' }),
        item(102, { column: 'New', lane: null }),
        item(103, { column: 'Done', lane: '' }),
        item(104, { column: 'New', lane: 'Gone' }),
        item(105, { column: 'New', lane: 'Expedite' }),
        item(106, { column: 'Active', lane: null })
      ]
    })
  ).board
  assert.equal(DEFAULT_LANE, 'Default lane')
  assert.deepEqual(laneCards(cards, LANES), [
    [
      'lane-default',
      'Default lane',
      [
        ['New', [102, 104]],
        ['Active', [106]],
        ['Done', [103]]
      ]
    ],
    [
      'lane-expedite',
      'Expedite',
      [
        ['New', [105]],
        ['Active', [101]]
      ]
    ]
  ])
  assert.deepEqual(byLane(cards, board('contoso', { lanes: LANES })).map(lane => lane.id), ['lane-default', 'lane-expedite'])
})

test('byLane falls back to the first lane when none is named empty, and keeps empty lanes', () => {
  const cards = planWork(
    snapshotOf({ mine: [item(101, { column: 'Active', lane: 'Urgent' }), item(102, { column: 'New', lane: null }), item(103, { column: 'Done', lane: 'Gone' })] })
  ).board
  const lanes = [
    { id: 'lane-a', name: 'Planned' },
    { id: 'lane-b', name: 'Urgent' },
    { id: 'lane-c', name: 'Blocked' }
  ]
  assert.deepEqual(laneCards(cards, lanes), [
    [
      'lane-a',
      'Planned',
      [
        ['New', [102]],
        ['Done', [103]]
      ]
    ],
    ['lane-b', 'Urgent', [['Active', [101]]]],
    ['lane-c', 'Blocked', []]
  ])
  assert.deepEqual(laneCards(cards, []), [])
  assert.deepEqual(laneCards([], LANES), [
    ['lane-default', 'Default lane', []],
    ['lane-expedite', 'Expedite', []]
  ])
})

test('byLane places a dimmed parent by its own lane and column, and an unknown column in the first one', () => {
  const plan = planWork(
    snapshotOf({
      mine: [item(101, { column: 'Gone', lane: 'Expedite' })],
      other: [task(301, { parentId: 150 })],
      families: { parents: [parentOf(150, { column: 'Done', lane: 'Expedite' })], lists: [] }
    })
  )
  assert.deepEqual(laneCards(plan.board, LANES), [
    ['lane-default', 'Default lane', []],
    [
      'lane-expedite',
      'Expedite',
      [
        ['New', [101]],
        ['Done', [150]]
      ]
    ]
  ])
})
